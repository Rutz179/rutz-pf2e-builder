/* Small helpers shared by every part of the builder. */

export const MID = "rutz-pf2e-builder";
export const ATTRS = ["str", "dex", "con", "int", "wis", "cha"];
export const MAX_LEVEL = 20;

/** RPB.* strings from lang/*.json. */
export function t(key, data) {
  const k = `RPB.${key}`;
  return data ? game.i18n.format(k, data) : game.i18n.localize(k);
}

export function esc(value) {
  return foundry.utils.escapeHTML(String(value ?? ""));
}

export function signed(n) {
  const v = Number(n) || 0;
  return v >= 0 ? `+${v}` : `${v}`;
}

export function randomId() {
  return foundry.utils.randomID();
}

export function setting(key, fallback = null) {
  try {
    const v = game.settings.get(MID, key);
    return v === undefined ? fallback : v;
  } catch (_) {
    return fallback;
  }
}

export function sluggify(text) {
  return game.pf2e?.system?.sluggify?.(String(text ?? "")) ?? String(text ?? "").toLowerCase().trim().replace(/[^a-z0-9가-힣]+/g, "-").replace(/^-|-$/g, "");
}

export function attrLabel(a) {
  const key = CONFIG.PF2E?.abilities?.[a];
  return key ? game.i18n.localize(key) : a.toUpperCase();
}

export function skillSlugs() {
  return Object.keys(CONFIG.PF2E?.skills ?? {});
}

export function skillLabel(slug) {
  if (slug === "perception") return game.i18n.localize("PF2E.PerceptionLabel");
  const c = CONFIG.PF2E?.skills?.[slug];
  return game.i18n.localize(typeof c === "string" ? c : c?.label ?? slug);
}

export function rankLabel(rank) {
  return game.i18n.localize(`PF2E.ProficiencyLevel${Number(rank) || 0}`);
}

export function rarityLabel(r) {
  const key = CONFIG.PF2E?.rarityTraits?.[r];
  return key ? game.i18n.localize(key) : r;
}

export function traitLabel(trait) {
  const key = CONFIG.PF2E?.featTraits?.[trait] ?? CONFIG.PF2E?.actionTraits?.[trait] ?? CONFIG.PF2E?.creatureTraits?.[trait] ?? CONFIG.PF2E?.classTraits?.[trait];
  return key ? game.i18n.localize(key) : trait;
}

export function sourceIdOf(item) {
  return item?._stats?.compendiumSource ?? item?.flags?.core?.sourceId ?? item?.sourceId ?? null;
}

const GLYPHS = { 1: "1", 2: "2", 3: "3", reaction: "r", free: "f" };
export function glyph(cost) {
  return GLYPHS[cost] ? `<span class="action-glyph">${GLYPHS[cost]}</span>` : "";
}

export function debounce(fn, ms = 150) {
  let timer = 0;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

/** Text editor (v13 namespaced, v12 global). */
export function enrich(html, options = {}) {
  const Editor = foundry.applications?.ux?.TextEditor?.implementation ?? globalThis.TextEditor;
  return Editor.enrichHTML(html ?? "", options).catch(() => html ?? "");
}

export function isPF2eCharacterType(actor) {
  return actor?.type === "character";
}
