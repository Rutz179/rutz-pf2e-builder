import { ATTRS, MID, randomId, skillSlugs } from "./util.mjs";
import { getDoc, loadIndex } from "./data.mjs";
import { boostsUpTo, entryOf, skillRanks, slotLevel } from "./rules.mjs";
import { abcSources, itemSource, lores } from "./sources.mjs";
import { previewFlags, slotInUse, slotLocation } from "./dualclass.mjs";

/* ======================================================================== *
 * Numbers for a plan at a level, worked out by PF2e itself: the plan is put
 * together as a character that exists only in memory (never saved), PF2e
 * prepares it like any other, and we read HP, AC, saves, skills … off it.
 *
 * A "sheet" plan starts from a copy of the real character, so everything it
 * already has (gear, granted feats, choices made) counts too.
 * Choices only made at the moment an item is added (a feat picked from a
 * prompt, a granted item) are not in a preview — it is a close estimate.
 * ======================================================================== */

const cache = new Map();

function featureSources(holder, level, plan, docs) {
  return (async () => {
    const out = [];
    for (const entry of Object.values(holder.src.system.items ?? {})) {
      const lv = Number(entry?.level ?? 1) || 1;
      if (!entry?.uuid || lv > level) continue;
      const d = await getDoc(entry.uuid);
      if (!d || d.type !== "feat") continue;
      const s = itemSource(d, plan, { location: holder.src._id, keepId: true, key: entry.uuid });
      if (d.system?.category === "classfeature") s.system.level = { ...(s.system.level ?? {}), value: lv };
      out.push(s);
      docs?.push(d);
    }
    return out;
  })();
}

async function featSources(plan, from, level) {
  const out = [];
  for (const [slot, ref] of Object.entries(plan.feats)) {
    const lv = slotLevel(slot);
    if (!ref || !slotInUse(slot) || lv < from || lv > level) continue;
    const d = await getDoc(ref.uuid);
    if (d) out.push(itemSource(d, plan, { location: slotLocation(slot, plan), taken: lv, keepId: true, key: ref.uuid }));
  }
  return out;
}

async function buildFree(plan, level, idx) {
  const abc = await abcSources(plan, { keepId: true });
  const items = abc.map(a => a.src);
  for (const holder of abc) if (holder.key !== "heritage") items.push(...await featureSources(holder, level, plan));
  items.push(...await featSources(plan, 1, level));
  for (const lore of lores(plan, idx)) items.push({ _id: randomId(), type: "lore", name: lore, system: { proficient: { value: 1 } } });
  const ranks = skillRanks(plan, level, idx);
  // Dual class: Dual Class Items reads its flag to treat the two class items as one character's classes.
  const second = abc.find(a => a.key === "class2")?.src;
  return {
    _id: randomId(), name: plan.name || "Preview", type: "character",
    ...(second ? { flags: previewFlags(second._id) } : {}),
    system: {
      details: { level: { value: level } },
      build: { attributes: { manual: false, boosts: boostsUpTo(plan, level) } },
      skills: Object.fromEntries(Object.entries(ranks).map(([k, r]) => [k, { rank: r }]))
    },
    items
  };
}

async function buildFromSheet(plan, level, idx, actor) {
  const src = actor.toObject();
  src._id = randomId();
  src.system.details.level.value = level;
  const sheetLevel = plan.sheet?.level ?? actor.level;
  // Boosts planned for later levels.
  const boosts = foundry.utils.deepClone(src.system.build?.attributes?.boosts ?? {});
  for (const [lv, list] of Object.entries(boostsUpTo(plan, level))) if (Number(lv) > sheetLevel) boosts[lv] = list;
  foundry.utils.setProperty(src, "system.build.attributes.boosts", boosts);
  // Skill ranks planned for later levels.
  const ranks = skillRanks(plan, level, idx);
  for (const [k, r] of Object.entries(ranks)) {
    const cur = Number(src.system.skills?.[k]?.rank ?? 0);
    if (r > cur) foundry.utils.setProperty(src, `system.skills.${k}.rank`, r);
  }
  // Class features of the levels to come (PF2e adds them on level-up; here we add them by hand).
  // (Dual class: both class items.)
  for (const classItem of src.items.filter(i => i.type === "class")) {
    const have = new Set(src.items.map(i => i._stats?.compendiumSource ?? i.flags?.core?.sourceId).filter(Boolean));
    for (const entry of Object.values(classItem.system.items ?? {})) {
      const lv = Number(entry?.level ?? 1) || 1;
      if (!entry?.uuid || lv <= sheetLevel || lv > level || have.has(entry.uuid)) continue;
      const d = await getDoc(entry.uuid);
      if (!d || d.type !== "feat") continue;
      const s = itemSource(d, plan, { location: classItem._id, keepId: true, key: entry.uuid });
      s.system.level = { ...(s.system.level ?? {}), value: lv };
      src.items.push(s);
    }
  }
  src.items.push(...await featSources(plan, sheetLevel + 1, level));
  return src;
}

export function statsOf(actor) {
  const s = actor.system ?? {};
  const stat = st => (st ? { mod: Number(st.mod ?? st.totalModifier ?? 0), rank: Number(st.rank ?? 0) } : null);
  const feats = (actor.itemTypes?.feat ?? []).map(f => ({ name: f.name, category: f.category, level: f.system?.level?.taken ?? f.level ?? 0, location: f.system?.location ?? null, img: f.img }));
  return {
    level: actor.level ?? s.details?.level?.value ?? 1,
    hp: Number(actor.hitPoints?.max ?? s.attributes?.hp?.max ?? 0) || 0,
    ac: Number(actor.armorClass?.value ?? s.attributes?.ac?.value ?? 0) || 0,
    perception: stat(actor.perception),
    saves: Object.fromEntries(["fortitude", "reflex", "will"].map(k => [k, stat(actor.saves?.[k])])),
    classDC: Number(actor.classDC?.dc?.value ?? actor.classDC?.value ?? 0) || null,
    speed: Number(actor.attributes?.speed?.total ?? s.movement?.speeds?.land?.value ?? s.attributes?.speed?.total ?? 0) || null,
    attrs: Object.fromEntries(ATTRS.map(a => [a, Number(s.abilities?.[a]?.mod ?? 0) || 0])),
    skills: Object.fromEntries(skillSlugs().map(k => [k, stat(actor.skills?.[k])])),
    feats: feats.filter(f => !["classfeature", "ancestryfeature"].includes(f.category)),
    features: feats.filter(f => f.category === "classfeature")
  };
}

/** Stats of a plan at a level (cached until the plan changes). `actor`: the real character, for sheet plans. */
export async function previewStats(plan, level, actor = null) {
  const key = `${plan.id}|${plan.updated}|${level}|${actor?.id ?? ""}|${actor?._stats?.modifiedTime ?? ""}`;
  if (cache.has(key)) return cache.get(key);
  const idx = await loadIndex();
  let result;
  try {
    const source = plan.base === "sheet" && actor ? await buildFromSheet(plan, level, idx, actor) : await buildFree(plan, level, idx);
    const Doc = CONFIG.Actor.documentClass;
    const temp = new Doc(source);
    result = statsOf(temp);
  } catch (err) {
    console.warn(`${MID} | preview failed`, err);
    result = { error: String(err?.message ?? err) };
  }
  if (cache.size > 60) cache.clear();
  cache.set(key, result);
  return result;
}

export { entryOf };
