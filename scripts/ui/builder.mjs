import { ATTRS, MAX_LEVEL, MID, attrLabel, debounce, enrich, esc, glyph, rankLabel, rarityLabel, setting, signed, skillLabel, skillSlugs, t, traitLabel } from "../util.mjs";
import { getDoc, loadIndex, loadSpells, norm, refOf } from "../data.mjs";
import { TRADITIONS, casterDefaults, castingSummary, hasTable, isCantripRef, kindLabel, learnCount, learnText, maxSpellRank, plannedUuids, spellSlotsAt, slotsText, spellsAt, traditionLabel } from "../spells.mjs";
import { planSpells } from "../class-spells.mjs";
import {
  BOOST_LEVELS, ancestryBoostSlots, ancestryFlaws, attributes, backgroundBoostSlots, context, entryOf, featsForSlot,
  intBonusLevels, keyAttribute, levelOneSkills, maxRankAt, openItems, prereqState, progression, rarityAllowed, skillRanks, slotLevel, slotsAt
} from "../rules.mjs";
import { activePlanId, clearDraft, clonePlan, draftOf, lockedAt, maxPlans, newPlan, planFromActor, plansOf, picksOf, refreshSheetPlan, saveDraft, savePlans, setPick } from "../plan.mjs";
import { questionHolders, questionsOf } from "../choices.mjs";
import { previewStats } from "../preview.mjs";
import { applyCreation, applyRebuild, applyUpTo, pendingUpTo, rebuildLoss } from "../apply.mjs";
import { canCreateMore, canUpload, requestActor, uploadImage } from "../create.mjs";
import { openCompare } from "./compare.mjs";
import { deityAlignment } from "../deity-alignment.mjs";

/* ======================================================================== *
 * The builder window.
 *
 *   left   — the steps: 요약 · 선조 · 배경 · 클래스 · 능력치 · 기술 · Lv 1 … Lv 20
 *            (each with a dot: done / still open / fixed by the sheet)
 *   top    — the plans of this character (up to 5), preview level, compare
 *   middle — the step: a list to pick from with the details beside it, the
 *            boost table, the skill list, or a level's slots
 *
 * Every change is saved at once (on the character, or as the player's draft
 * for a character not made yet). Rendering is plain HTML strings.
 * ======================================================================== */

const STEPS = ["overview", "ancestry", "background", "class", "deity", "attributes", "skills", "spells"];
const NEXT = { ancestry: "background", background: "class", class: "deity", deity: "attributes", attributes: "skills", skills: "spells", spells: "level-1" };
const STEP_KEY = { ancestry: "AncestryOnly", heritage: "Heritage", background: "Background", class: "Class", deity: "Deity" };
const GROUP_ICON = { ancestry: "fa-dna", class: "fa-shield-halved", archetype: "fa-masks-theater", skill: "fa-screwdriver-wrench", general: "fa-star" };
const RARITY = ["common", "uncommon", "rare", "unique"];

function ownerOrDraft(actor) {
  return actor ? actor.isOwner : true;
}

/** Make any plan follow the character's sheet: what the sheet has is taken from it, the rest (later levels) kept. */
function toSheetPlan(plan, actor) {
  const base = planFromActor(actor, plan.name);
  return refreshSheetPlan({ ...base, id: plan.id, feats: plan.feats ?? {}, skills: plan.skills ?? base.skills, boosts: { ...(base.boosts ?? {}), ...(plan.boosts ?? {}) },
    choices: plan.choices ?? base.choices, spells: plan.spells ?? base.spells, notes: plan.notes ?? "", updated: Date.now() }, actor);
}

export class BuilderApp extends foundry.applications.api.ApplicationV2 {
  static DEFAULT_OPTIONS = {
    classes: ["rpb-app"],
    window: { resizable: true, icon: "fa-solid fa-compass-drafting" },
    position: { width: 1200, height: 800 }
  };

  constructor({ actor = null } = {}) {
    super({ id: actor ? `rpb-builder-${actor.id}` : "rpb-builder-new", window: { title: actor ? t("Window.TitleFor", { name: actor.name }) : t("Window.TitleNew") } });
    this.actor = actor;
    this.idx = null;
    this.plans = [];
    this.ui = {
      step: "overview", sub: "ancestry", planId: null, picker: null, detail: null, search: "", tab: null,
      onlyMet: true, legacy: true, rarity: new Set(RARITY), limit: 200, attrBoost: new Set(), flaw: "any",
      previewLevel: actor ? Math.max(1, actor.level ?? 1) : Math.max(1, Number(setting("startLevel", 1)) || 1)
    };
    this.detailCache = new Map();
    this._choiceQs = new Map();
    this.saveSoon = debounce(() => this.save(), 500);
    this.searchSoon = debounce(() => this.refreshList(), 120);
  }

  get plan() {
    return this.plans.find(p => p.id === this.ui.planId) ?? this.plans[0] ?? null;
  }

  get editable() {
    return ownerOrDraft(this.actor);
  }

  /* ---------------- loading & saving ---------------- */

  async _load() {
    if (this._loading) return;
    this._loading = true;
    this.idx = await loadIndex();
    if (this.actor) {
      let plans = plansOf(this.actor).map(p => refreshSheetPlan(p, this.actor));
      if (!plans.length) {
        plans = [planFromActor(this.actor, t("Plan.MainName"))];
        if (this.actor.isOwner) await savePlans(this.actor, plans, plans[0].id);
      }
      this.plans = plans;
      this.ui.planId = activePlanId(this.actor) ?? plans[0].id;
    } else {
      const draft = draftOf() ?? newPlan(t("Plan.DraftName"), "free");
      draft.meta ??= { charName: "", img: "", tokenImg: "", ring: true, userId: game.user.id };
      this.plans = [draft];
      this.ui.planId = draft.id;
    }
    this.render();
  }

  async save() {
    if (!this.plan || !this.editable) return;
    try {
      if (this.actor) await savePlans(this.actor, this.plans);
      else await saveDraft(this.plan);
    } catch (err) {
      console.warn(`${MID} | save`, err);
    }
  }

  mutate(fn, { rerender = true } = {}) {
    const plan = this.plan;
    if (!plan || !this.editable) return;
    fn(plan);
    plan.updated = Date.now();
    this.saveSoon();
    if (rerender) this.render();
  }

  /* ---------------- ApplicationV2 plumbing ---------------- */

  async _renderHTML() {
    if (!this.idx) {
      this._load();
      return `<div class="rpb-loading"><i class="fa-solid fa-spinner fa-spin"></i> ${t("Common.Loading")}</div>`;
    }
    return this.html();
  }

  _replaceHTML(result, content) {
    const keep = {};
    for (const sel of [".rpb-list", ".rpb-main", ".rpb-nav-steps", ".rpb-detail", ".rpb-level-main", ".rpb-pane", ".rpb-overview"]) keep[sel] = content.querySelector(sel)?.scrollTop ?? 0;
    content.innerHTML = result;
    if (this._sameView) for (const [sel, top] of Object.entries(keep)) { const el = content.querySelector(sel); if (el) el.scrollTop = top; }
  }

  _onRender(context, options) {
    super._onRender?.(context, options);
    const root = this.element;
    if (!this._wired) {
      this._wired = true;
      root.addEventListener("click", ev => this.onClick(ev));
      root.addEventListener("dblclick", ev => {
        const row = ev.target.closest("[data-a=peek]");
        if (row) this.choose(row.dataset.uuid);
      });
      root.addEventListener("input", ev => this.onInput(ev));
      root.addEventListener("change", ev => this.onChange(ev));
    }
    this._sameView = true;
    this.fillDetail();
    this.fillClassSpells();
    this.fillStats();
    this.fillNames();
  }

  /* ---------------- top level ---------------- */

  html() {
    const plan = this.plan;
    if (!plan) return `<p>${t("Common.NoPlan")}</p>`;
    return `<div class="rpb">
      <aside class="rpb-nav">${this.navHtml(plan)}</aside>
      <section class="rpb-body">
        <header class="rpb-top">${this.topHtml(plan)}</header>
        <div class="rpb-main">${this.mainHtml(plan)}</div>
      </section>
    </div>`;
  }

  navHtml(plan) {
    const idx = this.idx;
    const open = openItems(plan, MAX_LEVEL, idx);
    const openSteps = new Set(open.map(o => o.step));
    const cls = entryOf(idx, plan.class);
    const prog = progression(cls);
    const sheetLv = plan.base === "sheet" && !plan.unlocked ? plan.sheet?.level ?? 0 : 0;
    const label = {
      overview: `<i class="fa-solid fa-scroll"></i> ${t("Step.Overview")}`,
      ancestry: `<i class="fa-solid fa-dna"></i> ${t("Step.Ancestry")}`,
      background: `<i class="fa-solid fa-book-open"></i> ${t("Step.Background")}`,
      class: `<i class="fa-solid fa-shield-halved"></i> ${t("Step.Class")}`,
      deity: `<i class="fa-solid fa-sun"></i> ${t("Step.Deity")}`,
      spells: `<i class="fa-solid fa-wand-sparkles"></i> ${t("Step.Spells")}`,
      attributes: `<i class="fa-solid fa-chart-simple"></i> ${t("Step.Attributes")}`,
      skills: `<i class="fa-solid fa-list-check"></i> ${t("Step.Skills")}`
    };
    const value = {
      ancestry: [plan.ancestry?.name, plan.heritage?.name].filter(Boolean).join(" · "),
      background: plan.background?.name ?? "",
      class: plan.class?.name ?? "",
      deity: plan.deity?.name ?? "",
      spells: castingSummary(plan.spells?.casting)
    };
    const top = STEPS.map(s => {
      const locked = s !== "overview" && s !== "attributes" && s !== "skills" && plan.base === "sheet";
      const dot = s === "overview" ? "" : locked ? "lock" : openSteps.has(s) ? "open" : (s === "deity" && !plan.deity) || (s === "spells" && !plan.spells?.casting?.tradition) ? "" : "done";
      return `<button type="button" class="rpb-step ${this.ui.step === s ? "on" : ""}" data-a="step" data-step="${s}">
        <span class="lbl">${label[s]}</span>${value[s] ? `<small>${esc(value[s])}</small>` : ""}<span class="dot ${dot}"></span></button>`;
    }).join("");
    const levels = [];
    for (let lv = 1; lv <= MAX_LEVEL; lv++) {
      const slots = cls ? slotsAt(prog, lv) : [];
      const icons = slots.map(s => `<i class="fa-solid ${GROUP_ICON[s.group]} ${plan.feats[s.id] ? "filled" : ""}"></i>`).join("")
        + (cls && lv > 1 && prog.skillIncrease.includes(lv) ? `<i class="fa-solid fa-arrow-up ${plan.skills.increases[lv] ? "filled" : ""}"></i>` : "")
        + (prog.boosts.includes(lv) ? `<i class="fa-solid fa-plus ${(plan.boosts.levels[lv] ?? []).length >= 4 ? "filled" : ""}"></i>` : "");
      const dot = lv <= sheetLv ? "lock" : openSteps.has(`level-${lv}`) ? "open" : cls ? "done" : "";
      const atPreview = lv === this.ui.previewLevel ? "preview" : "";
      levels.push(`<button type="button" class="rpb-lv ${this.ui.step === `level-${lv}` ? "on" : ""} ${atPreview}" data-a="step" data-step="level-${lv}">
        <b>Lv ${lv}</b><span class="icons">${icons}</span><span class="dot ${dot}"></span></button>`);
    }
    return `<div class="rpb-nav-steps">${top}<div class="rpb-lv-head">${t("Nav.Levels")}</div>${levels.join("")}</div>`;
  }

  topHtml(plan) {
    const tabs = this.plans.map(p => `<button type="button" class="rpb-plan ${p.id === plan.id ? "on" : ""}" data-a="plan" data-id="${p.id}"
        data-tooltip="${esc(p.base === "sheet" ? t("Plan.SheetHint") : t("Plan.FreeHint"))}">
        <i class="fa-solid ${p.base === "sheet" ? "fa-user-pen" : "fa-flask"}"></i> ${esc(p.name || t("Plan.Unnamed"))}
        ${this.actor && activePlanId(this.actor) === p.id ? `<i class="fa-solid fa-star star" data-tooltip="${esc(t("Plan.ActiveHint"))}"></i>` : ""}</button>`).join("");
    const canAdd = this.actor && this.editable && this.plans.length < maxPlans();
    const levelOpts = Array.from({ length: MAX_LEVEL }, (_, i) => `<option value="${i + 1}" ${i + 1 === this.ui.previewLevel ? "selected" : ""}>Lv ${i + 1}</option>`).join("");
    return `<div class="rpb-plans">${tabs}
        ${canAdd ? `<button type="button" class="rpb-plan add" data-a="plan-menu" data-tooltip="${esc(t("Plan.AddHint"))}"><i class="fa-solid fa-plus"></i></button>` : ""}</div>
      <div class="rpb-top-right">
        <label class="rpb-preview" data-tooltip="${esc(t("Top.PreviewHint"))}"><i class="fa-solid fa-eye"></i> <select data-a="preview-level">${levelOpts}</select></label>
        <button type="button" data-a="compare"><i class="fa-solid fa-scale-balanced"></i> ${t("Top.Compare")}</button>
        ${this.actor ? `<button type="button" data-a="familiar" data-tooltip="${esc(t("Fam.OpenHint"))}"><i class="fa-solid fa-feather"></i> ${t("Fam.Short")}</button>` : ""}
      </div>`;
  }

  mainHtml(plan) {
    if (this.ui.picker?.kind === "spell") return this.spellPickerHtml(plan);
    if (this.ui.picker?.kind === "choice") return this.choicePickerHtml(plan);
    if (this.ui.picker) return this.featPickerHtml(plan);
    const step = this.ui.step;
    if (step === "overview") return this.overviewHtml(plan);
    if (step === "ancestry") return this.ui.sub === "heritage" && plan.ancestry ? this.heritageHtml(plan) : this.ancestryHtml(plan);
    if (step === "background") return this.abcHtml(plan, "background");
    if (step === "class") return this.abcHtml(plan, "class");
    if (step === "deity") return this.abcHtml(plan, "deity");
    if (step === "attributes") return this.attributesHtml(plan);
    if (step === "skills") return this.skillsHtml(plan);
    if (step === "spells") return this.spellsHtml(plan);
    if (step.startsWith("level-")) return this.levelHtml(plan, Number(step.slice(6)));
    return "";
  }

  /* ---------------- shared list + detail ---------------- */

  rowHtml(e, { selected = false, prereq = null, check = false } = {}) {
    const pr = prereq ? `<span class="pr ${prereq.state}" data-tooltip="${esc(prereq.parts.map(p => `${p.ok === true ? "✔" : p.ok === false ? "✖" : "?"} ${p.text}`).join("<br>") || t("Feat.NoPrereq"))}">${prereq.state === "ok" ? "✔" : prereq.state === "no" ? "✖" : "?"}</span>` : "";
    const lv = e.type === "feat" || e.type === "heritage" ? (e.type === "feat" ? `<span class="lvl">${e.level}</span>` : "") : "";
    // A checkbox to tick a spell in or out without opening it (the row itself still shows the details).
    const box = check ? `<span class="chk ${selected ? "on" : ""}" data-a="check" data-uuid="${e.uuid}" data-tooltip="${esc(t(selected ? "Spells.Untick" : "Spells.Tick"))}"><i class="fa-${selected ? "solid fa-square-check" : "regular fa-square"}"></i></span>` : "";
    return `<button type="button" class="rpb-row ${check ? "has-chk" : ""} ${selected ? "sel" : ""} ${this.ui.detail === e.uuid ? "peek" : ""} ${prereq?.state === "no" ? "unmet" : ""}" data-a="peek" data-uuid="${e.uuid}">
      ${box}${lv}<img src="${esc(e.img)}" alt="" loading="lazy"><span class="nm">${esc(e.name)}${e.original && !e.name.includes(e.original) ? `<small>${esc(e.original)}</small>` : ""}</span>
      ${e.action ? `<span class="act">${glyph(e.action)}</span>` : ""}
      ${alignmentHtml(e)}
      ${e.rarity !== "common" ? `<span class="rar ${e.rarity}">${esc(rarityLabel(e.rarity))}</span>` : ""}
      ${e.remaster === false ? `<span class="legacy" data-tooltip="${esc(t("List.LegacyHint"))}">L</span>` : ""}
      ${pr}</button>`;
  }

  /** Ancestry / background: which attributes it boosts (fixed or a two-way choice — not the free boost) and its flaws. */
  boostInfo(e) {
    const slots = Object.values(e.boosts ?? {}).map(b => b?.value ?? []).filter(v => Array.isArray(v));
    const boosts = new Set(slots.filter(v => v.length > 0 && v.length < 6).flat());
    const flaws = new Set(Object.values(e.flaws ?? {}).flatMap(b => b?.value ?? []));
    return { boosts, flaws };
  }

  attrFilterHtml() {
    const chips = ATTRS.map(a => `<label class="chip ${this.ui.attrBoost.has(a) ? "on" : ""}"><input type="checkbox" data-a="f-boost" data-attr="${a}" ${this.ui.attrBoost.has(a) ? "checked" : ""}> +${esc(attrLabel(a))}</label>`).join("");
    const flaw = ["any", "none", "has"].map(k => `<option value="${k}" ${this.ui.flaw === k ? "selected" : ""}>${t(`List.Flaw.${k}`)}</option>`).join("");
    return `<div class="opts attrs"><span class="lbl" data-tooltip="${esc(t("List.BoostHint"))}">${t("List.Boost")}</span>${chips}
      <select data-a="f-flaw">${flaw}</select></div>`;
  }

  filterBarHtml({ tabs = null, prereq = false, attrs = false } = {}) {
    const hideLegacy = setting("hideLegacy", false);
    const rar = RARITY.map(r => `<label class="chip ${this.ui.rarity.has(r) ? "on" : ""}"><input type="checkbox" data-a="f-rarity" data-r="${r}" ${this.ui.rarity.has(r) ? "checked" : ""}> ${esc(rarityLabel(r))}</label>`).join("");
    return `<div class="rpb-filter">
      <input type="search" data-a="search" value="${esc(this.ui.search)}" placeholder="${esc(t("List.Search"))}">
      ${tabs ? `<div class="tabs">${tabs.map(([k, l]) => `<button type="button" class="${this.ui.tab === k ? "on" : ""}" data-a="tab" data-tab="${k}">${esc(l)}</button>`).join("")}</div>` : ""}
      <div class="opts">
        ${prereq ? `<label><input type="checkbox" data-a="f-met" ${this.ui.onlyMet ? "checked" : ""}> ${t("List.OnlyMet")}</label>
          <span class="legend" data-tooltip="${esc(t("List.LegendHint"))}"><b class="ok">✔</b> ${t("List.LegendOk")} <b class="no">✖</b> ${t("List.LegendNo")} <b class="unk">?</b> ${t("List.LegendUnknown")}</span>` : ""}
        <label class="rpb-check ${hideLegacy ? "locked" : ""}" ${hideLegacy ? `data-tooltip="${esc(t("List.LegacyDisabled"))}"` : ""}><input type="checkbox" data-a="f-legacy" ${this.ui.legacy && !hideLegacy ? "checked" : ""} ${hideLegacy ? "disabled" : ""}><span>${t("List.Legacy")}</span></label>
        ${rar}
      </div>${attrs ? this.attrFilterHtml() : ""}</div>`;
  }

  filtered(list) {
    const q = norm(this.ui.search);
    const attrs = this.ui.attrBoost.size || this.ui.flaw !== "any";
    return list.filter(e => (!q || e.search.includes(q)) && ((this.ui.legacy && !setting("hideLegacy", false)) || e.remaster !== false) && this.ui.rarity.has(e.rarity) && rarityAllowed(e.rarity)
      && (!attrs || !["ancestry", "background"].includes(e.type) || this.attrOk(e)));
  }

  attrOk(e) {
    const { boosts, flaws } = this.boostInfo(e);
    if ([...this.ui.attrBoost].some(a => !boosts.has(a))) return false;
    if (this.ui.flaw === "none" && flaws.size) return false;
    if (this.ui.flaw === "has" && !flaws.size) return false;
    return true;
  }

  pickHtml(title, listHtml, { tabs = null, prereq = false, back = null, hint = "", attrs = false } = {}) {
    return `<div class="rpb-pick">
      <div class="rpb-pick-left">
        <div class="rpb-pick-title">${back ? `<button type="button" class="back" data-a="${back}"><i class="fa-solid fa-arrow-left"></i></button>` : ""}<h3>${title}</h3></div>
        ${hint ? `<p class="rpb-hint">${hint}</p>` : ""}
        ${this.filterBarHtml({ tabs, prereq, attrs })}
        <div class="rpb-list">${listHtml}</div>
      </div>
      <div class="rpb-detail">${this.ui.detail ? `<div class="rpb-detail-body" data-uuid="${this.ui.detail}"><p class="rpb-dim"><i class="fa-solid fa-spinner fa-spin"></i></p></div>` : `<p class="rpb-dim">${t("List.PickHint")}</p>`}</div>
    </div>`;
  }

  listRows(entries, { selectedUuid = null, prereqCtx = null } = {}) {
    const all = this.filtered(entries);
    let rows = all.map(e => ({ e, pr: prereqCtx ? prereqState(e, prereqCtx, this.idx) : null }));
    if (prereqCtx && this.ui.onlyMet) rows = rows.filter(r => r.pr.state !== "no");
    const total = rows.length;
    rows = rows.slice(0, this.ui.limit);
    const html = rows.map(({ e, pr }) => this.rowHtml(e, { selected: e.uuid === selectedUuid, prereq: pr })).join("");
    const more = total > rows.length ? `<button type="button" class="rpb-more" data-a="more">${t("List.More", { n: total - rows.length })}</button>` : "";
    return (html || `<p class="rpb-dim">${t("List.Empty")}</p>`) + more + `<div class="rpb-count">${t("List.Count", { n: total })}</div>`;
  }

  /** Re-draw only the list (typing in the search box keeps its focus). */
  refreshList() {
    const el = this.element?.querySelector(".rpb-list");
    if (!el) return this.render();
    el.innerHTML = this.currentListHtml();
  }

  currentListHtml() {
    const plan = this.plan;
    if (this.ui.picker?.kind === "spell") {
      if (!this.idx.spell) { loadSpells().then(() => this.refreshList()); return `<p class="rpb-dim"><i class="fa-solid fa-spinner fa-spin"></i> ${t("Spells.Loading")}</p>`; }
      const lv = this.ui.picker.level;
      const c = plan.spells?.casting;
      const max = maxSpellRank(lv);
      const cantrip = this.ui.tab === "cantrip";
      const list = this.idx.spell.filter(sp => sp.cantrip === cantrip && (cantrip || sp.level <= max)
        && (this.ui.allTraditions || !c?.tradition || sp.traditions.includes(c.tradition)))
        .sort((a, b) => b.level - a.level || a.name.localeCompare(b.name, game.i18n.lang));
      const chosen = new Set(spellsAt(plan, lv).map(r => r.uuid));
      const other = plannedUuids(plan);
      const all = this.filtered(list);
      const rows = all.slice(0, this.ui.limit).map(e => this.rowHtml({ ...e, type: "feat", level: e.cantrip ? "C" : e.level }, { selected: chosen.has(e.uuid), check: this.editable }).replace('class="rpb-row', `class="rpb-row ${other.has(e.uuid) && !chosen.has(e.uuid) ? "elsewhere" : ""}`)).join("");
      const more = all.length > this.ui.limit ? `<button type="button" class="rpb-more" data-a="more">${t("List.More", { n: all.length - this.ui.limit })}</button>` : "";
      return (rows || `<p class="rpb-dim">${t("List.Empty")}</p>`) + more + `<div class="rpb-count">${t("List.Count", { n: all.length })}</div>`;
    }
    if (this.ui.picker?.kind === "choice") {
      const q = this.ui.picker.q;
      const cur = q.options.find(o => o.value === String(this.currentChoice(q) ?? ""));
      return this.listRows(this.choiceEntries(q), { selectedUuid: cur?.uuid ?? null });
    }
    if (this.ui.picker) {
      const slot = this.ui.picker;
      const entries = featsForSlot(this.idx, plan, slot, { tab: this.ui.tab }).sort((a, b) => b.level - a.level || a.name.localeCompare(b.name, game.i18n.lang));
      return this.listRows(entries, { selectedUuid: plan.feats[slot.id]?.uuid, prereqCtx: context(plan, slot.level, this.idx) });
    }
    const step = this.ui.step;
    if (step === "ancestry" && this.ui.sub === "heritage") return this.listRows(this.heritagesFor(plan), { selectedUuid: plan.heritage?.uuid });
    if (step === "ancestry") return this.listRows(this.idx.ancestry, { selectedUuid: plan.ancestry?.uuid });
    if (step === "background") return this.listRows(this.idx.background, { selectedUuid: plan.background?.uuid });
    if (step === "class") return this.listRows(this.idx.class, { selectedUuid: plan.class?.uuid });
    if (step === "deity") return this.listRows(this.idx.deity ?? [], { selectedUuid: plan.deity?.uuid });
    return "";
  }

  /* ---------------- ancestry / heritage / background / class ---------------- */

  lockedNote(plan) {
    return `<div class="rpb-locked"><i class="fa-solid fa-lock"></i> ${t("Locked.Sheet", { level: plan.sheet?.level ?? 1 })}</div>`;
  }

  /** Sheet plans: levels the sheet already has are locked; the owner can unlock them to change past picks. */
  unlockButton(plan, lv) {
    if (plan.base !== "sheet" || !plan.sheet || lv > plan.sheet.level || !this.editable) return "";
    return plan.unlocked
      ? `<button type="button" class="rpb-unlock on" data-a="unlock" data-tooltip="${esc(t("Locked.RelockHint"))}"><i class="fa-solid fa-lock-open"></i> ${t("Locked.Unlocked")}</button>`
      : `<button type="button" class="rpb-unlock" data-a="unlock" data-tooltip="${esc(t("Locked.UnlockHint"))}"><i class="fa-solid fa-lock"></i> ${t("Locked.Unlock")}</button>`;
  }

  ancestryHtml(plan) {
    if (plan.base === "sheet") return this.lockedSummary(plan, ["ancestry", "heritage"]);
    const sub = `<div class="rpb-subtabs"><button type="button" class="on">${t("Step.AncestryOnly")}</button>
      <button type="button" data-a="sub" data-sub="heritage" ${plan.ancestry ? "" : "disabled"}>${t("Step.Heritage")}${plan.heritage ? `: ${esc(plan.heritage.name)}` : ""}</button></div>`;
    return sub + this.pickHtml(t("Pick.Ancestry"), this.currentListHtml(), { attrs: true });
  }

  heritagesFor(plan) {
    const anc = entryOf(this.idx, plan.ancestry);
    return this.idx.heritage.filter(h => !h.ancestrySlug || h.ancestrySlug === anc?.slug)
      .sort((a, b) => (a.ancestrySlug ? 0 : 1) - (b.ancestrySlug ? 0 : 1) || a.name.localeCompare(b.name, game.i18n.lang));
  }

  heritageHtml(plan) {
    const sub = `<div class="rpb-subtabs"><button type="button" data-a="sub" data-sub="ancestry">${t("Step.AncestryOnly")}: ${esc(plan.ancestry?.name ?? "")}</button>
      <button type="button" class="on">${t("Step.Heritage")}</button></div>`;
    return sub + this.pickHtml(t("Pick.Heritage"), this.currentListHtml(), { hint: t("Pick.HeritageHint") });
  }

  abcHtml(plan, kind) {
    if (plan.base === "sheet") return this.lockedSummary(plan, [kind]);
    return this.pickHtml(t(`Pick.${{ class: "Class", background: "Background", deity: "Deity" }[kind]}`), this.currentListHtml(), { hint: kind === "deity" ? t("Pick.DeityHint") : "", attrs: kind === "background" });
  }

  lockedSummary(plan, keys) {
    const cards = keys.map(k => plan[k] ? `<div class="rpb-card"><img src="${esc(plan[k].img)}" alt=""><div><small>${t(`Step.${STEP_KEY[k]}`)}</small><b>${esc(plan[k].name)}</b></div>
      <button type="button" data-a="peek" data-uuid="${plan[k].uuid}"><i class="fa-solid fa-circle-info"></i></button></div>` : "").join("");
    return `${this.lockedNote(plan)}<div class="rpb-cards">${cards}</div><p class="rpb-hint">${t("Locked.FreeHint")}</p>
      <div class="rpb-detail solo">${this.ui.detail ? `<div class="rpb-detail-body" data-uuid="${this.ui.detail}"></div>` : ""}</div>`;
  }

  /* ---------------- attributes ---------------- */

  attributesHtml(plan) {
    const idx = this.idx;
    const anc = entryOf(idx, plan.ancestry);
    const bg = entryOf(idx, plan.background);
    const cls = entryOf(idx, plan.class);
    const locked1 = plan.base === "sheet";
    const cell = (row, a, { on = false, fixed = false, flaw = false, allowed = true } = {}) =>
      `<td><button type="button" class="b ${on ? "on" : ""} ${fixed ? "fixed" : ""} ${flaw ? "flaw" : ""}" ${(!allowed || fixed || flaw || !this.editable) ? "disabled" : ""}
        data-a="boost" data-row="${row}" data-attr="${a}">${flaw ? "−" : on || fixed ? "+" : ""}</button></td>`;
    const rows = [];
    // ancestry
    if (anc) {
      if (plan.boosts.ancestry.alt) {
        rows.push(`<tr><th>${esc(anc.name)} <small>${t("Attr.AltPicks")}</small></th>${ATTRS.map(a => cell("anc-alt", a, { on: plan.boosts.ancestry.altPicks.includes(a), allowed: !locked1 })).join("")}</tr>`);
      } else {
        const slots = ancestryBoostSlots(anc);
        const fixed = slots.filter(s => s.options.length === 1).map(s => s.options[0]);
        const flaws = ancestryFlaws(anc);
        if (fixed.length || flaws.length) rows.push(`<tr class="sub"><th>${esc(anc.name)} <small>${t("Attr.Fixed")}</small></th>${ATTRS.map(a => cell("x", a, { fixed: fixed.includes(a), flaw: flaws.includes(a) })).join("")}</tr>`);
        for (const s of slots.filter(x => x.options.length > 1)) {
          const pick = plan.boosts.ancestry.slots[s.key];
          const taken = new Set([...fixed, ...Object.entries(plan.boosts.ancestry.slots).filter(([k]) => k !== s.key).map(([, v]) => v)]);
          rows.push(`<tr><th>${esc(anc.name)} <small>${t("Attr.Free")}</small></th>${ATTRS.map(a => cell(`anc-${s.key}`, a, { on: pick === a, allowed: !locked1 && s.options.includes(a) && !taken.has(a) })).join("")}</tr>`);
        }
      }
      if (!locked1) rows.push(`<tr class="opt"><th colspan="7"><label><input type="checkbox" data-a="anc-alt" ${plan.boosts.ancestry.alt ? "checked" : ""}> ${t("Attr.AltToggle")}</label></th></tr>`);
    }
    if (bg) {
      for (const s of backgroundBoostSlots(bg)) {
        const pick = plan.boosts.background[s.key];
        const other = Object.entries(plan.boosts.background).filter(([k]) => k !== s.key).map(([, v]) => v);
        rows.push(`<tr><th>${esc(bg.name)} <small>${s.options.length === 6 ? t("Attr.Free") : t("Attr.OneOf")}</small></th>${ATTRS.map(a => cell(`bg-${s.key}`, a, { on: pick === a, allowed: !locked1 && s.options.includes(a) && !other.includes(a) })).join("")}</tr>`);
      }
    }
    if (cls) {
      const key = keyAttribute(plan, cls);
      rows.push(`<tr><th>${esc(cls.name)} <small>${t("Attr.Key")}</small></th>${ATTRS.map(a => cell("class", a, { on: key === a, fixed: (cls.keyAbility ?? []).length === 1 && key === a, allowed: !locked1 && (cls.keyAbility ?? []).includes(a) })).join("")}</tr>`);
    }
    for (const lv of BOOST_LEVELS) {
      const picks = plan.boosts.levels[lv] ?? [];
      const locked = lockedAt(plan, lv);
      rows.push(`<tr class="${lv > this.ui.previewLevel ? "future" : ""}"><th>Lv ${lv} <small>${t("Attr.FourFree", { n: picks.length })}</small></th>${ATTRS.map(a => cell(`lv-${lv}`, a, { on: picks.includes(a), allowed: !locked && (picks.includes(a) || picks.length < 4) })).join("")}</tr>`);
    }
    const res = attributes(plan, this.ui.previewLevel, idx);
    const head = ATTRS.map(a => `<th class="a">${esc(attrLabel(a))}</th>`).join("");
    const total = ATTRS.map(a => `<td class="total ${res.key === a ? "key" : ""}">${signed(res.mods[a])}${res.partial[a] ? `<sup data-tooltip="${esc(t("Attr.Partial"))}">½</sup>` : ""}</td>`).join("");
    return `<div class="rpb-pane">
      <h3>${t("Attr.Title")}</h3>
      ${locked1 ? this.lockedNote(plan) : `<p class="rpb-hint">${t("Attr.Hint")}</p>`}
      <table class="rpb-boosts"><thead><tr><th></th>${head}</tr></thead><tbody>${rows.join("")}</tbody>
        <tfoot><tr><th>${t("Attr.Result", { level: this.ui.previewLevel })}</th>${total}</tr></tfoot></table>
    </div>`;
  }

  /* ---------------- skills ---------------- */

  skillsHtml(plan) {
    const idx = this.idx;
    const locked = plan.base === "sheet";
    const one = levelOneSkills(plan, idx);
    const chosen = new Set(plan.skills.trained ?? []);
    const left = one.free - [...chosen].filter(s => !one.auto.has(s)).length;
    const ranks = skillRanks(plan, this.ui.previewLevel, idx);
    const rows = skillSlugs().map(s => {
      const auto = one.auto.has(s);
      const on = auto || chosen.has(s);
      const canToggle = !locked && !auto && this.editable && (on || left > 0);
      return `<tr class="${on ? "trained" : ""}">
        <td class="nm">${esc(skillLabel(s))}</td>
        <td>${locked ? "" : `<button type="button" class="t ${on ? "on" : ""} ${auto ? "auto" : ""}" data-a="skill" data-skill="${s}" ${canToggle ? "" : "disabled"}
              data-tooltip="${esc(auto ? t("Skills.Auto") : "")}">${on ? "✔" : ""}</button>`}</td>
        <td class="rk r${ranks[s]}">${esc(rankLabel(ranks[s]))}</td></tr>`;
    }).join("");
    const lores = one.lores.length ? `<p class="rpb-hint"><b>${t("Skills.Lores")}</b> ${one.lores.map(esc).join(", ")}</p>` : "";
    return `<div class="rpb-pane">
      <h3>${t("Skills.Title")}</h3>
      ${locked ? this.lockedNote(plan) : `<p class="rpb-hint">${t("Skills.Hint", { n: one.free, left: Math.max(0, left) })}</p>`}
      ${lores}
      <table class="rpb-skills"><thead><tr><th></th><th>${t("Skills.Lv1")}</th><th>${t("Skills.At", { level: this.ui.previewLevel })}</th></tr></thead><tbody>${rows}</tbody></table>
    </div>`;
  }

  /* ---------------- a level ---------------- */

  levelHtml(plan, lv) {
    const idx = this.idx;
    const cls = entryOf(idx, plan.class);
    if (!cls) return `<div class="rpb-pane"><p class="rpb-dim">${t("Level.NeedClass")}</p></div>`;
    const prog = progression(cls);
    const locked = lockedAt(plan, lv);
    const parts = [];
    // Class features gained here.
    const feats = [...(cls.items ?? []), ...(lv === 1 ? entryOf(idx, plan.ancestry)?.items ?? [] : [])].filter(i => i.level === lv);
    if (feats.length) {
      parts.push(`<section><h4><i class="fa-solid fa-gift"></i> ${t("Level.Features")}</h4><div class="rpb-features">${feats.map(f =>
        `<button type="button" class="rpb-feature" data-a="peek" data-uuid="${f.uuid}"><img src="${esc(f.img)}" alt=""><span data-name-uuid="${f.uuid}">${esc(idx.byUuid.get(f.uuid)?.name ?? f.name)}</span></button>`).join("")}</div></section>`);
    }
    // Feat slots.
    const slots = slotsAt(prog, lv);
    if (slots.length) {
      const ctx = context(plan, lv, idx);
      parts.push(`<section><h4><i class="fa-solid fa-star"></i> ${t("Level.Feats")}</h4>${slots.map(s => {
        const ref = plan.feats[s.id];
        const entry = ref ? (idx.byUuid.get(ref.uuid) ?? ref) : null;
        const pr = entry?.prereqs ? prereqState(entry, ctx, idx) : null;
        return `<div class="rpb-slot ${ref ? "filled" : ""}">
          <span class="grp"><i class="fa-solid ${GROUP_ICON[s.group]}"></i> ${t(`Group.${s.group}`)}</span>
          ${ref ? `<button type="button" class="feat" data-a="peek" data-uuid="${ref.uuid}"><img src="${esc(ref.img)}" alt=""> ${esc(entry?.name ?? ref.name)}
              ${pr && pr.state !== "ok" ? `<span class="pr ${pr.state}" data-tooltip="${esc(pr.parts.map(p => `${p.ok === true ? "✔" : p.ok === false ? "✖" : "?"} ${p.text}`).join("<br>"))}">${pr.state === "no" ? "✖" : "?"}</span>` : ""}</button>`
            : `<span class="empty">${t("Level.Empty")}</span>`}
          ${locked ? `<i class="fa-solid fa-lock rpb-dim" data-tooltip="${esc(t("Locked.Short"))}"></i>` : `
            <button type="button" class="pick" data-a="slot" data-slot="${s.id}">${ref ? t("Level.Change") : t("Level.Choose")}</button>
            ${ref ? `<button type="button" class="clear" data-a="slot-clear" data-slot="${s.id}" data-tooltip="${esc(t("Level.Clear"))}"><i class="fa-solid fa-xmark"></i></button>` : ""}`}
        </div>`;
      }).join("")}</section>`);
    }
    // Skill increase.
    if (lv > 1 && prog.skillIncrease.includes(lv)) {
      const before = skillRanks(plan, lv - 1, idx);
      const cap = maxRankAt(lv);
      const cur = plan.skills.increases[lv] ?? "";
      const grid = skillSlugs().map(s => {
        const r = before[s];
        const ok = r < cap && !locked && this.editable;
        const selected = cur === s;
        const next = Math.min(r + 1, cap);
        const label = `${skillLabel(s)}: ${rankLabel(r)}${r < cap ? ` → ${rankLabel(next)}` : ""}`;
        return `<button type="button" class="${selected ? "on" : ""}" data-a="increase-pick" data-level="${lv}" data-skill="${s}" ${!locked && this.editable && (ok || selected) ? "" : "disabled"}
          aria-pressed="${selected}" aria-label="${esc(label)}" data-tooltip="${esc(label)}" data-rutz-tip-delay="1000">
          <b>${esc(skillLabel(s))}</b><span class="rpb-rank-lights" aria-hidden="true"><span class="rpb-rank-light r${r}"></span>${r < cap ? `<span class="rpb-rank-arrow">→</span><span class="rpb-rank-light r${next} ${selected ? "" : "preview"}"></span>` : ""}</span></button>`;
      }).join("");
      parts.push(`<section class="rpb-increase"><h4><i class="fa-solid fa-arrow-up"></i> ${t("Level.Increase")}</h4>
        <div class="rpb-skillgrid">${grid}</div>
        <p class="rpb-hint">${t("Level.IncreaseHint", { rank: rankLabel(cap) })}</p></section>`);
    }
    // Extra trained skill from a raised Intelligence.
    if (intBonusLevels(plan, idx).includes(lv)) {
      const ranks = skillRanks(plan, lv, idx);
      const cur = plan.skills.extra?.[lv] ?? "";
      const grid = skillSlugs().filter(s => ranks[s] === 0 || s === cur).map(s => `<button type="button" class="${cur === s ? "on" : ""}" data-a="extra-pick" data-level="${lv}" data-skill="${s}" ${locked || !this.editable ? "disabled" : ""}><b>${esc(skillLabel(s))}</b></button>`).join("");
      parts.push(`<section><h4><i class="fa-solid fa-brain"></i> ${t("Level.IntSkill")}</h4>
        <div class="rpb-skillgrid">${grid}</div></section>`);
    }
    // Boosts.
    if (prog.boosts.includes(lv)) {
      const picks = plan.boosts.levels[lv] ?? [];
      const before = attributes(plan, lv - 1, idx).mods;
      const after = attributes(plan, lv, idx);
      parts.push(`<section><h4><i class="fa-solid fa-plus"></i> ${t("Level.Boosts", { n: picks.length })}</h4><div class="rpb-boostrow">${ATTRS.map(a =>
        `<button type="button" class="${picks.includes(a) ? "on" : ""}" data-a="boost" data-row="lv-${lv}" data-attr="${a}" ${locked || !this.editable || (!picks.includes(a) && picks.length >= 4) ? "disabled" : ""}
          data-tooltip="${esc(`${attrLabel(a)} ${signed(before[a])} → ${signed(after.mods[a])}${after.partial[a] ? " (½)" : ""}`)}">
          <span class="nm"><b>${esc(attrLabel(a))}</b><em>${signed(after.mods[a])}</em></span>${this.boostPips(before[a], after.mods[a], !!after.partial[a], picks.includes(a))}</button>`).join("")}</div>
        <p class="rpb-hint">${t("Level.BoostHint")}</p></section>`);
    }
    if (plan.spells?.casting?.tradition || this.casterSlug(plan)) parts.push(this.spellSectionHtml(plan, lv));
    if (!parts.length) parts.push(`<p class="rpb-dim">${t("Level.Nothing")}</p>`);
    // Apply.
    let actions = "";
    if (this.actor && plan.base === "sheet" && this.actor.isOwner) {
      const cur = this.actor.level;
      if (lv === cur + 1 && (game.user.isGM || setting("allowLevelUp", true))) {
        actions = `<div class="rpb-actions"><button type="button" class="primary" data-a="apply" data-mode="next"><i class="fa-solid fa-angles-up"></i> ${t("Level.RaiseApply", { level: lv })}</button></div>`;
      }
    }
    return `<div class="rpb-level">
      <div class="rpb-level-main">
        <h3>Lv ${lv} ${locked ? `<small class="rpb-dim"><i class="fa-solid fa-lock"></i> ${t("Locked.Short")}</small>` : ""}
          ${this.unlockButton(plan, lv)}</h3>
        ${parts.join("")}
        ${actions}
      </div>
      <div class="rpb-detail">${this.ui.detail ? `<div class="rpb-detail-body" data-uuid="${this.ui.detail}"></div>` : `<p class="rpb-dim">${t("Level.DetailHint")}</p>`}</div>
    </div>`;
  }

  /** The class (slug) the plan casts with, if its spells follow a known table. */
  casterSlug(plan) {
    const slug = entryOf(this.idx, plan.class)?.slug;
    return hasTable(slug) ? slug : null;
  }

  /** Planned spells of a level, cantrips and ranked spells apart. */
  splitSpells(plan, lv) {
    const list = spellsAt(plan, lv).map((r, i) => ({ r, i }));
    return { cantrips: list.filter(x => isCantripRef(x.r, this.idx)), spells: list.filter(x => !isCantripRef(x.r, this.idx)) };
  }

  spellChips(list, lv) {
    return list.map(({ r, i }) => `<span class="rpb-spellchip"><button type="button" class="nm" data-a="peek" data-uuid="${r.uuid}"><img src="${esc(r.img)}" alt="">${esc(r.name)}${!r.cantrip && r.level ? `<small>${r.level}</small>` : ""}</button>
      ${this.editable ? `<button type="button" class="x" data-a="spell-del" data-level="${lv}" data-i="${i}" aria-label="${esc(t("Level.Clear"))}"><i class="fa-solid fa-xmark"></i></button>` : ""}</span>`).join("");
  }

  /** Badges for a level's cantrips and ranked spells; per-level "any 2" spells may include cantrips (setting). */
  needBadges(need, cantrips, spells) {
    if (!need || need.mode === "list") return { c: "", s: "" };
    if (need.any && setting("levelCantrips", true)) {
      const extraC = Math.max(0, cantrips - need.cantrips);
      return { c: need.cantrips ? this.countBadge(Math.min(cantrips, need.cantrips), need.cantrips) : "", s: `${this.countBadge(spells + extraC, need.spells)}<small class="rpb-dim"> ${t("Spells.AnyInclCantrip")}</small>` };
    }
    return { c: this.countBadge(cantrips, need.cantrips), s: this.countBadge(spells, need.spells) };
  }

  /** "3 / 5" with a colour for done / short / over. */
  countBadge(have, need) {
    if (!need && !have) return "";
    const cls = have === need ? "ok" : have < need ? "short" : "over";
    return `<span class="rpb-need ${cls}">${have} / ${need}</span>`;
  }

  /** An attribute as a row of squares: filled up to the modifier, the new one lit, a half square for a partial boost. */
  boostPips(before, after, partial, on) {
    const n = Math.max(5, after + (partial ? 1 : 0), before);
    let html = "";
    for (let i = 1; i <= n; i++) {
      const cls = i <= Math.min(before, after) ? "f" : i <= after ? "new" : partial && i === after + 1 ? (on ? "half new" : "half") : "";
      html += `<i class="${cls}"></i>`;
    }
    const neg = after < 0 ? `<span class="neg">${after}</span>` : "";
    return `<span class="pips">${neg}${html}</span>`;
  }

  spellSectionHtml(plan, lv) {
    const slug = this.casterSlug(plan);
    const need = slug ? learnCount(slug, lv) : null;
    const { cantrips, spells } = this.splitSpells(plan, lv);
    const slots = slug ? spellSlotsAt(slug, lv) : null;
    const add = kind => this.editable ? `<button type="button" class="pick" data-a="spell-pick" data-level="${lv}" data-kind="${kind}"><i class="fa-solid fa-plus"></i> ${t(kind === "cantrip" ? "Spells.AddCantrip" : "Spells.AddSpell")}</button>` : "";
    const listMode = need?.mode === "list";
    return `<section class="rpb-spellsec"><h4><i class="fa-solid fa-wand-sparkles"></i> ${t("Spells.AtLevel", { rank: maxSpellRank(lv) })}</h4>
      ${need ? `<p class="rpb-learn"><b>${t("Spells.LearnHere")}</b> ${esc(learnText(need))}${need.note ? ` <i class="fa-solid fa-circle-info" data-tooltip="${esc(t(need.note))}"></i>` : ""}</p>` : ""}
      ${slots ? `<p class="rpb-slots"><b>${t("Spells.PerDay")}</b> ${esc(slotsText(slots))}${slots.extra ? ` <i class="fa-solid fa-circle-info" data-tooltip="${esc(t(slots.extra))}"></i>` : ""}</p>` : ""}
      ${listMode && !cantrips.length && !spells.length ? `<p class="rpb-hint">${t("Spells.ListHint")}</p>` : ""}
      <div class="rpb-spellrow"><span class="lab">${t("Spells.Cantrips")} ${this.needBadges(need, cantrips.length, spells.length).c}</span>
        <div class="rpb-spellchips">${this.spellChips(cantrips, lv) || `<span class="rpb-dim">—</span>`}</div>${add("cantrip")}</div>
      <div class="rpb-spellrow"><span class="lab">${t("Spells.RankedSpells")} ${this.needBadges(need, cantrips.length, spells.length).s}</span>
        <div class="rpb-spellchips">${this.spellChips(spells, lv) || `<span class="rpb-dim">—</span>`}</div>${add("spell")}</div>
      <div class="rpb-classspells" data-level="${lv}"></div></section>`;
  }

  spellsHtml(plan) {
    const c = plan.spells?.casting;
    const def = casterDefaults(plan, this.idx);
    const dis = this.editable ? "" : "disabled";
    const slug = this.casterSlug(plan);
    const trad = `<select data-a="cast-tradition" ${dis}><option value="">${t("Spells.NoCasting")}</option>${TRADITIONS.map(x => `<option value="${x}" ${c?.tradition === x ? "selected" : ""}>${esc(traditionLabel(x))}</option>`).join("")}</select>`;
    const mode = `<select data-a="cast-mode" ${dis}>${["prepared", "spontaneous"].map(x => `<option value="${x}" ${c?.mode === x ? "selected" : ""}>${esc(kindLabel(x))}</option>`).join("")}</select>`;
    const attr = `<select data-a="cast-attr" ${dis}>${ATTRS.map(a => `<option value="${a}" ${c?.attr === a ? "selected" : ""}>${esc(attrLabel(a))}</option>`).join("")}</select>`;
    const rows = [];
    for (let lv = 1; lv <= MAX_LEVEL; lv++) {
      const { cantrips, spells } = this.splitSpells(plan, lv);
      const need = slug ? learnCount(slug, lv) : null;
      const slots = slug ? spellSlotsAt(slug, lv) : null;
      const listMode = need?.mode === "list";
      const chip = list => list.map(({ r }) => `<span class="sp" data-a="peek" data-uuid="${r.uuid}">${esc(r.name)}</span>`).join("");
      rows.push(`<tr><th>Lv ${lv}<small>${t("Spells.MaxRank", { rank: maxSpellRank(lv) })}</small></th>
        <td class="slots">${slots ? `<small data-tooltip="${esc(slotsText(slots))}">${esc(slotsText(slots, true))}</small>` : ""}</td>
        <td class="need">${need ? `<small>${esc(learnText(need))}</small>` : ""}</td>
        <td><div class="cell">${this.needBadges(need, cantrips.length, spells.length).c}${chip(cantrips) || (need?.cantrips ? "" : `<span class="rpb-dim">—</span>`)}</div></td>
        <td><div class="cell">${this.needBadges(need, cantrips.length, spells.length).s}${chip(spells) || (need?.spells ? "" : `<span class="rpb-dim">—</span>`)}</div></td>
        <td>${c?.tradition && this.editable ? `<button type="button" data-a="step" data-step="level-${lv}" data-tooltip="${esc(t("Spells.GoLevel", { level: lv }))}"><i class="fa-solid fa-pen"></i></button>` : ""}</td></tr>`);
    }
    const learn = slug ? learnCount(slug, 1) : null;
    return `<div class="rpb-pane">
      <h3>${t("Spells.Title")} ${slug ? `<button type="button" class="rpb-setup" data-a="spell-setup"><i class="fa-solid fa-hat-wizard"></i> ${t("Setup.Button")}</button>` : ""}
        ${slug && this.actor?.isOwner ? `<button type="button" class="rpb-setup" data-a="spell-resync" data-tooltip="${esc(t("Spells.ResyncHint"))}"><i class="fa-solid fa-rotate"></i> ${t("Spells.Resync")}</button>` : ""}</h3>
      <p class="rpb-hint">${t("Spells.Hint")}</p>
      <div class="rpb-casting"><label>${t("Spells.Tradition")} ${trad}</label><label>${t("Spells.Mode")} ${mode}</label><label>${t("Spells.Attr")} ${attr}</label>
        ${def && this.editable ? `<button type="button" data-a="cast-default"><i class="fa-solid fa-rotate"></i> ${t("Spells.Default", { what: def.tradition ? traditionLabel(def.tradition) : kindLabel(def.mode) })}</button>` : ""}</div>
      ${def && !def.tradition ? `<p class="rpb-hint">${t("Spells.SubclassHint")}</p>` : ""}
      ${learn ? `<p class="rpb-learn big"><i class="fa-solid fa-book"></i> ${t(`Spells.Mode_${learn.mode}`)}</p>` : ""}
      <div class="rpb-classspells" data-level="${this.planLevel(plan)}" data-wide="1"></div>
      ${c?.tradition ? `<table class="rpb-spelltable"><thead><tr><th></th><th>${t("Spells.PerDay")}</th><th>${t("Spells.LearnHere")}</th><th>${t("Spells.Cantrips")}</th><th>${t("Spells.RankedSpells")}</th><th></th></tr></thead><tbody>${rows.join("")}</tbody></table>` : `<p class="rpb-dim">${t("Spells.NoCastingHint")}</p>`}
    </div>`;
  }

  /** Spells the class gives by itself (focus spells, granted spells), from its features, subclass picks and planned feats. */
  async fillClassSpells() {
    const holders = this.element?.querySelectorAll(".rpb-classspells") ?? [];
    if (!holders.length || !this.plan?.class) return;
    for (const el of holders) {
      const lv = Number(el.dataset.level) || 1;
      let found;
      try { found = await planSpells(this.plan, this.idx, lv); } catch (err) { console.warn(`${MID} | class spells`, err); continue; }
      if (!el.isConnected) continue;
      el.innerHTML = this.classSpellsHtml(found, lv, el.dataset.wide === "1");
    }
  }

  classSpellsHtml(found, lv, wide = false) {
    const chip = d => `<span class="rpb-spellchip fixed"><button type="button" class="nm" data-a="peek" data-uuid="${d.uuid}"><img src="${esc(d.img)}" alt="">${esc(d.name)}</button></span>`;
    const parts = [];
    if (found.focus.length) {
      const pool = Math.min(3, found.focus.filter(d => !(d.system?.traits?.value ?? []).includes("cantrip")).length || 1);
      parts.push(`<div class="rpb-spellrow"><span class="lab"><i class="fa-solid fa-sun"></i> ${t("Spells.FocusSpells")} <small>${t("Spells.FocusPool", { n: pool })}</small></span><div class="rpb-spellchips">${found.focus.map(chip).join("")}</div></div>`);
    }
    if (found.main.length) parts.push(`<div class="rpb-spellrow"><span class="lab"><i class="fa-solid fa-gift"></i> ${t("Spells.Granted")}</span><div class="rpb-spellchips">${found.main.map(chip).join("")}</div></div>`);
    if (!parts.length) return wide ? `<p class="rpb-dim">${t("Spells.NoClassSpells")}</p>` : "";
    return `<div class="rpb-classbox">${wide ? `<h5>${t("Spells.ClassGives", { level: lv })}</h5>` : ""}${parts.join("")}
      ${found.tradition && !this.plan.spells?.casting?.tradition ? `<button type="button" data-a="cast-found" data-trad="${found.tradition}"><i class="fa-solid fa-check"></i> ${t("Spells.UseTradition", { tradition: traditionLabel(found.tradition) })}</button>` : ""}</div>`;
  }

  /** A class whose tradition comes from its subclass (witch patron, sorcerer bloodline): take it from the pick. */
  async syncTradition() {
    const plan = this.plan;
    const def = plan && casterDefaults(plan, this.idx);
    if (!def || def.tradition || !this.editable) return;
    const found = await planSpells(plan, this.idx, this.planLevel(plan)).catch(() => null);
    const trad = found?.tradition;
    if (!trad || plan.spells?.casting?.tradition === trad) return;
    this.mutate(p => { p.spells.casting = { tradition: trad, mode: p.spells.casting?.mode ?? def.mode, attr: p.spells.casting?.attr ?? def.attr }; });
  }

  /** After a class is chosen (and its subclass questions answered): what the class casts and what to choose. */
  async spellSetup() {
    const plan = this.plan;
    const slug = plan && this.casterSlug(plan);
    if (!slug) return;
    const level = this.planLevel(plan);
    const found = await planSpells(plan, this.idx, level).catch(() => ({ focus: [], main: [], tradition: null }));
    const def = casterDefaults(plan, this.idx);
    const trad = plan.spells?.casting?.tradition ?? def?.tradition ?? found.tradition;
    const l1 = learnCount(slug, 1);
    const s1 = spellSlotsAt(slug, level);
    let learnedTotal = { cantrips: 0, spells: 0 };
    for (let lv = 1; lv <= level; lv++) { const n = learnCount(slug, lv); learnedTotal.cantrips += n.cantrips; learnedTotal.spells += n.spells; }
    const prepared = s1.ranks.reduce((a, b) => a + b, 0);
    const how = l1.mode === "book" ? t("Setup.Book", { c: learnedTotal.cantrips, s: learnedTotal.spells, pc: s1.cantrips, ps: prepared })
      : l1.mode === "rep" ? t("Setup.Rep", { c: learnedTotal.cantrips, s: learnedTotal.spells })
        : t("Setup.List", { pc: s1.cantrips, ps: prepared });
    const content = `<div class="rpb-setup-body">
      <p><b>${esc(plan.class?.name ?? "")}</b> · ${trad ? esc(traditionLabel(trad)) : t("Setup.NoTradition")} · ${esc(kindLabel(def?.mode ?? "prepared"))} · ${esc(attrLabel(def?.attr ?? "int"))} · Lv ${level}</p>
      <p class="how"><i class="fa-solid fa-book-open"></i> ${how}</p>
      <p><b>${t("Spells.PerDay")}</b> ${esc(slotsText(s1))}</p>
      ${s1.extra ? `<p class="rpb-hint">${t(s1.extra)}</p>` : ""}
      ${l1.note ? `<p class="rpb-hint">${t(l1.note)}</p>` : ""}
      ${this.classSpellsHtml(found, level, true)}
      <p class="rpb-hint">${t("Setup.FeatHint")}</p></div>`;
    const go = await foundry.applications.api.DialogV2.wait({
      window: { title: t("Setup.Title") }, position: { width: 560 }, classes: ["rpb-setup-dialog"], content, rejectClose: false,
      buttons: [{ action: "go", label: t("Setup.Go"), icon: "fa-solid fa-wand-sparkles", default: true }, { action: "later", label: t("Setup.Later") }],
      render: (_ev, dialog) => {
        const root = dialog?.element ?? dialog;
        root?.addEventListener?.("click", async ev => {
          const b = ev.target.closest?.("[data-a=peek]");
          if (b) { ev.preventDefault(); (await fromUuid(b.dataset.uuid))?.sheet?.render(true); }
        });
      }
    }).catch(() => null);
    if (trad && !plan.spells?.casting?.tradition && def) this.mutate(p => { p.spells.casting = { tradition: trad, mode: def.mode, attr: def.attr }; }, { rerender: false });
    if (go === "go") { this.ui.step = "spells"; this.ui.picker = null; this.ui.detail = null; this._sameView = false; }
    this.render();
  }

  spellPickerHtml(plan) {
    const lv = this.ui.picker.level;
    const tabs = [["cantrip", t("Spells.Cantrips")], ["spell", t("Spells.Spells", { rank: maxSpellRank(lv) })]];
    const slug = this.casterSlug(plan);
    const need = slug ? learnCount(slug, lv) : null;
    const { cantrips, spells } = this.splitSpells(plan, lv);
    const nb = this.needBadges(need, cantrips.length, spells.length);
    const counts = need && need.mode !== "list" ? ` ${nb.c ? `${nb.c} ${t("Spells.Cantrips")} · ` : ""}${nb.s} ${t("Spells.RankedSpells")}` : "";
    const hint = need ? `${t("Spells.LearnHere")} ${esc(learnText(need))}. ${t("Spells.PickHint")}` : t("Spells.PickHint");
    const html = this.pickHtml(`${t("Spells.PickTitleShort", { level: lv })}${counts}`, this.currentListHtml(), { tabs, back: "picker-close", hint });
    return html.replace('<div class="opts">', `<div class="opts"><label><input type="checkbox" data-a="f-alltrad" ${this.ui.allTraditions ? "checked" : ""}> ${t("Spells.AllTraditions")}</label>`);
  }

  /** A ChoiceSet's options (patron, muse, bloodline …) as a list with the usual detail panel. */
  choicePickerHtml(plan) {
    const pk = this.ui.picker;
    void plan;
    return this.pickHtml(`${esc(pk.q.holder?.name ?? "")} · ${esc(pk.q.label)}`, this.currentListHtml(), { back: "picker-close", hint: t("Choice.PickHint") });
  }

  choiceEntries(q) {
    return q.options.filter(o => o.uuid).map(o => {
      const e = this.idx.byUuid.get(o.uuid);
      return { uuid: o.uuid, name: o.label, img: o.img ?? e?.img ?? "icons/svg/item-bag.svg", type: "choice", original: e?.original ?? "",
        rarity: e?.rarity ?? "common", remaster: e?.remaster ?? true, search: norm(`${o.label} ${e?.original ?? ""}`), level: e?.level ?? 0 };
    });
  }

  currentChoice(q) {
    const p = this.plan;
    const picks = picksOf(p, q.holder.key);
    return picks?.[q.rule] ?? q.value;
  }

  featPickerHtml(plan) {
    const slot = this.ui.picker;
    const tabs = slot.group === "class" ? [["class", t("Tab.Class")], ["archetype", t("Tab.Archetype")]]
      : slot.group === "general" ? [["all", t("Tab.All")], ["general", t("Tab.General")], ["skill", t("Tab.Skill")]] : null;
    const title = `${t(`Group.${slot.group}`)} · Lv ${slot.level}`;
    return this.pickHtml(title, this.currentListHtml(), { tabs, prereq: true, back: "picker-close", hint: slot.group === "class" && this.ui.tab === "archetype" ? t("Pick.ArchetypeHint") : "" });
  }

  /* ---------------- overview ---------------- */

  overviewHtml(plan) {
    const idx = this.idx;
    const isNew = !this.actor;
    const meta = plan.meta ?? {};
    const open = openItems(plan, this.ui.previewLevel, idx);
    const openHtml = open.length
      ? `<ul class="rpb-open">${open.slice(0, 12).map(o => `<li><button type="button" data-a="step" data-step="${o.step}">${t(`Open.${o.key.includes("-") ? "slot" : o.key}`, { level: o.level, group: o.key.includes("-") ? t(`Group.${o.key.split("-")[0]}`) : "" })}</button></li>`).join("")}${open.length > 12 ? `<li>…</li>` : ""}</ul>`
      : `<p class="rpb-ok"><i class="fa-solid fa-check"></i> ${t("Overview.AllSet", { level: this.ui.previewLevel })}</p>`;
    const users = game.user.isGM ? game.users.filter(u => !u.isGM).map(u => `<option value="${u.id}" ${meta.userId === u.id ? "selected" : ""}>${esc(u.name)}</option>`).join("") : "";
    const ident = isNew ? `
      <div class="rpb-ident">
        <div class="pics">
          <button type="button" class="pic" data-a="upload" data-kind="portrait" data-tooltip="${esc(canUpload() ? t("Overview.UploadHint") : t("Create.NoUpload"))}">
            ${meta.img ? `<img src="${esc(meta.img)}" alt="">` : `<i class="fa-solid fa-image-portrait"></i>`}<small>${t("Overview.Portrait")}</small></button>
          <button type="button" class="pic token" data-a="upload" data-kind="token" data-tooltip="${esc(t("Overview.TokenHint"))}">
            ${meta.tokenImg || meta.img ? `<img src="${esc(meta.tokenImg || meta.img)}" alt="">` : `<i class="fa-solid fa-circle-user"></i>`}<small>${t("Overview.Token")}</small></button>
        </div>
        <div class="fields">
          <label>${t("Overview.CharName")}<input type="text" data-a="char-name" value="${esc(meta.charName ?? "")}" placeholder="${esc(t("Create.DefaultName"))}"></label>
          <label class="inline"><input type="checkbox" data-a="ring" ${meta.ring !== false ? "checked" : ""}> ${t("Overview.Ring")}</label>
          ${game.user.isGM ? `<label>${t("Overview.ForUser")}<select data-a="for-user"><option value="">${esc(game.user.name)} (GM)</option>${users}</select></label>` : ""}
          <input type="file" accept="image/*" class="rpb-file" hidden>
        </div>
      </div>` : "";
    const abc = ["ancestry", "heritage", "background", "class", "deity"].map(k => plan[k]
      ? `<button type="button" class="rpb-card" data-a="step" data-step="${k === "heritage" ? "ancestry" : k}"><img src="${esc(plan[k].img)}" alt=""><div><small>${t(`Step.${STEP_KEY[k]}`)}</small><b>${esc(plan[k].name)}</b></div></button>`
      : `<button type="button" class="rpb-card empty" data-a="step" data-step="${k === "heritage" ? "ancestry" : k}"><i class="fa-solid fa-plus"></i><div><small>${t(`Step.${STEP_KEY[k]}`)}</small><b>${t("Overview.NotChosen")}</b></div></button>`).join("");
    let action = "";
    if (isNew) {
      const ready = !openItems(plan, 1, idx).length;
      const allowed = canCreateMore(game.user) || game.user.isGM;
      action = `<button type="button" class="primary big" data-a="create" ${ready && allowed ? "" : "disabled"}><i class="fa-solid fa-user-plus"></i> ${t("Overview.Create")}</button>
        <p class="rpb-hint">${!allowed ? t("Create.Limit", { n: setting("charactersPerPlayer", 1) }) : ready ? t("Overview.CreateHint", { level: setting("startLevel", 1) }) : t("Overview.CreateNeed")}</p>`;
    } else if (plan.base === "sheet" && this.actor.isOwner) {
      action = `<button type="button" class="primary" data-a="apply" data-mode="current"><i class="fa-solid fa-wand-magic-sparkles"></i> ${t("Overview.ApplyCurrent", { level: this.actor.level })}</button>
        ${game.user.isGM || setting("allowLevelUp", true) ? `<button type="button" data-a="apply" data-mode="next"><i class="fa-solid fa-angles-up"></i> ${t("Level.RaiseApply", { level: this.actor.level + 1 })}</button>` : ""}
        ${activePlanId(this.actor) !== plan.id ? `<button type="button" data-a="plan-active"><i class="fa-solid fa-star"></i> ${t("Plan.MakeActive")}</button>` : `<p class="rpb-hint"><i class="fa-solid fa-star"></i> ${t("Plan.ActiveHint")}</p>`}`;
    } else if (plan.base === "free" && this.actor?.isOwner) {
      const may = game.user.isGM || setting("allowRebuild", true);
      action = `${may ? `<button type="button" class="primary" data-a="rebuild"><i class="fa-solid fa-wand-magic-sparkles"></i> ${t("Plan.Rebuild", { level: this.actor.level })}</button>` : ""}
        <button type="button" data-a="free-convert" data-tooltip="${esc(t("Plan.ConvertHint"))}"><i class="fa-solid fa-user-pen"></i> ${t("Plan.Convert")}</button>
        <p class="rpb-hint">${t("Plan.FreeNote")}</p>`;
    }
    return `<div class="rpb-overview">
      <div class="col">
        <label class="rpb-planname">${t("Overview.PlanName")}<input type="text" data-a="plan-name" value="${esc(plan.name ?? "")}" ${this.editable ? "" : "disabled"}></label>
        ${ident}
        <div class="rpb-cards">${abc}</div>
        <h4>${t("Overview.Open")}</h4>${openHtml}
        <label class="rpb-notes">${t("Overview.Notes")}<textarea data-a="notes" rows="3" ${this.editable ? "" : "disabled"}>${esc(plan.notes ?? "")}</textarea></label>
        <div class="rpb-actions">${action}
          ${this.actor && this.editable && this.plans.length > 1 ? `<button type="button" class="danger" data-a="plan-del"><i class="fa-solid fa-trash"></i> ${t("Plan.Delete")}</button>` : ""}</div>
      </div>
      <div class="col">
        <h4>${t("Overview.Stats", { level: this.ui.previewLevel })}</h4>
        <div class="rpb-stats" data-level="${this.ui.previewLevel}"><p class="rpb-dim"><i class="fa-solid fa-spinner fa-spin"></i> ${t("Overview.Computing")}</p></div>
      </div>
    </div>`;
  }

  /* ---------------- async fills ---------------- */

  async fillStats() {
    const el = this.element?.querySelector(".rpb-stats");
    const plan = this.plan;
    if (!el || !plan) return;
    if (!plan.class || !plan.ancestry) { el.innerHTML = `<p class="rpb-dim">${t("Overview.StatsNeed")}</p>`; return; }
    const level = this.ui.previewLevel;
    const stats = await previewStats(plan, level, plan.base === "sheet" ? this.actor : null);
    if (!el.isConnected || Number(el.dataset.level) !== level) return;
    el.innerHTML = statsHtml(stats);
  }

  /** Names shown from data that only has the English name (class features …): read the (translated) documents. */
  async fillNames() {
    for (const el of this.element?.querySelectorAll("[data-name-uuid]") ?? []) {
      const doc = await getDoc(el.dataset.nameUuid);
      if (doc?.name && el.isConnected) el.textContent = doc.name;
    }
  }

  async fillDetail() {
    const body = this.element?.querySelector(".rpb-detail-body");
    if (!body) return;
    const uuid = body.dataset.uuid;
    const html = await this.detailHtml(uuid);
    if (body.isConnected && body.dataset.uuid === uuid) body.innerHTML = html;
  }

  async detailHtml(uuid) {
    const plan = this.plan;
    const doc = await getDoc(uuid);
    const e = this.idx.byUuid.get(uuid);
    if (!doc) return `<p class="rpb-dim">${t("Detail.Missing")}</p>`;
    let desc = this.detailCache.get(uuid);
    if (desc === undefined) {
      desc = await enrich(doc.system?.description?.value ?? "", { relativeTo: doc });
      this.detailCache.set(uuid, desc);
    }
    const s = doc.system ?? {};
    const traits = (s.traits?.value ?? []).map(tr => `<span class="trait">${esc(traitLabel(tr))}</span>`).join("");
    const rar = s.traits?.rarity && s.traits.rarity !== "common" ? `<span class="trait rar ${s.traits.rarity}">${esc(rarityLabel(s.traits.rarity))}</span>` : "";
    const facts = [];
    if (doc.type === "ancestry") {
      facts.push([t("Detail.HP"), s.hp], [t("Detail.Speed"), s.speed], [t("Detail.Size"), game.i18n.localize(CONFIG.PF2E.actorSizes?.[s.size] ?? s.size ?? "")]);
      const boosts = Object.values(s.boosts ?? {}).filter(b => b?.value?.length).map(b => b.value.length === 1 ? attrLabel(b.value[0]) : t("Detail.FreeBoost"));
      facts.push([t("Detail.Boosts"), boosts.join(", ")]);
      const flaws = Object.values(s.flaws ?? {}).filter(b => b?.value?.length === 1).map(b => attrLabel(b.value[0]));
      if (flaws.length) facts.push([t("Detail.Flaws"), flaws.join(", ")]);
    } else if (doc.type === "class") {
      facts.push([t("Detail.HPLevel"), s.hp], [t("Detail.Key"), (s.keyAbility?.value ?? []).map(attrLabel).join(" / ")],
        [t("Detail.Skills"), t("Detail.SkillsCount", { n: s.trainedSkills?.additional ?? 0 })],
        [t("Detail.Perception"), rankLabel(s.perception)],
        [t("Detail.Saves"), ["fortitude", "reflex", "will"].map(k => `${game.i18n.localize(CONFIG.PF2E.saves?.[k] ?? k)} ${rankLabel(s.savingThrows?.[k])}`).join(" · ")]);
    } else if (doc.type === "background") {
      const boosts = Object.values(s.boosts ?? {}).filter(b => b?.value?.length).map(b => b.value.length >= 6 ? t("Detail.FreeBoost") : b.value.map(attrLabel).join("/"));
      facts.push([t("Detail.Boosts"), boosts.join(", ")], [t("Detail.Skills"), [...(s.trainedSkills?.value ?? []).map(skillLabel), ...(s.trainedSkills?.lore ?? [])].join(", ")]);
      const featNames = Object.values(s.items ?? {}).map(i => i.name).filter(Boolean);
      if (featNames.length) facts.push([t("Detail.Feat"), featNames.join(", ")]);
    } else if (doc.type === "spell") {
      facts.push([t("Detail.Level"), (s.traits?.value ?? []).includes("cantrip") ? t("Spells.Cantrip") : s.level?.value],
        [t("Spells.Tradition"), (s.traits?.traditions ?? []).map(traditionLabel).join(", ")]);
    } else if (doc.type === "feat") {
      facts.push([t("Detail.Level"), s.level?.value ?? ""]);
      if (s.prerequisites?.value?.length) {
        const slot = this.ui.picker;
        const ctx = context(plan, slot?.level ?? this.ui.previewLevel, this.idx);
        const pr = prereqState(e ?? { prereqs: s.prerequisites.value.map(p => p.value) }, ctx, this.idx);
        facts.push([t("Detail.Prereq"), pr.parts.map(p => `<span class="pq ${p.ok === true ? "ok" : p.ok === false ? "no" : "unk"}">${p.ok === true ? "✔" : p.ok === false ? "✖" : "?"} ${esc(p.text)}</span>`).join("")]);
      }
    }
    const factHtml = facts.filter(f => f[1] !== undefined && f[1] !== null && f[1] !== "").map(([k, v]) => `<div class="fact"><span>${esc(k)}</span><b>${typeof v === "string" && v.includes("<span") ? v : esc(v)}</b></div>`).join("");
    const chosenHere = this.isChosen(uuid);
    const choices = chosenHere ? await this.choicesHtml(doc, plan, uuid) : "";
    const canChoose = this.canChooseNow(uuid);
    const nav = chosenHere && canChoose ? this.nextButtons() : "";
    const button = canChoose ? (chosenHere
      ? (this.ui.picker?.kind === "spell" ? `<button type="button" class="primary" data-a="choose" data-uuid="${uuid}"><i class="fa-solid fa-minus"></i> ${t("Spells.Remove")}</button>${nav}` : `<button type="button" class="primary" disabled><i class="fa-solid fa-check"></i> ${t("Detail.Chosen")}</button>${nav}`)
      : `<button type="button" class="primary" data-a="choose" data-uuid="${uuid}"><i class="fa-solid fa-check"></i> ${t("Detail.Choose")}</button>`) : "";
    return `<header><img src="${esc(doc.img)}" alt=""><div><h3>${esc(doc.name)} ${doc.type === "feat" && e?.action ? glyph(e.action) : ""}</h3>
        ${e?.original && !doc.name.includes(e.original) ? `<small>${esc(e.original)}</small>` : ""}<div class="traits">${alignmentHtml(doc)}${rar}${traits}</div></div></header>
      <div class="rpb-choose">${button}<button type="button" class="rpb-tochat" data-a="to-chat" data-uuid="${uuid}" data-tooltip="${esc(t("Detail.ToChatHint"))}"><i class="fa-solid fa-comment-dots"></i> ${t("Detail.ToChat")}</button></div>
      ${factHtml ? `<div class="facts">${factHtml}</div>` : ""}
      ${choices}
      <div class="desc">${desc || `<p class="rpb-dim">${t("Detail.NoDesc")}</p>`}</div>
      ${e?.source ? `<p class="src">${esc(e.source)}</p>` : ""}`;
  }

  /** Show the GM (and the table) what this is: a small card in chat with a link to the item. */
  async toChat(uuid) {
    const doc = await getDoc(uuid);
    if (!doc) return;
    const e = this.idx.byUuid.get(uuid);
    const s = doc.system ?? {};
    const traits = (s.traits?.value ?? []).map(tr => `<span>${esc(traitLabel(tr))}</span>`).join("");
    const slot = this.ui.picker && this.ui.picker.kind !== "spell" ? `${t(`Group.${this.ui.picker.group}`)} · Lv ${this.ui.picker.level}` : "";
    const plan = this.plan;
    const who = this.actor?.name ?? plan?.meta?.name ?? plan?.name ?? game.user.name;
    const level = doc.type === "spell" ? ((s.traits?.value ?? []).includes("cantrip") ? t("Spells.Cantrip") : `${t("Detail.Level")} ${s.level?.value ?? ""}`)
      : s.level?.value !== undefined ? `${t("Detail.Level")} ${s.level.value}` : "";
    const content = `<div class="rpb-chat-card">
      <header><img src="${esc(doc.img)}" alt=""><div><h3>@UUID[${doc.uuid}]{${esc(doc.name)}}</h3><small>${esc([game.i18n.localize(CONFIG.Item?.typeLabels?.[doc.type] ?? doc.type), level].filter(Boolean).join(" · "))}${e?.original && !doc.name.includes(e.original) ? ` · ${esc(e.original)}` : ""}</small></div></header>
      <p class="who"><i class="fa-solid fa-compass-drafting"></i> ${esc(t("Detail.ToChatWho", { name: who }))}${slot ? ` — ${esc(slot)}` : ""}</p>
      ${traits ? `<div class="tags">${traits}</div>` : ""}
      ${s.prerequisites?.value?.length ? `<p><b>${t("Detail.Prereq")}</b> ${esc(s.prerequisites.value.map(p => p.value ?? p).join("; "))}</p>` : ""}
      <div class="desc">${s.description?.value ?? ""}</div></div>`;
    await ChatMessage.create({ speaker: this.actor ? ChatMessage.getSpeaker({ actor: this.actor }) : ChatMessage.getSpeaker(), content });
  }

  /** The item's questions (and its class features'): answered here, so PF2e need not ask later. */
  async choicesHtml(doc, plan, key) {
    const level = this.planLevel(plan);
    const qs = await questionsOf(await questionHolders(doc, this.idx, MAX_LEVEL, key), plan, level, this.idx);
    if (!qs.length) return "";
    const rows = [];
    let later = 0;
    let group = null;
    for (const q of qs) {
      if (!q.options) { later++; continue; }
      if (q.holder.key !== group) {
        group = q.holder.key;
        if (q.holder.doc !== doc) rows.push(`<h5 class="rpb-qhead">${q.holder.level > 1 ? `<span class="lv">Lv ${q.holder.level}</span>` : ""}${esc(q.holder.name)}</h5>`);
      }
      const has = q.options.some(o => o.value === String(q.value));
      if (q.options.some(o => o.uuid)) {
        const qid = `${q.holder.key}|${q.rule}`;
        this._choiceQs.set(qid, q);
        const cur = q.options.find(o => o.value === String(q.value));
        rows.push(`<div class="choice pickable"><span>${esc(q.label)}</span>
          <button type="button" class="rpb-choicebtn ${cur ? "set" : ""}" data-a="choice-open" data-q="${esc(qid)}" ${this.editable ? "" : "disabled"}>
            ${cur?.img ? `<img src="${esc(cur.img)}" alt="">` : `<i class="fa-solid fa-list-ul"></i>`}<b>${esc(cur?.label ?? (q.value ? String(q.value) : t("Choice.Pick")))}</b>
            <small>${t("Choice.Browse", { n: q.options.length })}</small></button>
          ${cur?.uuid ? `<button type="button" class="rpb-choiceinfo" data-a="peek-open" data-uuid="${esc(cur.uuid)}" data-tooltip="${esc(t("Choice.OpenSheet"))}"><i class="fa-solid fa-up-right-from-square"></i></button>` : ""}</div>`);
        continue;
      }
      rows.push(`<label class="choice">${esc(q.label)}<select data-a="choice" data-uuid="${esc(q.holder.key)}" data-slug="${esc(q.holder.slug ?? "")}" data-rule="${q.rule}" ${this.editable ? "" : "disabled"}>
        <option value="">${t("Detail.ChoiceLater")}</option>${q.value && !has ? `<option value="${esc(q.value)}" selected>${esc(q.value)}</option>` : ""}${q.options.map(o => `<option value="${esc(o.value)}" ${String(q.value) === o.value ? "selected" : ""}>${esc(o.label)}</option>`).join("")}</select></label>`);
    }
    return `<div class="rpb-choices"><h4>${t("Detail.Choices")}</h4>${rows.join("")}${later ? `<p class="rpb-hint">${t("Detail.ChoiceAsk", { n: later })}</p>` : ""}</div>`;
  }

  /** The level the plan is made for (creation: the start level; a character: its level). */
  planLevel(plan) {
    return Math.max(1, plan?.sheet?.level ?? this.actor?.level ?? (Number(setting("startLevel", 1)) || 1));
  }

  /** After a choice: on to the next step, or back to the summary (or the level, in a feat list). */
  nextButtons() {
    if (this.ui.picker?.kind === "choice") return `<button type="button" data-a="picker-close"><i class="fa-solid fa-arrow-left"></i> ${t("Choice.Back")}</button>`;
    if (this.ui.picker?.kind === "spell") return `<button type="button" data-a="picker-close"><i class="fa-solid fa-arrow-left"></i> ${t("Nav.BackLevel", { level: this.ui.picker.level })}</button>`;
    if (this.ui.picker) return `<button type="button" data-a="picker-close"><i class="fa-solid fa-arrow-left"></i> ${t("Nav.BackLevel", { level: this.ui.picker.level })}</button>`;
    const step = this.ui.step;
    const next = step === "ancestry" && this.ui.sub !== "heritage" ? "heritage" : NEXT[step];
    const label = next === "heritage" ? t("Step.Heritage") : next?.startsWith("level-") ? "Lv 1" : t(`Step.${{ background: "Background", class: "Class", deity: "Deity", attributes: "Attributes", skills: "Skills" }[next] ?? "Overview"}`);
    return `${next ? `<button type="button" data-a="${next === "heritage" ? "sub" : "step"}" data-${next === "heritage" ? "sub" : "step"}="${next}"><i class="fa-solid fa-arrow-right"></i> ${t("Nav.Next", { step: label })}</button>` : ""}
      <button type="button" data-a="step" data-step="overview"><i class="fa-solid fa-scroll"></i> ${t("Nav.Summary")}</button>`;
  }

  isChosen(uuid) {
    const p = this.plan;
    if (!p) return false;
    if ([p.ancestry, p.heritage, p.background, p.class, p.deity].some(r => r?.uuid === uuid)) return true;
    if (this.ui.picker?.kind === "spell") return spellsAt(p, this.ui.picker.level).some(r => r.uuid === uuid);
    if (this.ui.picker?.kind === "choice") {
      const q = this.ui.picker.q;
      return q.options.some(o => o.uuid === uuid && o.value === String(this.currentChoice(q) ?? ""));
    }
    if (this.ui.picker) return p.feats[this.ui.picker.id]?.uuid === uuid;
    return Object.values(p.feats).some(r => r?.uuid === uuid);
  }

  canChooseNow(uuid) {
    if (!this.editable) return false;
    if (this.ui.picker?.kind === "choice") return this.ui.picker.q.options.some(o => o.uuid === uuid);
    const e = this.idx.byUuid.get(uuid);
    if (!e) return false;
    if (setting("hideLegacy", false) && e.remaster === false && !this.isChosen(uuid)) return false;
    const plan = this.plan;
    if (this.ui.picker?.kind === "spell") return e.type === "spell";
    if (this.ui.picker) return e.type === "feat";
    if (plan.base === "sheet") return false;
    const step = this.ui.step;
    return (step === "ancestry" && ((this.ui.sub === "heritage" && e.type === "heritage") || (this.ui.sub !== "heritage" && e.type === "ancestry")))
      || (step === "background" && e.type === "background") || (step === "class" && e.type === "class") || (step === "deity" && e.type === "deity");
  }

  /* ---------------- choosing ---------------- */

  /** The spell list's checkbox: in or out at this level, the details panel stays where it is. */
  tickSpell(uuid) {
    if (this.ui.picker?.kind !== "spell" || !this.editable) return;
    const e = this.idx.byUuid.get(uuid);
    if (!e || !this.canChooseNow(uuid)) { this.peek(uuid); return; }
    const lv = this.ui.picker.level;
    this.mutate(p => {
      const list = (p.spells.byLevel[lv] ??= []);
      const i = list.findIndex(r => r.uuid === uuid);
      if (i >= 0) list.splice(i, 1); else list.push(refOf(e));
    });
  }

  choose(uuid) {
    if (this.ui.picker?.kind === "choice") {
      const { q, prev } = this.ui.picker;
      const o = q.options.find(x => x.uuid === uuid);
      if (!o || !this.editable) return;
      this.mutate(p => { setPick(p, q.holder.key, q.rule, o.value, q.holder.slug); }, { rerender: false });
      Object.assign(this.ui, prev);
      this._sameView = false;
      this.render();
      return this.syncTradition();
    }
    const e = this.idx.byUuid.get(uuid);
    if (!e || !this.canChooseNow(uuid)) { this.peek(uuid); return; }
    this.ui.detail = uuid;
    if (this.ui.picker?.kind === "spell") {
      const lv = this.ui.picker.level;
      return this.mutate(p => {
        const list = (p.spells.byLevel[lv] ??= []);
        const i = list.findIndex(r => r.uuid === uuid);
        if (i >= 0) list.splice(i, 1); else list.push(refOf(e));
      });
    }
    if (this.ui.picker) {
      const slot = this.ui.picker;
      this.mutate(p => { p.feats[slot.id] = refOf(e); });
      return this.askChoices(uuid);
    }
    if (e.type === "ancestry") {
      this.mutate(p => {
        if (p.ancestry?.uuid !== uuid) { p.heritage = null; p.boosts.ancestry = { alt: false, slots: {}, altPicks: [] }; }
        p.ancestry = refOf(e);
      }, { rerender: false });
      this.ui.sub = "heritage";
      this.ui.search = "";
      this.ui.detail = null;
      return this.render();
    }
    if (e.type === "heritage") { this.mutate(p => { p.heritage = refOf(e); }); return this.askChoices(uuid); }
    if (e.type === "background") { this.mutate(p => { if (p.background?.uuid !== uuid) p.boosts.background = {}; p.background = refOf(e); }); return this.askChoices(uuid); }
    if (e.type === "class") {
      const isNew = this.plan.class?.uuid !== uuid;
      this.mutate(p => {
        const changed = p.class?.uuid !== uuid;
        if (changed) p.boosts.classKey = null;
        p.class = refOf(e);
        // A caster: how it casts is known from the class (tradition left open when a subclass decides it).
        if (changed) {
          const d = casterDefaults(p, this.idx);
          p.spells.casting = d ? { tradition: d.tradition, mode: d.mode, attr: d.attr } : null;
          if (p.spells.casting && !p.spells.casting.tradition) p.spells.casting = null;
        }
      });
      return this.askChoices(uuid).then(() => { if (isNew && this.casterSlug(this.plan)) return this.spellSetup(); });
    }
    if (e.type === "deity") return this.mutate(p => { p.deity = p.deity?.uuid === uuid ? null : refOf(e); });
  }

  /** The item asks questions (its class features too, up to the plan's level): ask them now, in a small window. */
  async askChoices(uuid) {
    const doc = await getDoc(uuid);
    const plan = this.plan;
    if (!doc || !plan) return;
    const level = this.planLevel(plan);
    const qs = (await questionsOf(await questionHolders(doc, this.idx, level, uuid), plan, level, this.idx))
      .filter(q => q.options?.length && (q.value === undefined || q.value === ""));
    if (!qs.length) return;
    let group = null;
    const content = `<p>${t("Ask.Body", { name: esc(doc.name) })}</p>${qs.map((q, n) => {
      const head = q.holder.key !== group && q.holder.doc !== doc ? `<h5 class="rpb-qhead">${esc(q.holder.name)}</h5>` : "";
      group = q.holder.key;
      const items = q.options.some(o => o.uuid);
      return `${head}<label class="rpb-ask">${esc(q.label)}
      <select name="q${n}" ${items ? `data-peek="q${n}"` : ""}><option value="">${t("Detail.ChoiceLater")}</option>${q.options.map(o => `<option value="${esc(o.value)}" ${o.uuid ? `data-uuid="${esc(o.uuid)}"` : ""}>${esc(o.label)}</option>`).join("")}</select></label>
      ${items ? `<div class="rpb-ask-peek" data-for="q${n}"><p class="rpb-dim">${t("Choice.AskPeek")}</p></div>` : ""}`;
    }).join("")}`;
    const showPeek = async sel => {
      const box = sel.closest("form, .window-content")?.querySelector(`.rpb-ask-peek[data-for="${sel.name}"]`);
      const uuid = sel.selectedOptions[0]?.dataset.uuid;
      if (!box) return;
      if (!uuid) { box.innerHTML = `<p class="rpb-dim">${t("Choice.AskPeek")}</p>`; return; }
      const doc = await getDoc(uuid);
      const desc = doc ? await enrich(doc.system?.description?.value ?? "", { relativeTo: doc }) : "";
      if (sel.selectedOptions[0]?.dataset.uuid !== uuid) return;
      box.innerHTML = `<header><img src="${esc(doc?.img ?? "")}" alt=""><b>${esc(doc?.name ?? "")}</b>
        <button type="button" data-open="${esc(uuid)}" data-tooltip="${esc(t("Choice.OpenSheet"))}"><i class="fa-solid fa-up-right-from-square"></i></button></header><div class="desc">${desc}</div>`;
    };
    const answers = await foundry.applications.api.DialogV2.prompt({
      window: { title: t("Ask.Title"), resizable: true },
      position: { width: qs.some(q => q.options.some(o => o.uuid)) ? 640 : 420 },
      classes: ["rpb-ask-dialog"],
      content,
      render: (_ev, dialog) => {
        const root = dialog?.element ?? dialog;
        root?.addEventListener?.("change", ev => { if (ev.target.matches?.("select[data-peek]")) showPeek(ev.target); });
        root?.addEventListener?.("click", async ev => {
          const b = ev.target.closest?.("[data-open]");
          if (b) { ev.preventDefault(); (await fromUuid(b.dataset.open))?.sheet?.render(true); }
        });
      },
      ok: { label: t("Common.Ok"), callback: (_ev, button) => qs.map((_q, n) => button.form?.elements?.[`q${n}`]?.value ?? "") },
      rejectClose: false
    }).catch(() => null);
    if (!answers) return;
    this.mutate(p => {
      qs.forEach((q, n) => { if (answers[n]) setPick(p, q.holder.key, q.rule, answers[n], q.holder.slug); });
    });
    await this.syncTradition();
  }

  /** What is still open, and which fixed questions were left for PF2e to ask. */
  async pendingList(plan, upTo) {
    const lines = openItems(plan, upTo, this.idx).map(o => t(`Open.${o.key.includes("-") ? "slot" : o.key}`, { level: o.level, group: o.key.includes("-") ? t(`Group.${o.key.split("-")[0]}`) : "" }));
    const refs = [plan.ancestry, plan.heritage, plan.background, plan.class, plan.deity, ...Object.entries(plan.feats).filter(([sl]) => slotLevel(sl) <= upTo).map(([, r]) => r)].filter(Boolean);
    let asks = 0;
    for (const ref of refs) {
      const doc = await getDoc(ref.uuid);
      const qs = await questionsOf(await questionHolders(doc, this.idx, upTo, ref.uuid), plan, upTo, this.idx);
      asks += qs.filter(q => q.value === undefined || q.value === "").length;
    }
    return { lines, asks };
  }

  peek(uuid) {
    this.ui.detail = uuid;
    for (const el of this.element.querySelectorAll(".rpb-row.peek")) el.classList.remove("peek");
    this.element.querySelector(`.rpb-row[data-uuid="${CSS.escape(uuid)}"]`)?.classList.add("peek");
    let holder = this.element.querySelector(".rpb-detail");
    if (!holder) return this.render();
    holder.innerHTML = `<div class="rpb-detail-body" data-uuid="${uuid}"><p class="rpb-dim"><i class="fa-solid fa-spinner fa-spin"></i></p></div>`;
    holder.scrollTop = 0;
    this.fillDetail();
  }

  toggleBoost(row, a) {
    this.mutate(p => {
      const b = p.boosts;
      if (row === "anc-alt") {
        const list = b.ancestry.altPicks;
        const i = list.indexOf(a);
        if (i >= 0) list.splice(i, 1); else if (list.length < 2) list.push(a);
      } else if (row.startsWith("anc-")) {
        const k = row.slice(4);
        b.ancestry.slots[k] = b.ancestry.slots[k] === a ? undefined : a;
        if (!b.ancestry.slots[k]) delete b.ancestry.slots[k];
      } else if (row.startsWith("bg-")) {
        const k = row.slice(3);
        if (b.background[k] === a) delete b.background[k]; else b.background[k] = a;
      } else if (row === "class") {
        b.classKey = b.classKey === a ? null : a;
      } else if (row.startsWith("lv-")) {
        const lv = row.slice(3);
        const list = (b.levels[lv] ??= []);
        const i = list.indexOf(a);
        if (i >= 0) list.splice(i, 1); else if (list.length < 4) list.push(a);
      }
    });
  }

  /* ---------------- events ---------------- */

  async onClick(ev) {
    const el = ev.target.closest("[data-a]");
    if (!el || el.disabled) return;
    const a = el.dataset.a;
    if (["search", "f-met", "f-legacy", "f-rarity", "f-boost", "f-flaw", "anc-alt", "ring", "plan-name", "char-name", "notes", "increase", "extra", "choice", "preview-level", "for-user", "f-alltrad", "cast-tradition", "cast-mode", "cast-attr"].includes(a)) return;
    ev.preventDefault();
    switch (a) {
      case "step":
        this.ui.step = el.dataset.step;
        this.ui.picker = null;
        this.ui.detail = null;
        this.ui.search = "";
        this.ui.limit = 200;
        if (this.ui.step === "ancestry") this.ui.sub = this.plan?.ancestry && !this.plan?.heritage ? "heritage" : "ancestry";
        if (this.ui.step.startsWith("level-")) this.ui.previewLevel = Math.max(this.ui.previewLevel, Number(this.ui.step.slice(6)));
        this._sameView = false;
        return this.render();
      case "sub":
        this.ui.sub = el.dataset.sub;
        this.ui.detail = null;
        this.ui.search = "";
        this._sameView = false;
        return this.render();
      case "plan":
        this.ui.planId = el.dataset.id;
        this.ui.picker = null;
        this.ui.detail = null;
        return this.render();
      case "plan-menu": return this.planMenu();
      case "free-convert": return this.convertFree();
      case "rebuild": return this.rebuild();
      case "plan-del": return this.deletePlan();
      case "plan-active":
        await this.actor.setFlag(MID, "activePlan", this.plan.id);
        return this.render();
      case "compare": return openCompare(this.actor, this.plans, this.ui.previewLevel);
      case "familiar": return (await import("./familiar.mjs")).openFamiliar(this.actor);
      case "peek": return this.peek(el.dataset.uuid);
      case "choose": return this.choose(el.dataset.uuid);
      case "check": return this.tickSpell(el.dataset.uuid);
      case "to-chat": return this.toChat(el.dataset.uuid);
      case "unlock": {
        if (!this.plan.unlocked) {
          const ok = await foundry.applications.api.DialogV2.confirm({
            window: { title: t("Locked.UnlockTitle") }, content: `<p>${t("Locked.UnlockBody", { level: this.plan.sheet?.level ?? 1 })}</p>`, rejectClose: false
          }).catch(() => false);
          if (!ok) return;
        }
        return this.mutate(p => { p.unlocked = !p.unlocked; });
      }
      case "slot": {
        const id = el.dataset.slot;
        this.ui.picker = { id, group: id.split("-")[0], level: slotLevel(id) };
        this.ui.tab = this.ui.picker.group === "class" ? "class" : this.ui.picker.group === "general" ? "all" : null;
        this.ui.detail = this.plan.feats[id]?.uuid ?? null;
        this.ui.search = "";
        this.ui.limit = 200;
        this._sameView = false;
        return this.render();
      }
      case "slot-clear": return this.mutate(p => { delete p.feats[el.dataset.slot]; });
      case "choice-open": {
        const q = this._choiceQs.get(el.dataset.q);
        if (!q) return;
        const prev = { picker: this.ui.picker, detail: this.ui.detail, tab: this.ui.tab, search: this.ui.search, limit: this.ui.limit };
        const cur = q.options.find(o => o.value === String(this.currentChoice(q) ?? ""));
        this.ui.picker = { kind: "choice", id: "choice", q, prev };
        this.ui.detail = cur?.uuid ?? q.options.find(o => o.uuid)?.uuid ?? null;
        this.ui.tab = null; this.ui.search = ""; this.ui.limit = 500; this._sameView = false;
        return this.render();
      }
      case "peek-open": {
        const doc = await fromUuid(el.dataset.uuid);
        return doc?.sheet?.render(true);
      }
      case "picker-close":
        if (this.ui.picker?.kind === "choice") {
          Object.assign(this.ui, this.ui.picker.prev);
          this._sameView = false;
          return this.render();
        }
        this.ui.picker = null;
        this.ui.detail = null;
        this._sameView = false;
        return this.render();
      case "tab":
        this.ui.tab = el.dataset.tab;
        this.ui.limit = 200;
        return this.render();
      case "more":
        this.ui.limit += 300;
        return this.refreshList();
      case "boost": return this.toggleBoost(el.dataset.row, el.dataset.attr);
      case "skill":
        return this.mutate(p => {
          const s = el.dataset.skill;
          const set = new Set(p.skills.trained);
          if (set.has(s)) set.delete(s); else set.add(s);
          p.skills.trained = [...set];
        });
      case "upload": return this.pickImage(el.dataset.kind);
      case "spell-pick":
        this.ui.picker = { kind: "spell", id: `spell-${el.dataset.level}`, level: Number(el.dataset.level) };
        this.ui.tab = el.dataset.kind ?? (Number(el.dataset.level) === 1 && !spellsAt(this.plan, 1).length ? "cantrip" : "spell");
        this.ui.detail = null; this.ui.search = ""; this.ui.limit = 200; this._sameView = false;
        return this.render();
      case "spell-setup": return this.spellSetup();
      case "spell-resync": {
        const { syncActorClassSpells } = await import("../class-spells.mjs");
        const done = await syncActorClassSpells(this.actor);
        return ui.notifications.info(done.length ? t("Spells.Resynced", { list: done.join(", ") }) : t("Spells.ResyncNone"));
      }
      case "cast-found": {
        const d = casterDefaults(this.plan, this.idx);
        return this.mutate(p => { p.spells.casting = { tradition: el.dataset.trad, mode: d?.mode ?? p.spells.casting?.mode ?? "prepared", attr: d?.attr ?? p.spells.casting?.attr ?? "int" }; });
      }
      case "spell-del": return this.mutate(p => { p.spells.byLevel[el.dataset.level]?.splice(Number(el.dataset.i), 1); });
      case "cast-default": { const d = casterDefaults(this.plan, this.idx); return this.mutate(p => { p.spells.casting = { tradition: d.tradition ?? p.spells.casting?.tradition ?? null, mode: d.mode, attr: d.attr }; }); }
      case "increase-pick":
        return this.mutate(p => { const lv = el.dataset.level; if (p.skills.increases[lv] === el.dataset.skill) delete p.skills.increases[lv]; else p.skills.increases[lv] = el.dataset.skill; });
      case "extra-pick":
        return this.mutate(p => { const lv = el.dataset.level; if (p.skills.extra[lv] === el.dataset.skill) delete p.skills.extra[lv]; else p.skills.extra[lv] = el.dataset.skill; });
      case "create": return this.create();
      case "apply": return this.apply(el.dataset.mode);
    }
  }

  onInput(ev) {
    const el = ev.target;
    const a = el.dataset?.a;
    if (a === "search") {
      this.ui.search = el.value;
      this.ui.limit = 200;
      this.searchSoon();
    } else if (a === "plan-name") {
      this.mutate(p => { p.name = el.value; }, { rerender: false });
    } else if (a === "char-name") {
      this.mutate(p => { p.meta = { ...(p.meta ?? {}), charName: el.value }; }, { rerender: false });
    } else if (a === "notes") {
      this.mutate(p => { p.notes = el.value; }, { rerender: false });
    }
  }

  onChange(ev) {
    const el = ev.target;
    const a = el.dataset?.a;
    switch (a) {
      case "f-met": this.ui.onlyMet = el.checked; return this.refreshList();
      case "f-legacy": this.ui.legacy = !setting("hideLegacy", false) && el.checked; return this.refreshList();
      case "f-alltrad": this.ui.allTraditions = el.checked; return this.refreshList();
      case "cast-tradition": case "cast-mode": case "cast-attr":
        return this.mutate(p => {
          const def = casterDefaults(p, this.idx);
          const c = (p.spells.casting ??= { tradition: null, mode: def?.mode ?? "prepared", attr: def?.attr ?? "int" });
          c[{ "cast-tradition": "tradition", "cast-mode": "mode", "cast-attr": "attr" }[a]] = el.value || null;
          if (!c.tradition) p.spells.casting = null;
        });
      case "f-boost":
        if (el.checked) this.ui.attrBoost.add(el.dataset.attr); else this.ui.attrBoost.delete(el.dataset.attr);
        el.closest(".chip")?.classList.toggle("on", el.checked);
        return this.refreshList();
      case "f-flaw":
        this.ui.flaw = el.value;
        return this.refreshList();
      case "f-rarity":
        if (el.checked) this.ui.rarity.add(el.dataset.r); else this.ui.rarity.delete(el.dataset.r);
        el.closest(".chip")?.classList.toggle("on", el.checked);
        return this.refreshList();
      case "anc-alt": return this.mutate(p => { p.boosts.ancestry.alt = el.checked; });
      case "ring": return this.mutate(p => { p.meta = { ...(p.meta ?? {}), ring: el.checked }; }, { rerender: false });
      case "for-user": return this.mutate(p => { p.meta = { ...(p.meta ?? {}), userId: el.value || game.user.id }; }, { rerender: false });
      case "increase": return this.mutate(p => { if (el.value) p.skills.increases[el.dataset.level] = el.value; else delete p.skills.increases[el.dataset.level]; });
      case "extra": return this.mutate(p => { if (el.value) p.skills.extra[el.dataset.level] = el.value; else delete p.skills.extra[el.dataset.level]; });
      case "choice":
        this.mutate(p => {
          setPick(p, el.dataset.uuid, el.dataset.rule, el.value, el.dataset.slug || null);
        });
        return this.syncTradition();
      case "preview-level":
        this.ui.previewLevel = Number(el.value) || 1;
        return this.render();
    }
  }

  /* ---------------- plans ---------------- */

  async planMenu() {
    // From the sheet, a build from scratch (applied later by rebuilding the character), or a copy.
    const kinds = [["sheet", t("Plan.NewSheet"), "fa-user-pen"], ["free", t("Plan.NewFree"), "fa-flask"], ["copy", t("Plan.NewCopy"), "fa-copy"]];
    const choice = await foundry.applications.api.DialogV2.wait({
      window: { title: t("Plan.AddTitle") },
      content: `<p>${t("Plan.AddBody")}</p>`,
      buttons: kinds.map(([k, l, i]) => ({ action: k, label: l, icon: `fa-solid ${i}` })),
      rejectClose: false
    }).catch(() => null);
    if (!choice) return;
    const n = this.plans.length + 1;
    let plan;
    if (choice === "sheet") plan = planFromActor(this.actor, t("Plan.NumName", { n }));
    else if (choice === "free") plan = newPlan(t("Plan.FreeName", { n }), "free");
    else plan = clonePlan(this.plan, `${this.plan.name} (2)`);
    this.plans.push(plan);
    this.ui.planId = plan.id;
    this.ui.step = plan.base === "free" ? "ancestry" : "overview";
    await this.save();
    this.render();
  }

  /** A build from scratch → one that continues from the sheet; its picks for later levels are kept. */
  async convertFree() {
    const plan = this.plan;
    if (plan?.base !== "free" || !this.actor) return;
    const ok = await foundry.applications.api.DialogV2.confirm({ window: { title: t("Plan.Convert") }, content: `<p>${t("Plan.ConvertAsk", { name: esc(plan.name) })}</p>`, rejectClose: false }).catch(() => false);
    if (!ok) return;
    const fresh = toSheetPlan(plan, this.actor);
    this.plans = this.plans.map(p => (p.id === plan.id ? fresh : p));
    this.ui.step = "overview";
    await this.save();
    ui.notifications.info(t("Plan.Converted", { name: fresh.name }));
    this.render();
  }

  /** A build from scratch put on this character: the old build comes off, this one goes on up to the sheet's level. */
  async rebuild() {
    const actor = this.actor;
    const plan = this.plan;
    if (!actor?.isOwner || plan?.base !== "free" || !(game.user.isGM || setting("allowRebuild", true))) return;
    const level = actor.level;
    const loss = rebuildLoss(actor);
    const ok = await foundry.applications.api.DialogV2.confirm({
      window: { title: t("Plan.RebuildTitle", { name: plan.name }) },
      content: `<p>${t("Plan.RebuildBody", { actor: `<b>${esc(actor.name)}</b>`, level })}</p>
        <p><b>${t("Plan.RebuildLose")}:</b> ${esc(t("Plan.RebuildLoseList", { abc: loss.abc.join(", ") || "—", feats: loss.feats, spells: loss.spells }))}</p>
        <p class="hint">${t("Plan.RebuildKeep")}</p>${pendingHtml(await this.pendingList(plan, level))}<p class="hint">${t("Apply.Prompts")}</p>`,
      rejectClose: false
    }).catch(() => false);
    if (!ok) return;
    try {
      const done = await applyRebuild(actor, plan, { level, progress: msg => ui.notifications.info(msg) });
      ui.notifications.info(t("Plan.RebuildDone", { name: actor.name, n: done.length }));
      this.plans = plansOf(actor).map(p => refreshSheetPlan(p, actor));
      this.ui.planId = plan.id;
      this.ui.step = "overview";
      this.render();
    } catch (err) {
      console.error(`${MID} | rebuild`, err);
      ui.notifications.error(`${t("Apply.Failed")} ${err.message ?? err}`);
    }
  }

  async deletePlan() {
    const plan = this.plan;
    const ok = await foundry.applications.api.DialogV2.confirm({ window: { title: t("Plan.Delete") }, content: `<p>${t("Plan.DeleteBody", { name: esc(plan.name) })}</p>`, rejectClose: false }).catch(() => false);
    if (!ok) return;
    this.plans = this.plans.filter(p => p.id !== plan.id);
    this.ui.planId = this.plans[0]?.id ?? null;
    await savePlans(this.actor, this.plans, activePlanId(this.actor) === plan.id ? this.ui.planId : undefined);
    this.render();
  }

  /* ---------------- pictures, creating, applying ---------------- */

  pickImage(kind) {
    if (!canUpload()) return ui.notifications.warn(t("Create.NoUpload"));
    const input = this.element.querySelector(".rpb-file");
    if (!input) return;
    input.onchange = async () => {
      const file = input.files?.[0];
      input.value = "";
      if (!file) return;
      try {
        ui.notifications.info(t("Create.Uploading"));
        const path = await uploadImage(file, { kind, name: this.plan.meta?.charName || this.plan.name || game.user.name });
        this.mutate(p => { p.meta = { ...(p.meta ?? {}), [kind === "token" ? "tokenImg" : "img"]: path }; });
      } catch (err) {
        ui.notifications.error(`${t("Create.UploadFailed")} ${err.message ?? err}`);
      }
    };
    input.click();
  }

  async create() {
    const plan = this.plan;
    const meta = plan.meta ?? {};
    const level = Math.max(1, Math.min(20, Number(setting("startLevel", 1)) || 1));
    const name = meta.charName || t("Create.DefaultName");
    const pend = await this.pendingList(plan, level);
    const ok = await foundry.applications.api.DialogV2.confirm({
      window: { title: t("Overview.Create") },
      content: `<p>${t("Create.Confirm", { name: esc(name), level })}</p>${pendingHtml(pend)}`,
      rejectClose: false
    }).catch(() => false);
    if (!ok) return;
    try {
      ui.notifications.info(t("Create.Working"));
      const actor = await requestActor({ name, img: meta.img || null, tokenImg: meta.tokenImg || null, ring: meta.ring !== false, userId: meta.userId || game.user.id });
      await applyCreation(actor, plan, { level, progress: msg => ui.notifications.info(msg) });
      if (!game.user.isGM || !meta.userId || meta.userId === game.user.id) await clearDraft();
      ui.notifications.info(t("Create.Done", { name: actor.name }));
      this.close();
      actor.sheet?.render(true);
    } catch (err) {
      console.error(`${MID} | create`, err);
      ui.notifications.error(`${t("Create.Failed")} ${err.message ?? err}`);
    }
  }

  async apply(mode) {
    const actor = this.actor;
    const plan = this.plan;
    if (!actor?.isOwner || plan.base !== "sheet") return;
    const upTo = mode === "next" ? actor.level + 1 : actor.level;
    if (upTo > 20) return;
    const pending = await pendingUpTo(actor, plan, upTo);
    const list = [
      ...(mode === "next" ? [t("Apply.Raised", { level: upTo })] : []),
      ...pending.boosts.map(lv => t("Apply.Boosts", { level: lv })),
      ...pending.skills.map(s => t("Apply.Skill", { skill: skillLabel(s.slug), rank: rankLabel(s.to) })),
      ...pending.feats.map(f => {
        const r = (pending.replace ?? []).find(x => x.slot === f.slot);
        return `${t(`Group.${f.slot.split("-")[0]}`)} Lv ${slotLevel(f.slot)}: ${r ? `${r.from} → ` : ""}${f.name}`;
      }),
      ...(pending.spells ?? []).map(r => `${t("Spells.One")}: ${r.name}`)
    ];
    if (!list.length) return ui.notifications.info(t("Apply.Nothing"));
    const ok = await foundry.applications.api.DialogV2.confirm({
      window: { title: t("Apply.Title", { level: upTo }) },
      content: `<p>${t("Apply.Body")}</p><ul>${list.map(x => `<li>${esc(x)}</li>`).join("")}</ul>${pendingHtml(await this.pendingList(plan, upTo))}<p class="hint">${t("Apply.Prompts")}</p>`,
      rejectClose: false
    }).catch(() => false);
    if (!ok) return;
    try {
      const done = await applyUpTo(actor, plan, upTo, { raiseLevel: mode === "next" });
      ui.notifications.info(t("Apply.Done", { n: done.length }));
      this.plans = plansOf(actor).map(p => refreshSheetPlan(p, actor));
      this.ui.previewLevel = Math.max(this.ui.previewLevel, actor.level);
      this.render();
    } catch (err) {
      console.error(`${MID} | apply`, err);
      ui.notifications.error(`${t("Apply.Failed")} ${err.message ?? err}`);
    }
  }
}

function pendingHtml({ lines, asks }) {
  if (!lines.length && !asks) return "";
  return `<div class="rpb-pending"><b><i class="fa-solid fa-triangle-exclamation"></i> ${t("Pending.Title")}</b>
    ${lines.length ? `<ul>${lines.map(l => `<li>${esc(l)}</li>`).join("")}</ul>` : ""}
    ${asks ? `<p>${t("Pending.Asks", { n: asks })}</p>` : ""}<p class="hint">${t("Pending.Hint")}</p></div>`;
}

/* ---------------- stats block (overview and compare) ---------------- */

export function statsHtml(st) {
  if (!st) return "";
  if (st.error) return `<p class="rpb-dim">${t("Overview.StatsError")} <small>${esc(st.error)}</small></p>`;
  const rank = r => (r ? `<small class="rk r${r}">${esc(rankLabel(r).slice(0, 2))}</small>` : "");
  const line = (label, v, r) => `<div class="stat"><span>${esc(label)}</span><b>${esc(v)}</b>${rank(r)}</div>`;
  const saves = ["fortitude", "reflex", "will"].map(k => line(game.i18n.localize(CONFIG.PF2E.saves?.[k] ?? k), signed(st.saves[k]?.mod ?? 0), st.saves[k]?.rank)).join("");
  const attrs = ATTRS.map(a => `<div class="attr"><small>${esc(attrLabel(a))}</small><b>${signed(st.attrs[a])}</b></div>`).join("");
  const skills = skillSlugs().filter(s => (st.skills[s]?.rank ?? 0) > 0).map(s => `<span class="sk r${st.skills[s].rank}">${esc(skillLabel(s))} ${signed(st.skills[s].mod)}</span>`).join("");
  return `<div class="rpb-statgrid">
      ${line(t("Stat.HP"), st.hp)}${line(t("Stat.AC"), st.ac)}${line(game.i18n.localize("PF2E.PerceptionLabel"), signed(st.perception?.mod ?? 0), st.perception?.rank)}
      ${saves}${st.classDC ? line(t("Stat.ClassDC"), st.classDC) : ""}${st.speed ? line(t("Stat.Speed"), st.speed) : ""}
    </div>
    <div class="rpb-attrs">${attrs}</div>
    <div class="rpb-skillchips">${skills}</div>
    <p class="rpb-hint">${t("Stat.Note")}</p>`;
}

let open = new Map();
export function refreshBuilders() {
  for (const app of open.values()) if (app.rendered) app.render();
}

function alignmentHtml(entry) {
  const alignment = entry.deityAlignment ?? deityAlignment(entry);
  return alignment ? `<span class="rpb-alignment ${alignment.axis}" data-tooltip="${esc(t("DeityAlignment.Hint", { alignment: alignment.code }))}">${esc(t(`DeityAlignment.${alignment.axis}`))}</span>` : "";
}

export function openBuilder(actor = null) {
  const key = actor?.id ?? "new";
  const existing = open.get(key);
  if (existing?.rendered) { existing.bringToFront?.(); return existing; }
  const app = new BuilderApp({ actor });
  open.set(key, app);
  app.render(true);
  return app;
}
