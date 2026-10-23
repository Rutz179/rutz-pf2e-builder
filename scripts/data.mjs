import { MID, setting, sluggify } from "./util.mjs";
import { deityAlignment } from "./deity-alignment.mjs";

/* ======================================================================== *
 * Compendium data: an index of every ancestry, heritage, background, class
 * and feat the world can use, read once (on first use) from the item packs,
 * and full documents fetched only when a choice is looked at.
 *
 * Nothing is hard-coded: system packs, the Starfinder/anachronism packs and
 * homebrew packs all work, and the translation module's names come through
 * because the index and documents are read the normal way. Homebrew made
 * right in the world's Items tab is read too (setting "worldItems", in the
 * compendium chooser): all of it, only what players may see (Limited or
 * better; the GM always sees all), or none.
 * ======================================================================== */

const TYPES = new Set(["ancestry", "heritage", "background", "class", "feat", "deity"]);
const FIELDS = [
  "img", "system.slug", "system.level.value", "system.category", "system.traits.value", "system.traits.rarity",
  "system.prerequisites.value", "system.maxTakable", "system.actionType.value", "system.actions.value",
  "system.ancestry", "system.publication.title", "system.publication.remaster", "system.hp",
  "system.keyAbility.value", "system.boosts", "system.flaws", "system.trainedSkills", "system.onlyLevel1",
  "system.items", "system.ancestryFeatLevels", "system.classFeatLevels", "system.skillFeatLevels",
  "system.generalFeatLevels", "system.skillIncreaseLevels", "system.perception", "system.savingThrows",
  "system.alignment", "flags.rutz-pf2e-builder.alignment", "flags.rutz-pf2e-builder.casting", "_stats.compendiumSource"
];
// Packs worth indexing when no explicit list is set: their names say what they hold.
const AUTO_PACK = /(feat|ancestr|heritage|background|class|archetype|deit)/i;
const SKIP_PACK = /(class-?features?|ancestry-?features?|effects?|bestiary|equipment|spells?|journals?|macros?|tables?|hazards?|actions?)$/i;

let index = null;
let loading = null;
const docs = new Map();

/** Packs the GM switched off in PF2e's compendium browser settings (any tab). */
export function browserOff(pack) {
  try {
    const conf = game.settings.get(game.system.id, "compendiumBrowserPacks") ?? {};
    return Object.values(conf).some(tab => tab?.[pack.collection]?.load === false);
  } catch (_) {
    return false;
  }
}

/** A module that translates the system (its packs stand in for the system's). */
export function translationPackage(id) {
  const mod = game.modules.get(id);
  const text = `${id} ${mod?.title ?? ""}`;
  return /translat|번역|한글|korean|babele|(^|[-_ ])(ko|kr)([-_ ]|$)/i.test(text) || [...(mod?.relationships?.requires ?? [])].some(r => r?.id === "babele");
}

/** A system pack that a translation module mirrors (same pack name, a translation package). */
export function mirroredSystemPack(pack, all) {
  return pack.metadata.packageType === "system"
    && all.some(p => p !== pack && p.metadata.packageType !== "system" && p.metadata.name === pack.metadata.name && translationPackage(packageOf(p)));
}

/* ---------------- which packs ---------------- */

// Modules for companions (animal companions, eidolons, familiars …): their "ancestries" and "classes" are not for player characters.
const COMPANION = /companion|eidolon|familiar|minion|animal-?compan|동료|아이돌론|퍼밀리어|사역마/i;

function packageOf(pack) {
  return pack.metadata.packageName ?? pack.metadata.package ?? pack.metadata.system ?? "";
}

/** A pack from a companion module (Companion Compendia and the like). */
export function companionPack(pack) {
  if (pack.metadata.packageType === "system") return false;
  const pkg = packageOf(pack);
  const mod = game.modules.get(pkg);
  return COMPANION.test(`${pkg} ${mod?.title ?? ""} ${pack.metadata.name} ${pack.metadata.label ?? pack.title ?? ""}`);
}

/** The GM's own picks in "컴펜디움 고르기": { include: [collection], exclude: [collection] }. */
export function packRules() {
  const r = setting("packRules", null) ?? {};
  return { include: Array.isArray(r.include) ? r.include : [], exclude: Array.isArray(r.exclude) ? r.exclude : [] };
}

/** What the builder would read on its own (no picks), and why a pack is left out. */
export function autoPackState(pack, all = game.packs.filter(p => p.documentName === "Item")) {
  if (pack.documentName !== "Item") return { use: false, why: "type" };
  if (!AUTO_PACK.test(pack.metadata.name) || SKIP_PACK.test(pack.metadata.name)) return { use: false, why: "name" };
  if (companionPack(pack)) return { use: false, why: "companion" };
  if (browserOff(pack)) return { use: false, why: "browser" };
  if (mirroredSystemPack(pack, all)) return { use: false, why: "mirror" };
  const auto = all.filter(p => AUTO_PACK.test(p.metadata.name) && !SKIP_PACK.test(p.metadata.name));
  const systemOff = auto.some(p => p.metadata.packageType === "system" && /feat/i.test(p.metadata.name) && browserOff(p));
  if (systemOff && pack.metadata.packageType === "system") return { use: false, why: "system" };
  return { use: true, why: "" };
}

export function packList() {
  const custom = String(setting("packs", "") ?? "").split(/[,\s]+/).filter(Boolean);
  const all = game.packs.filter(p => p.documentName === "Item");
  if (custom.length) return all.filter(p => custom.includes(p.collection));
  const { include, exclude } = packRules();
  return all.filter(p => !SPELL_PACK(p) && !exclude.includes(p.collection) && (include.includes(p.collection) || autoPackState(p, all).use));
}

/**
 * Packs PF2e's own choice windows ("고르세요" after adding a class, a feat …) may list from:
 * PF2e looks in every Item pack; this leaves out the packs switched off in the
 * compendium browser and the system packs a translation module mirrors.
 */
export function queryPackAllowed(pack, all = game.packs.filter(p => p.documentName === "Item")) {
  return !browserOff(pack) && !mirroredSystemPack(pack, all);
}

/** Companion "ancestries" and "classes" that slipped into a normal pack. */
function companionEntry(e) {
  if (!["ancestry", "heritage", "class"].includes(e.type)) return false;
  const traits = e.system?.traits?.value ?? [];
  return traits.some(t => ["minion", "eidolon", "companion"].includes(t))
    || ["animal-companion", "eidolon", "familiar", "construct-companion"].includes(e.system?.slug);
}

/** "가디언(Guardian)" → "Guardian": translation packs often keep the English name in brackets. */
function bracketName(name) {
  const m = /\(([^()]*[A-Za-z][^()]*)\)\s*$/.exec(String(name ?? ""));
  return m ? m[1].trim() : "";
}

export function originalName(e) {
  return e.originalName ?? e.flags?.babele?.originalName ?? e.translated?.name ?? bracketName(e.name) ?? "";
}

function normalize(e, pack) {
  const s = e.system ?? {};
  const original = originalName(e);
  const prereqs = (s.prerequisites?.value ?? []).map(p => (typeof p === "string" ? p : p?.value)).filter(Boolean);
  return {
    uuid: e.uuid ?? `Compendium.${pack.collection}.Item.${e._id}`,
    id: e._id,
    type: e.type,
    deityAlignment: deityAlignment(e),
    name: e.name,
    original: original && original !== e.name ? original : "",
    img: e.img,
    slug: s.slug || sluggify(original || e.name),
    level: Number(s.level?.value ?? 0) || 0,
    category: s.category ?? null,
    traits: Array.isArray(s.traits?.value) ? s.traits.value : [],
    rarity: s.traits?.rarity ?? "common",
    prereqs,
    maxTakable: s.maxTakable === null ? Infinity : Number(s.maxTakable ?? 1) || 1,
    action: s.actionType?.value === "action" ? (s.actions?.value ?? 1) : (s.actionType?.value ?? null),
    ancestrySlug: e.type === "heritage" ? (s.ancestry?.slug ?? null) : null,
    source: s.publication?.title ?? "",
    remaster: s.publication?.remaster ?? true,
    hp: s.hp ?? null,
    keyAbility: s.keyAbility?.value ?? null,
    boosts: s.boosts ?? null,
    flaws: s.flaws ?? null,
    trained: s.trainedSkills ?? null,
    onlyLevel1: !!s.onlyLevel1,
    items: e.type === "feat" ? [] : Object.values(s.items ?? {}).filter(i => i?.uuid).map(i => ({ uuid: i.uuid, name: i.name, img: i.img, level: Number(i.level ?? 1) || 1 })),
    levels: e.type === "class" ? {
      ancestry: s.ancestryFeatLevels?.value ?? null, class: s.classFeatLevels?.value ?? null,
      skill: s.skillFeatLevels?.value ?? null, general: s.generalFeatLevels?.value ?? null,
      skillIncrease: s.skillIncreaseLevels?.value ?? null
    } : null,
    perception: s.perception ?? null,
    saves: s.savingThrows ?? null,
    casting: e.type === "class" ? (e.flags?.[MID]?.casting ?? null) : null,
    pack: pack.collection,
    search: `${e.name} ${original}`.toLowerCase()
  };
}

/* ---------------- the world's own Items tab (homebrew made in the world) ---------------- */

export const WORLD = "world-items";
const WORLD_PACK = { collection: WORLD };

/** "all" · "visible" (players: only items they may see) · "off". */
export function worldItemsMode() {
  const v = setting("worldItems", "all");
  return ["all", "visible", "off"].includes(v) ? v : "all";
}

/** Items in the world's Items tab (not inside an actor) of these types, as the setting allows. */
function worldItems(types) {
  const mode = worldItemsMode();
  if (mode === "off") return [];
  const out = [];
  for (const item of game.items ?? []) {
    if (!types.has(item.type)) continue;
    if (mode === "visible" && !game.user.isGM && !item.testUserPermission?.(game.user, "LIMITED")) continue;
    out.push({ ...item.toObject(), uuid: item.uuid });
  }
  return out;
}

/** A world item the lists show changed: read the lists again next time (and drop its cached document). */
export function worldItemChanged(item) {
  if (item?.parent || !(TYPES.has(item?.type) || item?.type === "spell")) return false;
  docs.delete(item.uuid);
  if (worldItemsMode() === "off") return false;
  invalidateIndex();
  return true;
}

/** Everything, by type. First call reads the packs (a second or two); later calls are instant. */
export async function loadIndex({ force = false } = {}) {
  if (index && !force) return index;
  if (loading && !force) return loading;
  loading = (async () => {
    const out = { ancestry: [], heritage: [], background: [], class: [], feat: [], deity: [] };
    const seen = new Set();
    for (const pack of packList()) {
      let idx;
      try { idx = await pack.getIndex({ fields: FIELDS }); } catch (err) { console.warn(`${MID} | index ${pack.collection}`, err); continue; }
      for (const e of idx) {
        if (!TYPES.has(e.type) || companionEntry(e)) continue;
        const n = normalize(e, pack);
        if (seen.has(n.uuid)) continue;
        seen.add(n.uuid);
        out[n.type].push(n);
      }
    }
    for (const e of worldItems(TYPES)) {
      if (companionEntry(e)) continue;
      const n = normalize(e, WORLD_PACK);
      if (seen.has(n.uuid)) continue;
      seen.add(n.uuid);
      out[n.type].push(n);
    }
    const lang = game.i18n.lang;
    for (const list of Object.values(out)) list.sort((a, b) => a.name.localeCompare(b.name, lang));
    out.byUuid = new Map(Object.values(out).flat().map(e => [e.uuid, e]));
    out.featNames = new Map();
    for (const f of out.feat) {
      out.featNames.set(norm(f.name), f);
      if (f.original) out.featNames.set(norm(f.original), f);
    }
    index = out;
    loading = null;
    return out;
  })();
  return loading;
}

/* ---------------- spells (read only when the spell parts are used) ---------------- */

const SPELL_FIELDS = ["img", "system.slug", "system.level.value", "system.traits.value", "system.traits.traditions", "system.traits.rarity",
  "system.publication.title", "system.publication.remaster", "system.time.value"];
let spellLoading = null;

const SPELL_PACK = p => /spell/i.test(p.metadata.name) && !/effect/i.test(p.metadata.name);

/** Like autoPackState, for the packs spells are read from. */
export function autoSpellState(pack, all = game.packs.filter(p => p.documentName === "Item")) {
  if (pack.documentName !== "Item" || !SPELL_PACK(pack)) return { use: false, why: "name" };
  if (companionPack(pack)) return { use: false, why: "companion" };
  if (browserOff(pack)) return { use: false, why: "browser" };
  if (mirroredSystemPack(pack, all)) return { use: false, why: "mirror" };
  const auto = all.filter(SPELL_PACK);
  const systemOff = auto.some(p => p.metadata.packageType === "system" && browserOff(p));
  if (systemOff && pack.metadata.packageType === "system" && auto.some(q => q.metadata.packageType !== "system")) return { use: false, why: "system" };
  return { use: true, why: "" };
}

export function isSpellPack(pack) {
  return SPELL_PACK(pack);
}

export function spellPackList() {
  const all = game.packs.filter(p => p.documentName === "Item");
  const custom = String(setting("spellPacks", "") ?? "").split(/[,\s]+/).filter(Boolean);
  if (custom.length) return all.filter(p => custom.includes(p.collection));
  const { include, exclude } = packRules();
  return all.filter(p => SPELL_PACK(p) && !exclude.includes(p.collection) && (include.includes(p.collection) || autoSpellState(p, all).use));
}

export async function loadSpells() {
  const idx = await loadIndex();
  if (idx.spell) return idx.spell;
  spellLoading ??= (async () => {
    const out = [];
    const sources = spellPackList().map(pack => ({ pack, list: null }));
    sources.push({ pack: WORLD_PACK, list: worldItems(new Set(["spell"])) });
    for (const src of sources) {
      const pack = src.pack;
      let list = src.list;
      if (!list) { try { list = await pack.getIndex({ fields: SPELL_FIELDS }); } catch (_) { continue; } }
      for (const e of list) {
        if (e.type !== "spell") continue;
        const sys = e.system ?? {};
        const traits = Array.isArray(sys.traits?.value) ? sys.traits.value : [];
        if (traits.includes("focus") || traits.includes("ritual")) continue;
        const original = originalName(e);
        const entry = {
          uuid: e.uuid ?? `Compendium.${pack.collection}.Item.${e._id}`, id: e._id, type: "spell", name: e.name,
          original: original && original !== e.name ? original : "", img: e.img, slug: sys.slug || sluggify(original || e.name),
          level: Number(sys.level?.value ?? 1) || 1, cantrip: traits.includes("cantrip"), traits,
          traditions: Array.isArray(sys.traits?.traditions) ? sys.traits.traditions : [],
          rarity: sys.traits?.rarity ?? "common", remaster: sys.publication?.remaster ?? true, source: sys.publication?.title ?? "",
          action: /^[123]$/.test(String(sys.time?.value ?? "")) ? Number(sys.time.value) : (sys.time?.value === "reaction" ? "reaction" : null),
          prereqs: [], search: `${e.name} ${original}`.toLowerCase(), pack: pack.collection
        };
        out.push(entry);
        idx.byUuid.set(entry.uuid, entry);
      }
    }
    out.sort((a, b) => a.level - b.level || a.name.localeCompare(b.name, game.i18n.lang));
    idx.spell = out;
    return out;
  })();
  return spellLoading;
}

export function cachedIndex() {
  return index;
}

export function norm(text) {
  return String(text ?? "").toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, " ").trim();
}

/** Full document (cached). */
/** Full document (cached) — from a translated mirror pack when there is one. */
export async function getDoc(uuid) {
  if (!uuid) return null;
  if (docs.has(uuid)) return docs.get(uuid);
  let doc = null;
  try { doc = await fromUuid(uuid); } catch (_) { doc = null; }
  try { doc = (await mirrored(uuid, doc)) ?? doc; } catch (_) { /* keep the original */ }
  docs.set(uuid, doc);
  return doc;
}

async function mirrored(uuid, original) {
  const m = /^Compendium\.([^.]+)\.([^.]+)\.Item\.(.+)$/.exec(uuid);
  if (!m || m[1] !== game.system.id) return null;
  const mirror = game.packs.find(p => p.metadata.name === m[2] && p.metadata.packageType !== "system" && p.documentName === "Item");
  if (!mirror) return null;
  const idx = await mirror.getIndex();
  if (idx.get(m[3])) return mirror.getDocument(m[3]);
  if (!original) return null;
  const want = `(${original.name})`.toLowerCase();
  const hit = idx.find(e => String(e.name).toLowerCase().endsWith(want));
  return hit ? mirror.getDocument(hit._id) : null;
}

export function peekDoc(uuid) {
  return docs.get(uuid) ?? null;
}

/** A small reference stored in plans: enough to show and to fetch again. */
export function refOf(entry) {
  if (!entry) return null;
  const ref = { uuid: entry.uuid, name: entry.name, img: entry.img, slug: entry.slug, level: entry.level ?? 0 };
  if (entry.type === "spell") ref.cantrip = !!entry.cantrip;
  return ref;
}

export function invalidateIndex() {
  index = null;
  loading = null;
  spellLoading = null;
}
