import { MID, sourceIdOf, t } from "./util.mjs";
import { getDoc } from "./data.mjs";
import { decodeChoiceKey } from "./plan.mjs";
import { dualActive, firstClassItem, secondClassItem } from "./dualclass.mjs";
import { castingForClass, entryName, maxSpellRank, shortClassName, slotRules, tableSlotsAt, traditionLabel } from "./spells.mjs";

/* ======================================================================== *
 * Spells a class gives by itself, read from its features on the sheet.
 *
 * PF2e grants the class features (and the subclass picked in them — muse,
 * bloodline, order, mystery …) but not their spells: those are only links in
 * the feature text ("You learn the Counter Performance composition spell",
 * "Bloodline Spells initial: …", "Granted Spells cantrip: …; 1st: …",
 * "Muse Spell …", "Order Spell …"). The English text is read (a translation's
 * mirror keeps the same ids, so its English original is one lookup away) and
 * the spells are put in the right place:
 *
 *   focus spells and class cantrips without a tradition → a focus entry
 *   (PF2e then counts the focus pool itself); the rest → the class's
 *   spellcasting entry, cantrips and ranks the character can cast.
 * ======================================================================== */

const LINK = /@UUID\[(Compendium\.[^\]]+\.Item\.[A-Za-z0-9]{16})\]/g;
// Words right before a link that make it a starting focus spell.
const FOCUS_BEFORE = /(?:\binitial:?|Initial (?:School|Lesson) Spell|Order Spell|Vessel Spell|Hex Cantrip|\blearn the)\s*$/i;
// "You gain the … hex cantrip / focus spell": a focus spell only if the spell itself is one (checked later).
const MAYBE_FOCUS_BEFORE = /\bgain the\s*$/i;
// "your familiar learns …", "add … to your repertoire": an ordinary spell the class knows.
const MAIN_BEFORE = /(?:familiar learns|familiar also learns|add|adds)\s*$/i;
// Lists of spells the class adds to its repertoire / spellbook.
const LIST_LABEL = /(Granted Spells|Sorcerous Gifts|Additional Curriculum|Sin Spells|Apparition Spells|Muse Spell|Mystery Spells?|Patron Spells?)/g;
const RANK_MARK = /(cantrips?|(\d+)(?:st|nd|rd|th))\s*:?\s*$/i;
const STOP = /(Bloodline Spells|Revelation Spells|Order Spell|Vessel Spell|Initial School Spell|Anathema|Bloodline Skills?|Spell List|Tradition|Blood Magic|Muse Feat)/;

/** English text of an item: the system original of a translated mirror, else its own. */
async function englishText(item) {
  const own = item.system?.description?.value ?? "";
  const src = sourceIdOf(item) ?? "";
  const m = /^Compendium\.([^.]+)\.([^.]+)\.Item\.(.+)$/.exec(src);
  if (m && m[1] !== "pf2e" && m[1] !== game.system.id) {
    try {
      const original = await fromUuid(`Compendium.${game.system.id}.${m[2]}.Item.${m[3]}`);
      if (original?.system?.description?.value) return original.system.description.value;
    } catch (_) { /* keep the own text */ }
  }
  return own;
}

const plain = html => String(html ?? "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ");

/** Spell links in a feature text: { uuid, focus: bool, rank: number|null }. */
export function spellLinks(html) {
  const text = plain(html);
  const out = [];
  const seen = new Set();
  // Starting focus spells: a link with the right words before it.
  for (const m of text.matchAll(LINK)) {
    const before = text.slice(Math.max(0, m.index - 60), m.index).replace(/@UUID\[[^\]]+\](\{[^}]*\})?/g, "#");
    if (FOCUS_BEFORE.test(before)) { out.push({ uuid: m[1], focus: true, rank: null }); seen.add(m[1]); }
    else if (MAYBE_FOCUS_BEFORE.test(before)) { out.push({ uuid: m[1], focus: "maybe", rank: null }); seen.add(m[1]); }
    else if (MAIN_BEFORE.test(before)) { out.push({ uuid: m[1], focus: false, rank: null }); seen.add(m[1]); }
  }
  // Spell lists: from the label to the next heading-like word; ranks from "cantrip:", "1st:", "2nd:" …
  const firstOf = new Set();
  for (const m of text.matchAll(LIST_LABEL)) {
    if (firstOf.has(m[1])) continue; // later copies are variants (e.g. a draconic bloodline's other traditions)
    firstOf.add(m[1]);
    const start = m.index + m[0].length;
    const rest = text.slice(start);
    const stop = rest.search(STOP);
    const seg = stop >= 0 ? rest.slice(0, stop) : rest;
    let last = 0;
    let rank = null;
    for (const l of seg.matchAll(LINK)) {
      const between = seg.slice(last, l.index);
      const r = RANK_MARK.exec(between.trim());
      if (r) rank = /^cantrip/i.test(r[1]) ? 0 : Number(r[2]);
      last = l.index + l[0].length;
      if (seen.has(l[1])) continue;
      seen.add(l[1]);
      out.push({ uuid: l[1], focus: false, rank });
    }
  }
  return out;
}

/** English text of a document from a pack (mirror → system original by id). */
async function englishOfDoc(doc) {
  if (!doc) return "";
  return englishText({ system: doc.system, _stats: { compendiumSource: sourceIdOf(doc) ?? doc.uuid } });
}

/** Sort spell links of some documents into focus spells and ordinary ones. */
export async function spellsFromDocs(docs, level) {
  const focus = new Map();
  const main = new Map();
  let tradition = null;
  const maxRank = maxSpellRank(level);
  for (const d of docs) {
    const html = d.__english ?? await englishOfDoc(d);
    tradition ??= (/(?:Spell List|Tradition)\s+(arcane|divine|occult|primal)\b/i.exec(plain(html))?.[1] ?? null)?.toLowerCase() ?? null;
    for (const link of spellLinks(html)) {
      const doc = await getDoc(link.uuid);
      if (!doc || doc.type !== "spell") continue;
      const traits = doc.system?.traits?.value ?? [];
      const traditions = doc.system?.traits?.traditions ?? [];
      const isCantrip = traits.includes("cantrip");
      const focusLike = traits.includes("focus") || (!traditions.length && (traits.includes("composition") || traits.includes("hex") || isCantrip));
      if (link.focus === "maybe" && !focusLike) continue;
      const isFocus = link.focus === true || focusLike;
      const rank = isCantrip ? 0 : (link.rank ?? Number(doc.system?.level?.value ?? 1));
      if (isFocus) focus.set(doc.uuid, doc);
      else if (rank <= maxRank) main.set(doc.uuid, doc);
    }
  }
  return { focus: [...focus.values()], main: [...main.values()], tradition };
}

/* ---------------- whose spells: the class's, not an archetype's ---------------- */

// An archetype's features (Psychic Dedication → a conscious mind, Sorcerer Dedication → a bloodline …) list
// the spells of *that* class. They go to the archetype's own spellcasting, by its own rules (one spell per
// archetype slot), never into the class's repertoire.
const ARCHETYPE_TRAITS = new Set(["archetype", "dedication", "multiclass"]);

function classTraitSet() {
  return new Set(Object.keys(CONFIG.PF2E?.classTraits ?? {}));
}

/** Another class's feat or feature (its class trait, not one of ours) or an archetype's. */
function foreignTraits(traits, ownSlugs, classTraits) {
  if (traits.some(tr => ARCHETYPE_TRAITS.has(tr))) return true;
  return traits.some(tr => classTraits.has(tr)) && !traits.some(tr => ownSlugs.has(tr));
}

/** A feat or class feature on the sheet that belongs to the character's own class (up the "granted by" chain). */
export function fromOwnClass(item, actor, ownSlugs, classTraits = classTraitSet()) {
  const seen = new Set();
  let cur = item;
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    if (cur.type === "class") return ownSlugs.has(cur.slug ?? cur.system?.slug);
    if (foreignTraits(cur.system?.traits?.value ?? [], ownSlugs, classTraits)) return false;
    const by = cur.flags?.pf2e?.grantedBy?.id ?? null;
    cur = by ? actor.items?.get?.(by) ?? null : null;
  }
  return true;
}

function ownClassSlugs(actor) {
  return new Set([firstClassItem(actor), secondClassItem(actor)].filter(Boolean).map(c => c.slug ?? c.system?.slug).filter(Boolean));
}

/** The class's own spells for a character at a level: { focus: [doc], main: [doc], tradition }. */
export async function classSpellsOf(actor, level) {
  const own = ownClassSlugs(actor);
  const classTraits = classTraitSet();
  const feats = (actor.itemTypes?.feat ?? []).filter(f => ((Number(f.system?.level?.value ?? 1) || 1) <= level || f.system?.location)
    && (!own.size || fromOwnClass(f, actor, own, classTraits)));
  const docs = [];
  for (const f of feats) docs.push({ system: f.system, __english: await englishText(f), uuid: f.uuid });
  return spellsFromDocs(docs, level);
}

/**
 * The same for a plan (before the character exists): class features up to the level, what was chosen in
 * their questions (muse, patron, bloodline …) and the planned feats.
 */
export async function planSpells(plan, idx, level) {
  const docs = [];
  const cls = plan.class ? await getDoc(plan.class.uuid) : null;
  const cls2 = plan.class2 && dualActive() ? await getDoc(plan.class2.uuid) : null;
  const own = new Set([cls, cls2].map(c => c?.system?.slug ?? c?.slug).filter(Boolean));
  const classTraits = classTraitSet();
  const foreign = d => own.size > 0 && foreignTraits(d?.system?.traits?.value ?? [], own, classTraits);
  for (const it of [...Object.values(cls?.system?.items ?? {}), ...Object.values(cls2?.system?.items ?? {})]) {
    if ((Number(it?.level ?? 1) || 1) > level || !it?.uuid) continue;
    const d = await getDoc(it.uuid);
    if (d) docs.push(d);
  }
  for (const [key, picks] of Object.entries(plan.choices ?? {})) {
    // Answers given inside an archetype's feat (Psychic Dedication's conscious mind …) are the archetype's.
    const owner = await getDoc(decodeChoiceKey(key));
    if (owner && foreign(owner)) continue;
    for (const [k, v] of Object.entries(picks ?? {})) {
      if (k === "_slug" || typeof v !== "string" || !/^Compendium\./.test(v)) continue;
      const d = await getDoc(v);
      if (d && d.type !== "spell" && !foreign(d)) docs.push(d);
    }
  }
  for (const [slot, ref] of Object.entries(plan.feats ?? {})) {
    if (!ref || Number(slot.split("-").pop()) > level) continue;
    const d = await getDoc(ref.uuid);
    if (d && !foreign(d)) docs.push(d);
  }
  void idx;
  return spellsFromDocs(docs, level);
}

/* ---------------- which spellcasting entry is the class's ---------------- */

const ARCHETYPE_WORDS = /archetype|dedication|multiclass|아키타입|헌신|다중\s*클래스/i;

function words(text) {
  const n = String(text ?? "");
  const out = [shortClassName(n)];
  const m = /\(([^()]*[A-Za-z][^()]*)\)\s*$/.exec(n);
  if (m) out.push(m[1].trim());
  return out.filter(w => w && w.length >= 2).map(w => w.toLowerCase());
}

/** Does an entry's name carry this word (Latin words as whole words)? */
function named(name, word) {
  if (/^[a-z]/i.test(word)) return new RegExp(`(^|[^a-z])${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z]|$)`, "i").test(name);
  return name.includes(word);
}

/** Other classes' names (slug and translated), for entries like "Archetype Psychic" / "사이킥 아키타입 주문". */
function otherClassWords(ownSlugs) {
  const out = [];
  for (const [slug, label] of Object.entries(CONFIG.PF2E?.classTraits ?? {})) {
    if (ownSlugs.has(slug)) continue;
    out.push(slug.toLowerCase());
    const loc = game.i18n?.localize?.(label) ?? "";
    if (loc && loc !== label && loc.length >= 2) out.push(loc.toLowerCase());
  }
  return out;
}

/**
 * The class's spellcasting entry of a kind (and tradition). An entry the builder made wins, then one named
 * after the class; one named for an archetype or another class ("Archetype Psychic") is never the class's —
 * except focus entries, which every source shares.
 */
export function classEntryOf(actor, mode, tradition = null, className = "", ownSlugs = ownClassSlugs(actor)) {
  const list = (actor.itemTypes?.spellcastingEntry ?? []).filter(e => e.system?.prepared?.value === mode && (!tradition || e.system?.tradition?.value === tradition));
  if (!list.length) return null;
  const mine = [...words(className), ...[...ownSlugs].map(s => s.toLowerCase())];
  const others = otherClassWords(ownSlugs);
  const score = e => {
    const name = String(e.name ?? "").toLowerCase();
    let n = 0;
    if (e.flags?.[MID]?.classEntry) n += 8;
    if (mine.some(w => named(name, w))) n += 4;
    if (mode === "focus") return n; // "헌신 주문" is also the champion's devotion spells: names only add here
    if (ARCHETYPE_WORDS.test(name)) n -= 6;
    if (others.some(w => named(name, w))) n -= 6;
    return n;
  };
  const ranked = list.map(e => [e, score(e)]).sort((a, b) => b[1] - a[1]);
  if (mode === "focus") return ranked[0][0];
  const best = ranked.find(([e, n]) => n >= 0 || e.flags?.[MID]?.classEntry);
  return best?.[0] ?? null;
}

function entryOfKind(actor, mode, tradition, className = "") {
  return classEntryOf(actor, mode, tradition, className);
}

/**
 * Make sure a new caster has its spellcasting entry (even before any spell is
 * planned) and the spells its class gives. Returns lines for the summary.
 */
export async function placeClassSpells(actor, casting, level, className = "") {
  const done = [];
  let found;
  try { found = await classSpellsOf(actor, level); } catch (err) { console.warn(`${MID} | class spells`, err); return done; }
  const c = { ...(casting ?? {}) };
  c.tradition ??= found.tradition;
  const have = new Set((actor.itemTypes.spell ?? []).flatMap(s => [sourceIdOf(s), s.system?.slug].filter(Boolean)));
  const add = async (entry, docs) => {
    const sources = [];
    for (const doc of docs) {
      if (have.has(doc.uuid) || (doc.system?.slug && have.has(doc.system.slug))) continue;
      have.add(doc.uuid);
      const src = doc.toObject();
      delete src._id;
      src._stats = { ...(src._stats ?? {}), compendiumSource: doc.uuid };
      src.system.location = { ...(src.system.location ?? {}), value: entry.id };
      sources.push(src);
    }
    if (!sources.length) return;
    const made = await actor.createEmbeddedDocuments("Item", sources);
    done.push(...made.map(m => m.name));
  };
  if (c.tradition && c.mode) {
    let entry = entryOfKind(actor, c.mode, c.tradition, className);
    if (!entry) {
      [entry] = await actor.createEmbeddedDocuments("Item", [{
        type: "spellcastingEntry", name: entryName(className, c.tradition),
        system: { tradition: { value: c.tradition }, prepared: { value: c.mode }, ability: { value: c.attr ?? "cha" }, proficiency: { value: 1 } },
        flags: { [MID]: { classEntry: c.slug ?? true } }
      }]);
      done.push(t("Spells.EntryMade"));
    }
    await add(entry, found.main);
    // Spells per day from the class table (plus the table rule's extra slots, if any).
    const slots = tableSlotsAt(c.slug, level);
    if (slots) {
      const upd = { "system.slots.slot0.max": slots.cantrips };
      if (c.mode === "spontaneous") upd["system.slots.slot0.value"] = slots.cantrips;
      slots.ranks.forEach((n, i) => {
        const cur = Number(entry.system?.slots?.[`slot${i + 1}`]?.max ?? 0);
        if (n <= cur) return;
        upd[`system.slots.slot${i + 1}.max`] = n;
        if (c.mode === "spontaneous") upd[`system.slots.slot${i + 1}.value`] = n;
      });
      if (Object.keys(upd).length > 1 || Number(entry.system?.slots?.slot0?.max ?? 0) !== slots.cantrips) {
        await entry.update(upd);
        done.push(t("Spells.SlotsSet"));
      }
    }
  }
  if (found.focus.length) {
    const trad = c.tradition ?? found.focus.map(d => d.system?.traits?.traditions?.[0]).find(Boolean) ?? "occult";
    let entry = entryOfKind(actor, "focus", null, className);
    if (!entry) {
      [entry] = await actor.createEmbeddedDocuments("Item", [{
        type: "spellcastingEntry", name: t("Spells.FocusEntryName", { name: shortClassName(className) || traditionLabel(trad) }),
        system: { tradition: { value: trad }, prepared: { value: "focus" }, ability: { value: c.attr ?? "cha" }, proficiency: { value: 1 } }
      }]);
      done.push(t("Spells.FocusEntryMade"));
    }
    await add(entry, found.focus);
    // PF2e works out the pool from the focus spells; start it full.
    const max = Number(actor.system?.resources?.focus?.max ?? 0);
    if (max > 0) await actor.update({ "system.resources.focus.value": max }, { rpbApply: true });
  }
  return done;
}

/* ---------------- archetype spellcasting slots (table rule) ---------------- */

// Basic / expert / master spellcasting benefits: the rank each step opens, and at what level.
const ARCH_STEPS = { basic: [[1, 4], [2, 6], [3, 8]], expert: [[4, 12], [5, 14], [6, 16]], master: [[7, 18], [8, 20]] };

/** "Basic Psychic Spellcasting" (its slug, English original or "(English)" in a translated name) → { step, key }. */
function archetypeStep(f) {
  const bracket = /\(([^()]*[A-Za-z][^()]*)\)\s*$/.exec(String(f.name ?? ""))?.[1];
  for (const c of [f.system?.slug, f.slug, f.flags?.["PF2e-KR"]?.originalName, bracket, f.name]) {
    const s = String(c ?? "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const m = /^(basic|expert|master)-(.+)-spellcasting$/.exec(s);
    if (m) return { step: m[1], key: m[2] };
  }
  return null;
}

/** Archetype spellcasting on the sheet: Map(key → Set of slot ranks it has opened by now). */
function archetypeCasting(actor) {
  const out = new Map();
  for (const f of actor.itemTypes?.feat ?? []) {
    const a = archetypeStep(f);
    if (!a) continue;
    const ranks = out.get(a.key) ?? new Set();
    for (const [rank, lv] of ARCH_STEPS[a.step]) if ((actor.level ?? 0) >= lv) ranks.add(rank);
    out.set(a.key, ranks);
  }
  return out;
}

/** The archetype's own entry: named after it ("Archetype Psychic", "사이킥 …"), else the one archetype-named entry of its tradition. */
function archetypeEntryOf(actor, key) {
  const entries = (actor.itemTypes?.spellcastingEntry ?? []).filter(e => ["prepared", "spontaneous"].includes(e.system?.prepared?.value) && !e.flags?.[MID]?.classEntry);
  const label = CONFIG.PF2E?.classTraits?.[key];
  const loc = label ? String(game.i18n?.localize?.(label) ?? "").toLowerCase() : "";
  const keys = [key.replace(/-/g, " "), key, loc].filter(w => w && w.length >= 2);
  const byName = entries.filter(e => keys.some(w => named(String(e.name ?? "").toLowerCase(), w)));
  if (byName.length) return byName.find(e => ARCHETYPE_WORDS.test(e.name ?? "")) ?? byName[0];
  const trad = castingForClass(key)?.tradition ?? null;
  const arch = entries.filter(e => ARCHETYPE_WORDS.test(e.name ?? "") && (!trad || e.system?.tradition?.value === trad));
  return arch.length === 1 ? arch[0] : null;
}

/**
 * Table rule "archetype slots per rank": each rank an archetype's spellcasting feats have opened gets that
 * many slots in the archetype's entry. Raised only, never lowered (a hand-set number stays).
 */
export async function placeArchetypeSlots(actor) {
  const per = slotRules().archetype;
  const done = [];
  if (!per || actor?.type !== "character") return done;
  for (const [key, ranks] of archetypeCasting(actor)) {
    if (!ranks.size) continue;
    const entry = archetypeEntryOf(actor, key);
    if (!entry) continue;
    const spont = entry.system?.prepared?.value === "spontaneous";
    const upd = {};
    for (const r of ranks) {
      if (per <= Number(entry.system?.slots?.[`slot${r}`]?.max ?? 0)) continue;
      upd[`system.slots.slot${r}.max`] = per;
      if (spont) upd[`system.slots.slot${r}.value`] = per;
    }
    if (!Object.keys(upd).length) continue;
    await entry.update(upd);
    done.push(t("Spells.ArchSlotsSet", { name: entry.name }));
  }
  return done;
}

/**
 * The character's class spells, from what is on its sheet now (a feat or class feature gained outside the
 * builder, a level raised on the sheet). The tradition comes from the class, or the entry already there.
 */
/*
 * One spell job per character at a time. Applying a plan creates feats, the createItem hook then
 * resyncs class spells — when both ran side by side, each saw "no entry yet" and made one (two entries).
 */
const locks = new Map();
export function withSpellLock(actor, fn) {
  const key = actor?.uuid ?? "none";
  const prev = locks.get(key) ?? Promise.resolve();
  const next = prev.catch(() => null).then(fn);
  locks.set(key, next);
  next.finally(() => { if (locks.get(key) === next) locks.delete(key); }).catch(() => null);
  return next;
}

export function syncActorClassSpells(actor, { manual = false } = {}) {
  return withSpellLock(actor, () => syncNow(actor, manual));
}

/*
 * Spells in the class's entry that an archetype's feature lists and the class's tradition doesn't have —
 * what an earlier builder put there from, e.g., Psychic Dedication's conscious mind. Only named (once a
 * session per character, or whenever asked), never removed: the player may have a reason.
 */
const warned = new Set();
async function straySpells(actor, entry) {
  const tradition = entry?.system?.tradition?.value;
  if (!entry || !tradition) return [];
  const own = ownClassSlugs(actor);
  const classTraits = classTraitSet();
  const foreign = (actor.itemTypes?.feat ?? []).filter(f => !fromOwnClass(f, actor, own, classTraits));
  if (!foreign.length) return [];
  const listed = new Set();
  for (const f of foreign) {
    for (const link of spellLinks(await englishText(f))) {
      const doc = await getDoc(link.uuid);
      if (doc?.type === "spell" && doc.system?.slug) listed.add(doc.system.slug);
    }
  }
  return (actor.itemTypes?.spell ?? []).filter(sp => sp.system?.location?.value === entry.id
    && listed.has(sp.system?.slug ?? sp.slug)
    && !(sp.system?.traits?.traditions ?? []).includes(tradition)
    && !(sp.system?.traits?.value ?? []).includes("cantrip"));
}

async function syncNow(actor, manual = false) {
  if (actor?.type !== "character" || !actor.class) return [];
  // Dual class: the first class that casts (the second when only it does).
  let caster = null;
  let c = null;
  for (const cls of [firstClassItem(actor), secondClassItem(actor)].filter(Boolean)) {
    c = castingForClass(cls.slug ?? cls.system?.slug, cls.flags?.[MID]?.casting ?? null);
    if (c) { caster = cls; break; }
  }
  // An archetype's slots (table rule) — a fighter with a wizard archetype too.
  const arch = await placeArchetypeSlots(actor).catch(err => { console.warn(`${MID} | archetype slots`, err); return []; });
  if (!c) return arch;
  // Tradition from a subclass (summoner's eidolon, sorcerer's bloodline): the class's entry says it — never an archetype's.
  const main = classEntryOf(actor, c.mode, null, caster?.name ?? actor.class?.name ?? "");
  if (!c.tradition) c.tradition = main?.system?.tradition?.value ?? null;
  const name = caster?.name ?? actor.class.name ?? "";
  const done = [...await placeClassSpells(actor, c, actor.level, name), ...arch];
  try {
    const entry = classEntryOf(actor, c.mode, c.tradition, name);
    const strays = slotRules().strays ? await straySpells(actor, entry) : [];
    if (strays.length && (manual || !warned.has(actor.uuid))) {
      warned.add(actor.uuid);
      ui.notifications.warn(t("Spells.Strays", { entry: entry.name, list: strays.map(sp => sp.name).join(", ") }), { permanent: manual });
    }
  } catch (err) { console.warn(`${MID} | stray spells`, err); }
  return done;
}
