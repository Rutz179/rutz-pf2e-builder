import { ATTRS, MAX_LEVEL, attrLabel, rankLabel, setting, skillLabel, skillSlugs } from "./util.mjs";
import { norm, peekDoc, resolveEntry } from "./data.mjs";
import { picksOf } from "./plan.mjs";
import { dualActive } from "./dualclass.mjs";

/* ======================================================================== *
 * The rules a plan follows (Player Core, remaster), computed from the
 * compendium index so nothing is hard-wired to particular classes:
 *  - which feat slots, skill increases and boosts each level gives;
 *  - attribute modifiers after boosts (partial boosts above +4 from level 5);
 *  - skill ranks at a level, and how high an increase may go;
 *  - feat prerequisites, read from their text (English and Korean).
 * ======================================================================== */

export const BOOST_LEVELS = [1, 5, 10, 15, 20];

/* Attribute boosts come in groups stored under 1 / 5 / 10 / 15 / 20 (as PF2e
 * keeps them). With the Gradual Ability Boosts variant, each group's four are
 * taken one a level (2–5, 7–10, 12–15, 17–20) and PF2e uses the first N of the
 * group's list, so a plan keeps them in order: index i = level (group − 3 + i). */

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

/**
 * Levels at which this class gets each kind of slot (variant rules included).
 * Dual class: each class's class feats at its own levels ("class2" for the second); skill feats,
 * general feats, ancestry feats and skill increases at every level either class gives them (once).
 */
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

/**
 * Modifiers at `level`: every boost +1, except that from level 5 a boost to
 * a modifier already at +4 or more is a partial boost (two make +1).
 */
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
    // Dual class (as the Dual Class Items module does it): both key attribute boosts; one that would
    // land on an attribute already at +4 is dropped, not halved.
    for (const k of [key, keyAttribute2(plan, cls2)]) if (ATTRS.includes(k) && mods[k] < 4) add(k, 1);
  } else add(key, 1);
  for (const g of BOOST_LEVELS) for (const a of boostsOfGroup(plan, g, level)) add(a, g);
  return { mods, partial, key };
}

/**
 * A class's key attribute options: its own, plus what its chosen 1st-level subclass adds (a rogue's
 * racket: Mastermind → Intelligence; a psychic's subconscious mind …), as PF2e does from the feature's
 * "key attribute options". The chosen feature's document must have been fetched (the builder does that).
 */
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

/** Level 1: skills trained automatically, and how many the player picks. */
export function levelOneSkills(plan, idx) {
  const cls = entryOf(idx, plan.class);
  const cls2 = secondClass(plan, idx);
  const bg = entryOf(idx, plan.background);
  // Dual class: both classes' automatic skills, and the larger number of extra ones.
  const fromClass = new Set([...(cls?.trained?.value ?? []), ...classSkillChoices(plan),
    ...(cls2 ? [...(cls2.trained?.value ?? []), ...classSkillChoices(plan, plan.class2)] : [])]);
  const fromBg = new Set(bg?.trained?.value ?? []);
  const overlap = [...fromBg].filter(s => fromClass.has(s)).length;
  const auto = new Set([...fromClass, ...fromBg]);
  const int = Math.max(0, attributes(plan, 1, idx).mods.int);
  const extra = Math.max(Number(cls?.trained?.additional ?? 0) || 0, Number(cls2?.trained?.additional ?? 0) || 0);
  const free = extra + int + overlap;
  return { auto, free, lores: bg?.trained?.lore ?? [] };
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

/** Highest rank a skill increase can reach at this level. */
export function maxRankAt(level) {
  return level >= 15 ? 4 : level >= 7 ? 3 : 2;
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

/**
 * One prerequisite line, with "and", "or", "/" and lists read:
 *   "expert in Deception and Diplomacy"         → both
 *   "trained in Arcana, Nature, or Religion"     → any one
 *   "Strength +2 or Dexterity +2" · "A / B"      → either
 *   "Shield Block and trained in Athletics"      → both
 * Each piece is still checked as before (true / false / can't tell).
 */
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

/**
 * Feats that fit `slot` (group + level). `tab` narrows class/general slots:
 * class → "class" | "archetype"; general → "general" | "skill".
 */
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
