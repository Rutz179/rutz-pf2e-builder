import { MID, esc, t } from "./util.mjs";
import { PackChooser } from "./ui/packs.mjs";

/*
 * The builder's settings window. Foundry's list holds one button (registerMenu "config"); every setting is config: false and lives here in three tabs, with a heading over each group; "menu:packs" is a row opening the compendium chooser.
 * A change saves at once through game.settings.set; players see only client-scope settings (none yet, so the button is GM only).
 */

/** [tab, [[section, [keys]]]] — every named setting is in exactly one row (or on INTERNAL). */
export const LAYOUT = [
  ["players", [
    ["Players", ["charactersPerPlayer", "ownership", "promptNewPlayers", "allowLevelUp", "allowRebuild"]],
    ["NewChar", ["startLevel", "folder", "imageFolder"]]
  ]],
  ["build", [
    ["Lists", ["rarityLimit", "hideLegacy", "tidyChoices"]],
    ["Plans", ["maxPlans", "levelUpCard"]],
    ["Spells", ["levelCantrips", "autoClassSpells", "slotClassBonus", "slotArchetype", "slotStrays"]]
  ]],
  ["data", [
    ["Data", ["menu:packs", "translationModule", "translationUrl"]]
  ]]
];

/** Settings with no row: kept by other windows or plainly internal (packs: the legacy typed list, read by the pack chooser). */
export const INTERNAL = ["packs", "packRules", "homebrewCasting", "worldItems", "translationNoticeSeen"];

/** Buttons inside the window that open another window. */
const MENUS = {
  packs: { name: "Settings.PacksMenu", hint: "Settings.PacksMenuHint", label: "Settings.PacksMenuLabel", icon: "fa-solid fa-book-atlas", open: () => new PackChooser().render({ force: true }) }
};

/** Foundry's registered setting for a key of this module, or null. */
function registered(key, all = game.settings.settings) {
  return all?.get?.(`${MID}.${key}`) ?? null;
}

/** How a setting is edited: a toggle, a select, a number box or (folder, path, URL, module id) a text box. */
export function kindOf(cfg) {
  if (cfg?.choices && Object.keys(cfg.choices).length) return "select";
  if (cfg?.type === Boolean) return "bool";
  if (cfg?.type === Number) return "number";
  return "text";
}

/** What the window shows: [{ id, sections: [{ id, rows: [{ key, name, hint, kind, choices, range, value, client } | { menu, kind: "menu", … }] }] }]; gm: the viewer is a GM (else only client rows, no menus). */
export function settingsView({ all = game.settings.settings, get = k => game.settings.get(MID, k), gm = game.user?.isGM } = {}) {
  const tabs = [];
  for (const [tab, sections] of LAYOUT) {
    const secs = [];
    for (const [sec, keys] of sections) {
      const rows = [];
      for (const key of keys) {
        if (key.startsWith("menu:")) {
          const m = MENUS[key.slice(5)];
          if (m && gm) rows.push({ menu: key.slice(5), kind: "menu", name: t(m.name), hint: t(m.hint), label: t(m.label), icon: m.icon });
          continue;
        }
        const cfg = registered(key, all);
        if (!cfg || (!gm && cfg.scope !== "client")) continue;
        let value;
        try { value = get(key); } catch (_) { value = cfg.default; }
        rows.push({ key, name: cfg.name ?? key, hint: cfg.hint ?? "", kind: kindOf(cfg), choices: cfg.choices ?? null, range: cfg.range ?? null, value, client: cfg.scope === "client" });
      }
      if (rows.length) secs.push({ id: sec, rows });
    }
    if (secs.length) tabs.push({ id: tab, sections: secs });
  }
  return tabs;
}

/** A form value back to the setting's type: numbers kept in their range and step, choices only from the list. */
export function parseValue(cfg, raw) {
  const kind = kindOf(cfg);
  if (kind === "bool") return raw === true || raw === "true" || raw === "on";
  if (kind === "select") return Object.hasOwn(cfg.choices, String(raw)) ? String(raw) : cfg.default;
  if (kind === "number") {
    let n = Number(raw);
    if (raw === "" || raw === null || !Number.isFinite(n)) return cfg.default;
    const r = cfg.range;
    if (r) {
      if (Number.isFinite(r.step) && r.step > 0) n = Math.round((n - (r.min ?? 0)) / r.step) * r.step + (r.min ?? 0);
      n = Math.max(r.min ?? -Infinity, Math.min(r.max ?? Infinity, n));
      n = Math.round(n * 1000) / 1000;
    }
    return n;
  }
  return String(raw ?? "");
}

/** Save one row (the setting's own onChange runs). Returns the value saved. */
export async function saveRow(key, raw, { all = game.settings.settings } = {}) {
  const cfg = registered(key, all);
  if (!cfg) return undefined;
  const value = parseValue(cfg, raw);
  await game.settings.set(MID, key, value);
  return value;
}

/** Open the window a menu row points to (false for an unknown one). */
export function openMenu(id) {
  const m = MENUS[id];
  if (!m) return false;
  m.open();
  return true;
}

function inputHtml(r) {
  if (r.kind === "menu") return `<button type="button" data-menu="${esc(r.menu)}"><i class="${esc(r.icon)}"></i> ${esc(r.label)}</button>`;
  const name = `data-key="${esc(r.key)}"`;
  if (r.kind === "bool") return `<input type="checkbox" ${name} ${r.value ? "checked" : ""}>`;
  if (r.kind === "select") return `<select ${name}>${Object.entries(r.choices).map(([k, l]) => `<option value="${esc(k)}" ${String(r.value) === k ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>`;
  if (r.kind === "number") {
    const g = r.range ?? {};
    return `<input type="number" ${name} value="${esc(r.value)}"${Number.isFinite(g.min) ? ` min="${g.min}"` : ""}${Number.isFinite(g.max) ? ` max="${g.max}"` : ""} step="${Number.isFinite(g.step) ? g.step : "any"}">`;
  }
  return `<input type="text" ${name} value="${esc(r.value)}">`;
}

export function settingsHtml(tabs, current) {
  const tab = tabs.find(x => x.id === current) ?? tabs[0];
  if (!tab) return `<div class="rpb-set"><p class="rpb-hint">${t("Settings.Nothing")}</p></div>`;
  const nav = tabs.length > 1 ? `<nav>${tabs.map(x => `<button type="button" data-tab="${x.id}" class="${x === tab ? "on" : ""}">${t(`Settings.Tab.${x.id}`)}</button>`).join("")}</nav>` : "";
  const body = tab.sections.map(s => `<section><h4>${t(`Settings.Section.${s.id}`)}</h4>
    ${s.rows.map(r => `<div class="srow k-${r.kind}"><div class="tx"><b>${esc(r.name)}</b>${r.hint ? `<small>${esc(r.hint)}</small>` : ""}</div><div class="in">${inputHtml(r)}</div></div>`).join("")}</section>`).join("");
  return `<div class="rpb-set" data-tab="${tab.id}">${nav}<div class="body">${body}</div></div>`;
}

export class BuilderSettings extends foundry.applications.api.ApplicationV2 {
  static DEFAULT_OPTIONS = { id: "rpb-settings", classes: ["rpb-app", "rpb-settings-win"], window: { title: "RPB.Settings.Window", icon: "fa-solid fa-sliders", resizable: true }, position: { width: 580, height: 620 } };

  constructor(options = {}) {
    // Foundry makes a new one for each click on the menu button: the one already open comes forward instead.
    const open = foundry.applications.instances?.get?.("rpb-settings");
    if (open) {
      try { open.bringToFront?.(); } catch (_) { /* nothing to do */ }
      return open;
    }
    super(options);
    this.tab = "players";
  }

  async _renderHTML() {
    const tabs = settingsView();
    if (!tabs.some(x => x.id === this.tab)) this.tab = tabs[0]?.id ?? "players";
    return settingsHtml(tabs, this.tab);
  }

  _replaceHTML(result, content) {
    const top = content.querySelector(".body")?.scrollTop ?? 0;
    const same = content.querySelector(".rpb-set")?.dataset.tab === this.tab;
    content.innerHTML = result;
    if (same && top) content.querySelector(".body").scrollTop = top;
  }

  _onFirstRender() {
    const root = this.element.querySelector(".window-content");
    root.addEventListener("click", ev => {
      const m = ev.target.closest("button[data-menu]");
      if (m) return void openMenu(m.dataset.menu);
      const b = ev.target.closest("button[data-tab]");
      if (!b) return;
      this.tab = b.dataset.tab;
      this.render();
    });
    root.addEventListener("change", async ev => {
      const el = ev.target;
      const key = el.dataset?.key;
      if (!key) return;
      const v = await saveRow(key, el.type === "checkbox" ? el.checked : el.value);
      // a number out of its range: the box shows what was kept
      if (el.type === "number" && v !== undefined && String(v) !== el.value) el.value = v;
    });
  }
}

/** The one entry in Foundry's list. Players may open it only when a setting of their own computer has a row. */
export function registerSettingsMenu() {
  const keys = LAYOUT.flatMap(([, secs]) => secs.flatMap(([, k]) => k)).filter(k => !k.startsWith("menu:"));
  const client = keys.some(k => registered(k)?.scope === "client");
  game.settings.registerMenu(MID, "config", {
    name: t("Settings.Menu"), label: t("Settings.MenuLabel"), hint: t("Settings.MenuHint"),
    icon: "fa-solid fa-sliders", type: BuilderSettings, restricted: !client
  });
}
