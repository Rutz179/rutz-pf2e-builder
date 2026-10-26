import { ATTRS, attrLabel, esc, t } from "../util.mjs";
import { PRINTED_CASTERS, SLOT_TABLES, TRADITIONS, homebrew, homebrewSettings, homebrewSource, kindLabel, printedConfig, resolveCasting, saveHomebrew, traditionLabel } from "../spells.mjs";

/* ======================================================================== *
 * "이 클래스의 주문 시전 정하기" (GM): spells per day and how spells are
 * learned, for a homebrew class the builder has no table for. Saved in the
 * world by class slug, so it covers every character of that class here.
 * ======================================================================== */

function className(idx, slug) {
  return idx?.class?.find(e => e.slug === slug)?.name ?? slug.replace(/(^|-)([a-z])/g, (_m, a, b) => `${a ? " " : ""}${b.toUpperCase()}`);
}

// Printed classes that don't cast from slots (focus spells come from their features): no box for them.
const PRINTED_OTHERS = ["alchemist", "barbarian", "champion", "commander", "daredevil", "exemplar", "fighter", "guardian", "gunslinger", "inventor",
  "investigator", "kineticist", "monk", "ranger", "rogue", "runesmith", "slayer", "swashbuckler", "thaumaturge"];

/** Box in the spells step: what the builder knows about a class that isn't a printed caster. */
export function homebrewBoxHtml(entry, { editable, casting = null } = {}) {
  if (!entry?.slug || PRINTED_CASTERS.includes(entry.slug)) return "";
  const src = homebrewSource(entry.slug, entry.casting);
  if (!src && PRINTED_OTHERS.includes(entry.slug)) return "";
  const gm = game.user.isGM && editable !== false;
  if (!src && !gm && !casting?.tradition) return "";
  const btn = gm ? `<button type="button" data-a="hb-cast" data-uuid="${esc(entry.uuid ?? "")}"><i class="fa-solid fa-sliders"></i> ${t(src ? "Homebrew.Edit" : "Homebrew.Setup")}</button>` : "";
  if (src) {
    const h = homebrew(entry.slug, entry.casting);
    const what = `${h.tradition ? traditionLabel(h.tradition) : t("Homebrew.FromSubclass")} · ${kindLabel(h.mode)} · ${attrLabel(h.attr)} · ${t(`Homebrew.Slots_${h.table}`)} · ${t(`Homebrew.Learn_${h.learn.mode}`)}`;
    return `<div class="rpb-homebrew on"><p><i class="fa-solid fa-flask"></i> <b>${t(src === "setting" ? "Homebrew.FromGm" : "Homebrew.FromItem")}</b> ${esc(what)}</p>${btn}</div>`;
  }
  return `<div class="rpb-homebrew"><p><i class="fa-solid fa-flask"></i> <b>${esc(entry.name ?? "")}</b> — ${t(gm ? "Homebrew.NoTableGm" : "Homebrew.NoTable")}</p>${btn}</div>`;
}

/** The GM's form. Resolves true when something was saved or removed. */
export async function editHomebrewCasting(entry, idx) {
  const slug = entry?.slug;
  if (!slug || !game.user.isGM) return false;
  const current = homebrewSettings()[slug] ?? entry.casting ?? null;
  const r = resolveCasting(current) ?? resolveCasting({ mode: "prepared" });
  const v = { tradition: r.tradition ?? "", mode: r.mode, attr: r.attr, slots: r.table, learn: r.learn.mode,
    cantrips: r.learn.cantrips ?? 10, first: r.learn.first ?? 5, per: r.learn.per ?? 2 };
  const sel = (name, opts, cur) => `<select name="${name}">${opts.map(([val, label]) => `<option value="${esc(val)}" ${String(cur) === String(val) ? "selected" : ""}>${esc(label)}</option>`).join("")}</select>`;
  const like = sel("like", [["", t("Homebrew.LikeNone")], ...PRINTED_CASTERS.map(s => [s, className(idx, s)])], current?.like ?? "");
  const content = `<div class="rpb-hb-form">
    <p class="hint">${t("Homebrew.FormHint", { name: esc(entry.name ?? slug) })}</p>
    <div class="form-group"><label>${t("Homebrew.Like")}</label>${like}<p class="hint">${t("Homebrew.LikeHint")}</p></div>
    <div class="form-group"><label>${t("Spells.Tradition")}</label>${sel("tradition", [["", t("Homebrew.FromSubclass")], ...TRADITIONS.map(x => [x, traditionLabel(x)])], v.tradition)}</div>
    <div class="form-group"><label>${t("Spells.Mode")}</label>${sel("mode", [["prepared", kindLabel("prepared")], ["spontaneous", kindLabel("spontaneous")]], v.mode)}</div>
    <div class="form-group"><label>${t("Spells.Attr")}</label>${sel("attr", ATTRS.map(a => [a, attrLabel(a)]), v.attr)}</div>
    <div class="form-group"><label>${t("Homebrew.Slots")}</label>${sel("slots", SLOT_TABLES.map(x => [x, t(`Homebrew.Slots_${x}`)]), v.slots)}</div>
    <div class="form-group"><label>${t("Homebrew.Learn")}</label>${sel("learn", ["book", "rep", "list"].map(x => [x, t(`Homebrew.Learn_${x}`)]), v.learn)}</div>
    <div class="form-group rpb-hb-book"><label>${t("Homebrew.Book")}</label>
      <div class="form-fields"><input type="number" name="cantrips" min="0" max="20" value="${v.cantrips}" data-tooltip="${esc(t("Spells.Cantrips"))}">
      <input type="number" name="first" min="0" max="20" value="${v.first}" data-tooltip="${esc(t("Homebrew.First"))}">
      <input type="number" name="per" min="0" max="10" value="${v.per}" data-tooltip="${esc(t("Homebrew.Per"))}"></div>
      <p class="hint">${t("Homebrew.BookHint")}</p></div>
    <p class="hint">${t("Homebrew.WorldNote", { slug: esc(slug) })}</p>
  </div>`;
  const read = form => {
    const el = form.elements;
    return {
      ...(el.like.value ? { like: el.like.value } : {}),
      tradition: el.tradition.value || null, mode: el.mode.value, attr: el.attr.value, slots: el.slots.value, learn: el.learn.value,
      ...(el.learn.value === "book" ? { cantrips: Number(el.cantrips.value), first: Number(el.first.value), per: Number(el.per.value) } : {})
    };
  };
  const has = !!homebrewSettings()[slug];
  const buttons = [{ action: "save", label: t("Homebrew.Save"), icon: "fa-solid fa-floppy-disk", default: true, callback: (_ev, button) => read(button.form) }];
  if (has) buttons.push({ action: "remove", label: t("Homebrew.Remove"), icon: "fa-solid fa-trash" });
  buttons.push({ action: "cancel", label: t("Homebrew.Cancel") });
  const result = await foundry.applications.api.DialogV2.wait({
    window: { title: t("Homebrew.Title", { name: entry.name ?? slug }) }, position: { width: 520 }, classes: ["rpb-hb-dialog"], content, rejectClose: false, buttons,
    render: (_ev, dialog) => {
      const root = dialog?.element ?? dialog;
      const form = root?.querySelector?.("form") ?? root;
      const el = form?.elements;
      if (!el?.like) return;
      const book = () => { root.querySelector(".rpb-hb-book")?.classList.toggle("off", el.learn.value !== "book"); };
      el.learn.addEventListener("change", book);
      el.like.addEventListener("change", () => {
        const p = printedConfig(el.like.value);
        if (!p) return;
        el.tradition.value = p.tradition ?? ""; el.mode.value = p.mode; el.attr.value = p.attr; el.slots.value = p.slots; el.learn.value = p.learn;
        el.cantrips.value = p.cantrips; el.first.value = p.first; el.per.value = p.per;
        book();
      });
      book();
    }
  }).catch(() => null);
  if (result === "remove") { await saveHomebrew(slug, null); ui.notifications.info(t("Homebrew.Removed", { name: entry.name ?? slug })); return true; }
  if (!result || typeof result !== "object") return false;
  await saveHomebrew(slug, result);
  ui.notifications.info(t("Homebrew.Saved", { name: entry.name ?? slug }));
  return true;
}
