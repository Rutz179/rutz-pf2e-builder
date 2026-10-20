import { MID, setting } from "./util.mjs";
import { getDoc, queryPackAllowed } from "./data.mjs";
import { entryOf } from "./rules.mjs";
import { activePlanId, decodeChoiceKey, picksOf, plansOf } from "./plan.mjs";

/* ======================================================================== *
 * An item's questions (PF2e ChoiceSet rule elements) answered in the builder.
 *
 *  - Fixed lists (Fighter: Acrobatics or Athletics, CONFIG lists …) and
 *    compendium questions ("one of the Bard muses", "a cleric doctrine" …)
 *    are both offered, the latter from the same packs PF2e's compendium
 *    browser uses (no English duplicates when a translation mirrors them).
 *  - The class's features count too: their questions are asked where the
 *    class is chosen, not after the character is made.
 *  - When PF2e adds the item (at creation, or a class feature at level-up),
 *    the answer from the character's plan is handed to the rule, so PF2e does
 *    not open its own window. Unanswered questions ask as usual.
 *  - Setting "PF2e 선택창 정리": PF2e's own windows list each option once,
 *    from the packs the compendium browser uses.
 * ======================================================================== */

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
  for (const t of entryOf(idx, plan.ancestry)?.traits ?? []) out.add(`self:trait:${t}`);
  for (const ref of Object.values(plan.feats ?? {})) if (ref?.slug) out.add(`feat:${ref.slug}`);
  return out;
}

/** Options of a compendium question, from the allowed packs. null: can't tell here (PF2e asks later). */
async function queryChoices(rule, plan, level, idx) {
  const c = rule.choices;
  const Predicate = game.pf2e?.Predicate;
  if (!Predicate) return null;
  let predicate;
  try { predicate = new Predicate(foundry.utils.deepClone(c.filter)); } catch (_) { return null; }
  if (/\{(actor|item|rule)\|/.test(JSON.stringify(c.filter))) return null;
  const type = c.itemType ?? "feat";
  const all = game.packs.filter(p => p.documentName === "Item");
  const packs = c.pack ? all.filter(p => p.collection === c.pack) : all.filter(p => queryPackAllowed(p, all));
  const actorOptions = planOptions(plan, level, idx);
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

/** Options of one ChoiceSet: a list, or null when only PF2e can answer it (at creation). */
export async function ruleChoices(rule, plan, level, idx) {
  if (rule?.key !== "ChoiceSet") return null;
  if (isQuery(rule)) return queryChoices(rule, plan, level, idx);
  return staticChoices(rule);
}

/**
 * The items whose questions belong to a chosen thing: the thing itself and,
 * for a class (or ancestry/heritage …), the features it grants up to `upTo`.
 * Each: { key (uuid answers are stored under), slug, name, level, doc }.
 */
export async function questionHolders(doc, idx, upTo = 20, key = null) {
  if (!doc) return [];
  const out = [{ key: key ?? doc.uuid, slug: doc.system?.slug ?? null, name: doc.name, level: 1, doc }];
  if (!["class", "ancestry", "heritage", "background"].includes(doc.type)) return out;
  const entries = Object.values(doc.system?.items ?? {}).filter(i => i?.uuid && (Number(i.level ?? 1) || 1) <= upTo)
    .sort((a, b) => (Number(a.level) || 1) - (Number(b.level) || 1));
  for (const i of entries) {
    const d = await getDoc(i.uuid);
    if (!(d?.system?.rules ?? []).some(r => r?.key === "ChoiceSet")) continue;
    out.push({ key: i.uuid, slug: d.system?.slug ?? null, name: d.name, level: Number(i.level ?? 1) || 1, doc: d });
  }
  void idx;
  return out;
}

/** Every question of these holders with its options and the plan's answer. */
export async function questionsOf(holders, plan, level, idx) {
  const out = [];
  for (const h of holders) {
    const picks = picksOf(plan, h.key);
    const rules = h.doc.system?.rules ?? [];
    for (let i = 0; i < rules.length; i++) {
      const r = rules[i];
      if (r?.key !== "ChoiceSet") continue;
      const options = await ruleChoices(r, plan, Math.max(level, h.level), idx);
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

function planFor(actor) {
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
