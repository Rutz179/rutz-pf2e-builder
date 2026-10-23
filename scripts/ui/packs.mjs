import { MID, esc, t } from "../util.mjs";
import { autoPackState, autoSpellState, invalidateIndex, isSpellPack, packRules, worldItemsMode } from "../data.mjs";
import { forgetQueryIndex } from "../choices.mjs";
import { refreshBuilders } from "./builder.mjs";

/* ======================================================================== *
 * "컴펜디움 고르기" (settings menu): every Item pack, ticked when the builder
 * reads it. Ticked by default: packs named for what the builder needs, minus
 * companion modules (Companion Compendia …), packs switched off in PF2e's
 * compendium browser and system packs a translation mirrors. The GM can tick
 * or untick any of them; only the differences from that default are saved.
 * On top: whether homebrew in the world's Items tab is read too.
 * ======================================================================== */

const WHY = { name: "WhyName", companion: "WhyCompanion", browser: "WhyBrowser", mirror: "WhyMirror", system: "WhySystem" };

function packageLabel(pack) {
  const id = pack.metadata.packageName ?? pack.metadata.package ?? "";
  if (pack.metadata.packageType === "system") return game.system.title ?? id;
  if (pack.metadata.packageType === "world") return game.world.title ?? id;
  return game.modules.get(id)?.title ?? id;
}

export class PackChooser extends foundry.applications.api.ApplicationV2 {
  static DEFAULT_OPTIONS = {
    id: "rpb-packs",
    classes: ["rpb-packs"],
    tag: "form",
    window: { title: "RPB.Packs.Title", icon: "fa-solid fa-book-atlas", resizable: true },
    position: { width: 640, height: 680 },
    form: { handler: PackChooser.#save, closeOnSubmit: true }
  };

  async _renderHTML() {
    const all = game.packs.filter(p => p.documentName === "Item");
    const { include, exclude } = packRules();
    const groups = new Map();
    for (const pack of all) {
      const auto = isSpellPack(pack) ? autoSpellState(pack, all) : autoPackState(pack, all);
      const on = !exclude.includes(pack.collection) && (include.includes(pack.collection) || auto.use);
      const label = packageLabel(pack);
      if (!groups.has(label)) groups.set(label, []);
      groups.get(label).push({ pack, auto, on, changed: on !== auto.use });
    }
    const body = [...groups].map(([label, rows]) => `<fieldset><legend>${esc(label)}</legend>${rows.map(({ pack, auto, on, changed }) => `
      <label class="rpb-pack ${changed ? "changed" : ""}">
        <input type="checkbox" name="${esc(pack.collection)}" ${on ? "checked" : ""} data-auto="${auto.use ? 1 : 0}">
        <span class="nm">${esc(pack.metadata.label ?? pack.title)}</span>
        <code>${esc(pack.collection)}</code>
        ${auto.why && auto.why !== "type" ? `<span class="why">${esc(t(`Packs.${WHY[auto.why] ?? "WhyName"}`))}</span>` : ""}
      </label>`).join("")}</fieldset>`).join("");
    const mode = worldItemsMode();
    const count = game.items?.filter(i => ["ancestry", "heritage", "background", "class", "feat", "deity", "spell"].includes(i.type)).length ?? 0;
    const world = `<fieldset class="rpb-world"><legend>${esc(t("Packs.World"))}</legend>
      <p class="hint">${esc(t("Packs.WorldHint", { n: count }))}</p>
      ${["all", "visible", "off"].map(v => `<label class="rpb-pack" data-world="${v}">
        <input type="radio" name="__worldItems" value="${v}" ${mode === v ? "checked" : ""}>
        <span class="nm">${esc(t(`Packs.World_${v}`))}</span></label>`).join("")}
    </fieldset>`;
    return `<div class="rpb-packs-body">
      <p class="hint">${t("Packs.Hint")}</p>
      ${world}
      ${body}
    </div>
    <footer class="form-footer">
      <button type="button" data-action="reset"><i class="fa-solid fa-rotate-left"></i> ${t("Packs.Reset")}</button>
      <button type="submit"><i class="fa-solid fa-floppy-disk"></i> ${t("Packs.Save")}</button>
    </footer>`;
  }

  _replaceHTML(result, content) {
    content.innerHTML = result;
    content.querySelector("[data-action=reset]")?.addEventListener("click", () => {
      for (const box of content.querySelectorAll("input[type=checkbox]")) box.checked = box.dataset.auto === "1";
      const all = content.querySelector("input[name=__worldItems][value=all]");
      if (all) all.checked = true;
    });
  }

  static async #save(_event, form) {
    const include = [];
    const exclude = [];
    for (const box of form.querySelectorAll("input[type=checkbox]")) {
      const auto = box.dataset.auto === "1";
      if (box.checked && !auto) include.push(box.name);
      if (!box.checked && auto) exclude.push(box.name);
    }
    const world = form.querySelector("input[name=__worldItems]:checked")?.value ?? "all";
    if (world !== game.settings.get(MID, "worldItems")) await game.settings.set(MID, "worldItems", world);
    await game.settings.set(MID, "packRules", { include, exclude });
    invalidateIndex();
    forgetQueryIndex();
    refreshBuilders();
    ui.notifications.info(t("Packs.Saved"));
  }
}
