import { MID, setting } from "./util.mjs";
import { getDoc, peekDoc, queryPackAllowed } from "./data.mjs";
import { entryOf } from "./rules.mjs";
import { activePlanId, decodeChoiceKey, picksOf, plansOf } from "./plan.mjs";

/*
 * An item's questions (PF2e ChoiceSet) answered in the builder: fixed lists and compendium questions (from the packs PF2e's browser uses), including the class features' questions.
 * When PF2e adds the item, the plan's answer is handed to the rule so PF2e opens no window. Assurance also offers Lore skills (PF2e's list has the 16 skills only).
 */

const QUERY_FIELDS = ["system.slug", "system.level.value", "system.category", "system.traits.value", "system.traits.otherTags", "system.traits.rarity"];
const packIndex = new Map();

export function staticChoices(rule) {
  let c = rule?.choices;
  if (c && typeof c === "object" && !Array.isArray(c) && typeof c.config === "string") c = c.config;
  if (Array.isArray(c)) {
    const list = c.filter(x => x && (typeof x.value === "string" || typeof x.value === "number"));
    return list.length ? list.map(x => {
      const v = String(x.value);
      const o = { value: v, label: labelOf(x) };
      if (/^Compendium\./.test(v)) {
        o.uuid = v;
        try { o.img = fromUuidSync(v)?.img ?? x.img ?? null; } catch (_) { o.img = x.img ?? null; }
      }
      return o;
    }) : null;
  }
  if (typeof c === "string") {
    const obj = foundry.utils.getProperty(CONFIG.PF2E, c.replace(/^CONFIG\.PF2E\./, ""));
    if (obj && typeof obj === "object") return Object.entries(obj).map(([k, v]) => ({ value: k, label: game.i18n.localize(typeof v === "string" ? v : v?.label ?? k) }));
  }
  return null;
}

function labelOf(x) {
  const v = String(x.value);
  if (x.label) return game.i18n.localize(x.label);
  if (/^(Compendium|Item)\./.test(v)) {
    try { return fromUuidSync(v)?.name ?? v; } catch (_) { return v; }
  }
  return game.i18n.localize(v);
}

function isQuery(rule) {
  const c = rule?.choices;
  return !!c && typeof c === "object" && !Array.isArray(c) && (Array.isArray(c.filter) || (c.filter && typeof c.filter === "object"));
}

async function indexOf(pack) {
  if (packIndex.has(pack.collection)) return packIndex.get(pack.collection);
  let list = [];
  try { list = [...await pack.getIndex({ fields: QUERY_FIELDS })]; } catch (_) { list = []; }
  const out = list.map(e => {
    const s = e.system ?? {};
    const slug = s.slug || game.pf2e?.system?.sluggify?.(e.name) || "";
    const traits = Array.isArray(s.traits?.value) ? s.traits.value : [];
    const tags = Array.isArray(s.traits?.otherTags) ? s.traits.otherTags : [];
    const level = Number(s.level?.value ?? 0) || 0;
    const options = new Set([
      `item:type:${e.type}`, `item:slug:${slug}`, `item:${slug}`, `item:level:${level}`, `item:rarity:${s.traits?.rarity ?? "common"}`,
      ...traits.flatMap(t => [`item:trait:${t}`, `item:${t}`]), ...tags.map(t => `item:tag:${t}`),
      ...(s.category ? [`item:category:${s.category}`, `${e.type}:category:${s.category}`] : [])
    ]);
    return { uuid: e.uuid ?? `Compendium.${pack.collection}.Item.${e._id}`, name: e.name, img: e.img, type: e.type, slug, level, options, system: pack.metadata.packageType === "system" };
  });
  packIndex.set(pack.collection, out);
  return out;
}

/** Roll options the plan would give (enough for the usual "class:bard" style conditions). */
function planOptions(plan, level, idx) {
  const out = new Set([`self:level:${level}`]);
  const add = (kind, ref) => {
    const slug = entryOf(idx, ref)?.slug ?? ref?.slug;
    if (!slug) return;
    out.add(`${kind}:${slug}`); out.add(`self:${kind}:${slug}`);
  };
  add("ancestry", plan.ancestry); add("heritage", plan.heritage); add("background", plan.background); add("class", plan.class); add("deity", plan.deity);
  if (plan.class2) add("class", plan.class2);
  for (const t of entryOf(idx, plan.ancestry)?.traits ?? []) out.add(`self:trait:${t}`);
  for (const ref of Object.values(plan.feats ?? {})) if (ref?.slug) out.add(`feat:${ref.slug}`);
  return out;
}

/** Options of a compendium question, from the allowed packs. null: can't tell here (PF2e asks later). */
async function queryChoices(rule, plan, level, idx, extra = []) {
  const c = rule.choices;
  const Predicate = game.pf2e?.Predicate;
  if (!Predicate) return null;
  let predicate;
  try { predicate = new Predicate(foundry.utils.deepClone(c.filter)); } catch (_) { return null; }
  if (/\{(actor|item|rule)\|/.test(JSON.stringify(c.filter))) return null;
  const type = c.itemType ?? "feat";
  const all = game.packs.filter(p => p.documentName === "Item");
  const packs = c.pack ? all.filter(p => p.collection === c.pack) : all.filter(p => queryPackAllowed(p, all));
  const actorOptions = new Set([...planOptions(plan, level, idx), ...extra]);
  const found = new Map();
  for (const pack of packs) {
    for (const e of await indexOf(pack)) {
      if (e.type !== type) continue;
      if (!predicate.test(new Set([...e.options, ...actorOptions]))) continue;
      const key = e.slug || e.uuid;
      const prev = found.get(key);
      if (!prev || (prev.system && !e.system)) found.set(key, e);
    }
  }
  if (!found.size) return null;
  const lang = game.i18n.lang;
  return [...found.values()].sort((a, b) => a.level - b.level || a.name.localeCompare(b.name, lang))
    .map(e => ({ value: c.slugsAsValues ? e.slug : e.uuid, label: e.name, img: e.img, uuid: e.uuid }));
}

/** "One of your deity's domains" (Domain Initiate, Deity's Domain): the plan's deity's domains, as PF2e lists them. */
async function domainChoices(plan) {
  const deity = plan?.deity?.uuid ? await getDoc(plan.deity.uuid) : null;
  const list = deity?.system?.domains?.primary ?? [];
  if (!list.length) return null;
  const conf = CONFIG.PF2E?.deityDomains ?? {};
  const out = list.flatMap(d => [d, ...(conf[`${d}-apocryphal`] ? [`${d}-apocryphal`] : [])]);
  return out.map(d => ({ value: d, label: game.i18n.localize(conf[d]?.label ?? d) }));
}

/** A ChoiceSet that takes Lore skills as well as the 16 (Assurance: "a skill you're trained in"). */
export function takesLores(rule) {
  const c = rule?.choices;
  return rule?.flag === "assurance" && !!c && typeof c === "object" && !Array.isArray(c) && c.config === "skills";
}

/** PF2e's key of a Lore skill, from its name ("Warfare Lore" → "warfare-lore"; LorePF2e#slug). */
export function loreSlug(name) {
  const sl = game.pf2e?.system?.sluggify ?? (v => String(v ?? "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""));
  const s = sl(String(name ?? ""));
  return /\blore\b/.test(s) ? s : `${s}-lore`;
}

/** "warfare-lore" → "Warfare Lore" (a Lore that is in the plan but not on a sheet yet). */
export function loreLabel(slug) {
  return String(slug ?? "").split("-").filter(Boolean).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

/** The Lore skills to offer: the plan's background Lore, and the trained ones on the character the plan belongs to. */
export function loreChoices(plan, idx) {
  const out = new Map();
  for (const name of entryOf(idx, plan?.background)?.trained?.lore ?? []) if (name) out.set(loreSlug(name), String(name));
  const actor = plan?.id ? game.actors?.find?.(a => plansOf(a).some(p => p.id === plan.id)) : null;
  for (const sk of Object.values(actor?.skills ?? {})) if (sk?.lore && (Number(sk.rank) || 0) >= 1 && sk.slug) out.set(sk.slug, sk.label ?? loreLabel(sk.slug));
  return [...out].map(([value, label]) => ({ value, label }));
}

/** Options of one ChoiceSet: a list, or null when only PF2e can answer it (at creation). */
export async function ruleChoices(rule, plan, level, idx, extra = []) {
  if (rule?.key !== "ChoiceSet") return null;
  if (isQuery(rule)) return queryChoices(rule, plan, level, idx, extra);
  if (rule.choices === "system.details.deities.domains") return domainChoices(plan);
  const list = staticChoices(rule);
  if (!list || !takesLores(rule)) return list;
  const have = new Set(list.map(o => o.value));
  return [...list, ...loreChoices(plan, idx).filter(o => !have.has(o.value))];
}

const isUuid = v => typeof v === "string" && /^Compendium\./.test(v);

/** Does this item hand over what its ChoiceSet `flag` picked (GrantItem "{item|flags.system.rulesSelections.<flag>}")? */
function grantsPick(doc, flag) {
  if (!flag) return false;
  return (doc?.system?.rules ?? []).some(r => r?.key === "GrantItem" && String(r.uuid ?? "").includes(`rulesSelections.${flag}}`));
}

/** The roll option a ChoiceSet sets from its answer ("kinetic-gate:initial:single-gate"; an item answer by its slug). */
async function pickOption(rule, value) {
  if (!rule?.rollOption || value === undefined || value === null || value === "") return null;
  if (isUuid(value)) {
    const d = peekDoc(value) ?? await getDoc(value);
    const slug = d?.system?.slug || game.pf2e?.system?.sluggify?.(d?.name ?? "") || "";
    return slug ? `${rule.rollOption}:${slug}` : null;
  }
  return `${rule.rollOption}:${value}`;
}

/** The items whose questions belong to a chosen thing: itself and, for a class or ancestry, the features it grants up to `upTo`. Each { key (answer key, uuid), slug, name, level, doc }. */
export async function questionHolders(doc, idx, upTo = 20, key = null, plan = null) {
  if (!doc) return [];
  const out = [{ key: key ?? doc.uuid, slug: doc.system?.slug ?? null, name: doc.name, level: 1, doc }];
  if (["class", "ancestry", "heritage", "background"].includes(doc.type)) {
    const entries = Object.values(doc.system?.items ?? {}).filter(i => i?.uuid && (Number(i.level ?? 1) || 1) <= upTo)
      .sort((a, b) => (Number(a.level) || 1) - (Number(b.level) || 1));
    for (const i of entries) {
      const d = await getDoc(i.uuid);
      if (!(d?.system?.rules ?? []).some(r => r?.key === "ChoiceSet")) continue;
      out.push({ key: i.uuid, slug: d.system?.slug ?? null, name: d.name, level: Number(i.level ?? 1) || 1, doc: d });
    }
  }
  // An answer can hand over items with questions of their own (a kineticist's gate → the element's impulse feats): follow the plan's answers a GrantItem passes on, a few steps deep.
  if (plan) {
    const seen = new Set(out.map(h => h.key));
    for (let n = 0; n < out.length && out.length < 40; n++) {
      const h = out[n];
      if ((h.depth ?? 0) >= 3) continue;
      const picks = picksOf(plan, h.key);
      const rules = h.doc.system?.rules ?? [];
      for (let i = 0; i < rules.length; i++) {
        const r = rules[i];
        const v = picks[i];
        if (r?.key !== "ChoiceSet" || !isUuid(v) || seen.has(v) || !grantsPick(h.doc, r.flag)) continue;
        seen.add(v);
        const d = await getDoc(v);
        if (!d || !(d.system?.rules ?? []).some(x => x?.key === "ChoiceSet")) continue;
        out.push({ key: v, slug: d.system?.slug ?? null, name: d.name, level: h.level, doc: d, granter: h, depth: (h.depth ?? 0) + 1 });
      }
    }
  }
  void idx;
  return out;
}

/** Every question of these holders with its options and the plan's answer. */
export async function questionsOf(holders, plan, level, idx) {
  const out = [];
  // Roll options the answers so far set ("kinetic-gate:initial:single-gate"): later questions may depend on them.
  const answered = new Set();
  for (const h of holders) {
    const picks = picksOf(plan, h.key);
    const rules = h.doc.system?.rules ?? [];
    for (let i = 0; i < rules.length; i++) {
      if (rules[i]?.key !== "ChoiceSet") continue;
      const o = await pickOption(rules[i], picks[i]);
      if (o) answered.add(o);
    }
  }
  const Predicate = game.pf2e?.Predicate;
  const known = new Set([...planOptions(plan, level, idx), ...answered]);
  for (const h of holders) {
    const picks = picksOf(plan, h.key);
    const rules = h.doc.system?.rules ?? [];
    for (let i = 0; i < rules.length; i++) {
      const r = rules[i];
      if (r?.key !== "ChoiceSet") continue;
      // A question that only applies in some cases (the second element of a dual gate): skip it when it doesn't.
      if (Predicate && Array.isArray(r.predicate) && r.predicate.length) {
        let applies = true;
        try { applies = new Predicate(foundry.utils.deepClone(r.predicate)).test(known); } catch (_) { applies = true; }
        if (!applies) continue;
      }
      const extra = [...answered, `parent:granter:level:${h.granter?.level ?? h.level}`];
      const options = await ruleChoices(r, plan, Math.max(level, h.level), idx, extra);
      out.push({
        holder: h, rule: i, options,
        label: game.i18n.localize(r.prompt ?? r.label ?? "PF2E.UI.RuleElements.ChoiceSet.Prompt"),
        value: picks[i] ?? ""
      });
    }
  }
  return out;
}

/* ---------------- handing the answers to PF2e ---------------- */

const live = new Map(); // actor id → plan being applied right now

export function answering(actor, plan) {
  if (plan) live.set(actor.id, plan); else live.delete(actor.id);
}

/** Is the builder putting a plan on this character right now (on this client)? */
export function isAnswering(actor) {
  return !!actor && live.has(actor.id);
}

export function planFor(actor) {
  if (!actor) return null;
  if (live.has(actor.id)) return live.get(actor.id);
  const plans = plansOf(actor);
  return plans.find(p => p.id === activePlanId(actor)) ?? plans.find(p => p.base === "sheet") ?? null;
}

function answerFor(rule) {
  const item = rule.item;
  const plan = planFor(rule.actor ?? item?.actor);
  if (!plan?.choices || !item) return undefined;
  const index = Number.isInteger(rule.sourceIndex) ? rule.sourceIndex : (item._source?.system?.rules ?? []).findIndex(r => r?.key === "ChoiceSet" && r?.flag === rule.flag);
  if (index < 0) return undefined;
  const ids = new Set([item.sourceId, item._stats?.compendiumSource, item.flags?.core?.sourceId, item.uuid].filter(Boolean));
  let fallback;
  for (const [key, picks] of Object.entries(plan.choices)) {
    const v = picks?.[index];
    if (v === undefined || v === "") continue;
    if (ids.has(decodeChoiceKey(key))) return v;
    if (fallback === undefined && picks._slug && picks._slug === item.slug) fallback = v;
  }
  return fallback;
}

function dedupe(choices) {
  const korean = game.i18n.lang === "ko";
  const out = new Map();
  for (const c of choices) {
    const key = typeof c.value === "string" || typeof c.value === "number" ? String(c.value) : JSON.stringify(c.value);
    const prev = out.get(key);
    if (!prev) { out.set(key, c); continue; }
    if (korean && /[가-힣]/.test(c.label ?? "") && !/[가-힣]/.test(prev.label ?? "")) out.set(key, c);
  }
  return [...out.values()];
}

function allowedChoice(c, all) {
  const m = /^Compendium\.([^.]+\.[^.]+)\./.exec(typeof c.value === "string" ? c.value : "");
  if (!m) return true;
  const pack = game.packs.get(m[1]);
  return !pack || queryPackAllowed(pack, all);
}

export function installChoiceHooks() {
  const CS = game.pf2e?.RuleElements?.builtin?.ChoiceSet;
  if (!CS?.prototype || CS.prototype.__rpbWrapped) return;
  CS.prototype.__rpbWrapped = true;

  const preCreate = CS.prototype.preCreate;
  if (typeof preCreate === "function") {
    CS.prototype.preCreate = async function (args) {
      try {
        if (this.selection === null || this.selection === undefined || this.selection === "") {
          const v = answerFor(this);
          if (v !== undefined) this.selection = v;
        }
      } catch (err) {
        console.warn(`${MID} | choice answer`, err);
      }
      return preCreate.call(this, args);
    };
  }

  // Assurance: Lore skills are added to PF2e's list too (its window and the plan's answer); otherwise a Lore answer isn't among PF2e's choices and its window opens again.
  const inflate = CS.prototype.inflateChoices;
  if (typeof inflate === "function") {
    CS.prototype.inflateChoices = async function (...args) {
      const asks = takesLores({ flag: this.flag, choices: this.choices });   // read before PF2e replaces the question with its list
      const result = await inflate.apply(this, args);
      if (!asks || !Array.isArray(result)) return result;
      try {
        const have = new Set(result.map(c => c.value));
        for (const sk of Object.values(this.actor?.skills ?? {})) {
          if (!sk?.lore || !(Number(sk.rank) >= 1) || !sk.slug || have.has(sk.slug)) continue;
          result.push({ value: sk.slug, label: sk.label ?? loreLabel(sk.slug) });
          have.add(sk.slug);
        }
        // the plan's Lore that isn't on the sheet yet (a background's Lore comes after the feats at creation)
        const v = this.selection;
        if (typeof v === "string" && v && !have.has(v) && !(v in (CONFIG.PF2E?.skills ?? {})) && /(^|-)lore$/.test(v)) result.push({ value: v, label: loreLabel(v) });
      } catch (err) {
        console.warn(`${MID} | lore choices`, err);
      }
      return result;
    };
  }

  const query = CS.prototype.queryCompendium;
  if (typeof query === "function") {
    CS.prototype.queryCompendium = async function (...args) {
      const result = await query.apply(this, args);
      if (!setting("tidyChoices", true) || !Array.isArray(result) || args[0]?.pack) return result;
      try {
        const all = game.packs.filter(p => p.documentName === "Item");
        const kept = dedupe(result.filter(c => allowedChoice(c, all)));
        return kept.length ? kept : result;
      } catch (_) {
        return result;
      }
    };
  }
}

export function forgetQueryIndex() {
  packIndex.clear();
}
