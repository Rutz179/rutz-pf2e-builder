import { ATTRS, MID, randomId, setting, skillSlugs, sourceIdOf } from "./util.mjs";

/* ======================================================================== *
 * A plan is one build of a character, level 1 to 20:
 *
 *   { id, name, base: "free" | "sheet", updated,
 *     ancestry, heritage, background, class     — refs { uuid, name, img, slug }
 *     boosts: { ancestry: { alt: bool, slots: { "0": "str" … }, altPicks: [] },
 *               background: { "0": "int", "1": "con" }, classKey: "str",
 *               levels: { "1": [4], "5": [4], "10": [4], "15": [4], "20": [4] } }
 *     skills: { trained: [slugs at level 1], increases: { "3": "athletics", … },
 *               extra: { "5": "medicine" } }  — extra trained skill when Int rises
 *     feats: { "class-2": ref, "skill-2": ref, … }        — slot id = group-level
 *     choices: { [item uuid, "." → "~"]: { [rule index]: value, _slug } }
 *        — dots would be read as nested keys when Foundry saves the flag
 *     sheet: { level, ranks } | null                       — for base "sheet"
 *     notes }
 *
 * base "sheet": follows the character as it is; everything up to the sheet's
 * level is read from the sheet, the plan only adds what comes after (this is
 * the plan that "apply on level-up" uses). base "free": a what-if build from
 * scratch (another class, another archetype …), for comparing.
 *
 * Plans live on the actor (flags); a player's not-yet-created character lives
 * on the user as a draft.
 * ======================================================================== */

export function newPlan(name = "", base = "free") {
  return {
    id: randomId(), name, base, updated: Date.now(),
    ancestry: null, heritage: null, background: null, class: null, deity: null,
    boosts: { ancestry: { alt: false, slots: {}, altPicks: [] }, background: {}, classKey: null, levels: {} },
    skills: { trained: [], increases: {}, extra: {} },
    feats: {},
    choices: {},
    spells: { casting: null, byLevel: {} },
    sheet: null,
    notes: ""
  };
}

export function normalizePlan(p) {
  const base = newPlan(p?.name ?? "", p?.base ?? "free");
  const out = foundry.utils.mergeObject(base, foundry.utils.deepClone(p ?? {}), { inplace: false });
  out.boosts.ancestry ??= { alt: false, slots: {}, altPicks: [] };
  out.boosts.ancestry.slots ??= {};
  out.boosts.ancestry.altPicks ??= [];
  out.boosts.background ??= {};
  out.boosts.levels ??= {};
  out.skills.trained ??= [];
  out.skills.increases ??= {};
  out.skills.extra ??= {};
  out.feats ??= {};
  out.choices = fixChoices(out.choices);
  out.spells ??= { casting: null, byLevel: {} };
  out.spells.byLevel ??= {};
  return out;
}

/* ---------------- answers to an item's questions (ChoiceSets) ---------------- */

const enc = uuid => String(uuid ?? "").replace(/\./g, "~");
export const decodeChoiceKey = key => String(key).replace(/~/g, ".");

/** Older plans were saved with dotted keys, which Foundry spread into nested objects: put them back. */
function fixChoices(c) {
  const out = {};
  const leaf = v => v && typeof v === "object" && !Array.isArray(v)
    && Object.entries(v).every(([k, x]) => (/^\d+$/.test(k) || k === "_slug") && (x === null || typeof x !== "object"));
  const walk = (obj, path) => {
    for (const [k, v] of Object.entries(obj ?? {})) {
      if (!v || typeof v !== "object" || Array.isArray(v)) continue;
      const key = [...path, k].join(".");
      if (leaf(v)) out[enc(key)] = { ...(out[enc(key)] ?? {}), ...v };
      else walk(v, [...path, k]);
    }
  };
  walk(c, []);
  return out;
}

export function picksOf(plan, uuid) {
  return plan?.choices?.[enc(uuid)] ?? {};
}

export function setPick(plan, uuid, rule, value, slug) {
  const key = enc(uuid);
  const map = (plan.choices[key] ??= {});
  if (value === "" || value === null || value === undefined) delete map[rule]; else map[rule] = value;
  if (slug) map._slug = slug;
  if (!Object.keys(map).some(k => k !== "_slug")) delete plan.choices[key];
}

export function clonePlan(p, name) {
  const c = normalizePlan(foundry.utils.deepClone(p));
  c.id = randomId();
  c.name = name ?? p.name;
  c.updated = Date.now();
  return c;
}

/* ---------------- storage ---------------- */

export function maxPlans() {
  return Math.max(1, Math.min(10, Number(setting("maxPlans", 5)) || 5));
}

export function plansOf(actor) {
  const list = actor?.getFlag?.(MID, "plans");
  return Array.isArray(list) ? list.map(normalizePlan) : [];
}

export function activePlanId(actor) {
  return actor?.getFlag?.(MID, "activePlan") ?? null;
}

export async function savePlans(actor, plans, activeId) {
  const data = plans.map(p => ({ ...p, updated: p.updated ?? Date.now() }));
  await actor.update({ [`flags.${MID}.plans`]: data, ...(activeId !== undefined ? { [`flags.${MID}.activePlan`]: activeId } : {}) }, { render: false });
}

export function draftOf(user = game.user) {
  let d = user.getFlag(MID, "draft");
  if (Array.isArray(d)) d = d[0];
  return d ? normalizePlan(d) : null;
}

export async function saveDraft(plan, user = game.user) {
  // In a list, so the saved draft is replaced as a whole (removed picks stay removed).
  await user.setFlag(MID, "draft", [plan]);
}

export async function clearDraft(user = game.user) {
  await user.unsetFlag(MID, "draft");
}

/* ---------------- reading a real character ---------------- */

function refFromItem(item) {
  if (!item) return null;
  return { uuid: sourceIdOf(item) ?? item.uuid, name: item.name, img: item.img, slug: item.slug ?? item.system?.slug ?? null, level: item.level ?? 0 };
}

/**
 * A "sheet" plan for an existing character: its ancestry/background/class and
 * every choice made so far, so future levels can be planned on top of it.
 */
export function planFromActor(actor, name) {
  const p = newPlan(name ?? actor.name, "sheet");
  p.ancestry = refFromItem(actor.ancestry);
  p.heritage = refFromItem(actor.heritage);
  p.background = refFromItem(actor.background);
  p.class = refFromItem(actor.class);
  p.deity = refFromItem(actor.deity ?? actor.itemTypes?.deity?.[0]);
  const anc = actor.ancestry?._source?.system;
  if (anc) {
    p.boosts.ancestry.alt = Array.isArray(anc.alternateAncestryBoosts);
    p.boosts.ancestry.altPicks = [...(anc.alternateAncestryBoosts ?? [])];
    for (const [k, b] of Object.entries(anc.boosts ?? {})) if (b?.selected) p.boosts.ancestry.slots[k] = b.selected;
  }
  for (const [k, b] of Object.entries(actor.background?._source?.system?.boosts ?? {})) if (b?.selected) p.boosts.background[k] = b.selected;
  p.boosts.classKey = actor.class?._source?.system?.keyAbility?.selected ?? actor.class?.system?.keyAbility?.selected ?? null;
  const levels = actor._source?.system?.build?.attributes?.boosts ?? {};
  for (const [lv, list] of Object.entries(levels)) if (Array.isArray(list)) p.boosts.levels[lv] = [...list];
  for (const feat of actor.itemTypes?.feat ?? []) {
    const loc = feat.system?.location;
    if (!loc || !/^[a-z]+-\d+$/.test(loc)) continue;
    p.feats[loc] = refFromItem(feat);
  }
  const ranks = {};
  for (const slug of skillSlugs()) ranks[slug] = Number(actor.skills?.[slug]?.rank ?? actor.system?.skills?.[slug]?.rank ?? 0) || 0;
  const mods = Object.fromEntries(ATTRS.map(a => [a, Number(actor.system?.abilities?.[a]?.mod ?? 0) || 0]));
  p.sheet = { level: actor.level ?? 1, ranks, mods, actorId: actor.id };
  return p;
}

/** Refresh the read-only part of a sheet plan (the character may have changed since). */
export function refreshSheetPlan(plan, actor) {
  if (plan.base !== "sheet" || !actor) return plan;
  const fresh = planFromActor(actor, plan.name);
  const level = fresh.sheet.level;
  // Unlocked: the plan's own picks for levels the sheet already has are kept too (and win over the sheet).
  const keep = lv => plan.unlocked || Number(lv) > level;
  const keepFeats = Object.fromEntries(Object.entries(plan.feats).filter(([slot]) => keep(slot.split("-").pop())));
  const keepInc = Object.fromEntries(Object.entries(plan.skills.increases).filter(([lv]) => keep(lv)));
  const keepExtra = Object.fromEntries(Object.entries(plan.skills.extra ?? {}).filter(([lv]) => keep(lv)));
  const keepBoosts = Object.fromEntries(Object.entries(plan.boosts.levels).filter(([lv]) => keep(lv)));
  // Gradual boosts: a group the sheet is partway through keeps the sheet's first picks, then the plan's.
  if (!plan.unlocked && game.pf2e?.settings?.variants?.gab) {
    for (const [g, list] of Object.entries(keepBoosts)) {
      const n = 4 - Math.max(0, Math.min(4, Number(g) - level));
      if (n <= 0 || n >= 4 || !Array.isArray(list)) continue;
      const head = (fresh.boosts.levels[g] ?? []).slice(0, n);
      while (head.length < n) head.push(null);
      const merged = [...head, ...list.slice(n).map(a => (head.includes(a) ? null : a))];
      while (merged.length && !ATTRS.includes(merged[merged.length - 1])) merged.pop();
      keepBoosts[g] = merged;
    }
  }
  return normalizePlan({
    ...plan,
    ancestry: fresh.ancestry, heritage: fresh.heritage, background: fresh.background, class: fresh.class, deity: fresh.deity,
    boosts: { ...fresh.boosts, levels: { ...fresh.boosts.levels, ...keepBoosts } },
    feats: { ...fresh.feats, ...keepFeats },
    skills: { trained: plan.skills.trained, increases: keepInc, extra: keepExtra },
    sheet: fresh.sheet
  });
}

/** Is this part of the plan fixed by the sheet (not editable here)? */
export function lockedAt(plan, level) {
  return plan.base === "sheet" && !!plan.sheet && !plan.unlocked && level <= plan.sheet.level;
}
