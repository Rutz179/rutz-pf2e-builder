import { MID, sluggify, sourceIdOf, t } from "./util.mjs";
import { getDoc } from "./data.mjs";
import { decodeChoiceKey } from "./plan.mjs";
import { dualActive, firstClassItem, secondClassItem } from "./dualclass.mjs";
import { castingForClass, entryName, maxSpellRank, shortClassName, slotRules, tableSlotsAt, traditionLabel } from "./spells.mjs";
import { dropOrphans, grantKey, grantOf, holderSlug, innateDiff, parseGrants, picksFor, planGrants, syncInnate } from "./innate.mjs";
import { domainOfSpell, domainSpell } from "./domains.mjs";
import { planFor } from "./choices.mjs";

/*
 * Spells a class gives by itself, read from the links in its class features' English text (PF2e grants the features but not their spells).
 * Focus spells and tradition-less cantrips go to a focus entry, the rest to the class's spellcasting entry. Picks are saved in the plan (spells.grants); each added spell carries flags.grant, so it leaves with its item or pick.
 */

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
export async function englishText(item) {
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

/** Spell links in a feature text: { uuid, focus: bool, rank: number|null }. `skip`: links that are options of a choice. */
export function spellLinks(html, skip = null) {
  const text = plain(html);
  const out = [];
  const seen = new Set(skip ?? []);
  // Starting focus spells: a link with the right words before it.
  for (const m of text.matchAll(LINK)) {
    if (seen.has(m[1])) continue;
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
export async function englishOfDoc(doc) {
  if (!doc) return "";
  return englishText({ system: doc.system, _stats: { compendiumSource: sourceIdOf(doc) ?? doc.uuid } });
}

const focusLikeDoc = doc => {
  const traits = doc?.system?.traits?.value ?? [];
  return traits.includes("focus") || (!(doc?.system?.traits?.traditions ?? []).length && (traits.includes("composition") || traits.includes("hex") || traits.includes("cantrip")));
};
const slugOfDoc = d => d?.system?.slug ?? d?.slug ?? null;
// A focus entry's tradition and attribute for a class or archetype that doesn't cast otherwise ("Your devotion spells are divine spells", "you cast this focus spell as an occult spell"); else "trained in arcane spell DCs".
const FOCUS_TRAD = [
  /\b(?:are|is|they're|as an?|as|type of) (arcane|divine|occult|primal) (?:focus )?(?:spells?|magic)\b/i,
  /\b(arcane|divine|occult|primal) [a-z ]+ spells, which are a type of focus spell/i
];
const FOCUS_TRAD_WEAK = /\b(?:trained|expert) in (arcane|divine|occult|primal) spell (?:DCs|attack)/i;
// "Your spellcasting attribute is Charisma" and its variants name the attribute.
const FOCUS_ATTR = [
  /\bspellcasting (?:attribute|ability)(?: score)?(?: for [a-z' ]+?)? is (strength|dexterity|constitution|intelligence|wisdom|charisma)\b/i,
  /\b(?:using|use) (strength|dexterity|constitution|intelligence|wisdom|charisma) as your spellcasting (?:attribute|ability)\b/i
];
const firstOf = (list, text) => list.map(re => re.exec(text)?.[1]).find(Boolean)?.toLowerCase() ?? null;
const ATTR_OF = { strength: "str", dexterity: "dex", constitution: "con", intelligence: "int", wisdom: "wis", charisma: "cha" };

/** A text's spell choices ("your choice of the A hex or B hex", "your familiar learns your choice of …"): the plan's pick, else an option already on the sheet (`sheet`: slugs). */
async function choicesIn(d, html, plan, sheet) {
  const out = [];
  for (const g of parseGrants(html)) {
    if (g.kind !== "choice") continue;
    const options = [];
    for (const u of g.options) {
      const doc = await getDoc(u);
      if (doc?.type === "spell") options.push(doc);
    }
    if (options.length < 2 || options.length !== g.options.length) continue;
    const kind = options.every(focusLikeDoc) ? "focus" : g.main && !options.some(focusLikeDoc) ? "main" : null;
    if (!kind) continue;
    const key = grantKey(d, g.n);
    const want = new Set(picksFor(plan, key).flatMap(r => [r.uuid, r.slug]).filter(Boolean));
    let picked = options.filter(o => want.has(o.uuid) || want.has(slugOfDoc(o))).slice(0, g.count);
    const fromPlan = picked.length > 0;
    if (!fromPlan && sheet) picked = options.filter(o => sheet.has(slugOfDoc(o))).slice(0, g.count);
    out.push({ key, kind, holder: d, options, picked, fromPlan, count: g.count, links: g.options });
  }
  return out;
}

/* ---------------- domain spells ---------------- */

const DOMAIN_CHOICES = "system.details.deities.domains";

/** What an item's ChoiceSet was answered with: on the sheet's item, else in the plan. */
function selectionOf(d, rule, i, plan) {
  const own = d.flags?.pf2e?.rulesSelections?.[rule.flag];
  if (own !== undefined && own !== null && own !== "") return own;
  const slug = d.system?.slug ?? null;
  for (const [key, picks] of Object.entries(plan?.choices ?? {})) {
    const v = picks?.[i];
    if (v !== undefined && v !== "" && (decodeChoiceKey(key) === d.uuid || (slug && picks._slug === slug))) return v;
  }
  return null;
}

/** A spell grant among some uuids, like choicesIn's: `fixed` when there is nothing to choose. */
async function grantChoice(d, tag, uuids, plan, sheet, fixed) {
  const options = [];
  for (const u of uuids) {
    const doc = await getDoc(u);
    if (doc?.type === "spell") options.push(doc);
  }
  const key = `${holderSlug(d)}|${tag}`;
  const want = new Set(picksFor(plan, key).flatMap(r => [r.uuid, r.slug]).filter(Boolean));
  let picked = fixed ? options : options.filter(o => want.has(o.uuid) || want.has(slugOfDoc(o))).slice(0, 1);
  const fromPlan = picked.length > 0;
  if (!fromPlan && sheet) picked = options.filter(o => sheet.has(slugOfDoc(o))).slice(0, 1);
  return { key, kind: "focus", holder: d, options, picked, fromPlan, count: 1, links: [], fixed };
}

/** Domain spells: the domain answered in the item's question gives its initial spell; alternate/related domains are picked in the builder; an advanced spell is the one of a domain the character has an initial spell of (PF2e lists these only in its Domains journal, domains.mjs). */
async function domainChoices(docs, texts, plan, sheet, deity) {
  const out = [];
  const have = new Set();
  const related = new Set();
  for (const d of docs) {
    const rules = d.system?.rules ?? [];
    for (let i = 0; i < rules.length; i++) {
      if (rules[i]?.key !== "ChoiceSet" || rules[i].choices !== DOMAIN_CHOICES) continue;
      const domain = selectionOf(d, rules[i], i, plan);
      if (!domainSpell(domain)) continue;
      have.add(domain);
      out.push(await grantChoice(d, `domain${i}`, [domainSpell(domain)], plan, sheet, true));
    }
    // an oracle's mystery: "Related Domains death, duty, family, soul"
    const rel = /\bRelated Domains\s+([a-z][a-z ,-]*?)(?=\s+[A-Z]|\s*$)/.exec(texts.get(d));
    for (const x of rel?.[1].split(/\s*,\s*/) ?? []) related.add(x.trim());
  }
  for (const d of docs) {
    const text = texts.get(d);
    if (!/\bgain\b[^.]*\binitial domain spell\b/i.test(text) || (d.system?.rules ?? []).some(r => r?.choices === DOMAIN_CHOICES)) continue;
    const pool = /\balternate domains\b/i.test(text) ? (deity?.system?.domains?.alternate ?? []) : /\bassociated with your mystery\b/i.test(text) ? [...related] : [];
    const uuids = pool.filter(x => !have.has(x)).map(x => domainSpell(x)).filter(Boolean);
    if (!uuids.length) continue;
    const c = await grantChoice(d, "domain", uuids, plan, sheet, uuids.length === 1);
    for (const p of c.picked) have.add(domainOfSpell(p.uuid));
    out.push(c);
  }
  for (const d of docs) {
    if (!/\bgain\b[^.]*\badvanced domain spell\b/i.test(texts.get(d))) continue;
    const uuids = [...have].map(x => domainSpell(x, true)).filter(Boolean);
    if (uuids.length) out.push(await grantChoice(d, "advanced", uuids, plan, sheet, uuids.length === 1));
  }
  return out;
}

/** Sort spell links of some documents into focus spells and ordinary ones (and the choices among them). */
export async function spellsFromDocs(docs, level, plan = null, sheet = null, deity = null) {
  const focus = new Map();
  const main = new Map();
  const from = new Map(); // spell uuid → { item, key? }: what granted it (sheet items only)
  const choices = [];
  let tradition = null;
  let focusTradition = null;
  let focusTradWeak = null;
  let focusAttr = null;
  const maxRank = maxSpellRank(level);
  const texts = new Map();
  for (const d of docs) texts.set(d, d.__english ?? await englishOfDoc(d));
  for (const c of await domainChoices(docs, new Map([...texts].map(([d, h]) => [d, plain(h)])), plan, sheet, deity)) {
    choices.push(c);
    for (const doc of c.picked) {
      focus.set(doc.uuid, doc);
      if (c.holder.id && c.fromPlan) from.set(doc.uuid, { item: c.holder.id, key: c.key });
    }
  }
  for (const d of docs) {
    const html = texts.get(d);
    tradition ??= (/(?:Spell List|Tradition)\s+(arcane|divine|occult|primal)\b/i.exec(plain(html))?.[1] ?? null)?.toLowerCase() ?? null;
    focusTradition ??= firstOf(FOCUS_TRAD, plain(html));
    focusTradWeak ??= FOCUS_TRAD_WEAK.exec(plain(html))?.[1]?.toLowerCase() ?? null;
    focusAttr ??= ATTR_OF[firstOf(FOCUS_ATTR, plain(html))] ?? null;
    const picks = await choicesIn(d, html, plan, sheet);
    choices.push(...picks);
    for (const c of picks) {
      for (const doc of c.picked) {
        if (c.kind === "focus") focus.set(doc.uuid, doc);
        else if (Number(doc.system?.level?.value ?? 1) <= maxRank || (doc.system?.traits?.value ?? []).includes("cantrip")) main.set(doc.uuid, doc);
        if (d.id && c.fromPlan) from.set(doc.uuid, { item: d.id, key: c.key });
      }
    }
    for (const link of spellLinks(html, picks.flatMap(c => c.links))) {
      const doc = await getDoc(link.uuid);
      if (!doc || doc.type !== "spell") continue;
      const traits = doc.system?.traits?.value ?? [];
      const isCantrip = traits.includes("cantrip");
      const focusLike = focusLikeDoc(doc);
      if (link.focus === "maybe" && !focusLike) continue;
      const isFocus = link.focus === true || focusLike;
      const rank = isCantrip ? 0 : (link.rank ?? Number(doc.system?.level?.value ?? 1));
      if (isFocus) focus.set(doc.uuid, doc);
      else if (rank <= maxRank) main.set(doc.uuid, doc);
      else continue;
      if (d.id && !from.has(doc.uuid)) from.set(doc.uuid, { item: d.id });
    }
  }
  return { focus: [...focus.values()], main: [...main.values()], tradition, focusTradition: focusTradition ?? focusTradWeak, focusAttr, choices, from };
}

/* ---------------- whose spells: the class's, not an archetype's ---------------- */

// An archetype's features list the spells of *that* class; they go to the archetype's own spellcasting (one spell per archetype slot), never the class's repertoire.
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

/** The class's own spells for a character at a level: { focus: [doc], main: [doc], tradition, choices, from }. */
export async function classSpellsOf(actor, level, plan = planFor(actor)) {
  const own = ownClassSlugs(actor);
  const classTraits = classTraitSet();
  const feats = (actor.itemTypes?.feat ?? []).filter(f => ((Number(f.system?.level?.value ?? 1) || 1) <= level || f.system?.location)
    && (!own.size || fromOwnClass(f, actor, own, classTraits)));
  const docs = [];
  for (const f of feats) docs.push({ system: f.system, __english: await englishText(f), uuid: f.uuid, id: f.id, name: f.name, flags: f.flags });
  const sheet = new Set((actor.itemTypes?.spell ?? []).map(slugOfDoc).filter(Boolean));
  return spellsFromDocs(docs, level, plan, sheet, actor.deity ?? actor.itemTypes?.deity?.[0] ?? null);
}

/** The same for a plan: class features up to the level, what was chosen in their questions, and the planned feats. */
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
  const deity = plan.deity ? await getDoc(plan.deity.uuid) : null;
  const found = await spellsFromDocs(docs, level, plan, null, deity);
  // archetypes' focus spells: the feats left out above (and what was answered inside them)
  try {
    const foreignDocs = [];
    for (const [slot, ref] of Object.entries(plan.feats ?? {})) {
      if (!ref || Number(slot.split("-").pop()) > level) continue;
      const d = await getDoc(ref.uuid);
      if (d && foreign(d)) foreignDocs.push(d);
    }
    found.archetypes = own.size && foreignDocs.length ? await archetypeFocus(foreignDocs, level, plan, null, deity, own) : [];
  } catch (err) { console.warn(`${MID} | archetype focus spells`, err); found.archetypes = []; }
  // innate spells come from anything taken (ancestry, heritage, any feat), not only the class's
  try { found.innate = await planGrants(plan, level); } catch (err) { console.warn(`${MID} | innate spells`, err); found.innate = []; }
  return found;
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

/** The class's spellcasting entry of a kind (and tradition): the builder's own wins, then one named after the class; entries named for an archetype or another class are never the class's, except focus entries. */
export function classEntryOf(actor, mode, tradition = null, className = "", ownSlugs = ownClassSlugs(actor)) {
  const list = (actor.itemTypes?.spellcastingEntry ?? []).filter(e => e.system?.prepared?.value === mode && (!tradition || e.system?.tradition?.value === tradition)
    && !e.flags?.[MID]?.focusArchetype);
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

/** Make sure a new caster has its spellcasting entry and the spells its class gives. Returns lines for the summary. */
export async function placeClassSpells(actor, casting, level, className = "", plan = null) {
  const done = [];
  let found;
  try {
    // spells whose item left the sheet before this ran (a feat replaced by the plan) go first, so the new item's are added
    await dropOrphans(actor);
    found = await classSpellsOf(actor, level, plan ?? planFor(actor));
  } catch (err) { console.warn(`${MID} | class spells`, err); return done; }
  done.push(...await dropStalePicks(actor, found.choices));
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
      // the item it came from: taking that item off the sheet takes the spell too
      const by = found.from.get(doc.uuid);
      if (by) src.flags = { ...(src.flags ?? {}), [MID]: { ...(src.flags?.[MID] ?? {}), grant: { ...by, kind: by.key ? "pick" : "class" } } };
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
  try { done.push(...await placeDivineFont(actor, level)); } catch (err) { console.warn(`${MID} | divine font`, err); }
  if (found.focus.length) {
    const trad = c.tradition ?? found.focusTradition ?? found.focus.map(d => d.system?.traits?.traditions?.[0]).find(Boolean) ?? "occult";
    let entry = entryOfKind(actor, "focus", null, className);
    if (!entry) {
      [entry] = await actor.createEmbeddedDocuments("Item", [{
        type: "spellcastingEntry", name: t("Spells.FocusEntryName", { name: shortClassName(className) || traditionLabel(trad) }),
        system: { tradition: { value: trad }, prepared: { value: "focus" }, ability: { value: c.attr ?? found.focusAttr ?? "cha" }, proficiency: { value: 1 } }
      }]);
      done.push(t("Spells.FocusEntryMade"));
    }
    await add(entry, found.focus);
    // PF2e works out the pool from the focus spells; start it full.
    const max = Number(actor.system?.resources?.focus?.max ?? 0);
    if (max > 0) await actor.update({ "system.resources.focus.value": max }, { rpbApply: true });
  }
  try { done.push(...await placeArchetypeFocus(actor, level, plan ?? planFor(actor))); } catch (err) { console.warn(`${MID} | archetype focus spells`, err); }
  return done;
}

/** A choice picked again (Phase Familiar instead of Patron's Puppet, another domain): the earlier pick goes. */
async function dropStalePicks(actor, choices) {
  const stale = (actor.itemTypes.spell ?? []).filter(sp => {
    const g = grantOf(sp);
    const ch = g?.key ? choices.find(x => x.key === g.key && x.holder.id === g.item) : null;
    return ch?.fromPlan && !ch.picked.some(p => slugOfDoc(p) === slugOfDoc(sp));
  });
  if (!stale.length) return [];
  await actor.deleteEmbeddedDocuments("Item", stale.map(sp => sp.id));
  return [t("Spells.GrantRemoved", { list: stale.map(sp => sp.name).join(", ") })];
}

/* ---------------- archetypes' focus spells ---------------- */

/** The pack original of a translated mirror's item (its English prerequisites and name), else the item. */
async function originalOf(item) {
  const m = /^Compendium\.([^.]+)\.([^.]+)\.Item\.(.+)$/.exec(sourceIdOf(item) ?? item.uuid ?? "");
  if (m && m[1] !== "pf2e" && m[1] !== game.system.id) {
    try { return (await fromUuid(`Compendium.${game.system.id}.${m[2]}.Item.${m[3]}`)) ?? item; } catch (_) { /* the item itself */ }
  }
  return item;
}

const dedicationKey = slug => String(slug ?? "").replace(/-dedication$/, "");

/** Which archetype a feat belongs to: a dedication is its own; another class's feat, that class; else the dedication its prerequisites name (directly or through another of its feats). */
async function archetypeKeys(docs, classTraits, own) {
  const info = new Map();
  for (const d of docs) {
    const o = await originalOf(d);
    const traits = d.system?.traits?.value ?? [];
    info.set(d, {
      name: String(o.name ?? d.name ?? ""), slug: slugOfDoc(d) ?? sluggify(o.name ?? d.name ?? ""),
      cls: traits.find(tr => classTraits.has(tr) && !own.has(tr)) ?? null, dedication: traits.includes("dedication"),
      prereqs: (o.system?.prerequisites?.value ?? d.system?.prerequisites?.value ?? []).map(p => String(p?.value ?? p))
    });
  }
  const byName = new Map([...info].map(([d, i]) => [i.name.toLowerCase(), d]));
  const keyOf = (d, depth = 0) => {
    const i = info.get(d);
    if (i.dedication) return dedicationKey(i.slug);
    if (i.cls) return i.cls;
    for (const p of i.prereqs) {
      const m = /^(.+?) Dedication$/i.exec(p.trim());
      if (m) return sluggify(m[1]);
      const via = byName.get(p.trim().toLowerCase());
      if (via && via !== d && depth < 4) return keyOf(via, depth + 1);
    }
    return "archetype";
  };
  return new Map(docs.map(d => [d, { key: keyOf(d), ...info.get(d) }]));
}

/** Focus spells from archetypes, grouped by archetype, with the tradition and attribute its texts give (else the class's) → [{ key, name, tradition, attr, focus, choices, from }] */
async function archetypeFocus(docs, level, plan, sheet, deity, own) {
  const classTraits = classTraitSet();
  const keys = await archetypeKeys(docs, classTraits, own);
  const groups = new Map();
  for (const d of docs) {
    const k = keys.get(d).key;
    groups.set(k, [...(groups.get(k) ?? []), d]);
  }
  const out = [];
  for (const [key, list] of groups) {
    const found = await spellsFromDocs(list, level, plan, sheet, deity);
    if (!found.focus.length && !found.choices.some(c => c.kind === "focus")) continue;
    const ded = list.find(d => keys.get(d).dedication);
    const cls = castingForClass(key);
    const label = CONFIG.PF2E?.classTraits?.[key];
    const name = ded ? shortClassName(String(ded.name ?? "")).replace(/\s*Dedication$/i, "") : label ? game.i18n.localize(label) : key;
    out.push({
      key, name, focus: found.focus, choices: found.choices.filter(c => c.kind === "focus"), from: found.from,
      tradition: found.focusTradition ?? cls?.tradition ?? found.focus.map(d => d.system?.traits?.traditions?.[0]).find(Boolean) ?? null,
      attr: found.focusAttr ?? cls?.attr ?? null
    });
  }
  return out;
}

/** The archetypes' focus spells on the sheet: into a focus entry of the same tradition and attribute, else the archetype's own. */
export async function placeArchetypeFocus(actor, level, plan) {
  const done = [];
  const own = ownClassSlugs(actor);
  const classTraits = classTraitSet();
  const feats = (actor.itemTypes?.feat ?? []).filter(f => ((Number(f.system?.level?.value ?? 1) || 1) <= level || f.system?.location)
    && own.size && !fromOwnClass(f, actor, own, classTraits));
  if (!feats.length) return done;
  const docs = [];
  for (const f of feats) docs.push({ system: f.system, __english: await englishText(f), uuid: f.uuid, id: f.id, name: f.name, flags: f.flags, _stats: f._stats });
  const sheet = new Set((actor.itemTypes?.spell ?? []).map(slugOfDoc).filter(Boolean));
  const groups = await archetypeFocus(docs, level, plan, sheet, actor.deity ?? actor.itemTypes?.deity?.[0] ?? null, own);
  let added = false;
  for (const g of groups) {
    done.push(...await dropStalePicks(actor, g.choices));
    const have = new Set((actor.itemTypes.spell ?? []).flatMap(sp => [sourceIdOf(sp), slugOfDoc(sp)].filter(Boolean)));
    const docsToAdd = g.focus.filter(d => !have.has(d.uuid) && !have.has(slugOfDoc(d)));
    if (!docsToAdd.length) continue;
    const tradition = g.tradition ?? "occult";
    const attr = g.attr ?? "cha";
    const focusEntries = (actor.itemTypes?.spellcastingEntry ?? []).filter(e => e.system?.prepared?.value === "focus");
    let entry = focusEntries.find(e => e.flags?.[MID]?.focusArchetype === g.key)
      ?? focusEntries.find(e => e.system?.tradition?.value === tradition && (e.system?.ability?.value || "cha") === attr);
    if (!entry) {
      [entry] = await actor.createEmbeddedDocuments("Item", [{
        type: "spellcastingEntry", name: t("Spells.FocusEntryName", { name: g.name }),
        system: { tradition: { value: tradition }, prepared: { value: "focus" }, ability: { value: attr }, proficiency: { value: 1 } },
        flags: { [MID]: { focusArchetype: g.key } }
      }]);
      done.push(t("Spells.FocusEntryMade"));
    }
    const sources = docsToAdd.map(doc => {
      const src = doc.toObject();
      delete src._id;
      src._stats = { ...(src._stats ?? {}), compendiumSource: doc.uuid };
      src.system.location = { ...(src.system.location ?? {}), value: entry.id };
      const by = g.from.get(doc.uuid);
      if (by) src.flags = { ...(src.flags ?? {}), [MID]: { ...(src.flags?.[MID] ?? {}), grant: { ...by, kind: by.key ? "pick" : "class" } } };
      return src;
    });
    const made = await actor.createEmbeddedDocuments("Item", sources);
    done.push(...made.map(m => m.name));
    added = true;
  }
  if (added) {
    // one focus pool for all entries: PF2e counts the focus spells, wherever they are
    const max = Number(actor.system?.resources?.focus?.max ?? 0);
    if (max > 0) await actor.update({ "system.resources.focus.value": max }, { rpbApply: true });
  }
  // the builder's archetype entries left with no spells go
  const spells = actor.itemTypes?.spell ?? [];
  const empty = (actor.itemTypes?.spellcastingEntry ?? []).filter(e => e.flags?.[MID]?.focusArchetype && !spells.some(sp => sp.system?.location?.value === e.id));
  if (empty.length) await actor.deleteEmbeddedDocuments("Item", empty.map(e => e.id));
  return done;
}

/* ---------------- divine font (cleric) ---------------- */

/* Divine Font: PF2e asks heal or harm but adds no slots. The cleric gets 4 extra highest-rank slots (5 from 5th level, 6 from 15th) in an entry of their own ("치유의 샘" / "해악의 샘", prepared, divine); slots already cast stay cast. */
const FONT_SPELL = { heal: "heal", harm: "harm" };

function divineFontOf(actor) {
  for (const f of actor.itemTypes?.feat ?? []) {
    if ((f.system?.slug ?? f.slug) !== "divine-font") continue;
    const choice = f.flags?.pf2e?.rulesSelections?.divineFont;
    if (FONT_SPELL[choice]) return { feature: f, choice };
  }
  return null;
}

export const fontSlotsAt = level => (level >= 15 ? 6 : level >= 5 ? 5 : 4);

/** The highest rank the cleric's own entry has slots in (else the highest a caster of this level casts). */
function highestClassRank(actor, level) {
  const main = classEntryOf(actor, "prepared", "divine", actor.class?.name ?? "");
  for (let r = 10; r >= 1; r--) if (Number(main?.system?.slots?.[`slot${r}`]?.max ?? 0) > 0) return { rank: r, main };
  return { rank: Math.max(1, maxSpellRank(level)), main };
}

async function fontSpellDoc(feature, slug) {
  // Divine Font's text links both spells ("prepare additional heal or harm spells").
  for (const [, uuid] of String(await englishText(feature)).matchAll(LINK)) {
    const doc = await getDoc(uuid);
    if (doc?.type === "spell" && (doc.system?.slug ?? doc.slug) === slug) return doc;
  }
  const pack = game.packs.get(`${game.system.id}.spells-srd`);
  const idx = await pack?.getIndex({ fields: ["system.slug"] });
  const hit = idx?.find(e => e.system?.slug === slug);
  return hit ? getDoc(hit.uuid ?? `Compendium.${pack.collection}.Item.${hit._id}`) : null;
}

export async function placeDivineFont(actor, level = actor.level) {
  const done = [];
  const font = divineFontOf(actor);
  if (!font || !fromOwnClass(font.feature, actor, ownClassSlugs(actor))) return done;
  const { rank, main } = highestClassRank(actor, level);
  const n = fontSlotsAt(level);
  const key = font.choice === "heal" ? "Healing" : "Harmful";
  const name = t(`Spells.Font.${key}`);
  let entry = (actor.itemTypes?.spellcastingEntry ?? []).find(e => e.flags?.[MID]?.divineFont);
  if (!entry) {
    [entry] = await actor.createEmbeddedDocuments("Item", [{
      type: "spellcastingEntry", name,
      system: { tradition: { value: "divine" }, prepared: { value: "prepared" }, ability: { value: main?.system?.ability?.value ?? "wis" }, proficiency: { value: Number(main?.system?.proficiency?.value ?? 1) || 1 } },
      flags: { [MID]: { divineFont: font.choice } }
    }]);
    done.push(t("Spells.FontMade", { name, n }));
  } else if (entry.flags[MID].divineFont !== font.choice) {
    await entry.update({ name, [`flags.${MID}.divineFont`]: font.choice });
  }
  // the spell (heal or harm), in this entry
  const slug = FONT_SPELL[font.choice];
  const inEntry = (actor.itemTypes?.spell ?? []).filter(sp => sp.system?.location?.value === entry.id);
  const wrong = inEntry.filter(sp => (sp.system?.slug ?? sp.slug) !== slug);
  if (wrong.length) await actor.deleteEmbeddedDocuments("Item", wrong.map(sp => sp.id));
  let spell = inEntry.find(sp => (sp.system?.slug ?? sp.slug) === slug);
  if (!spell) {
    const doc = await fontSpellDoc(font.feature, slug);
    if (!doc) return done;
    const src = doc.toObject();
    delete src._id;
    src._stats = { ...(src._stats ?? {}), compendiumSource: doc.uuid };
    src.system.location = { ...(src.system.location ?? {}), value: entry.id };
    [spell] = await actor.createEmbeddedDocuments("Item", [src]);
  }
  // n slots at the rank, the spell in each; other ranks emptied (a rank left behind by an earlier level)
  const upd = {};
  for (let r = 1; r <= 10; r++) {
    const cur = entry.system?.slots?.[`slot${r}`] ?? {};
    const prepared = Object.values(cur.prepared ?? {});
    if (r === rank) {
      const want = Array.from({ length: n }, (_, i) => ({ id: spell.id, expended: prepared[i]?.id === spell.id ? !!prepared[i]?.expended : false }));
      const same = Number(cur.max ?? 0) === n && prepared.length === n && prepared.every((p, i) => p?.id === spell.id && !!p.expended === want[i].expended);
      if (!same) { upd[`system.slots.slot${r}.max`] = n; upd[`system.slots.slot${r}.prepared`] = want; }
    } else if (Number(cur.max ?? 0) > 0 || prepared.length) {
      upd[`system.slots.slot${r}.max`] = 0;
      upd[`system.slots.slot${r}.prepared`] = [];
    }
  }
  if (Object.keys(upd).length) {
    await entry.update(upd);
    if (!done.length) done.push(t("Spells.FontSet", { name, n, rank }));
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

/** Table rule "archetype slots per rank": each rank the archetype's spellcasting feats have opened gets that many slots in its entry; raised only, never lowered. */
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

/** The character's class spells from what is on its sheet now; the tradition comes from the class, or the entry already there. */
/* One spell job per character at a time: applying a plan creates feats and the createItem hook resyncs class spells; run side by side, each saw "no entry yet" and made one. */
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

/* Spells in the class's entry that an archetype's feature lists but the class's tradition lacks: only named (once per session per character, or when asked), never removed. */
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
  if (actor?.type !== "character") return [];
  // innate spells (ancestry, heritage, any feat): with or without a class that casts
  const innate = await syncInnate(actor, planFor(actor)).catch(err => { console.warn(`${MID} | innate spells`, err); return []; });
  if (!actor.class) return innate;
  // Dual class: the first class that casts (the second when only it does).
  let caster = null;
  let c = null;
  for (const cls of [firstClassItem(actor), secondClassItem(actor)].filter(Boolean)) {
    c = castingForClass(cls.slug ?? cls.system?.slug, cls.flags?.[MID]?.casting ?? null);
    if (c) { caster = cls; break; }
  }
  // An archetype's slots (table rule) — a fighter with a wizard archetype too.
  const arch = [...await placeArchetypeSlots(actor).catch(err => { console.warn(`${MID} | archetype slots`, err); return []; }), ...innate];
  // a class that doesn't cast (champion, monk, ranger …): its focus spells, and its archetypes'
  if (!c) return [...await placeClassSpells(actor, null, actor.level, actor.class?.name ?? "", planFor(actor)), ...arch];
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

/** What applying would add or take off for the sheet's items as they are: innate spells, and focus / familiar picks. Names. */
export async function pendingGranted(actor, plan) {
  if (actor?.type !== "character") return [];
  const out = [];
  try {
    const { add, remove } = await innateDiff(actor, plan);
    out.push(...add.map(w => w.doc.name), ...remove.map(sp => `✕ ${sp.name}`));
    const found = await classSpellsOf(actor, actor.level ?? 1, plan);
    const have = new Set((actor.itemTypes?.spell ?? []).map(slugOfDoc).filter(Boolean));
    for (const ch of found.choices) if (ch.fromPlan) out.push(...ch.picked.filter(d => !have.has(slugOfDoc(d))).map(d => d.name));
    for (const g of await archetypeFocusOfActor(actor, plan)) for (const ch of g.choices) if (ch.fromPlan) out.push(...ch.picked.filter(d => !have.has(slugOfDoc(d))).map(d => d.name));
  } catch (err) { console.warn(`${MID} | pending spells`, err); }
  return [...new Set(out)];
}

/** The archetypes' focus spell groups of a character (for what applying would add). */
async function archetypeFocusOfActor(actor, plan) {
  const own = ownClassSlugs(actor);
  if (!own.size) return [];
  const classTraits = classTraitSet();
  const docs = [];
  for (const f of (actor.itemTypes?.feat ?? []).filter(x => !fromOwnClass(x, actor, own, classTraits))) {
    docs.push({ system: f.system, __english: await englishText(f), uuid: f.uuid, id: f.id, name: f.name, flags: f.flags, _stats: f._stats });
  }
  const sheet = new Set((actor.itemTypes?.spell ?? []).map(slugOfDoc).filter(Boolean));
  return docs.length ? archetypeFocus(docs, actor.level ?? 1, plan, sheet, actor.deity ?? null, own) : [];
}
