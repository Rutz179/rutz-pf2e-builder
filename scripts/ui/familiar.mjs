import { MID, enrich, esc, sluggify, sourceIdOf, t } from "../util.mjs";
import { browserOff, mirroredSystemPack, originalName, norm } from "../data.mjs";
import { castingForClass } from "../spells.mjs";

/* ======================================================================== *
 * 사역마 빌더 — the familiar's abilities, with what each one needs.
 *
 * PF2e keeps how many abilities a familiar gets on its master
 * (system.attributes.familiarAbilities, raised by Familiar, Enhanced
 * Familiar, the witch's familiar …) but the abilities themselves are plain
 * items with their conditions only in the text: "you must be at least 8th
 * level", "your familiar must have the manual dexterity ability", "Leshy
 * Familiar Secrets", a witch patron's own "Familiar of …" ability.
 * Here they are sorted (familiar / master / only for some familiars) and
 * checked against the master and the familiar:
 *   ✔ meets it   ✖ does not (why)   ? the book says something only the GM can check
 * Abilities go onto the familiar actor (made here if there is none).
 * ======================================================================== */

// Player Core / AoN: abilities that belong to the master.
const MASTER = new Set(["absorb-familiar", "cantrip-connection", "extra-alchemy", "extra-vial", "familiar-focus", "innate-surge", "kindling",
  "lifelink", "recall-familiar", "restorative-familiar", "share-senses", "spell-battery", "spell-delivery", "tattoo-transformation"]);

// What an ability needs. abilities: other abilities on the familiar; feats: on the master (slugs);
// level / rank (highest spell slot) / focus / cantrips: the master; ask: only the GM can tell.
const NEEDS = {
  "construct": { abilities: ["tough"] },
  "elemental": { abilities: ["resistance"] },
  "greater-resistance": { abilities: ["resistance"] },
  "major-resistance": { level: 8, abilities: ["resistance"] },
  "item-delivery": { abilities: ["manual-dexterity"] },
  "lab-assistant": { abilities: ["manual-dexterity"], feats: ["quick-alchemy"] },
  "masters-form": { abilities: ["manual-dexterity", "speech"] },
  "toolbearer": { abilities: ["manual-dexterity"] },
  "kinspeech": { abilities: ["speech"], level: 6 },
  "versatile-form": { abilities: ["construct"], skill: ["crafting", 1] },
  "plant-form": { abilities: ["plant"] },
  "augury": { level: 8 },
  "shadow-step": { level: 7, feats: ["shadowcaster-dedication"], ask: "Fam.Ask.Shadow" },
  "darkeater": { feats: ["shadowcaster-dedication"], ask: "Fam.Ask.Shadow" },
  "spellcasting": { rank: 6 },
  "spell-battery": { rank: 4 },
  "medic": { rank: 3, ask: "Fam.Ask.Deity" },
  "familiar-focus": { focus: true },
  "cantrip-connection": { cantrips: true },
  "extra-alchemy": { feats: ["advanced-alchemy"] },
  "extra-vial": { feats: ["versatile-vials"] },
  "grasping-tendrils": { feats: ["leshy-familiar-secrets"] },
  "purify-air": { feats: ["leshy-familiar-secrets"] },
  "verdant-burst": { feats: ["leshy-familiar-secrets"] },
  "mask-freeze": { feats: ["mask-familiar", "adaptive-mask-familiar"] },
  "poison-reservoir": { ask: "Fam.Ask.Homunculus" },
  "animated": { ask: "Fam.Ask.Object" },
  "undead": { feats: ["undead-familiar", "enhanced-undead-familiar"], ask: "Fam.Ask.Undead" }
};
for (const el of ["air", "earth", "fire", "metal", "water", "wood"]) NEEDS[`elemental-familiar-${el}`] = { feats: ["elemental-familiar-kineticist", "elemental-familiar"] };

const KINDS = ["familiar", "master", "special"];

/* ---------------- data ---------------- */

let cache = null;

function abilityPacks() {
  const all = game.packs.filter(p => p.documentName === "Item");
  return all.filter(p => /familiar-?abilit/i.test(p.metadata.name) && !browserOff(p) && !mirroredSystemPack(p, all));
}

/** Every familiar ability: { uuid, name, english, slug, img, kind, folder, needs, source } */
async function loadAbilities() {
  if (cache) return cache;
  const out = [];
  for (const pack of abilityPacks()) {
    const folders = new Map((pack.folders?.contents ?? [...(pack.folders ?? [])]).map(f => [f.id, f]));
    const idx = await pack.getIndex({ fields: ["img", "system.slug", "system.category", "system.traits.value", "system.publication.title", "folder", "flags.babele.originalName"] });
    for (const e of idx) {
      if (e.type !== "action") continue;
      const english = originalName(e) || e.name;
      const slug = e.system?.slug || sluggify(english);
      // Folders: the witch's patron abilities, specific familiars, undead familiars.
      let folder = folders.get(e.folder);
      let path = "";
      while (folder) { path = `${folder.name}/${path}`; folder = folder.folder ? (typeof folder.folder === "string" ? folders.get(folder.folder) : folder.folder) : null; }
      const special = /witch|마녀|specific|특정|전용|undead|언데드/i.test(path) || /^familiar-of-/.test(slug);
      const patron = /witch|마녀/i.test(path) || /^familiar-of-/.test(slug);
      out.push({
        uuid: e.uuid ?? `Compendium.${pack.collection}.Item.${e._id}`, name: e.name, english, slug, img: e.img,
        kind: special ? "special" : MASTER.has(slug) ? "master" : "familiar", patron, folder: path.replace(/\/$/, ""),
        needs: NEEDS[slug] ?? null, source: e.system?.publication?.title ?? "", search: norm(`${e.name} ${english}`)
      });
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name, game.i18n.lang));
  cache = out;
  return out;
}

/** Slugs of what an actor has (system slug, the English name of translated items). */
function slugsOf(actor) {
  const set = new Set();
  for (const i of actor?.items ?? []) {
    if (i.system?.slug) set.add(i.system.slug);
    const en = i.flags?.babele?.originalName ?? (/\(([^()]*[A-Za-z][^()]*)\)\s*$/.exec(i.name)?.[1]) ?? i.name;
    set.add(sluggify(en));
  }
  return set;
}

function highestSlot(master) {
  let top = 0;
  for (const e of master?.itemTypes?.spellcastingEntry ?? []) {
    if (!["prepared", "spontaneous"].includes(e.system?.prepared?.value)) continue;
    for (let r = 10; r >= 1; r--) if (Number(e.system?.slots?.[`slot${r}`]?.max ?? 0) > 0) { top = Math.max(top, r); break; }
  }
  return top;
}

/** { state: ok | no | unk | patron | special, lines: [{ ok, text }] } */
function check(ab, master, familiar) {
  const lines = [];
  if (ab.patron) return { state: "patron", lines: [{ ok: null, text: t("Fam.Patron") }] };
  const n = ab.needs ?? {};
  const mine = slugsOf(master);
  const fam = slugsOf(familiar);
  if (n.level) lines.push({ ok: (master?.level ?? 0) >= n.level, text: t("Fam.Need.Level", { n: n.level }) });
  if (n.rank) lines.push({ ok: highestSlot(master) >= n.rank, text: t("Fam.Need.Rank", { n: n.rank }) });
  if (n.focus) lines.push({ ok: Number(master?.system?.resources?.focus?.max ?? 0) > 0, text: t("Fam.Need.Focus") });
  if (n.cantrips) lines.push({ ok: (master?.itemTypes?.spellcastingEntry ?? []).some(e => ["prepared", "spontaneous"].includes(e.system?.prepared?.value)), text: t("Fam.Need.Cantrips") });
  if (n.skill) lines.push({ ok: Number(master?.skills?.[n.skill[0]]?.rank ?? 0) >= n.skill[1], text: t("Fam.Need.Skill", { skill: game.i18n.localize(CONFIG.PF2E?.skills?.[n.skill[0]]?.label ?? n.skill[0]) }) });
  if (n.feats) lines.push({ ok: n.feats.some(f => mine.has(f)), feat: true, text: t("Fam.Need.Feat", { list: n.feats.map(f => f.replace(/-/g, " ")).join(" / ") }) });
  for (const a of n.abilities ?? []) lines.push({ ok: fam.has(a), text: t("Fam.Need.Ability", { name: a.replace(/-/g, " ") }) });
  if (n.ask) lines.push({ ok: null, text: t(n.ask) });
  if (ab.kind === "special" && !n.feats) lines.push({ ok: null, text: t("Fam.Specific", { folder: ab.folder || "—" }) });
  // A failed requirement decides — except a feat when the book also allows another way the GM must judge (a shadow familiar …).
  const hard = lines.filter(l => l.ok === false);
  let state = hard.length ? (n.ask && hard.every(l => l.feat) ? "unk" : "no") : lines.some(l => l.ok === null) ? "unk" : "ok";
  if (ab.kind === "special" && state === "ok" && !n.feats) state = "unk";
  return { state, lines };
}

/* ---------------- the window ---------------- */

export class FamiliarBuilder extends foundry.applications.api.ApplicationV2 {
  static DEFAULT_OPTIONS = {
    classes: ["rpb-app", "rpb-familiar"],
    window: { title: "RPB.Fam.Title", icon: "fa-solid fa-feather", resizable: true },
    position: { width: 940, height: 680 }
  };

  constructor(master) {
    super({ id: `rpb-familiar-${master?.id ?? "x"}` });
    this.masterId = master?.id ?? null;
    this.ui = { tab: "familiar", search: "", detail: null, onlyOk: false };
  }

  get master() { return game.actors.get(this.masterId) ?? null; }
  get familiar() {
    const m = this.master;
    return game.actors.find(a => a.type === "familiar" && a.system?.master?.id === m?.id) ?? null;
  }

  async _renderHTML() {
    const list = await loadAbilities();
    const master = this.master;
    const fam = this.familiar;
    const masters = game.actors.filter(a => a.type === "character" && (a.isOwner || game.user.isGM));
    const total = Number(master?.system?.attributes?.familiarAbilities?.value ?? 0);
    const have = (fam?.items ?? []).filter(i => i.type === "action");
    const haveSlugs = slugsOf(fam);
    const words = norm(this.ui.search).split(" ").filter(Boolean);
    const rows = list.filter(a => a.kind === this.ui.tab && words.every(w => a.search.includes(w))).map(a => ({ a, c: check(a, master, fam) }))
      .filter(r => !this.ui.onlyOk || r.c.state === "ok");
    const mark = s => ({ ok: "✔", no: "✖", unk: "?", patron: "★" }[s] ?? "?");
    const counts = Object.fromEntries(KINDS.map(k => [k, list.filter(a => a.kind === k).length]));
    return `<div class="rpb-fam">
      <header class="rpb-fam-top">
        <label>${t("Fam.Master")} <select data-a="master">${masters.map(a => `<option value="${a.id}" ${a.id === this.masterId ? "selected" : ""}>${esc(a.name)}</option>`).join("")}</select></label>
        ${fam ? `<button type="button" data-a="fam-sheet"><img src="${esc(fam.img)}" alt=""> ${esc(fam.name)}</button>` : `<button type="button" class="primary" data-a="fam-create" ${master ? "" : "disabled"}><i class="fa-solid fa-plus"></i> ${t("Fam.Create")}</button>`}
        <span class="count ${have.length > total ? "over" : have.length === total ? "ok" : ""}" data-tooltip="${esc(t("Fam.CountHint"))}">${t("Fam.Count", { n: have.length, total })}</span>
      </header>
      <div class="rpb-fam-have">${have.length ? have.map(i => `<span class="chip"><button type="button" class="nm" data-a="peek" data-uuid="${esc(sourceIdOf(i) ?? i.uuid)}"><img src="${esc(i.img)}" alt="">${esc(i.name)}</button>
        <button type="button" class="x" data-a="remove" data-id="${i.id}" aria-label="${esc(t("Fam.Remove"))}"><i class="fa-solid fa-xmark"></i></button></span>`).join("") : `<span class="rpb-dim">${t(fam ? "Fam.NoneYet" : "Fam.NoFamiliar")}</span>`}</div>
      <div class="rpb-fam-body">
        <section class="left">
          <div class="tabs">${KINDS.map(k => `<button type="button" class="${this.ui.tab === k ? "on" : ""}" data-a="tab" data-tab="${k}">${t(`Fam.Kind.${k}`)} <small>${counts[k]}</small></button>`).join("")}</div>
          <div class="row"><input type="search" data-a="search" value="${esc(this.ui.search)}" placeholder="${esc(t("Fam.Search"))}">
            <label><input type="checkbox" data-a="only-ok" ${this.ui.onlyOk ? "checked" : ""}> ${t("Fam.OnlyOk")}</label></div>
          <p class="rpb-hint">${t(`Fam.KindHint.${this.ui.tab}`)}</p>
          <div class="list">${rows.map(({ a, c }) => `<button type="button" class="rpb-row ${this.ui.detail === a.uuid ? "peek" : ""} ${c.state} ${haveSlugs.has(a.slug) ? "sel" : ""}" data-a="peek" data-uuid="${esc(a.uuid)}">
              <span class="pr ${c.state}" data-tooltip="${esc(c.lines.map(l => `${l.ok === true ? "✔" : l.ok === false ? "✖" : "?"} ${l.text}`).join("<br>") || t("Fam.NoNeeds"))}">${mark(c.state)}</span>
              <img src="${esc(a.img)}" alt="" loading="lazy"><span class="nm">${esc(a.name)}${a.english && !a.name.includes(a.english) ? `<small>${esc(a.english)}</small>` : ""}</span></button>`).join("") || `<p class="rpb-dim">${t("List.Empty")}</p>`}</div>
        </section>
        <section class="rpb-detail">${this.ui.detail ? `<div class="rpb-fam-detail" data-uuid="${esc(this.ui.detail)}"><p class="rpb-dim"><i class="fa-solid fa-spinner fa-spin"></i></p></div>` : `<p class="rpb-dim">${t("Fam.PickHint")}</p>`}</section>
      </div></div>`;
  }

  _replaceHTML(result, content) {
    const top = content.querySelector(".list")?.scrollTop ?? 0;
    content.innerHTML = result;
    const list = content.querySelector(".list");
    if (list && top) list.scrollTop = top;
    if (this._wired !== content) {
      this._wired = content;
      content.addEventListener("click", ev => this.onClick(ev));
      content.addEventListener("change", ev => this.onChange(ev));
      const typed = ev => {
        if (ev.isComposing || ev.target.dataset.a !== "search") return; // Korean IME: wait for the syllable
        this.ui.search = ev.target.value;
        clearTimeout(this._typing);
        this._typing = setTimeout(async () => { await this.render(); const box = this.element.querySelector('[data-a="search"]'); box?.focus(); box?.setSelectionRange(box.value.length, box.value.length); }, 200);
      };
      content.addEventListener("input", typed);
      content.addEventListener("compositionend", typed);
      content.addEventListener("dblclick", ev => { const row = ev.target.closest(".list [data-a=peek]"); if (row) this.add(row.dataset.uuid); });
    }
    this.fillDetail();
  }

  async fillDetail() {
    const box = this.element?.querySelector(".rpb-fam-detail");
    if (!box) return;
    const uuid = box.dataset.uuid;
    const doc = await fromUuid(uuid).catch(() => null);
    const ab = (await loadAbilities()).find(a => a.uuid === uuid) ?? { kind: "familiar", needs: null, slug: sluggify(doc?.name ?? "") };
    if (!doc || !box.isConnected) return;
    const c = check(ab, this.master, this.familiar);
    const has = slugsOf(this.familiar).has(ab.slug);
    const desc = await enrich(doc.system?.description?.value ?? "", { relativeTo: doc });
    box.innerHTML = `<header><img src="${esc(doc.img)}" alt=""><div><h3>${esc(doc.name)}</h3><small>${esc(t(`Fam.Kind.${ab.kind}`))}${ab.source ? ` · ${esc(ab.source)}` : ""}</small></div></header>
      <ul class="needs">${c.lines.length ? c.lines.map(l => `<li class="${l.ok === true ? "ok" : l.ok === false ? "no" : "unk"}">${l.ok === true ? "✔" : l.ok === false ? "✖" : "?"} ${esc(l.text)}</li>`).join("") : `<li class="ok">✔ ${t("Fam.NoNeeds")}</li>`}</ul>
      <div class="rpb-choose">${c.state === "patron" ? "" : `<button type="button" class="primary" data-a="add" data-uuid="${esc(uuid)}" ${has && !/skilled|resistance/.test(ab.slug) ? "disabled" : ""}>
        <i class="fa-solid fa-plus"></i> ${t(c.state === "no" ? "Fam.AddAnyway" : "Fam.Add")}</button>`}
        <button type="button" data-a="open" data-uuid="${esc(uuid)}"><i class="fa-solid fa-up-right-from-square"></i> ${t("Choice.OpenSheet")}</button></div>
      <div class="desc">${desc}</div>`;
  }

  async onClick(ev) {
    const el = ev.target.closest("[data-a]");
    if (!el || el.tagName === "SELECT" || el.tagName === "INPUT") return;
    ev.preventDefault();
    switch (el.dataset.a) {
      case "tab": this.ui.tab = el.dataset.tab; this.ui.detail = null; return this.render();
      case "peek": {
        // Only the detail changes (a full redraw would break double-clicks).
        this.ui.detail = el.dataset.uuid;
        for (const r of this.element.querySelectorAll(".list .rpb-row")) r.classList.toggle("peek", r.dataset.uuid === el.dataset.uuid);
        const box = this.element.querySelector(".rpb-fam-body .rpb-detail");
        if (!box) return this.render();
        box.innerHTML = `<div class="rpb-fam-detail" data-uuid="${esc(el.dataset.uuid)}"><p class="rpb-dim"><i class="fa-solid fa-spinner fa-spin"></i></p></div>`;
        return this.fillDetail();
      }
      case "open": return (await fromUuid(el.dataset.uuid))?.sheet?.render(true);
      case "add": return this.add(el.dataset.uuid);
      case "remove": await this.familiar?.items.get(el.dataset.id)?.delete(); return this.render();
      case "fam-sheet": return this.familiar?.sheet?.render(true);
      case "fam-create": return this.create();
    }
  }

  onChange(ev) {
    const el = ev.target;
    if (el.dataset.a === "master") { this.masterId = el.value; this.ui.detail = null; return this.render(); }
    if (el.dataset.a === "only-ok") { this.ui.onlyOk = el.checked; return this.render(); }
  }

  async add(uuid) {
    const fam = this.familiar;
    if (!fam) return ui.notifications.warn(t("Fam.NoFamiliar"));
    if (!fam.isOwner) return ui.notifications.warn(t("Fam.NotOwner"));
    const doc = await fromUuid(uuid).catch(() => null);
    if (!doc) return;
    const ab = (await loadAbilities()).find(a => a.uuid === uuid);
    const c = ab ? check(ab, this.master, fam) : { state: "ok" };
    if (c.state === "no") {
      const ok = await foundry.applications.api.DialogV2.confirm({ window: { title: t("Fam.AddAnyway") }, content: `<p>${t("Fam.AddAnywayBody", { name: esc(doc.name) })}</p><ul>${c.lines.filter(l => l.ok === false).map(l => `<li>✖ ${esc(l.text)}</li>`).join("")}</ul>`, rejectClose: false }).catch(() => false);
      if (!ok) return;
    }
    const src = doc.toObject();
    delete src._id;
    src._stats = { ...(src._stats ?? {}), compendiumSource: doc.uuid };
    await fam.createEmbeddedDocuments("Item", [src]);
    const total = Number(this.master?.system?.attributes?.familiarAbilities?.value ?? 0);
    const n = fam.items.filter(i => i.type === "action").length;
    if (total && n > total) ui.notifications.warn(t("Fam.Over", { n, total }));
    this.render();
  }

  async create() {
    const master = this.master;
    if (!master) return;
    if (!game.user.isGM && !game.user.can("ACTOR_CREATE")) return ui.notifications.warn(t("Fam.CannotCreate"));
    const owners = Object.fromEntries(Object.entries(master.ownership ?? {}).filter(([k]) => k !== "default"));
    const attr = castingForClass(master.class?.slug ?? master.class?.system?.slug, master.class?.flags?.["rutz-pf2e-builder"]?.casting ?? null)?.attr ?? "int";
    const actor = await Actor.create({
      name: t("Fam.DefaultName", { name: master.name }), type: "familiar", img: "icons/creatures/mammals/cat-hunched-glowing-red.webp",
      folder: master.folder?.id ?? null, ownership: { default: 0, ...owners, [game.user.id]: 3 },
      system: { master: { id: master.id, ability: attr } }
    });
    if (actor) ui.notifications.info(t("Fam.Created", { name: actor.name }));
    this.render();
  }
}

export function openFamiliar(master) {
  const m = master ?? game.user.character ?? canvas?.tokens?.controlled?.[0]?.actor ?? game.actors.find(a => a.type === "character" && a.isOwner);
  const target = m?.type === "familiar" ? m.master : m;
  const id = `rpb-familiar-${target?.id ?? "x"}`;
  const open = foundry.applications.instances.get(id);
  if (open) { open.render(true); return open; }
  const app = new FamiliarBuilder(target);
  app.render(true);
  return app;
}

export const _test = { check, NEEDS, MASTER };
void MID;
