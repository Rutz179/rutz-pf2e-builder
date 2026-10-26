import { ATTRS, MID, attrLabel, setting, t } from "./util.mjs";
import { entryOf, secondClass } from "./rules.mjs";
import { cachedIndex } from "./data.mjs";

/* ======================================================================== *
 * Spells in a plan: how the character casts (tradition, prepared or
 * spontaneous, attribute) and which spells to add at each level — the
 * spellbook or repertoire grows by plan and is put on the sheet with the
 * rest of the level. Focus spells and rituals come from their own features.
 * ======================================================================== */

// Class → [tradition, kind, attribute]; null tradition = chosen by a subclass (bloodline, patron …).
const CASTERS = {
  wizard: ["arcane", "prepared", "int"], magus: ["arcane", "prepared", "int"], witch: [null, "prepared", "int"],
  cleric: ["divine", "prepared", "wis"], druid: ["primal", "prepared", "wis"], animist: ["divine", "prepared", "wis"],
  bard: ["occult", "spontaneous", "cha"], oracle: ["divine", "spontaneous", "cha"], sorcerer: [null, "spontaneous", "cha"],
  psychic: ["occult", "spontaneous", "int"], summoner: [null, "spontaneous", "cha"], necromancer: ["occult", "prepared", "int"]
};
export const TRADITIONS = ["arcane", "divine", "occult", "primal"];

export function traditionLabel(tr) {
  const key = CONFIG.PF2E?.magicTraditions?.[tr];
  return key ? game.i18n.localize(key) : tr;
}
export function kindLabel(kind) {
  return t(`Spells.Kind.${kind}`);
}

/** How a class casts, by its slug: { tradition (null = from a subclass), mode, attr } or null. */
export function castingForClass(slug, flag = null) {
  const d = CASTERS[slug];
  if (d) return { tradition: d[0], mode: d[1], attr: d[2], slug };
  const h = homebrew(slug, flag);
  return h ? { tradition: h.tradition, mode: h.mode, attr: h.attr, slug } : null;
}

/** "마녀(Witch)" → "마녀" in Korean, the name as it is otherwise. */
export function shortClassName(name) {
  const n = String(name ?? "");
  return /[\uAC00-\uD7A3]/.test(n) ? n.replace(/\s*\([^()]*[A-Za-z][^()]*\)\s*$/, "").trim() : n;
}

export function entryName(className, tradition) {
  const cls = shortClassName(className);
  return cls ? t("Spells.EntryName", { cls, tradition: traditionLabel(tradition) }) : t("Spells.EntryNameNoClass", { tradition: traditionLabel(tradition) });
}

/**
 * The class the plan's spells follow: the class, or — dual class — the second class when only it casts.
 * (Both casting: the spell plan follows the first; the second's spellcasting entry and slots are still made.)
 */
export function casterClassOf(plan, idx) {
  const cls = entryOf(idx, plan.class);
  if (cls?.slug && castingForClass(cls.slug, cls.casting)) return cls;
  const cls2 = secondClass(plan, idx);
  if (cls2?.slug && castingForClass(cls2.slug, cls2.casting)) return cls2;
  return cls;
}

export function casterDefaults(plan, idx) {
  const cls = casterClassOf(plan, idx);
  const c = cls?.slug ? castingForClass(cls.slug, cls.casting) : null;
  return c ? { tradition: c.tradition, mode: c.mode, attr: c.attr } : null;
}

export function maxSpellRank(level) {
  return Math.min(10, Math.ceil(level / 2));
}

export function spellsAt(plan, level) {
  return plan.spells?.byLevel?.[level] ?? [];
}

export function plannedUuids(plan) {
  return new Set(Object.values(plan.spells?.byLevel ?? {}).flat().map(r => r?.uuid).filter(Boolean));
}

export function castingSummary(c) {
  if (!c?.tradition) return "";
  return `${traditionLabel(c.tradition)} · ${kindLabel(c.mode)} · ${attrLabel(c.attr)}`;
}

/* ======================================================================== *
 * Class tables (Player Core 1 & 2, Rage of Elements, Howl of the Wild,
 * Secrets of Magic, Dark Archive, Impossible Playtest classes as printed).
 *
 * spellSlotsAt(slug, level)  → spells per day: { cantrips, ranks: [r1 … r10], extra }
 * learnAt(slug, level)  → what the character adds to spellbook/repertoire
 *                         on reaching that level: { mode, cantrips, byRank, any, note }
 *   mode "rep"   spontaneous repertoire — one known spell per slot
 *   mode "book"  spellbook — a start, then 2 spells of any rank per level
 *   mode "list"  prepares from the whole list (cleric, druid, animist)
 * ======================================================================== */

const full = (lo, hi) => (r, L) => (L >= 2 * r ? hi : L >= 2 * r - 1 ? lo : 0);
const TABLE = {
  // cantrips, slots of rank r (1–9), rank 10 at 19/20
  full: { cantrips: 5, slot: full(2, 3), r10: L => (L >= 19 ? 1 : 0) },
  spont: { cantrips: 5, slot: full(3, 4), r10: L => (L >= 19 ? 1 : 0) },
  psychic: { cantrips: 3, slot: full(1, 2), r10: L => (L >= 20 ? 2 : L >= 19 ? 1 : 0) },
  wave: { cantrips: 5, slot: full(1, 2), r10: () => 0 },
  necro: { cantrips: 5, slot: full(1, 2), r10: L => (L >= 19 ? 1 : 0) },
  animist: { cantrips: 2, slot: full(1, 2), r10: () => 0 }
};
const CLASS_TABLE = {
  bard: "full", cleric: "full", druid: "full", witch: "full", wizard: "full",
  oracle: "spont", sorcerer: "spont", psychic: "psychic", magus: "wave", summoner: "wave",
  necromancer: "necro", animist: "animist"
};
// How the class learns: rep (repertoire = slots, minus spells its subclass grants) / book (start + 2 a level) / list.
const LEARN = {
  bard: { mode: "rep" }, oracle: { mode: "rep" }, psychic: { mode: "rep" }, summoner: { mode: "rep" },
  sorcerer: { mode: "rep", granted: 1, grantedCantrips: 1 },
  wizard: { mode: "book", cantrips: 10, first: 5, per: 2, note: "Spells.Learn.WizardNote" },
  magus: { mode: "book", cantrips: 8, first: 5, per: 2 },
  witch: { mode: "book", cantrips: 10, first: 5, per: 2, note: "Spells.Learn.WitchNote" },
  necromancer: { mode: "book", cantrips: 8, first: 4, per: 2, note: "Spells.Learn.NecroNote" },
  cleric: { mode: "list", note: "Spells.Learn.ClericNote" }, druid: { mode: "list" },
  animist: { mode: "list", note: "Spells.Learn.AnimistNote" }
};
const EXTRA = {
  psychic: "Spells.Extra.Psychic", animist: "Spells.Extra.Animist", cleric: "Spells.Extra.Cleric",
  sorcerer: "Spells.Extra.Sorcerer", wizard: "Spells.Extra.Wizard"
};

export function hasTable(slug) {
  return !!(CLASS_TABLE[slug] || homebrew(slug)?.table);
}

export function spellSlotsAt(slug, level) {
  const tb = TABLE[CLASS_TABLE[slug] ?? homebrew(slug)?.table];
  if (!tb || level < 1) return null;
  const ranks = [];
  for (let r = 1; r <= 9; r++) ranks.push(tb.slot(r, level));
  ranks.push(tb.r10(level));
  let cantrips = tb.cantrips;
  if (slug === "animist") cantrips = 2;
  return { cantrips, ranks, extra: EXTRA[slug] ?? null };
}

/* ---------------- table rules for daily slots (GM settings) ---------------- */

/**
 * { classBonus: extra slots on every rank the class has, archetype: slots per rank an archetype's
 *   basic/expert/master spellcasting gives (0 = the builder leaves archetype entries alone), strays }
 */
export function slotRules() {
  const n = (v, max) => Math.max(0, Math.min(max, Math.floor(Number(v) || 0)));
  return {
    classBonus: n(setting("slotClassBonus", 0), 4),
    archetype: n(setting("slotArchetype", "0"), 4),
    strays: setting("slotStrays", true) !== false
  };
}

/** Daily slots as the table plays them: the class table plus the table rule's extra slots per rank. */
export function tableSlotsAt(slug, level) {
  const s = spellSlotsAt(slug, level);
  const { classBonus } = slotRules();
  if (!s || !classBonus) return s;
  return { ...s, ranks: s.ranks.map(n => (n ? n + classBonus : 0)), bonus: classBonus };
}

function learnOf(slug) {
  return LEARN[slug] ?? homebrew(slug)?.learn ?? null;
}

/** Known spells the class has chosen by a level, per rank (index 0 = cantrips). */
function knownTotals(slug, level) {
  const l = learnOf(slug);
  const s = spellSlotsAt(slug, level);
  if (!l || !s || l.mode !== "rep") return null;
  const out = [Math.max(0, s.cantrips - (l.grantedCantrips ?? 0))];
  // Granted spells (sorcerer's bloodline) stop at 9th rank; the 10th-rank slot is one spell to know.
  s.ranks.forEach((n, i) => out.push(i === 9 ? Math.min(1, n) : Math.max(0, n - (n ? (l.granted ?? 0) : 0))));
  return out;
}

/** What to add on reaching a level. byRank[0] = cantrips. */
export function learnAt(slug, level) {
  const l = learnOf(slug);
  if (!l) return null;
  if (l.mode === "list") return { mode: "list", cantrips: 0, byRank: {}, any: 0, note: l.note ?? null };
  if (l.mode === "book") {
    if (level === 1) return { mode: "book", cantrips: l.cantrips, byRank: { 1: l.first }, any: 0, note: l.note ?? null };
    return { mode: "book", cantrips: 0, byRank: {}, any: l.per, note: null };
  }
  const now = knownTotals(slug, level);
  const before = level > 1 ? knownTotals(slug, level - 1) : now.map(() => 0);
  const byRank = {};
  for (let r = 1; r <= 10; r++) if (now[r] > before[r]) byRank[r] = now[r] - before[r];
  return { mode: "rep", cantrips: Math.max(0, now[0] - before[0]), byRank, any: 0, note: level === 1 && l.granted ? "Spells.Learn.SorcNote" : null };
}

/** How many cantrips / ranked spells a level asks for in total. */
export function learnCount(slug, level) {
  const l = learnAt(slug, level);
  if (!l) return null;
  return { cantrips: l.cantrips, spells: Object.values(l.byRank).reduce((a, b) => a + b, 0) + l.any, ...l };
}

/** Is the ref a cantrip (old plans did not record it: look it up). */
export function isCantripRef(ref, idx) {
  if (typeof ref?.cantrip === "boolean") return ref.cantrip;
  return !!idx?.byUuid?.get(ref?.uuid)?.cantrip;
}

/** Short text: "캔트립 5 · 1랭크 2 · 2랭크 1". */
export function slotsText(s, compact = false) {
  if (!s) return "";
  if (compact) {
    const ranks = s.ranks.filter(Boolean);
    return `${t("Spells.Cantrips")} ${s.cantrips}${ranks.length ? ` · ${t("Spells.ByRank")} ${ranks.join("/")}` : ""}`;
  }
  const parts = [`${t("Spells.Cantrips")} ${s.cantrips}`];
  s.ranks.forEach((n, i) => { if (n) parts.push(`${t("Spells.RankN", { rank: i + 1 })} ${n}`); });
  return parts.join(" · ");
}

export function learnText(l) {
  if (!l) return "";
  if (l.mode === "list") return t("Spells.Learn.List");
  const parts = [];
  if (l.cantrips) parts.push(t("Spells.Learn.Cantrips", { n: l.cantrips }));
  for (const [r, n] of Object.entries(l.byRank)) parts.push(t("Spells.Learn.Rank", { rank: r, n }));
  if (l.any) parts.push(t("Spells.Learn.Any", { n: l.any }));
  return parts.join(" · ") || t("Spells.Learn.Nothing");
}

/* ======================================================================== *
 * Homebrew spellcasting classes. The tables above know the printed classes
 * by slug; a homebrew class gets one from
 *  - the GM, in the builder's spells step (world setting "homebrewCasting",
 *    by class slug — works for classes in locked module packs too), or
 *  - its own item: flags["rutz-pf2e-builder"].casting, for homebrew authors:
 *      { "like": "wizard" }                       a printed class's way, or
 *      { "tradition": "arcane" | null, "mode": "prepared" | "spontaneous",
 *        "attr": "int", "slots": "full" | "spont" | "wave" | "psychic" | "necro" | "animist",
 *        "learn": "book" | "rep" | "list", "cantrips": 10, "first": 5, "per": 2 }
 *    ("like" can be combined with any of the others to change just those).
 * The GM's setting wins over the item's flag; the printed classes can't be changed.
 * ======================================================================== */

export const SLOT_TABLES = Object.keys(TABLE);
export const PRINTED_CASTERS = Object.keys(CASTERS);
const MODES = ["prepared", "spontaneous"];
const LEARN_MODES = ["book", "rep", "list"];
const flagSeen = new Map();
let memo = { key: null, idx: null, map: new Map() };

/** The world's own settings for homebrew casters: { [slug]: config }. */
export function homebrewSettings() {
  const v = setting("homebrewCasting", null);
  return v && typeof v === "object" ? v : {};
}

/** A printed class's way of casting, as a config (for "like" and the GM's form). */
export function printedConfig(slug) {
  const d = CASTERS[slug];
  if (!d) return null;
  const l = LEARN[slug] ?? { mode: "list" };
  return { tradition: d[0], mode: d[1], attr: d[2], slots: CLASS_TABLE[slug], learn: l.mode,
    cantrips: l.cantrips ?? 10, first: l.first ?? 5, per: l.per ?? 2 };
}

const num = (v, lo, hi, fb) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : fb; };

/** A config (setting or flag) made whole: { tradition, mode, attr, table, learn: {mode, cantrips, first, per, granted?} } or null. */
export function resolveCasting(raw) {
  if (!raw || typeof raw !== "object") return null;
  const like = raw.like ? printedConfig(String(raw.like).toLowerCase()) : null;
  const base = { ...(like ?? {}), ...Object.fromEntries(Object.entries(raw).filter(([k, v]) => k !== "like" && v !== undefined && v !== "")) };
  const mode = MODES.includes(base.mode) ? base.mode : "prepared";
  const tradition = TRADITIONS.includes(base.tradition) ? base.tradition : null;
  const attr = ATTRS.includes(base.attr) ? base.attr : (mode === "spontaneous" ? "cha" : "int");
  const table = SLOT_TABLES.includes(base.slots) ? base.slots : (mode === "spontaneous" ? "spont" : "full");
  const lm = LEARN_MODES.includes(base.learn) ? base.learn : (mode === "spontaneous" ? "rep" : "book");
  const learn = { mode: lm };
  if (lm === "book") Object.assign(learn, { cantrips: num(base.cantrips, 0, 20, 10), first: num(base.first, 0, 20, 5), per: num(base.per, 0, 10, 2) });
  if (lm === "rep" && like && raw.like === "sorcerer") Object.assign(learn, { granted: 1, grantedCantrips: 1 });
  return { tradition, mode, attr, table, learn };
}

/** The homebrew config of a class slug (null for printed classes and classes without one). */
export function homebrew(slug, flag = null) {
  if (!slug || CASTERS[slug]) return null;
  if (flag && JSON.stringify(flag) !== JSON.stringify(flagSeen.get(slug))) { flagSeen.set(slug, flag); memo.key = null; }
  const set = homebrewSettings();
  const idx = cachedIndex();
  const key = JSON.stringify(set);
  if (memo.key !== key || memo.idx !== idx) memo = { key, idx, map: new Map() };
  if (memo.map.has(slug)) return memo.map.get(slug);
  const raw = set[slug] ?? flagSeen.get(slug) ?? idx?.class?.find(e => e.slug === slug && e.casting)?.casting ?? null;
  const out = resolveCasting(raw);
  memo.map.set(slug, out);
  return out;
}

/** Where a homebrew class's casting comes from: "setting", "flag" or null. */
export function homebrewSource(slug, flag = null) {
  if (!slug || CASTERS[slug]) return null;
  if (homebrewSettings()[slug]) return "setting";
  return homebrew(slug, flag) ? "flag" : null;
}

export async function saveHomebrew(slug, conf) {
  const all = { ...homebrewSettings() };
  if (conf) all[slug] = conf; else delete all[slug];
  memo = { key: null, idx: null, map: new Map() };
  await game.settings.set(MID, "homebrewCasting", all);
}
