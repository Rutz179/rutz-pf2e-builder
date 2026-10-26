import { randomId } from "./util.mjs";
import { getDoc } from "./data.mjs";
import { dualActive } from "./dualclass.mjs";
import { picksOf } from "./plan.mjs";
import { attributes, boostsUpTo, entryOf, skillRanks } from "./rules.mjs";

/* ======================================================================== *
 * Item sources made from compendium documents with the plan's choices in
 * them, ready to be put on a character (for real, or in memory to preview):
 *  - ancestry / background boosts and the class's key attribute selected;
 *  - ChoiceSet rule elements pre-answered where the plan has an answer
 *    (PF2e then skips the prompt; unanswered ones still ask, as usual);
 *  - feats placed in their slot (location "class-2" …, level taken).
 * ======================================================================== */

export function itemSource(doc, plan, { location, taken, keepId = false, key = null } = {}) {
  const src = doc.toObject();
  if (keepId) src._id = randomId(); else delete src._id;
  src._stats = { ...(src._stats ?? {}), compendiumSource: doc.pack ? doc.uuid : (src._stats?.compendiumSource ?? doc.uuid) };
  const picks = { ...picksOf(plan, doc.uuid), ...(key ? picksOf(plan, key) : {}) };
  if (Array.isArray(src.system?.rules)) {
    src.system.rules = src.system.rules.map((r, i) => (r?.key === "ChoiceSet" && picks[i] !== undefined && picks[i] !== null && picks[i] !== "")
      ? { ...r, selection: picks[i] } : r);
  }
  if (location !== undefined) src.system.location = location;
  if (taken) src.system.level = { ...(src.system.level ?? {}), taken };
  return src;
}

export function withAncestryBoosts(src, plan) {
  const b = plan.boosts.ancestry;
  if (b.alt) {
    src.system.alternateAncestryBoosts = b.altPicks.slice(0, 2);
  } else {
    src.system.alternateAncestryBoosts = null;
    for (const [k, slot] of Object.entries(src.system.boosts ?? {})) {
      const opts = slot?.value ?? [];
      if (!opts.length) continue;
      slot.selected = opts.length === 1 ? opts[0] : (opts.includes(b.slots[k]) ? b.slots[k] : null);
    }
    for (const slot of Object.values(src.system.flaws ?? {})) {
      const opts = slot?.value ?? [];
      if (opts.length === 1) slot.selected = opts[0];
    }
  }
  return src;
}

export function withBackgroundBoosts(src, plan) {
  for (const [k, slot] of Object.entries(src.system.boosts ?? {})) {
    const opts = slot?.value ?? [];
    if (!opts.length) continue;
    slot.selected = opts.length === 1 ? opts[0] : (opts.includes(plan.boosts.background[k]) ? plan.boosts.background[k] : null);
  }
  return src;
}

export function withClassKey(src, plan, pick = plan.boosts.classKey, extra = []) {
  const opts = [...new Set([...(src.system.keyAbility?.value ?? []), ...extra])];
  const key = opts.length === 1 ? opts[0] : (opts.includes(pick) ? pick : null);
  src.system.keyAbility = { ...(src.system.keyAbility ?? {}), selected: key };
  return src;
}

/** The second class (dual class): its own key attribute choice. */
const withSecondKey = (src, plan, pick = plan.boosts.classKey2, extra = []) => withClassKey(src, plan, pick, extra);

/** Key attribute options the class's chosen 1st-level subclass adds (Mastermind → int …). */
async function subclassKeyOptions(plan, classDoc) {
  const out = [];
  for (const it of Object.values(classDoc?.system?.items ?? {})) {
    if (!it?.uuid || (Number(it.level ?? 1) || 1) > 1) continue;
    for (const [k, v] of Object.entries(picksOf(plan, it.uuid))) {
      if (k === "_slug" || typeof v !== "string" || !/^Compendium\./.test(v)) continue;
      const d = await getDoc(v);
      out.push(...(d?.system?.subfeatures?.keyOptions ?? []));
    }
  }
  return out;
}

/** Ancestry, heritage, background and class as sources (in that order), with their documents. */
export async function abcSources(plan, { keepId = false } = {}) {
  const out = [];
  const steps = [
    ["ancestry", withAncestryBoosts],
    ["heritage", null],
    ["background", withBackgroundBoosts],
    ["class", withClassKey],
    ["class2", withSecondKey],
    ["deity", null]
  ];
  for (const [key, fix] of steps) {
    if (key === "class2" && !dualActive()) continue;
    const ref = plan[key];
    if (!ref) continue;
    const doc = await getDoc(ref.uuid);
    if (!doc) continue;
    const src = itemSource(doc, plan, { keepId, key: ref.uuid });
    if (key === "class" || key === "class2") fix(src, plan, key === "class" ? plan.boosts.classKey : plan.boosts.classKey2, await subclassKeyOptions(plan, doc));
    else if (fix) fix(src, plan);
    out.push({ key, doc, src });
  }
  return out;
}

/** Actor system data a plan sets directly at a level: boosts by level and skill ranks. */
export function actorSystemFor(plan, level, idx) {
  const ranks = skillRanks(plan, level, idx);
  return {
    details: { level: { value: level } },
    build: { attributes: { manual: false, boosts: boostsUpTo(plan, level) } },
    skills: Object.fromEntries(Object.entries(ranks).map(([k, r]) => [k, { rank: r }]))
  };
}

export function lores(plan, idx) {
  return entryOf(idx, plan.background)?.trained?.lore ?? [];
}

export { attributes };
