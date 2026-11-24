import { ATTRS, MAX_LEVEL, attrLabel, rankLabel, setting, skillLabel, skillSlugs, t } from "./util.mjs";
import { norm, peekDoc, resolveEntry } from "./data.mjs";
import { extraSkillsOf, picksOf } from "./plan.mjs";
import { dualActive } from "./dualclass.mjs";
import { auditSkills, maxRankAt } from "./audit.mjs";

export { maxRankAt };

/* The rules a plan follows (Player Core, remaster), computed from the compendium index: feat slots, skill increases and boosts per level; attribute modifiers; skill ranks; feat prerequisites read from text (English and Korean). */

export const BOOST_LEVELS = [1, 5, 10, 15, 20];

/* Attribute boosts come in groups stored under 1 / 5 / 10 / 15 / 20 (as PF2e keeps them). With Gradual Ability Boosts the four of a group are taken one a level and PF2e uses the first N of the list, so a plan keeps them in order: index i = level (group − 3 + i). */

export function gradualBoosts() {
  return !!game.pf2e?.settings?.variants?.gab;
}

/** How many boosts of a group a character of `level` has (PF2e's own rule). */
export function allowedBoosts(group, level) {
  group = Number(group);
  if (group === 1) return level >= 0 ? 4 : 0;
  if (gradualBoosts()) return 4 - Math.max(0, Math.min(4, group - level));
  return level >= group ? 4 : 0;
}

/** The group a level's boost goes into (null: no boost at that level). */
export function boostGroupAt(level) {
  if (level <= 1) return 1;
  if (!gradualBoosts()) return BOOST_LEVELS.includes(level) ? level : null;
  const g = Math.ceil(level / 5) * 5;
  return g - level <= 3 ? g : null;
}

/** Gradual: the place of a level's boost in its group (0–3). */
export function boostIndexAt(level) {
  const g = boostGroupAt(level);
  return g && g > 1 ? 3 - (g - level) : null;
}

/** A group's planned boosts (gradual plans may have gaps: null). */
export function boostList(plan, group) {
  const list = plan?.boosts?.levels?.[group];
  return Array.isArray(list) ? list : [];
}

/** Planned boosts of a group a character of `level` has, in order. */
export function boostsOfGroup(plan, group, level) {
  const n = allowedBoosts(group, level);
  return n ? boostList(plan, group).slice(0, n).filter(a => ATTRS.includes(a)) : [];
}

/** Is the boost (or the four) of this level chosen? */
export function boostDone(plan, level) {
  const g = boostGroupAt(level);
  if (!g) return true;
  if (g === 1 || !gradualBoosts()) return boostList(plan, g).filter(a => ATTRS.includes(a)).length >= 4;
  return ATTRS.includes(boostList(plan, g)[boostIndexAt(level)]);
}
const DEFAULTS = {
  ancestry: [1, 5, 9, 13, 17],
  class: [1, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20],
  skill: [2, 4, 6, 8, 10, 12, 14, 16, 18, 20],
  general: [3, 7, 11, 15, 19],
  skillIncrease: [3, 5, 7, 9, 11, 13, 15, 17, 19]
};
export const GROUPS = ["ancestry", "class", "class2", "archetype", "skill", "general"];

export function entryOf(idx, ref) {
  return ref?.uuid ? resolveEntry(idx, ref) : null;
}

/** The plan's second class (dual class, with the Dual Class Items module on), else null. */
export function secondClass(plan, idx) {
  return plan?.class2 && dualActive() ? entryOf(idx, plan.class2) : null;
}

/** Levels at which this class gets each kind of slot (variant rules included). Dual class: class feats at each class's own levels ("class2" for the second); the other slots at every level either class gives them (once). */
export function progression(classEntry, second = null) {
  const of = (entry, key) => {
    const list = entry?.levels?.[key];
    return Array.isArray(list) && list.length ? list : DEFAULTS[key];
  };
  const lv = key => [...new Set([...of(classEntry, key), ...(second && key !== "class" ? of(second, key) : [])])].map(Number).sort((a, b) => a - b);
  const fa = !!game.pf2e?.settings?.variants?.fa;
  return {
    ancestry: lv("ancestry"),
    class: lv("class"),
    class2: second ? [...new Set(of(second, "class"))].map(Number).sort((a, b) => a - b) : [],
    skill: lv("skill"),
    general: lv("general"),
    skillIncrease: lv("skillIncrease"),
    archetype: fa ? [2, 4, 6, 8, 10, 12, 14, 16, 18, 20] : [],
    boosts: gradualBoosts() ? [2, 3, 4, 5, 7, 8, 9, 10, 12, 13, 14, 15, 17, 18, 19, 20] : [5, 10, 15, 20]
  };
}

/** progression() for a plan: its class, and its second class when dual-classing. */
export function planProgression(plan, idx) {
  return progression(entryOf(idx, plan?.class), secondClass(plan, idx));
}

export function slotsAt(prog, level) {
  return GROUPS.filter(g => prog[g]?.includes(level)).map(g => ({ id: `${g}-${level}`, group: g, level }));
}

export function slotLevel(slotId) {
  return Number(String(slotId).split("-").pop()) || 0;
}

/* ---------------- attributes ---------------- */

function boostSlots(boosts) {
  return Object.entries(boosts ?? {}).map(([k, b]) => ({ key: k, options: Array.isArray(b?.value) ? b.value : [] })).filter(s => s.options.length);
}

/** What the ancestry/background ask for: fixed boosts and free choices. */
export function ancestryBoostSlots(entry) {
  return boostSlots(entry?.boosts);
}
export function ancestryFlaws(entry) {
  return boostSlots(entry?.flaws).filter(s => s.options.length === 1).map(s => s.options[0]);
}
export function backgroundBoostSlots(entry) {
  return boostSlots(entry?.boosts);
}

/** Modifiers at `level`: every boost +1, except that from level 5 a boost to a modifier at +4 or more is a partial boost (two make +1). */
export function attributes(plan, level, idx) {
  const mods = Object.fromEntries(ATTRS.map(a => [a, 0]));
  const partial = Object.fromEntries(ATTRS.map(a => [a, false]));
  const add = (a, lv) => {
    if (!ATTRS.includes(a)) return;
    if (lv >= 5 && mods[a] >= 4) {
      if (partial[a]) { mods[a] += 1; partial[a] = false; } else partial[a] = true;
    } else mods[a] += 1;
  };
  const anc = entryOf(idx, plan.ancestry);
  if (anc) {
    if (plan.boosts.ancestry.alt) {
      for (const a of plan.boosts.ancestry.altPicks.slice(0, 2)) add(a, 1);
    } else {
      for (const s of ancestryBoostSlots(anc)) add(s.options.length === 1 ? s.options[0] : plan.boosts.ancestry.slots[s.key], 1);
      for (const f of ancestryFlaws(anc)) mods[f] -= 1;
    }
  }
  const bg = entryOf(idx, plan.background);
  for (const s of backgroundBoostSlots(bg)) add(s.options.length === 1 ? s.options[0] : plan.boosts.background[s.key], 1);
  const cls = entryOf(idx, plan.class);
  const key = keyAttribute(plan, cls);
  const cls2 = secondClass(plan, idx);
  if (cls2) {
    // Dual class (as Dual Class Items does it): both key attribute boosts; one landing on an attribute already at +4 is dropped, not halved.
    for (const k of [key, keyAttribute2(plan, cls2)]) if (ATTRS.includes(k) && mods[k] < 4) add(k, 1);
  } else add(key, 1);
  for (const g of BOOST_LEVELS) for (const a of boostsOfGroup(plan, g, level)) add(a, g);
  return { mods, partial, key };
}

/** A class's key attribute options: its own plus what its chosen 1st-level subclass adds (a rogue's racket, a psychic's subconscious mind), as PF2e does. The chosen feature's document must have been fetched. */
export function keyOptions(plan, cls) {
  const out = new Set(cls?.keyAbility ?? []);
  for (const v of subclassPicks(plan, cls)) for (const a of peekDoc(v)?.system?.subfeatures?.keyOptions ?? []) if (ATTRS.includes(a)) out.add(a);
  return [...out];
}

/** Items picked in the class's 1st-level features' questions (uuids). */
export function subclassPicks(plan, cls) {
  const out = [];
  for (const it of cls?.items ?? []) {
    if ((Number(it.level) || 1) > 1) continue;
    for (const [k, v] of Object.entries(picksOf(plan, it.uuid))) if (k !== "_slug" && typeof v === "string" && /^Compendium\./.test(v)) out.push(v);
  }
  return out;
}

export function keyAttribute(plan, cls) {
  const opts = keyOptions(plan, cls);
  return opts.length === 1 ? opts[0] : (opts.includes(plan.boosts.classKey) ? plan.boosts.classKey : null);
}

/** The second class's key attribute (its boost and its class DC). */
export function keyAttribute2(plan, cls2) {
  const opts = keyOptions(plan, cls2);
  return opts.length === 1 ? opts[0] : (opts.includes(plan.boosts.classKey2) ? plan.boosts.classKey2 : null);
}

/** The boosts to write on a sheet of `level` (system.build.attributes.boosts). */
export function boostsUpTo(plan, level) {
  const out = {};
  for (const g of BOOST_LEVELS) {
    const list = boostsOfGroup(plan, g, level);
    if (list.length) out[g] = list;
  }
  return out;
}

/* ---------------- skills ---------------- */

/** Skill slugs a ChoiceSet on the class (e.g. Fighter: Acrobatics or Athletics) was set to. */
function classSkillChoices(plan, ref = plan.class) {
  const picks = Object.entries(picksOf(plan, ref?.uuid)).filter(([k]) => k !== "_slug").map(([, v]) => v);
  const skills = new Set(skillSlugs());
  return picks.filter(v => skills.has(v));
}

/** Classes whose deity trains its divine skill (Player Core: cleric, champion). */
const DEITY_SKILL_CLASSES = new Set(["cleric", "champion"]);
/** Heritages and level-1 ancestry feats that train skills of the player's choice, when no rule of theirs says which. */
const PICK_ITEMS = { "skilled-human": 1, "skilled-heritage": 1, "natural-skill": 2 };

const slugOf = ref => ref?.slug ?? null;
const asList = v => (Array.isArray(v) ? v : v ? [v] : []).filter(x => typeof x === "string");

/** Skill ranks an item's own rules give (ActiveEffectLike on system.skills.<slug>.rank): [{ skill | null, rank, from }]; skill null = choice not made yet; from = lowest level it applies at ("self:level" predicate). */
function ruleSkills(item) {
  const out = [];
  const sel = k => item.flags?.system?.rulesSelections?.[k] ?? item.flags?.pf2e?.rulesSelections?.[k] ?? null;
  for (const r of item.system?.rules ?? []) {
    if (r?.key !== "ActiveEffectLike") continue;
    const m = /^system\.skills\.(.+)\.rank$/.exec(String(r.path ?? ""));
    const rank = Number(r.value);
    if (!m || !(rank >= 1)) continue;
    let skill = m[1];
    const tpl = /^\{item\|flags\.(?:system|pf2e)\.rulesSelections\.([\w-]+)\}$/.exec(skill);
    if (tpl) skill = sel(tpl[1]);
    else if (/[{}]/.test(skill)) skill = null;
    let from = 1;
    for (const p of r.predicate ?? []) if (Array.isArray(p?.gte) && p.gte[0] === "self:level") from = Math.max(from, Number(p.gte[1]) || 1);
    out.push({ skill: skill && skillSlugs().includes(skill) ? skill : skill ? "other" : null, rank, from });
  }
  return out;
}

/**
 * Where each level-1 trained skill comes from, and the free picks left. → { fixed: Map skill → [labels], slots: [{ key, label, n }], ranks: { more, list } (ranks above trained from items' rules, up to `level`) }
 * actor: the sheet's character; level: how far to count.
 */
export function levelOneSources(plan, idx, { actor = null, level = 1 } = {}) {
  const fixed = new Map();
  const add = (s, label) => { if (!s || !skillSlugs().includes(s)) return false; const had = fixed.has(s); if (!had) fixed.set(s, []); fixed.get(s).push(label); return had; };
  const slots = [];
  const slot = (key, label, n) => { if (n > 0) slots.push({ key, label, n }); };
  const cls = entryOf(idx, plan.class);
  const cls2 = secondClass(plan, idx);
  const bg = entryOf(idx, plan.background);
  const clsName = [cls?.name, cls2?.name].filter(Boolean).join(" · ");
  // class: its own skills and answered choices (dual class: both)
  for (const s of [...(cls?.trained?.value ?? []), ...(cls2?.trained?.value ?? [])]) add(s, t("SkillSrc.Class", { name: clsName }));
  for (const s of [...classSkillChoices(plan), ...(cls2 ? classSkillChoices(plan, plan.class2) : [])]) add(s, t("SkillSrc.ClassPick", { name: clsName }));
  // background: a skill the class already trains is replaced by one of the player's choice
  let overlap = 0;
  for (const s of bg?.trained?.value ?? []) if (add(s, t("SkillSrc.Background", { name: bg.name }))) overlap++;
  // the deity's divine skill (cleric, champion); already trained: another of the player's choice
  const deityClass = [cls, cls2].some(c => DEITY_SKILL_CLASSES.has(c?.slug ?? slugOf(c)));
  const deityName = actor?.deity?.name ?? entryOf(idx, plan.deity)?.name ?? plan.deity?.name ?? "";
  const deitySkills = asList(actor?.deity?.system?.skill ?? entryOf(idx, plan.deity)?.deitySkills).filter(s => skillSlugs().includes(s));
  let deityOpen = 0;
  if (deityClass && deitySkills.length) {
    const label = t("SkillSrc.Deity", { name: deityName });
    const free = deitySkills.find(s => !fixed.has(s));
    if (deitySkills.length === 1 || !actor) { if (add(free ?? deitySkills[0], label)) overlap++; }
    else {
      // two divine skills: the one the sheet trains (else a pick still to make)
      const onSheet = deitySkills.find(s => (plan.sheet?.ranks?.[s] ?? 0) >= 1 && !fixed.has(s));
      if (onSheet) add(onSheet, label); else if (!free) overlap++; else deityOpen++;
    }
  } else if (deityClass && (actor?.deity || plan.deity)) deityOpen++;
  // items' own rules (sheet characters) or the builder's answered choices (plans): heritage, feats, features
  const ranks = { more: 0, list: [] };
  const coveredItems = new Set();
  if (actor) {
    for (const item of actor.items ?? []) {
      const lv = Number(item.system?.level?.value ?? 0) || 0;
      if (item.type === "feat" && lv > level) continue;
      for (const r of ruleSkills(item)) {
        if (r.from > level || r.skill === "other") continue;
        coveredItems.add(item.slug ?? item.system?.slug);
        if (r.skill === null) { if (r.from <= 1 && r.rank === 1) slot("choice", t("SkillSrc.Open", { name: item.name }), 1); continue; }
        // a training (an expert rank some levels later is counted as a rank above it, not a second training)
        if ((r.rank === 1 || r.from <= 1) && add(r.skill, item.name) && r.from <= 1 && r.rank === 1) overlap++;
        if (r.rank >= 2) { ranks.more += r.rank - 1; ranks.list.push({ skill: r.skill, rank: r.rank, name: item.name }); }
      }
    }
  } else {
    for (const ref of [plan.heritage, plan.background, plan.deity, plan.feats?.["ancestry-1"], plan.feats?.["class-1"], plan.feats?.["general-1"]]) {
      if (!ref?.uuid || ref === plan.class) continue;
      const picks = Object.entries(picksOf(plan, ref.uuid)).filter(([k]) => k !== "_slug").map(([, v]) => v);
      for (const s of picks) if (skillSlugs().includes(s)) { coveredItems.add(slugOf(ref)); if (add(s, ref.name)) overlap++; }
    }
  }
  // heritages and feats that train skills of the player's choice, when nothing above already accounts for them
  const pickRefs = actor ? [actor.heritage, ...(actor.itemTypes?.feat ?? []).filter(f => (Number(f.system?.level?.value) || 0) <= 1)]
    : [plan.heritage, plan.feats?.["ancestry-1"]];
  for (const it of pickRefs) {
    const sl = it?.slug ?? it?.system?.slug ?? slugOf(it);
    if (sl && PICK_ITEMS[sl] && !coveredItems.has(sl)) slot("choice", it.name, PICK_ITEMS[sl]);
  }
  const extra = Math.max(Number(cls?.trained?.additional ?? 0) || 0, Number(cls2?.trained?.additional ?? 0) || 0);
  slot("class", t("SkillSrc.ClassExtra", { name: clsName, n: extra }), extra);
  // Intelligence counts at level 1 only (each later rise is its own training, intBonusLevels); with hand-typed attributes, the sheet's current Intelligence.
  const int = Math.max(0, manualAttributes(actor) ? Number(actor.system?.abilities?.int?.mod ?? plan.sheet?.mods?.int ?? 0) || 0 : attributes(plan, 1, idx).mods.int);
  slot("int", t("SkillSrc.Int", { n: int }), int);
  slot("overlap", t("SkillSrc.Overlap"), overlap);
  slot("deity", t("SkillSrc.DeityOpen", { name: deityName }), deityOpen);
  // the class's own extra trainings first, then Intelligence, overlaps, the deity, heritage and feat choices
  const ORDER = ["class", "int", "overlap", "deity", "choice"];
  slots.sort((a, b) => ORDER.indexOf(a.key) - ORDER.indexOf(b.key));
  return { fixed, slots, ranks, lores: bg?.trained?.lore ?? [] };
}

/** The sheet's attributes are typed in by hand (PF2e's "manual entry"): there are no boosts to count from. */
const manualAttributes = actor => !!actor?.system?.build?.attributes?.manual;

/** Each trained skill with its source, and how the sheet compares with what class and level give (maths in audit.mjs). Level: a new plan 1, a sheet plan the sheet's level. opts: { ranks } other ranks to audit, { extras } out-of-build records (default: the actor's). */
export function skillAudit(plan, idx, actor = null, opts = {}) {
  const sheet = plan.base === "sheet" && !!plan.sheet;
  const level = Math.max(1, Number(opts.level ?? (sheet ? actor?.level ?? plan.sheet.level : 1)) || 1);
  const src = levelOneSources(plan, idx, { actor: sheet ? actor : null, level });
  const live = sheet && actor ? Object.fromEntries(skillSlugs().map(s => [s, Number(actor.skills?.[s]?.rank ?? actor.system?.skills?.[s]?.rank ?? 0) || 0])) : null;
  const ranks = opts.ranks ?? (sheet ? live ?? plan.sheet.ranks ?? {} : skillRanks(plan, 1, idx));
  const res = auditSkills({
    level, slugs: skillSlugs(), ranks, fixed: src.fixed, slots: src.slots,
    intLevels: sheet && !manualAttributes(actor) ? intBonusLevels(plan, idx) : [],
    increaseLevels: sheet ? planProgression(plan, idx).skillIncrease : [],
    more: src.ranks,
    extras: sheet ? opts.extras ?? extraSkillsOf(actor) : [],
    labels: { int: lv => t("SkillSrc.IntLevel", { level: lv }) }
  });
  res.lores = src.lores;
  return res;
}

/** Level 1: skills trained automatically, and how many the player picks. */
export function levelOneSkills(plan, idx) {
  const src = levelOneSources(plan, idx);
  // a heritage's or feat's own skill question is answered with that item (its ChoiceSet), not with the toggles here
  return { auto: new Set(src.fixed.keys()), free: src.slots.filter(x => x.key !== "choice").reduce((n, x) => n + x.n, 0), lores: src.lores };
}

/** At these levels a raised Intelligence gives one more trained skill (remaster). */
export function intBonusLevels(plan, idx) {
  const out = [];
  for (let lv = 2; lv <= MAX_LEVEL; lv++) {
    if (!(boostGroupAt(lv) > 1)) continue;
    const before = attributes(plan, lv - 1, idx).mods.int;
    const after = attributes(plan, lv, idx).mods.int;
    if (after > before) out.push(lv);
  }
  return out;
}

export function skillRanks(plan, level, idx) {
  const ranks = Object.fromEntries(skillSlugs().map(s => [s, 0]));
  let from = 1;
  if (plan.base === "sheet" && plan.sheet) {
    Object.assign(ranks, plan.sheet.ranks ?? {});
    from = plan.sheet.level + 1;
  } else {
    const one = levelOneSkills(plan, idx);
    for (const s of one.auto) if (s in ranks) ranks[s] = Math.max(ranks[s], 1);
    for (const s of plan.skills.trained ?? []) if (s in ranks) ranks[s] = Math.max(ranks[s], 1);
  }
  for (let lv = from; lv <= level; lv++) {
    const extra = plan.skills.extra?.[lv];
    if (extra && extra in ranks) ranks[extra] = Math.max(ranks[extra], 1);
    const inc = plan.skills.increases?.[lv];
    if (inc && inc in ranks && ranks[inc] < maxRankAt(lv)) ranks[inc] += 1;
  }
  return ranks;
}

/* ---------------- prerequisites ---------------- */

const RANK_EN = { trained: 1, expert: 2, master: 3, legendary: 4 };
const ATTR_EN = { strength: "str", dexterity: "dex", constitution: "con", intelligence: "int", wisdom: "wis", charisma: "cha" };

let words = null;
function localWords() {
  if (words) return words;
  const rank = [];
  for (let r = 1; r <= 4; r++) rank.push([norm(rankLabel(r)), r]);
  rank.push(["숙련", 1], ["훈련", 1], ["전문", 2], ["달인", 3], ["전설", 4]);
  const skills = skillSlugs().map(s => [norm(skillLabel(s)), s]).filter(([w]) => w);
  const attrs = ATTRS.map(a => [norm(attrLabel(a)), a]);
  words = { rank, skills, attrs };
  return words;
}

/** Everything a feat's prerequisites can be checked against, for a plan at a level. */
export function context(plan, level, idx) {
  const names = new Set();
  const addName = e => { if (!e) return; names.add(norm(e.name)); if (e.original) names.add(norm(e.original)); };
  const cls2 = secondClass(plan, idx);
  for (const r of [plan.ancestry, plan.heritage, plan.background, plan.class, plan.deity, cls2 ? plan.class2 : null]) addName(entryOf(idx, r) ?? r);
  for (const [slot, ref] of Object.entries(plan.feats)) if (ref && slotLevel(slot) <= level) addName(entryOf(idx, ref) ?? ref);
  const cls = entryOf(idx, plan.class);
  for (const it of [...(cls?.items ?? []), ...(cls2?.items ?? []), ...(entryOf(idx, plan.ancestry)?.items ?? []), ...(entryOf(idx, plan.background)?.items ?? [])]) {
    if (it.level <= level) names.add(norm(it.name));
  }
  const takenUuids = Object.entries(plan.feats).filter(([, r]) => r).map(([slot, r]) => ({ slot, uuid: r.uuid }));
  const lores = (entryOf(idx, plan.background)?.trained?.lore ?? []).map(norm);
  return { level, ranks: skillRanks(plan, level, idx), mods: attributes(plan, level, idx).mods, names, takenUuids, lores };
}

function checkPart(text, ctx, idx) {
  const raw = String(text ?? "").trim().replace(/\.$/, "");
  if (!raw) return null;
  const t = norm(raw);
  // English rank: "expert in Athletics"
  let m = /^(trained|expert|master|legendary)\s+in\s+(?:the\s+)?(.+)$/i.exec(raw);
  if (m) {
    const need = RANK_EN[m[1].toLowerCase()];
    const target = norm(m[2]).replace(/\s+/g, "-");
    if (target in ctx.ranks) return ctx.ranks[target] >= need;
    // "trained in Legal Lore": the background's lore counts; other lores can come from anywhere (unknown).
    if (/lore$/i.test(m[2].trim()) && need === 1) {
      const lore = norm(m[2]);
      if ((ctx.lores ?? []).some(l => l.includes(lore) || lore.includes(l))) return true;
    }
    return null;
  }
  // English attribute: "Strength +2" (or legacy "Strength 14")
  m = /^(strength|dexterity|constitution|intelligence|wisdom|charisma)\s*\+?\s*(\d+)$/i.exec(raw);
  if (m) {
    const a = ATTR_EN[m[1].toLowerCase()];
    const n = Number(m[2]);
    return (ctx.mods[a] ?? 0) >= (n >= 10 ? Math.floor((n - 10) / 2) : n);
  }
  // Korean (or other translated) text: a rank word and a skill name, or an attribute and a number.
  const w = localWords();
  const rank = w.rank.find(([word]) => word && t.includes(word));
  const skills = w.skills.filter(([word]) => word && t.includes(word));
  if (rank && skills.length) {
    // "기만과 외교 전문가" → both; "곡예 또는 운동 숙련" → either.
    const results = skills.map(([, slug]) => (ctx.ranks[slug] ?? 0) >= rank[1]);
    return /또는|이나\s|거나|\//.test(t) ? results.some(Boolean) : results.every(Boolean);
  }
  const attr = w.attrs.find(([word]) => word && t.includes(word));
  const num = /\+\s*(\d)/.exec(raw);
  if (attr && num) return (ctx.mods[attr[1]] ?? 0) >= Number(num[1]);
  // A feat or feature by name.
  if (ctx.names.has(t)) return true;
  if (idx?.featNames?.has(t)) return false;
  return null;
}

const all = rs => (rs.some(r => r === false) ? false : rs.every(r => r === true) ? true : null);
const any = rs => (rs.some(r => r === true) ? true : rs.every(r => r === false) ? false : null);
const OR_SPLIT = /\s+or\s+|\s*\/\s*|\s+또는\s+/i;
const AND_SPLIT = /\s+and\s+|\s*[,;]\s*|\s+및\s+|\s+그리고\s+/i;

/** One prerequisite line with "and", "or", "/" and lists read ("expert in A and B" → both; "trained in A, B, or C" → any one; "A / B" → either); each piece is checked true / false / can't tell. */
function checkLine(text, ctx, idx) {
  const raw = String(text ?? "").trim().replace(/\.$/, "");
  if (!raw) return null;
  const whole = checkPart(raw, ctx, idx);
  if (whole !== null && !/\s(and|or)\s|\/|,/i.test(raw)) return whole;
  // A rank followed by a list of skills shares the rank: "expert in A and B", "trained in A, B, or C".
  const m = /^(trained|expert|master|legendary)\s+in\s+(.+)$/i.exec(raw);
  if (m && !/\s(trained|expert|master|legendary)\s+in\s/i.test(m[2])) {
    const list = m[2].split(/\s*,\s*(?:and\s+|or\s+)?|\s+and\s+|\s+or\s+|\s*\/\s*/i).map(x => x.trim()).filter(Boolean);
    if (list.length > 1) {
      const rs = list.map(x => checkPart(`${m[1]} in ${x}`, ctx, idx));
      return /\sor\s|\//i.test(m[2]) ? any(rs) : all(rs);
    }
  }
  const ors = raw.split(OR_SPLIT).map(x => x.trim()).filter(Boolean);
  if (ors.length > 1) return any(ors.map(o => checkLine(o, ctx, idx)));
  const ands = raw.split(AND_SPLIT).map(x => x.trim()).filter(Boolean);
  if (ands.length > 1) return all(ands.map(a => checkPart(a, ctx, idx)));
  return whole;
}

/** { state: "ok" | "no" | "unknown", parts: [{ text, ok }] } */
export function prereqState(entry, ctx, idx) {
  const parts = (entry?.prereqs ?? []).map(p => ({ text: String(p), ok: checkLine(p, ctx, idx) }));
  const state = parts.some(x => x.ok === false) ? "no" : parts.every(x => x.ok === true) ? "ok" : "unknown";
  return { state, parts };
}

/* ---------------- which feats fit a slot ---------------- */

export function ancestryTraits(plan, idx) {
  const out = new Set();
  const anc = entryOf(idx, plan.ancestry);
  const her = entryOf(idx, plan.heritage);
  if (anc) { out.add(anc.slug); for (const t of anc.traits) if (t !== "humanoid") out.add(t); }
  if (her) { for (const t of her.traits) out.add(t); if (!her.ancestrySlug) out.add(her.slug); }
  return out;
}

export function rarityAllowed(rarity) {
  if (game.user.isGM) return true;
  const limit = setting("rarityLimit", "all");
  if (limit === "common") return rarity === "common";
  if (limit === "uncommon") return rarity === "common" || rarity === "uncommon";
  return true;
}

/** Feats that fit `slot` (group + level); `tab` narrows class slots ("class" | "archetype") and general slots ("general" | "skill"). */
export function featsForSlot(idx, plan, slot, { tab = null } = {}) {
  const cls = entryOf(idx, plan.class);
  const classSlug = cls?.slug ?? null;
  const class2Slug = secondClass(plan, idx)?.slug ?? null;
  const ancTraits = ancestryTraits(plan, idx);
  const taken = new Map();
  for (const [sid, ref] of Object.entries(plan.feats)) if (ref && sid !== slot.id) taken.set(ref.uuid, (taken.get(ref.uuid) ?? 0) + 1);
  return idx.feat.filter(f => {
    if (f.level > slot.level) return false;
    if (f.onlyLevel1 && slot.level !== 1) return false;
    if ((taken.get(f.uuid) ?? 0) >= f.maxTakable) return false;
    if (!rarityAllowed(f.rarity)) return false;
    switch (slot.group) {
      case "ancestry": return f.category === "ancestry" && f.traits.some(t => ancTraits.has(t));
      case "class":
        if (tab === "archetype") return f.traits.includes("archetype");
        return f.category === "class" && !!classSlug && f.traits.includes(classSlug);
      case "class2":
        if (tab === "archetype") return f.traits.includes("archetype");
        return f.category === "class" && !!class2Slug && f.traits.includes(class2Slug);
      case "archetype": return f.traits.includes("archetype");
      case "skill": return f.category === "skill";
      case "general":
        if (tab === "skill") return f.category === "skill";
        if (tab === "general") return f.category === "general";
        return f.category === "general" || f.category === "skill";
      default: return false;
    }
  });
}

/* ---------------- what is still open ---------------- */

export function openItems(plan, upTo, idx) {
  const out = [];
  if (!plan.ancestry) out.push({ step: "ancestry", level: 1, key: "ancestry" });
  if (!plan.heritage) out.push({ step: "ancestry", level: 1, key: "heritage" });
  if (!plan.background) out.push({ step: "background", level: 1, key: "background" });
  if (!plan.class) out.push({ step: "class", level: 1, key: "class" });
  const cls = entryOf(idx, plan.class);
  if (!cls) {
    if (plan.base !== "sheet") {
      if (!boostDone(plan, 1)) out.push({ step: "attributes", level: 1, key: "boosts" });
      if (!(plan.skills.trained ?? []).length) out.push({ step: "skills", level: 1, key: "skills" });
    }
    return out;
  }
  const cls2 = secondClass(plan, idx);
  const prog = progression(cls, cls2);
  const from = plan.base === "sheet" && plan.sheet ? plan.sheet.level + 1 : 1;
  // Dual Class Items stops a player from leaving level 1 without the second class, so a new build needs one.
  if (dualActive() && !plan.class2 && plan.base !== "sheet") out.push({ step: "class", level: 1, key: "class2" });
  if (from <= 1) {
    if (!keyAttribute(plan, cls)) out.push({ step: "attributes", level: 1, key: "classKey" });
    if (cls2 && !keyAttribute2(plan, cls2)) out.push({ step: "attributes", level: 1, key: "classKey2" });
    if (!boostDone(plan, 1)) out.push({ step: "attributes", level: 1, key: "boosts" });
    const one = levelOneSkills(plan, idx);
    if ((plan.skills.trained ?? []).length < one.free) out.push({ step: "skills", level: 1, key: "skills" });
  }
  for (let lv = Math.max(from, 1); lv <= Math.min(upTo, MAX_LEVEL); lv++) {
    for (const s of slotsAt(prog, lv)) if (!plan.feats[s.id]) out.push({ step: `level-${lv}`, level: lv, key: s.id });
    if (lv > 1 && prog.skillIncrease.includes(lv) && !plan.skills.increases[lv]) out.push({ step: `level-${lv}`, level: lv, key: "increase" });
    if (prog.boosts.includes(lv) && !boostDone(plan, lv)) out.push({ step: `level-${lv}`, level: lv, key: "boosts" });
  }
  return out;
}
