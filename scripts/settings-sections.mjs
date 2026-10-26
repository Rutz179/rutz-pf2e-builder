import { MID, t } from "./util.mjs";

/* ======================================================================== *
 * Configure Settings: this module's settings in groups — a divider and a
 * short heading over each group (registration order keeps each group
 * together). "menu:key" is a settings-menu button: Foundry puts menus first,
 * so it is moved under its group's heading. A group with nothing on screen
 * (a Plus-only group in Lite) gets no heading.
 * ======================================================================== */

const CLS = "rpb-settings-section";
const GROUPS = [
  ["Players", ["charactersPerPlayer", "ownership", "promptNewPlayers", "allowLevelUp", "allowRebuild"]],
  ["NewChar", ["startLevel", "folder", "imageFolder"]],
  ["Lists", ["rarityLimit", "hideLegacy", "tidyChoices"]],
  ["Plans", ["maxPlans", "levelUpCard"]],
  ["Spells", ["levelCantrips", "autoClassSpells", "slotClassBonus", "slotArchetype", "slotStrays"]],
  ["Data", ["menu:packMenu", "packs", "translationModule", "translationUrl"]]
];

function rowOf(root, key) {
  const menu = key.startsWith("menu:");
  const id = `${MID}.${menu ? key.slice(5) : key}`;
  const el = menu
    ? root.querySelector(`[data-key="${id}"]`)
    : root.querySelector(`[data-setting-id="${id}"]`) ?? root.querySelector(`[name="${id}"]`);
  return el?.closest?.(".form-group") ?? null;
}

export function addSettingsSections(app, html) {
  const root = html instanceof HTMLElement ? html : html?.[0] ?? (app?.element instanceof HTMLElement ? app.element : null);
  if (!root?.querySelector) return;
  for (const [label, keys] of GROUPS) {
    const mark = `${MID}:${label}`;
    if (root.querySelector(`[data-rutz-section="${mark}"]`)) continue;
    const found = keys.map(k => ({ menu: k.startsWith("menu:"), row: rowOf(root, k) })).filter(f => f.row);
    if (!found.length) continue;
    const settings = found.filter(f => !f.menu).map(f => f.row);
    const menus = found.filter(f => f.menu).map(f => f.row);
    // The group's first row on screen.
    const first = (settings.length ? settings : menus)
      .reduce((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_PRECEDING ? b : a));
    const head = document.createElement("h4");
    head.className = CLS;
    head.dataset.rutzSection = mark;
    head.textContent = t(`Settings.Section.${label}`);
    first.before(head);
    if (settings.length && menus.length) head.after(...menus);
  }
}
