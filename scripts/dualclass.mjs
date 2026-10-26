import { sluggify } from "./util.mjs";

/* ======================================================================== *
 * Dual-class characters, through the "Dual Class Items (PF2e)" module
 * (pf2e-dual-class-items, Foundry v14). When it is active and its world
 * setting "Enable Dual Class" is on, the builder plans a second class and
 * puts it on the sheet the way that module expects:
 *
 *  - a second real class item, added right after the first (the module is
 *    armed first, so PF2e doesn't replace the first class); the module flags
 *    it, merges proficiencies and HP, gives each class its class DC and key
 *    attribute boost, and grants the second class's features on level-up;
 *  - the second class's class feats in the module's ladder, location
 *    "dc-class-<slug>-<level>" (the plan calls those slots "class2-<level>");
 *  - skill feats, general feats, ancestry feats and skill increases at every
 *    level either class gives them, in the system's own slots.
 *
 * Without that module the builder plans one class, as before.
 * ======================================================================== */

export const DCI = "pf2e-dual-class-items";

/** Is dual class available in this world (the module is active and switched on)? */
export function dualActive() {
  if (!game.modules?.get(DCI)?.active) return false;
  try { return game.settings.get(DCI, "moduleEnabled") === true; } catch (_) { return false; }
}

/** The character's second class item (the module's first "extra" class). */
export function secondClassItem(actor) {
  if (!actor || actor.type !== "character") return null;
  const flags = actor.flags?.[DCI] ?? {};
  const ids = Array.isArray(flags.extraClasses) ? flags.extraClasses : typeof flags.secondaryClass === "string" ? [flags.secondaryClass] : [];
  for (const id of ids) {
    const item = actor.items?.get(id);
    if (item?.type === "class") return item;
  }
  return null;
}

/** The first class: the class item that isn't an extra one (PF2e's own actor.class otherwise). */
export function firstClassItem(actor) {
  const second = secondClassItem(actor);
  if (!second) return actor?.class ?? null;
  return actor.itemTypes?.class?.find(c => c.id !== second.id) ?? actor.class ?? null;
}

const slugOf = ref => ref?.slug || sluggify(ref?.name ?? "");

/** Where a planned slot goes on the sheet: "class2-4" → "dc-class-wizard-4"; anything else as it is. */
export function slotLocation(slotId, plan) {
  const m = /^class2-(\d+)$/.exec(String(slotId));
  return m && plan?.class2 ? `dc-class-${slugOf(plan.class2)}-${m[1]}` : slotId;
}

/** The plan's slot for a feat's location on the sheet: "dc-class-wizard-4" → "class2-4" (for that second class). */
export function slotFromLocation(location, secondSlug) {
  const m = /^dc-class-(.+)-(\d+)$/.exec(String(location ?? ""));
  return m && secondSlug && m[1] === secondSlug ? `class2-${m[2]}` : location;
}

/** A planned slot that counts now (second-class slots only while dual class is on). */
export function slotInUse(slotId) {
  return !/^class2-/.test(String(slotId)) || dualActive();
}

/** Tell the module the next class added to this actor is a second class (not a replacement). */
export function armSecondClass(actor) {
  try { game.modules.get(DCI)?.api?.armSecondClass?.(actor); } catch (_) { /* it keeps a second class by default anyway */ }
}

/** Flags a character made in memory (previews) needs for the module to treat it as dual-class. */
export function previewFlags(secondId) {
  return { [DCI]: { extraClasses: [secondId] } };
}
