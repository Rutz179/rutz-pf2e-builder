import { ATTRS, MAX_LEVEL, attrLabel, rankLabel, setting, skillLabel, skillSlugs } from "./util.mjs";
import { norm } from "./data.mjs";
import { picksOf } from "./plan.mjs";

/* ======================================================================== *
 * The rules a plan follows (Player Core, remaster), computed from the
 * compendium index so nothing is hard-wired to particular classes:
 *  - which feat slots, skill increases and boosts each level gives;
 *  - attribute modifiers after boosts (partial boosts above +4 from level 5);
 *  - skill ranks at a level, and how high an increase may go;
 *  - feat prerequisites, read from their text (English and Korean).
 * ======================================================================== */

export const BOOST_LEVELS = [1, 5, 10, 15, 20];
const DEFAULTS = {
  ancestry: [1, 5, 9, 13, 17],
  class: [1, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20],
  skill: [2, 4, 6, 8, 10, 12, 14, 16, 18, 20],
  general: [3, 7, 11, 15, 19],
  skillIncrease: [3, 5, 7, 9, 11, 13, 15, 17, 19]
};
export const GROUPS = ["ancestry", "class", "archetype", "skill", "general"];

export function entryOf(idx, ref) {
  return ref?.uuid ? idx?.byUuid?.get(ref.uuid) ?? null : null;
}

/** Levels at which this class gets each kind of slot (variant rules included). */
export function progression(classEntry) {
  const lv = key => {
    const list = classEntry?.levels?.[key];
    return [...new Set(Array.isArray(list) && list.length ? list : DEFAULTS[key])].map(Number).sort((a, b) => a - b);
  };
  const fa = !!game.pf2e?.settings?.variants?.fa;
  return {
    ancestry: lv("ancestry"),
    class: lv("class"),
    skill: lv("skill"),
    general: lv("general"),
    skillIncrease: lv("skillIncrease"),
    archetype: fa ? [2, 4, 6, 8, 10, 12, 14, 16, 18, 20] : [],
    boosts: [5, 10, 15, 20]
  };
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
  add(key, 1);
  for (const lv of BOOST_LEVELS) if (lv <= level) for (const a of plan.boosts.levels[lv] ?? []) add(a, lv);
  return { mods, partial, key };
}

export function keyAttribute(plan, cls) {
  const opts = cls?.keyAbility ?? [];
  return opts.length === 1 ? opts[0] : (opts.includes(plan.boosts.classKey) ? plan.boosts.classKey : null);
}

export function boostsUpTo(plan, level) {
  const out = {};
  for (const lv of BOOST_LEVELS) if (lv <= level && plan.boosts.levels[lv]?.length) out[lv] = [...plan.boosts.levels[lv]];
  return out;
}

/* ---------------- skills ---------------- */

/** Skill slugs a ChoiceSet on the class (e.g. Fighter: Acrobatics or Athletics) was set to. */
function classSkillChoices(plan) {
  const picks = Object.entries(picksOf(plan, plan.class?.uuid)).filter(([k]) => k !== "_slug").map(([, v]) => v);
  const skills = new Set(skillSlugs());
  return picks.filter(v => skills.has(v));
}

/** Level 1: skills trained automatically, and how many the player picks. */
export function levelOneSkills(plan, idx) {
  const cls = entryOf(idx, plan.class);
  const bg = entryOf(idx, plan.background);
  const fromClass = new Set([...(cls?.trained?.value ?? []), ...classSkillChoices(plan)]);
  const fromBg = new Set(bg?.trained?.value ?? []);
  const overlap = [...fromBg].filter(s => fromClass.has(s)).length;
  const auto = new Set([...fromClass, ...fromBg]);
  const int = Math.max(0, attributes(plan, 1, idx).mods.int);
  const free = (Number(cls?.trained?.additional ?? 0) || 0) + int + overlap;
  return { auto, free, lores: bg?.trained?.lore ?? [] };
}

/** At these levels a raised Intelligence gives one more trained skill (remaster). */
export function intBonusLevels(plan, idx) {
  const out = [];
  for (const lv of [5, 10, 15, 20]) {
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
  for (const r of [plan.ancestry, plan.heritage, plan.background, plan.class, plan.deity]) addName(entryOf(idx, r) ?? r);
  for (const [slot, ref] of Object.entries(plan.feats)) if (ref && slotLevel(slot) <= level) addName(entryOf(idx, ref) ?? ref);
  const cls = entryOf(idx, plan.class);
  for (const it of [...(cls?.items ?? []), ...(entryOf(idx, plan.ancestry)?.items ?? []), ...(entryOf(idx, plan.background)?.items ?? [])]) {
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
      if ((plan.boosts.levels[1] ?? []).length < 4) out.push({ step: "attributes", level: 1, key: "boosts" });
      if (!(plan.skills.trained ?? []).length) out.push({ step: "skills", level: 1, key: "skills" });
    }
    return out;
  }
  const prog = progression(cls);
  const from = plan.base === "sheet" && plan.sheet ? plan.sheet.level + 1 : 1;
  if (from <= 1) {
    if (!keyAttribute(plan, cls)) out.push({ step: "attributes", level: 1, key: "classKey" });
    if ((plan.boosts.levels[1] ?? []).length < 4) out.push({ step: "attributes", level: 1, key: "boosts" });
    const one = levelOneSkills(plan, idx);
    if ((plan.skills.trained ?? []).length < one.free) out.push({ step: "skills", level: 1, key: "skills" });
  }
  for (let lv = Math.max(from, 1); lv <= Math.min(upTo, MAX_LEVEL); lv++) {
    for (const s of slotsAt(prog, lv)) if (!plan.feats[s.id]) out.push({ step: `level-${lv}`, level: lv, key: s.id });
    if (lv > 1 && prog.skillIncrease.includes(lv) && !plan.skills.increases[lv]) out.push({ step: `level-${lv}`, level: lv, key: "increase" });
    if (prog.boosts.includes(lv) && (plan.boosts.levels[lv] ?? []).length < 4) out.push({ step: `level-${lv}`, level: lv, key: "boosts" });
  }
  return out;
}
