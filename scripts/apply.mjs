import { MID, sourceIdOf, t } from "./util.mjs";
import { casterDefaults, entryName, traditionLabel } from "./spells.mjs";
import { entryOf } from "./rules.mjs";
import { placeClassSpells, withSpellLock } from "./class-spells.mjs";
import { getDoc, loadIndex } from "./data.mjs";
import { boostsUpTo, skillRanks, slotLevel } from "./rules.mjs";
import { abcSources, itemSource, lores } from "./sources.mjs";
import { planFromActor, plansOf, refreshSheetPlan, savePlans } from "./plan.mjs";
import { answering } from "./choices.mjs";

/* ======================================================================== *
 * Putting a plan on a real character.
 *
 * applyCreation — a brand-new character: level, boosts and skill ranks, then
 *   ancestry → heritage → background → class (PF2e adds their features and
 *   asks whatever the plan did not answer), background lores, and the feats
 *   of every slot up to the starting level.
 *
 * applyRebuild — an existing character rebuilt from a plan made from
 *   scratch (a respec): ancestry, heritage, background, class, deity, feats,
 *   lores, spells and spellcasting entries, boosts and skill ranks are taken
 *   off, then the plan goes on as for a new character at the sheet's level.
 *   Equipment, coins, effects and conditions stay.
 *
 * applyUpTo — an existing character reaching a level: the boosts, skill
 *   increases and feats the plan has for every level up to it that the sheet
 *   does not have yet. Nothing already on the sheet is replaced. Optionally
 *   raises the level first (PF2e then adds the class features).
 * ======================================================================== */

async function createOne(actor, src) {
  const [made] = await actor.createEmbeddedDocuments("Item", [src]);
  return made ?? null;
}

export async function applyCreation(actor, plan, options = {}) {
  answering(actor, plan);
  try { return await withSpellLock(actor, () => creation(actor, plan, options)); } finally { answering(actor, null); }
}

async function creation(actor, plan, { level = 1, progress = () => {} } = {}) {
  const idx = await loadIndex();
  const done = [];
  progress(t("Apply.Step.Base"));
  const ranks = skillRanks(plan, level, idx);
  await actor.update({
    "system.details.level.value": level,
    "system.build.attributes.boosts": boostsUpTo(plan, level),
    ...Object.fromEntries(Object.entries(ranks).filter(([, r]) => r > 0).map(([k, r]) => [`system.skills.${k}.rank`, r]))
  }, { rpbApply: true });
  for (const { key, src } of await abcSources(plan)) {
    progress(t(`Apply.Step.${key}`));
    const made = await createOne(actor, src);
    if (made) done.push(made.name);
  }
  const have = new Set(actor.itemTypes.lore.map(l => l.name));
  // The background as it is on the sheet (translated), else the index.
  const loreNames = actor.background?.system?.trainedSkills?.lore ?? lores(plan, idx);
  const newLores = loreNames.filter(n => n && !have.has(n)).map(name => ({ type: "lore", name, system: { proficient: { value: 1 } } }));
  if (newLores.length) await actor.createEmbeddedDocuments("Item", newLores);
  progress(t("Apply.Step.Feats"));
  done.push(...await placeFeats(actor, plan, 1, level));
  progress(t("Apply.Step.ClassSpells"));
  done.push(...await placeClassSpells(actor, castingOf(plan, idx), level, actor.class?.name ?? plan.class?.name ?? ""));
  done.push(...await placeSpells(actor, plan, 1, level));
  await rememberPlan(actor, plan);
  return done;
}

/** What a rebuild takes off the sheet. */
const BUILD_TYPES = ["ancestry", "heritage", "background", "class", "deity", "feat", "lore", "spellcastingEntry", "spell"];

export function rebuildLoss(actor) {
  const items = actor.items.filter(i => BUILD_TYPES.includes(i.type));
  const of = type => items.filter(i => i.type === type);
  return {
    abc: ["ancestry", "heritage", "background", "class", "deity"].flatMap(of).map(i => i.name),
    feats: of("feat").filter(f => !["classfeature", "ancestryfeature", "pfsboon", "curse", "deityboon"].includes(f.system?.category)).length,
    spells: of("spell").length,
    ids: items.map(i => i.id)
  };
}

export async function applyRebuild(actor, plan, options = {}) {
  answering(actor, plan);
  try {
    return await withSpellLock(actor, async () => {
      const level = Math.max(1, Math.min(20, options.level ?? actor.level ?? 1));
      (options.progress ?? (() => {}))(t("Apply.Step.Clear"));
      const ids = [...new Set(rebuildLoss(actor).ids)];
      if (ids.length) {
        // PF2e also takes away what those items granted; skip whatever is already gone.
        await actor.deleteEmbeddedDocuments("Item", ids.filter(id => actor.items.has(id)));
      }
      const src = actor._source.system;
      const reset = { "system.build.attributes.boosts": Object.fromEntries([1, 5, 10, 15, 20].map(lv => [lv, []])) };
      for (const k of Object.keys(src.skills ?? {})) reset[`system.skills.${k}.rank`] = 0;
      await actor.update(reset, { rpbApply: true });
      return await creation(actor, plan, { ...options, level });
    });
  } finally { answering(actor, null); }
}

/** How the plan casts: what was set in the spells step, else the class's usual way. */
function castingOf(plan, idx) {
  const c = plan.spells?.casting;
  const slug = entryOf(idx, plan.class)?.slug ?? null;
  if (c?.tradition) return { ...c, slug };
  const d = casterDefaults(plan, idx);
  return d ? { tradition: d.tradition ?? c?.tradition ?? null, mode: d.mode, attr: d.attr, slug } : null;
}

/** Feats of slots from..to that the character does not have in that slot yet. */
/** A feat on the sheet in this slot that the (unlocked) plan wants changed. */
function replacedIn(actor, plan, slot, ref) {
  if (!plan.unlocked || !ref) return null;
  const cur = actor.itemTypes.feat.find(f => f.system?.location === slot);
  if (!cur) return null;
  const src = sourceIdOf(cur);
  return src === ref.uuid || cur.slug === ref.slug ? null : cur;
}

async function placeFeats(actor, plan, from, to) {
  const done = [];
  const occupied = new Set(actor.itemTypes.feat.map(f => f.system?.location).filter(Boolean));
  const slots = Object.entries(plan.feats).filter(([slot, ref]) => ref && slotLevel(slot) >= from && slotLevel(slot) <= to)
    .sort((a, b) => slotLevel(a[0]) - slotLevel(b[0]));
  for (const [slot, ref] of slots) {
    const old = replacedIn(actor, plan, slot, ref);
    if (old) {
      await old.delete();
      done.push(t("Apply.Replaced", { old: old.name }));
      occupied.delete(slot);
    }
    if (occupied.has(slot)) continue;
    const doc = await getDoc(ref.uuid);
    if (!doc) { done.push(`⚠ ${ref.name}`); continue; }
    const made = await createOne(actor, itemSource(doc, plan, { location: slot, taken: slotLevel(slot), key: ref.uuid }));
    if (made) done.push(made.name);
  }
  return done;
}

/** Spells planned for levels from..to that the sheet does not have yet, into the matching spellcasting entry. */
async function placeSpells(actor, plan, from, to) {
  const c = castingOf(plan, await loadIndex());
  // Tradition from a subclass (witch patron, sorcerer bloodline): the entry the class spells went into says it.
  if (c && !c.tradition) c.tradition = actor.itemTypes.spellcastingEntry?.find(e => e.system?.prepared?.value === c.mode)?.system?.tradition?.value ?? null;
  const wanted = Object.entries(plan.spells?.byLevel ?? {}).filter(([lv]) => Number(lv) >= from && Number(lv) <= to).flatMap(([, list]) => list).filter(Boolean);
  if (!c?.tradition || !wanted.length) return [];
  const done = [];
  let entry = actor.itemTypes.spellcastingEntry?.find(e => e.system?.tradition?.value === c.tradition && e.system?.prepared?.value === c.mode);
  if (!entry) {
    [entry] = await actor.createEmbeddedDocuments("Item", [{
      type: "spellcastingEntry", name: entryName(actor.class?.name ?? plan.class?.name ?? "", c.tradition),
      system: { tradition: { value: c.tradition }, prepared: { value: c.mode }, ability: { value: c.attr }, proficiency: { value: 1 } }
    }]);
    done.push(t("Spells.EntryMade"));
  }
  const have = new Set((actor.itemTypes.spell ?? []).map(s => sourceIdOf(s)).filter(Boolean));
  const sources = [];
  for (const ref of wanted) {
    if (have.has(ref.uuid)) continue;
    have.add(ref.uuid);
    const doc = await getDoc(ref.uuid);
    if (!doc) continue;
    const src = itemSource(doc, plan);
    src.system.location = { ...(src.system.location ?? {}), value: entry.id };
    sources.push(src);
  }
  if (sources.length) {
    const made = await actor.createEmbeddedDocuments("Item", sources);
    done.push(...made.map(m => m.name));
  }
  return done;
}

/** After a change on the sheet: the plan follows the sheet again, the rest of it is kept. */
async function rememberPlan(actor, plan) {
  const plans = plansOf(actor);
  const fresh = plan.base === "sheet" ? refreshSheetPlan(plan, actor) : refreshSheetPlan({ ...planFromActor(actor, plan.name), id: plan.id, feats: plan.feats, skills: plan.skills, boosts: { ...plan.boosts }, choices: plan.choices, spells: plan.spells, notes: plan.notes }, actor);
  fresh.updated = Date.now();
  if (!fresh.name || fresh.name === t("Plan.DraftName")) fresh.name = t("Plan.MainName");
  const i = plans.findIndex(p => p.id === plan.id);
  if (i >= 0) plans[i] = fresh; else plans.unshift(fresh);
  await savePlans(actor, plans, fresh.id);
  return fresh;
}

/** What applyUpTo would do, without doing it (for the confirmation and the level-up card). */
export async function pendingUpTo(actor, plan, upTo) {
  const idx = await loadIndex();
  const out = { boosts: [], skills: [], feats: [] };
  const src = actor._source.system;
  for (const [lv, list] of Object.entries(boostsUpTo(plan, upTo))) {
    const cur = src.build?.attributes?.boosts?.[lv] ?? [];
    if (list.length && (cur.length < list.length || (plan.unlocked && [...cur].sort().join() !== [...list].sort().join()))) out.boosts.push(Number(lv));
  }
  const ranks = skillRanks(plan, upTo, idx);
  for (const [k, r] of Object.entries(ranks)) {
    const eff = Number(actor.skills?.[k]?.rank ?? src.skills?.[k]?.rank ?? 0);
    if (r > eff) out.skills.push({ slug: k, from: eff, to: r });
  }
  const occupied = new Set(actor.itemTypes.feat.map(f => f.system?.location).filter(Boolean));
  out.replace = [];
  for (const [slot, ref] of Object.entries(plan.feats)) {
    if (!ref || slotLevel(slot) > upTo) continue;
    const old = replacedIn(actor, plan, slot, ref);
    if (old) { out.feats.push({ slot, name: ref.name }); out.replace.push({ slot, from: old.name, to: ref.name }); }
    else if (!occupied.has(slot)) out.feats.push({ slot, name: ref.name });
  }
  const have = new Set((actor.itemTypes.spell ?? []).map(s => sourceIdOf(s)).filter(Boolean));
  out.spells = plan.spells?.casting?.tradition ? Object.entries(plan.spells.byLevel ?? {}).filter(([lv]) => Number(lv) <= upTo).flatMap(([, l]) => l).filter(r => r && !have.has(r.uuid)) : [];
  out.empty = !out.replace.length && !out.boosts.length && !out.skills.length && !out.feats.length && !out.spells.length;
  return out;
}

export async function applyUpTo(actor, plan, upTo, options = {}) {
  answering(actor, plan);
  try { return await withSpellLock(actor, () => upToLevel(actor, plan, upTo, options)); } finally { answering(actor, null); }
}

async function upToLevel(actor, plan, upTo, { raiseLevel = false } = {}) {
  const idx = await loadIndex();
  const done = [];
  if (raiseLevel && actor.level < upTo) {
    await actor.update({ "system.details.level.value": upTo }, { rpbApply: true });
    done.push(t("Apply.Raised", { level: upTo }));
  }
  const src = actor._source.system;
  const update = {};
  for (const [lv, list] of Object.entries(boostsUpTo(plan, upTo))) {
    const cur = src.build?.attributes?.boosts?.[lv] ?? [];
    if (list.length && (cur.length < list.length || (plan.unlocked && [...cur].sort().join() !== [...list].sort().join()))) {
      update[`system.build.attributes.boosts.${lv}`] = list;
      done.push(t("Apply.Boosts", { level: lv }));
    }
  }
  const ranks = skillRanks(plan, upTo, idx);
  for (const [k, r] of Object.entries(ranks)) {
    const eff = Number(actor.skills?.[k]?.rank ?? src.skills?.[k]?.rank ?? 0);
    if (r > eff) {
      update[`system.skills.${k}.rank`] = r;
      done.push(t("Apply.Skill", { skill: actor.skills?.[k]?.label ?? k, rank: game.i18n.localize(`PF2E.ProficiencyLevel${r}`) }));
    }
  }
  if (Object.keys(update).length) await actor.update(update, { rpbApply: true });
  done.push(...await placeFeats(actor, plan, 1, upTo));
  done.push(...await placeClassSpells(actor, castingOf(plan, idx), actor.level, actor.class?.name ?? ""));
  done.push(...await placeSpells(actor, plan, 1, upTo));
  await rememberPlan(actor, plan);
  return done;
}
