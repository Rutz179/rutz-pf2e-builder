import { ATTRS, MAX_LEVEL, attrLabel, esc, rankLabel, signed, skillLabel, skillSlugs, t } from "../util.mjs";
import { previewStats, statsOf } from "../preview.mjs";
import { slotLevel } from "../rules.mjs";

/* ======================================================================== *
 * Compare: the character as it is now next to its plans, at any level.
 * "What does my fighter look like at 13 — and what if I'd gone
 * swashbuckler?" Each column is worked out by PF2e (see preview.mjs);
 * numbers better than the first column are green, worse are red.
 * ======================================================================== */

class CompareApp extends foundry.applications.api.ApplicationV2 {
  static DEFAULT_OPTIONS = {
    classes: ["rpb-app", "rpb-compare-app"],
    window: { resizable: true, icon: "fa-solid fa-scale-balanced" },
    position: { width: 980, height: 760 }
  };

  constructor({ actor, plans, level }) {
    super({ id: `rpb-compare-${actor?.id ?? "new"}`, window: { title: t("Compare.Title", { name: actor?.name ?? t("Plan.DraftName") }) } });
    this.actor = actor;
    this.plans = plans;
    this.level = level;
    this.picked = new Set(plans.slice(0, 3).map(p => p.id));
    this.columns = null;
  }

  async _renderHTML() {
    if (!this.columns) { this._compute(); return `<div class="rpb-loading"><i class="fa-solid fa-spinner fa-spin"></i> ${t("Overview.Computing")}</div>`; }
    return this.html();
  }

  _replaceHTML(result, content) { content.innerHTML = result; }

  _onRender() {
    if (this._wired) return;
    this._wired = true;
    this.element.addEventListener("change", ev => {
      const el = ev.target;
      if (el.dataset.a === "level") { this.level = Number(el.value) || 1; this.columns = null; this.render(); }
      if (el.dataset.a === "pick") { if (el.checked) this.picked.add(el.value); else this.picked.delete(el.value); this.columns = null; this.render(); }
    });
  }

  async _compute() {
    if (this._busy) return;
    this._busy = true;
    const cols = [];
    if (this.actor) cols.push({ name: t("Compare.Now", { level: this.actor.level }), stats: statsOf(this.actor), now: true });
    for (const p of this.plans) {
      if (!this.picked.has(p.id)) continue;
      cols.push({ name: p.name || t("Plan.Unnamed"), plan: p, stats: await previewStats(p, this.level, p.base === "sheet" ? this.actor : null) });
    }
    this.columns = cols;
    this._busy = false;
    this.render();
  }

  html() {
    const cols = this.columns;
    const base = cols[0]?.stats;
    const diff = (v, b) => (typeof v !== "number" || typeof b !== "number" || v === b) ? "" : v > b ? "up" : "down";
    const cell = (v, b, text = v) => `<td class="${diff(v, b)}">${esc(text ?? "—")}</td>`;
    const rows = [];
    const row = (label, get, fmt = x => x) => rows.push(`<tr><th>${esc(label)}</th>${cols.map(c => { const v = c.stats?.error ? null : get(c.stats); return cell(v, get(base), v === null || v === undefined ? "—" : fmt(v)); }).join("")}</tr>`);
    const head = cols.map(c => `<th class="col">${esc(c.name)}${c.plan ? `<small>${esc([c.plan.ancestry?.name, c.plan.class?.name].filter(Boolean).join(" · "))}</small>` : ""}</th>`).join("");
    row(t("Stat.Level"), s => s.level);
    row(t("Stat.HP"), s => s.hp);
    row(t("Stat.AC"), s => s.ac);
    row(game.i18n.localize("PF2E.PerceptionLabel"), s => s.perception?.mod, signed);
    for (const k of ["fortitude", "reflex", "will"]) row(game.i18n.localize(CONFIG.PF2E.saves?.[k] ?? k), s => s.saves?.[k]?.mod, signed);
    row(t("Stat.ClassDC"), s => s.classDC);
    rows.push(`<tr class="sep"><th colspan="${cols.length + 1}">${t("Compare.Attributes")}</th></tr>`);
    for (const a of ATTRS) row(attrLabel(a), s => s.attrs?.[a], signed);
    rows.push(`<tr class="sep"><th colspan="${cols.length + 1}">${t("Compare.Skills")}</th></tr>`);
    for (const k of skillSlugs()) {
      rows.push(`<tr><th>${esc(skillLabel(k))}</th>${cols.map(c => {
        const s = c.stats?.skills?.[k];
        const b = base?.skills?.[k];
        return `<td class="${diff(s?.mod, b?.mod)}">${s ? `${signed(s.mod)} <small class="rk r${s.rank}">${esc(rankLabel(s.rank))}</small>` : "—"}</td>`;
      }).join("")}</tr>`);
    }
    rows.push(`<tr class="sep"><th colspan="${cols.length + 1}">${t("Compare.Feats")}</th></tr>`);
    rows.push(`<tr class="feats"><th></th>${cols.map(c => `<td>${(c.stats?.feats ?? []).slice().sort((x, y) => (x.level ?? 0) - (y.level ?? 0))
      .map(f => `<div><small>${f.location && /-\d+$/.test(f.location) ? slotLevel(f.location) : f.level ?? ""}</small> ${esc(f.name)}</div>`).join("") || "—"}</td>`).join("")}</tr>`);
    const levelOpts = Array.from({ length: MAX_LEVEL }, (_, i) => `<option value="${i + 1}" ${i + 1 === this.level ? "selected" : ""}>Lv ${i + 1}</option>`).join("");
    const picks = this.plans.map(p => `<label><input type="checkbox" data-a="pick" value="${p.id}" ${this.picked.has(p.id) ? "checked" : ""}> ${esc(p.name || t("Plan.Unnamed"))}</label>`).join("");
    const errors = cols.filter(c => c.stats?.error).map(c => `<p class="rpb-dim">${esc(c.name)}: ${esc(c.stats.error)}</p>`).join("");
    return `<div class="rpb-compare">
      <div class="bar"><label>${t("Compare.Level")} <select data-a="level">${levelOpts}</select></label><div class="picks">${picks}</div></div>
      ${errors}
      <div class="wrap"><table><thead><tr><th></th>${head}</tr></thead><tbody>${rows.join("")}</tbody></table></div>
      <p class="rpb-hint">${t("Compare.Note")}</p>
    </div>`;
  }
}

export function openCompare(actor, plans, level) {
  new CompareApp({ actor, plans, level }).render(true);
}
