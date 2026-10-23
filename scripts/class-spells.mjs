import { MID, sourceIdOf, t } from "./util.mjs";
import { getDoc } from "./data.mjs";
import { castingForClass, entryName, maxSpellRank, shortClassName, spellSlotsAt, traditionLabel } from "./spells.mjs";

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

/** The class's own spells for a character at a level: { focus: [doc], main: [doc], tradition }. */
export async function classSpellsOf(actor, level) {
  const feats = (actor.itemTypes?.feat ?? []).filter(f => (Number(f.system?.level?.value ?? 1) || 1) <= level || f.system?.location);
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
  for (const it of Object.values(cls?.system?.items ?? {})) {
    if ((Number(it?.level ?? 1) || 1) > level || !it?.uuid) continue;
    const d = await getDoc(it.uuid);
    if (d) docs.push(d);
  }
  for (const picks of Object.values(plan.choices ?? {})) {
    for (const [k, v] of Object.entries(picks ?? {})) {
      if (k === "_slug" || typeof v !== "string" || !/^Compendium\./.test(v)) continue;
      const d = await getDoc(v);
      if (d && d.type !== "spell") docs.push(d);
    }
  }
  for (const [slot, ref] of Object.entries(plan.feats ?? {})) {
    if (!ref || Number(slot.split("-").pop()) > level) continue;
    const d = await getDoc(ref.uuid);
    if (d) docs.push(d);
  }
  void idx;
  return spellsFromDocs(docs, level);
}

function entryOfKind(actor, mode, tradition) {
  return actor.itemTypes.spellcastingEntry?.find(e => e.system?.prepared?.value === mode && (!tradition || e.system?.tradition?.value === tradition));
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
    let entry = entryOfKind(actor, c.mode, c.tradition);
    if (!entry) {
      [entry] = await actor.createEmbeddedDocuments("Item", [{
        type: "spellcastingEntry", name: entryName(className, c.tradition),
        system: { tradition: { value: c.tradition }, prepared: { value: c.mode }, ability: { value: c.attr ?? "cha" }, proficiency: { value: 1 } }
      }]);
      done.push(t("Spells.EntryMade"));
    }
    await add(entry, found.main);
    // Spells per day from the class table.
    const slots = spellSlotsAt(c.slug, level);
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
    let entry = entryOfKind(actor, "focus");
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

export function syncActorClassSpells(actor) {
  return withSpellLock(actor, () => syncNow(actor));
}

async function syncNow(actor) {
  if (actor?.type !== "character" || !actor.class) return [];
  const c = castingForClass(actor.class.slug ?? actor.class.system?.slug, actor.class.flags?.[MID]?.casting ?? null);
  if (!c) return [];
  const main = actor.itemTypes.spellcastingEntry?.find(e => e.system?.prepared?.value === c.mode);
  if (!c.tradition) c.tradition = main?.system?.tradition?.value ?? null;
  return placeClassSpells(actor, c, actor.level, actor.class.name ?? "");
}
