import { MID, sluggify, sourceIdOf, t } from "./util.mjs";
import { getDoc, originalName } from "./data.mjs";
import { englishOfDoc, englishText } from "./class-spells.mjs";
import { slotLevel } from "./rules.mjs";
import { dualActive, slotInUse } from "./dualclass.mjs";
import { TRADITIONS, traditionLabel } from "./spells.mjs";

/*
 * Spells a feat or feature grants in its text (PF2e adds none): innate ("You can cast X as an arcane innate spell at will", picks made in the builder) and choice ("your choice of the A hex or B hex", focus spells in class-spells.mjs).
 * The English text is read; ODD covers feats it can't. Innate spells go to one entry per tradition, and each remembers its granting item.
 */

const LINK = /@UUID\[(Compendium\.[^\]]+\.Item\.[A-Za-z0-9]{16})\](?:\{[^}]*\})?/g;
const TRAD = /\b(arcane|divine|occult|primal)\b/gi;
const RANK = /\b(\d+)(?:st|nd|rd|th)[- ]rank\b/gi;
const COUNT = { a: 1, an: 1, one: 1, two: 2, three: 3 };
// "choose one …", "select two of the following …", "choose either …", "choose §0§, §1§ or §2§" — not "choose to / whether".
const CHOOSE = /\b(?:choose|select)\s+(?:(?:one|two|three|a|an|either)\b|§)/i;
const PART = /^(one|two|three|a|an)\s+(?:(common)\s+)?(?:(\d+)(?:st|nd|rd|th)-rank(\s+or\s+lower)?\s+)?(?:(arcane|divine|occult|primal)\s+)?(?:(cantrips?)|spells?(?:\s+of\s+(\d+)(?:st|nd|rd|th)\s+rank(\s+or\s+lower)?)?)\b(.*)$/i;
const FROM_LIST = /\bfrom (?:either )?the (arcane|divine|occult|primal)(?: spells?)? list(?: or the (arcane|divine|occult|primal)(?: spells?)? list)?/i;
// Links that are not what is granted: "Instead of casting Light, you can cast …".
const NOT_GRANTED = /\b(?:casting|instead of|when you cast|if you cast|after you cast)\s+(?:the\s+|a\s+|an\s+)?$/i;
const REFERS_BACK = /\b(?:each of these|these|them|both|this spell|that spell|this cantrip)\b/i;

/* Known items the text can't give: slug → grants (the shape parseGrants gives). Kept small on purpose. */
const ODD = {
  // "You gain message as an innate arcane cantrip." — the spell is named, not linked
  messenger: [{ n: 0, kind: "innate", type: "fixed", spells: [{ uuid: "Compendium.pf2e.spells-srd.Item.vLzFcIaSXs7YTIqJ", rank: null }], traditions: ["arcane"], uses: 0 }]
};

/** A description as paragraphs of sentences; links become §n§ (their uuids in `links`). */
function sentencesOf(html) {
  const links = [];
  const text = String(html ?? "")
    .replace(/<\/(?:p|li|h[1-6]|div|tr)>|<br\s*\/?>|<hr[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
    .replace(LINK, (_m, uuid) => `§${links.push(uuid) - 1}§`);
  const paras = text.split(/\n+/).map(p => p.replace(/\s+/g, " ").trim())
    // "Enhancement" (a later feat's upgrade), "Special" (a rules note): not what this item grants by itself
    .filter(p => p && !/^(Enhancement|Special|Heightened)\b/.test(p))
    .map(p => p.replace(/\([^()]*\b(?:for example|e\.g\.)[^()]*\)/gi, " ").split(/(?<=[.!?])\s+(?=[A-Z§])/));
  return { paras, links };
}

const marks = s => [...s.matchAll(/§(\d+)§/g)].map(m => ({ i: Number(m[1]), at: m.index }));
const tradsIn = s => [...new Set([...s.matchAll(TRAD)].map(m => m[1].toLowerCase()))];

function usesIn(s) {
  if (/\bat will\b/i.test(s)) return 0;
  if (/\bper week\b/i.test(s)) return 1;
  if (/\bthree times (?:per|each|a)\b/i.test(s)) return 3;
  if (/\btwice (?:per|each|a)\b/i.test(s)) return 2;
  if (/\bonce (?:per|each|a|that)\b/i.test(s)) return 1;
  return null;
}

/** The rank written nearest before a link ("You gain 3rd-rank X and 2nd-rank Y"), else the one rank in the sentence. */
function rankFor(s, at) {
  const all = [...s.matchAll(RANK)].map(m => ({ r: Number(m[1]), at: m.index }));
  if (!all.length) return null;
  if (all.length === 1) return all[0].r;
  return [...all].reverse().find(x => x.at < at)?.r ?? all[0].r;
}

// someone else's innate spell ("Your eidolon can cast …", "They can cast …") is not the character's
const OTHERS = /\b(?:eidolon|familiar|companion|minion|mount)s?\b|^(?:They|It|He|She)\b/i;
const isInnate = s => /\binnate\b/i.test(s) && /\b(?:spells?|cantrips?)\b/i.test(s) && !/^If\b/.test(s) && !/\binnately\b/i.test(s) && !OTHERS.test(s);
// "You can cast this spell once per day." right after a pick: an ancestry's spells are innate even where the text doesn't say so
const castsPick = s => /\byou can cast (?:this|that|the chosen|your chosen|these|those|each of these)\b/i.test(s) && usesIn(s) !== null;
// "Choose arcane, divine, or occult." — the list a later "one cantrip from that magical tradition's spell list" means
const TRAD_CHOICE = /^(?:choose|select)\s+((?:arcane|divine|occult|primal)(?:\s*,\s*(?:or\s+)?(?:arcane|divine|occult|primal)|\s+or\s+(?:arcane|divine|occult|primal))+)\s*\.?$/i;
// a tradition only the character's draconic benefactor (kobold) tells
const BENEFACTOR = "benefactor";
const CHOSEN_LIST = /\bfrom (?:that (?:magical )?tradition's|the chosen|your chosen)(?: spells?)? list\b/i;

/** "Choose one cantrip from the arcane spell list", "Select one 1st-rank arcane spell and one 2nd-rank or lower arcane spell" → picks. */
function listPicks(s, chosen = []) {
  const m = /\b(choose|select|gain)\s+(.*)$/i.exec(s);
  if (!m) return [];
  const out = [];
  for (const part of m[2].split(/\s+and\s+(?=(?:one|two|three|a|an)\b)/i)) {
    const p = PART.exec(part.trim());
    if (!p) return [];
    const rest = p[9] ?? "";
    const from = FROM_LIST.exec(rest);
    const traditions = [p[5], from?.[1], from?.[2]].filter(Boolean).map(x => x.toLowerCase());
    if (CHOSEN_LIST.test(rest)) traditions.push(...chosen);
    // "a cantrip or 1st-rank spell from the same tradition as …", "from those listed for …": no list to offer; "… for a dragon spellcaster of your draconic benefactor's type": the benefactor's tradition.
    if (!traditions.length && /\bdraconic benefactor\b/i.test(rest)) traditions.push(BENEFACTOR);
    if (!traditions.length && /\bor\s+\d|\bother than\b|\bsame\b|\bthose\b/i.test(rest)) return [];
    if (/^gain$/i.test(m[1]) && !traditions.length) return [];
    const cantrip = !!p[6];
    const rank = cantrip ? 0 : Number(p[3] ?? p[7] ?? 0) || null;
    out.push({ type: "list", count: COUNT[p[1].toLowerCase()] ?? 1, cantrip, rank, orLower: !!(p[4] || p[8]), common: !!p[2], traditions });
  }
  // "one 1st-rank spell and one 2nd-rank spell from the occult spells list": the list named last is everyone's
  const last = out.at(-1)?.traditions ?? [];
  for (const o of out) if (!o.traditions.length) o.traditions = [...last];
  return out.filter(o => o.cantrip || o.rank);
}

/**
 * Grants in an item's English text, in order (n = their place, the key a pick is saved under):
 * { n, kind: "innate", type: "fixed"|"options"|"list", spells | options | count, cantrip, rank, orLower, common, traditions, uses } or { n, kind: "choice", options: [uuid], count, main }; uses: 0 at will, n per day, null not said.
 */
export function parseGrants(html) {
  const { paras, links } = sentencesOf(html);
  const out = [];
  const push = g => { g.n = out.length; out.push(g); return g; };
  const choice = p => push({ kind: "choice", options: p.options, count: p.count, main: !!p.main });
  // a pick in one paragraph, cast in the next ("During your daily preparations, choose A, B or C." ¶ "… you can cast this spell …")
  let carry = null;
  // "You gain your choice of one warden spell from these initial warden spells." ¶ A ¶ B ¶ C
  let listed = null;
  // "… one of the following features which grant an innate primal spell …" ¶ Anteater … [Grim Tendrils] ¶ Cat Sith … [Pest Form]
  let innateListed = null;
  for (const sentences of paras) {
    const only = sentences.join(" ").replace(/§\d+§/g, "").replace(/[\s,.;:()—–-]+/g, "");
    if (listed && !only && marks(sentences.join(" ")).length) { listed.options.push(...marks(sentences.join(" ")).map(m => links[m.i])); continue; }
    if (listed) { if (listed.options.length >= 2) choice(listed); listed = null; }
    const first = marks(sentences.join(" "))[0];
    if (innateListed && first) { innateListed.options.push(links[first.i]); continue; }
    if (innateListed) { if (innateListed.options.length >= 2) push(innateListed); innateListed = null; }
    let pending = null;
    let last = [];
    let tradChoice = [];
    if (carry) {
      const first = sentences[0] ?? "";
      if (isInnate(first) && !marks(first).length && REFERS_BACK.test(first)) pending = [carry]; else choice(carry);
      carry = null;
    }
    for (const s of sentences) {
      const ms = marks(s).filter(m => !NOT_GRANTED.test(s.slice(Math.max(0, m.at - 30), m.at)));
      const tc = TRAD_CHOICE.exec(s.trim());
      if (tc) { tradChoice = tradsIn(tc[1]); continue; }
      const choose = CHOOSE.test(s) && !/^If\b/.test(s);
      if (choose && ms.length) {
        const many = /\b(two|three) of\b/i.exec(s);
        const pick = { type: "options", options: ms.map(m => links[m.i]), count: many ? COUNT[many[1].toLowerCase()] : 1 };
        if (isInnate(s)) {
          last = [push({ kind: "innate", ...pick, traditions: tradsIn(s), uses: usesIn(s), rank: rankFor(s, Infinity) })];
          pending = null;
        } else pending = [pick];
        continue;
      }
      if (!ms.length && /\b(?:choose|select|gain)\b/i.test(s) && !/^If\b/.test(s)) {
        const picks = listPicks(s, tradChoice);
        if (picks.length) {
          pending = picks;
          if (!isInnate(s)) continue;
        }
      }
      if (!isInnate(s) && !(pending && pending[0].type !== "fixed" && castsPick(s))) {
        // "your choice of the A hex or B hex", "You gain A, B, or another 1st-rank qi spell": a choice (resolved by the caller)
        const or = ms.length >= 2 && /\bor\b/i.test(s.slice(ms.at(-2).at, ms.at(-1).at + 8));
        if (or && !/^If\b/.test(s) && /\b(?:your choice of|choice between|either|gain|learn)\b/i.test(s)) choice({ options: ms.map(m => links[m.i]), count: 1, main: /\bfamiliar (?:also )?learns\b/i.test(s) });
        else if (!ms.length && /\byour choice of (?:one|a|an)\b|\bchoose one of the following\b/i.test(s) && /[.:]$/.test(s)) listed = { options: [], count: 1 };
        else if (ms.length && /\b(?:gain|learn)\b/i.test(s)) pending = [{ type: "fixed", spells: ms.map(m => ({ uuid: links[m.i], rank: rankFor(s, m.at) })) }];
        // "You can cast each of these spells once per day." after an innate grant
        else if (!ms.length && last.length && REFERS_BACK.test(s) && /\bcast\b/i.test(s) && usesIn(s) !== null) for (const g of last) g.uses = usesIn(s);
        continue;
      }
      const traditions = tradsIn(s);
      const uses = usesIn(s);
      if (ms.length) {
        last = [push({ kind: "innate", type: "fixed", spells: ms.map(m => ({ uuid: links[m.i], rank: rankFor(s, m.at) })), traditions, uses })];
        pending = null;
      } else if (!pending && /\bone of the following\b/i.test(s)) {
        innateListed = { kind: "innate", type: "options", options: [], count: 1, traditions, uses, rank: rankFor(s, Infinity) };
      } else if (pending) {
        last = pending.map(p => push({
          kind: "innate", ...p, uses,
          traditions: p.traditions?.length ? p.traditions : traditions,
          ...(p.type === "options" ? { rank: rankFor(s, Infinity) } : {}),
          ...(p.type === "fixed" ? { spells: p.spells.map(x => ({ ...x, rank: x.rank ?? rankFor(s, Infinity) })) } : {}),
          ...(p.type === "list" && !p.rank && rankFor(s, Infinity) ? { rank: rankFor(s, Infinity) } : {})
        }));
        pending = null;
      } else if (last.length && REFERS_BACK.test(s)) {
        // "You can cast each of these arcane innate spells once per day."
        for (const g of last) {
          if (uses !== null) g.uses = uses;
          if (!g.traditions.length) g.traditions = traditions;
        }
      }
    }
    if (pending?.[0]?.type === "options") carry = pending[0];
  }
  if (innateListed?.options.length >= 2) push(innateListed);
  // "Choose one of the following: A, B or C." with nothing innate after it: an ordinary choice
  if (carry) choice(carry);
  if (listed?.options.length >= 2) choice(listed);
  return out;
}

/** Korean text (a translation with no English original to read): links in a "선천" sentence only. */
export function parseGrantsKorean(html) {
  const { paras, links } = sentencesOf(html);
  const local = TRADITIONS.map(tr => [tr, String(traditionLabel(tr) ?? "")]).filter(([, l]) => l && !/^[a-z]+$/i.test(l));
  const out = [];
  for (const s of paras.flat()) {
    if (!/선천/.test(s)) continue;
    const ms = marks(s);
    if (!ms.length) continue;
    const traditions = local.filter(([, l]) => s.includes(l)).map(([tr]) => tr);
    const uses = /자유롭게|원하는\s*만큼|무제한/.test(s) ? 0 : /(?:세|3)\s*번/.test(s) ? 3 : /(?:두|2)\s*번/.test(s) ? 2 : /(?:한|1)\s*번|1회/.test(s) ? 1 : null;
    const rank = Number(/(\d+)\s*랭크/.exec(s)?.[1]) || null;
    out.push({ n: out.length, kind: "innate", type: "fixed", spells: ms.map(m => ({ uuid: links[m.i], rank })), traditions, uses });
  }
  return out;
}

/** What an item's text grants (the English original when there is one). */
export function grantsIn(html, slug = "") {
  if (slug && ODD[slug]) return foundry.utils.deepClone(ODD[slug]);
  const out = parseGrants(html);
  return out.length || !/[가-힣]/.test(String(html ?? "")) ? out : parseGrantsKorean(html);
}

/** The slug a pick is saved under (the same for the pack's item, its translated mirror and the sheet's copy). */
export function holderSlug(doc) {
  return String(doc?.system?.slug || sluggify(originalName(doc ?? {}) || doc?.name || "")).replace(/\./g, "~");
}

export const grantKey = (doc, n) => `${holderSlug(doc)}|${n}`;

/* ---------------- what the plan says ---------------- */

export function picksFor(plan, key) {
  const list = plan?.spells?.grants?.[key];
  return Array.isArray(list) ? list.filter(r => r?.uuid) : [];
}

const slugOf = d => d?.system?.slug ?? d?.slug ?? null;
const isCantripDoc = d => (d?.system?.traits?.value ?? []).includes("cantrip");
const baseRank = d => Number(d?.system?.level?.value ?? 1) || 1;

/** The tradition of a character's draconic benefactor (kobold): what its ancestry feature's question was answered. */
function benefactorOf(actor) {
  const own = actor?.flags?.pf2e?.draconicBenefactor?.tradition;
  if (own) return own;
  for (const i of actor?.items ?? []) {
    const tr = i.flags?.pf2e?.rulesSelections?.draconicBenefactor?.tradition;
    if (tr) return tr;
  }
  return null;
}

/** "Choose one of the following features …" answered in the item's own question (Fey Influence: { creature, spell }). */
function answeredSpell(doc, options) {
  for (const v of Object.values(doc.flags?.pf2e?.rulesSelections ?? {})) {
    const hit = v && typeof v === "object" && options.find(o => slugOf(o) === v.spell);
    if (hit) return [{ uuid: hit.uuid, name: hit.name, img: hit.img, slug: slugOf(hit) }];
  }
  return [];
}

/** Grants of one holder, with the spells looked up: [{ key, holder, level, …grant, spells: [{ doc, rank }], options: [doc], picked: [ref] }]. */
async function resolveHolder(doc, english, level, plan, { benefactor = null } = {}) {
  const out = [];
  for (const raw of grantsIn(english, holderSlug(doc))) {
    if (raw.kind !== "innate") continue;
    // the benefactor's tradition when it is known, else any (the pick's own tradition is used then)
    const g = { ...raw, traditions: raw.traditions.flatMap(tr => (tr === BENEFACTOR ? (benefactor ? [benefactor] : TRADITIONS) : [tr])) };
    const key = grantKey(doc, g.n);
    const view = { ...g, key, holder: doc, level, spells: [], options: [], picked: picksFor(plan, key) };
    if (g.type === "fixed") {
      for (const s of g.spells) {
        const d = await getDoc(s.uuid);
        if (d?.type === "spell") view.spells.push({ doc: d, rank: s.rank });
      }
      if (!view.spells.length) continue;
    } else if (g.type === "options") {
      for (const u of g.options) {
        const d = await getDoc(u);
        if (d?.type === "spell") view.options.push(d);
      }
      if (!view.options.length) continue;
      if (!view.picked.length) view.picked = answeredSpell(doc, view.options);
      const chosen = new Set(view.picked.flatMap(r => [r.uuid, r.slug]).filter(Boolean));
      view.spells = view.options.filter(d => chosen.has(d.uuid) || chosen.has(slugOf(d))).slice(0, g.count).map(d => ({ doc: d, rank: g.rank }));
    } else {
      if (!g.traditions.length) continue; // "from the list of your draconic benefactor": nothing to list from
      for (const r of view.picked.slice(0, g.count)) {
        const d = await getDoc(r.uuid);
        if (d?.type === "spell") view.spells.push({ doc: d, rank: !g.cantrip && g.rank && !g.orLower ? g.rank : null });
      }
    }
    out.push(view);
  }
  return out;
}

/** The plan's innate grants up to a level (before the character exists, or for levels to come). */
export async function planGrants(plan, level) {
  const benefactor = benefactorOf(plan?.sheet?.actorId ? game.actors?.get(plan.sheet.actorId) : null);
  const holders = [];
  const add = async (ref, lv) => {
    if (!ref?.uuid || lv > level) return;
    const d = await getDoc(ref.uuid);
    if (d) holders.push({ doc: d, level: lv });
  };
  await add(plan.ancestry, 1);
  await add(plan.heritage, 1);
  await add(plan.background, 1);
  // the features an ancestry or class grants by itself (PF2e puts them on the sheet)
  for (const ref of [plan.ancestry, plan.class, dualActive() ? plan.class2 : null]) {
    const owner = ref ? await getDoc(ref.uuid) : null;
    for (const it of Object.values(owner?.system?.items ?? {})) await add(it, Number(it?.level ?? 1) || 1);
  }
  for (const [slot, ref] of Object.entries(plan.feats ?? {})) if (ref && slotInUse(slot)) await add(ref, slotLevel(slot));
  const out = [];
  const seen = new Set();
  for (const h of holders) {
    if (seen.has(h.doc.uuid)) continue;
    seen.add(h.doc.uuid);
    out.push(...await resolveHolder(h.doc, await englishOfDoc(h.doc), h.level, plan, { benefactor }));
  }
  return out;
}

/* ---------------- on the sheet ---------------- */

const HOLDERS = new Set(["feat", "heritage", "ancestry", "background"]);
export const grantOf = sp => sp?.flags?.[MID]?.grant ?? null;

/** The tradition the spell is cast as: the text's, else one the spell has. */
function traditionFor(g, doc) {
  const own = doc.system?.traits?.traditions ?? [];
  return g.traditions.find(tr => own.includes(tr)) ?? g.traditions[0] ?? own[0] ?? "arcane";
}

export function innateEntryName(tradition) {
  const type = game.i18n.localize(CONFIG.PF2E?.preparationType?.innate ?? "PF2E.PreparationTypeInnate");
  const trad = traditionLabel(tradition);
  return game.i18n.has?.("PF2E.SpellCastingFormat") ? game.i18n.format("PF2E.SpellCastingFormat", { preparationType: type, traditionSpells: trad })
    : t("Spells.InnateEntryName", { tradition: trad });
}

/** Spells the sheet should have from its items' innate grants, and the flagged ones it should lose. */
export async function innateDiff(actor, plan) {
  const items = actor.items.filter(i => HOLDERS.has(i.type));
  const wanted = [];
  const keep = new Set();
  const benefactor = benefactorOf(actor);
  for (const item of items) {
    for (const g of await resolveHolder(item, await englishText(item), item.level ?? 1, plan, { benefactor })) {
      // a pick not made yet (or a plan without it): what this grant put on the sheet before stays
      if (g.type !== "fixed" && !g.picked.length) { keep.add(`${item.id}|${g.key}`); continue; }
      for (const { doc, rank } of g.spells) wanted.push({ item, key: g.key, doc, tradition: traditionFor(g, doc), uses: isCantripDoc(doc) ? null : (g.uses || 1), rank });
    }
  }
  const spells = actor.itemTypes?.spell ?? [];
  const entries = new Map((actor.itemTypes?.spellcastingEntry ?? []).map(e => [e.id, e]));
  const mine = spells.filter(sp => grantOf(sp)?.kind === "innate");
  const same = (sp, w) => (slugOf(sp) && slugOf(sp) === slugOf(w.doc)) || sourceIdOf(sp) === w.doc.uuid;
  const remove = mine.filter(sp => {
    const g = grantOf(sp);
    if (!actor.items.has(g.item)) return true;
    if (keep.has(`${g.item}|${g.key}`)) return false;
    return !wanted.some(w => w.item.id === g.item && w.key === g.key && same(sp, w));
  });
  const add = wanted.filter(w => !mine.some(sp => !remove.includes(sp) && grantOf(sp).item === w.item.id && grantOf(sp).key === w.key && same(sp, w))
    // put there by hand in an innate entry of that tradition: already done
    && !spells.some(sp => !grantOf(sp) && same(sp, w) && entries.get(sp.system?.location?.value)?.system?.prepared?.value === "innate"
      && entries.get(sp.system?.location?.value)?.system?.tradition?.value === w.tradition));
  return { add, remove };
}

/** The innate entry of a tradition: the builder's own first, else one the player made. */
function innateEntryOf(actor, tradition) {
  const list = (actor.itemTypes?.spellcastingEntry ?? []).filter(e => e.system?.prepared?.value === "innate" && e.system?.tradition?.value === tradition);
  return list.find(e => e.flags?.[MID]?.innate) ?? list[0] ?? null;
}

/** Put the innate spells on the sheet (and take off what its items no longer grant). Lines for the summary. */
export async function syncInnate(actor, plan) {
  if (actor?.type !== "character") return [];
  const done = [];
  const { add, remove } = await innateDiff(actor, plan);
  if (remove.length) {
    const ids = remove.map(sp => sp.id).filter(id => actor.items.has(id));
    if (ids.length) await actor.deleteEmbeddedDocuments("Item", ids);
    done.push(t("Spells.GrantRemoved", { list: remove.map(sp => sp.name).join(", ") }));
  }
  const byTrad = new Map();
  for (const w of add) byTrad.set(w.tradition, [...(byTrad.get(w.tradition) ?? []), w]);
  for (const [tradition, list] of byTrad) {
    let entry = innateEntryOf(actor, tradition);
    if (!entry) {
      [entry] = await actor.createEmbeddedDocuments("Item", [{
        type: "spellcastingEntry", name: innateEntryName(tradition),
        system: { tradition: { value: tradition }, prepared: { value: "innate" }, ability: { value: "cha" }, proficiency: { value: 1 } },
        flags: { [MID]: { innate: tradition } }
      }]);
      done.push(t("Spells.InnateEntryMade", { name: entry.name }));
    }
    const sources = list.map(w => {
      const src = w.doc.toObject();
      delete src._id;
      src._stats = { ...(src._stats ?? {}), compendiumSource: w.doc.uuid };
      const location = { ...(src.system.location ?? {}), value: entry.id };
      if (w.uses) location.uses = { value: w.uses, max: w.uses };
      if (w.rank && w.rank > baseRank(w.doc) && !isCantripDoc(w.doc)) location.heightenedLevel = w.rank;
      src.system.location = location;
      src.flags = { ...(src.flags ?? {}), [MID]: { ...(src.flags?.[MID] ?? {}), grant: { item: w.item.id, key: w.key, kind: "innate" } } };
      return src;
    });
    const made = await actor.createEmbeddedDocuments("Item", sources);
    done.push(...made.map(m => m.name));
  }
  await dropEmptyInnate(actor);
  return done;
}

/** The builder's innate entries left with no spells go. */
async function dropEmptyInnate(actor) {
  const spells = actor.itemTypes?.spell ?? [];
  const empty = (actor.itemTypes?.spellcastingEntry ?? []).filter(e => e.flags?.[MID]?.innate && !spells.some(sp => sp.system?.location?.value === e.id));
  if (empty.length) await actor.deleteEmbeddedDocuments("Item", empty.map(e => e.id));
}

/** Items left the sheet: the spells they granted go too (innate and class spells the builder added). */
export async function dropGranted(actor, itemIds) {
  const gone = new Set(itemIds);
  const ids = (actor.itemTypes?.spell ?? []).filter(sp => { const g = grantOf(sp); return g?.item && gone.has(g.item) && !actor.items.has(g.item); }).map(sp => sp.id);
  if (ids.length) await actor.deleteEmbeddedDocuments("Item", ids);
  await dropEmptyInnate(actor);
  return ids.length;
}

/** Spells the builder added for an item that is no longer on the sheet (it was replaced before this ran). */
export async function dropOrphans(actor) {
  const ids = (actor.itemTypes?.spell ?? []).filter(sp => { const g = grantOf(sp); return g?.item && !actor.items.has(g.item); }).map(sp => sp.id);
  if (ids.length) await actor.deleteEmbeddedDocuments("Item", ids);
  return ids.length;
}

