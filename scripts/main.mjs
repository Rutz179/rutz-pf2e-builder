import { MID, esc, setting, t } from "./util.mjs";
import { installCalmTooltips } from "./tips.mjs";
import { loadIndex, invalidateIndex } from "./data.mjs";
import { activePlanId, plansOf, refreshSheetPlan } from "./plan.mjs";
import { pendingUpTo } from "./apply.mjs";
import { canCreateMore, initSocket } from "./create.mjs";
import { maybeRecommend } from "./translation.mjs";
import { openBuilder, refreshBuilders } from "./ui/builder.mjs";
import { openCompare } from "./ui/compare.mjs";
import { openFamiliar } from "./ui/familiar.mjs";
import { PackChooser } from "./ui/packs.mjs";
import { forgetQueryIndex, installChoiceHooks } from "./choices.mjs";
import { syncActorClassSpells } from "./class-spells.mjs";

/* ======================================================================== *
 * Rutz's PF2e Character Builder — entry point.
 *
 * Opens from: the Actors sidebar ("캐릭터 만들기 / 빌더"), the character
 * sheet's header, the Rutz PF2e HUD's bar, or game.rutzBuilder.open(actor).
 * A player without a character is offered the builder when they log in.
 * When a character gains a level, its owner gets a card with what the plan
 * has for it and one button to apply it.
 * ======================================================================== */

function registerSettings() {
  const s = (key, data) => game.settings.register(MID, key, { config: true, scope: "world", ...data });
  const L = CONST.DOCUMENT_OWNERSHIP_LEVELS;
  s("charactersPerPlayer", { name: t("Settings.PerPlayer"), hint: t("Settings.PerPlayerHint"), type: Number, default: 1, range: { min: 0, max: 10, step: 1 } });
  s("ownership", {
    name: t("Settings.Ownership"), hint: t("Settings.OwnershipHint"), type: String, default: "world",
    choices: { world: t("Settings.OwnWorld"), NONE: t("Settings.OwnNone"), LIMITED: t("Settings.OwnLimited"), OBSERVER: t("Settings.OwnObserver"), OWNER: t("Settings.OwnOwner") }
  });
  s("startLevel", { name: t("Settings.StartLevel"), type: Number, default: 1, range: { min: 1, max: 20, step: 1 } });
  s("allowLevelUp", { name: t("Settings.AllowLevelUp"), hint: t("Settings.AllowLevelUpHint"), type: Boolean, default: true });
  s("allowRebuild", { name: t("Settings.AllowRebuild"), hint: t("Settings.AllowRebuildHint"), type: Boolean, default: true });
  s("levelUpCard", { name: t("Settings.LevelUpCard"), hint: t("Settings.LevelUpCardHint"), type: Boolean, default: true });
  s("promptNewPlayers", { name: t("Settings.PromptNew"), hint: t("Settings.PromptNewHint"), type: Boolean, default: true });
  s("rarityLimit", { name: t("Settings.Rarity"), hint: t("Settings.RarityHint"), type: String, default: "all", choices: { all: t("Settings.RarityAll"), uncommon: t("Settings.RarityUncommon"), common: t("Settings.RarityCommon") } });
  s("hideLegacy", { name: t("Settings.HideLegacy"), hint: t("Settings.HideLegacyHint"), type: Boolean, default: false,
    onChange: refreshBuilders });
  s("maxPlans", { name: t("Settings.MaxPlans"), type: Number, default: 5, range: { min: 1, max: 10, step: 1 } });
  s("folder", { name: t("Settings.Folder"), hint: t("Settings.FolderHint"), type: String, default: "" });
  s("imageFolder", { name: t("Settings.ImageFolder"), hint: t("Settings.ImageFolderHint"), type: String, default: "" });
  game.settings.registerMenu(MID, "packMenu", { name: t("Settings.PacksMenu"), label: t("Settings.PacksMenuLabel"), hint: t("Settings.PacksMenuHint"), icon: "fa-solid fa-book-atlas", type: PackChooser, restricted: true });
  game.settings.register(MID, "packRules", { scope: "world", config: false, type: Object, default: { include: [], exclude: [] } });
  s("levelCantrips", { name: t("Settings.LevelCantrips"), hint: t("Settings.LevelCantripsHint"), type: Boolean, default: true });
  s("autoClassSpells", { name: t("Settings.AutoClassSpells"), hint: t("Settings.AutoClassSpellsHint"), type: Boolean, default: true });
  s("tidyChoices", { name: t("Settings.TidyChoices"), hint: t("Settings.TidyChoicesHint"), type: Boolean, default: true });
  s("packs", { name: t("Settings.Packs"), hint: t("Settings.PacksHint"), type: String, default: "", onChange: () => { invalidateIndex(); forgetQueryIndex(); } });
  s("translationModule", { name: t("Settings.TrModule"), hint: t("Settings.TrModuleHint"), type: String, default: "" });
  s("translationUrl", { name: t("Settings.TrUrl"), hint: t("Settings.TrUrlHint"), type: String, default: "" });
  game.settings.register(MID, "translationNoticeSeen", { scope: "client", config: false, type: Boolean, default: false });
  void L;
}

/* ---------------- where it opens from ---------------- */

function targetFor(user = game.user) {
  const controlled = canvas?.tokens?.controlled?.[0]?.actor;
  if (controlled?.type === "character" && controlled.isOwner) return controlled;
  if (user.character?.type === "character") return user.character;
  return null;
}

function directoryButton(app, html) {
  const root = html instanceof HTMLElement ? html : html?.[0];
  const header = root?.querySelector(".header-actions, .directory-header .action-buttons");
  if (!header || header.querySelector(".rpb-dir")) return;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "rpb-dir";
  const mine = targetFor();
  const making = !mine && canCreateMore();
  btn.innerHTML = `<i class="fa-solid fa-compass-drafting"></i> ${esc(making ? t("Dir.Create") : t("Dir.Builder"))}`;
  btn.addEventListener("click", ev => {
    ev.preventDefault();
    if (game.user.isGM && !targetFor()) return openBuilder(null);
    openBuilder(targetFor() ?? null);
  });
  header.appendChild(btn);
}

function sheetButtonV1(sheet, buttons) {
  const actor = sheet.actor ?? sheet.document;
  if (actor?.type === "familiar" && (actor.isOwner || game.user.isGM)) {
    buttons.unshift({ label: t("Fam.Short"), class: "rpb-fam-open", icon: "fa-solid fa-feather fa-fw", onclick: () => openFamiliar(actor) });
    return;
  }
  if (actor?.type !== "character" || !(actor.isOwner || game.user.isGM)) return;
  buttons.unshift({ label: t("Sheet.Button"), class: "rpb-open", icon: "fa-solid fa-compass-drafting fa-fw", onclick: () => openBuilder(actor) });
}

function sheetButtonV2(app, controls) {
  const actor = app.document ?? app.actor;
  if (actor?.documentName === "Actor" && actor.type === "familiar" && (actor.isOwner || game.user.isGM) && !controls.some(c => c.action === "rpbFam")) {
    controls.unshift({ icon: "fa-solid fa-feather fa-fw", label: t("Fam.Short"), action: "rpbFam", onClick: () => openFamiliar(actor) });
    app.options.actions ??= {};
    app.options.actions.rpbFam ??= () => openFamiliar(actor);
    return;
  }
  if (actor?.documentName !== "Actor" || actor.type !== "character" || !(actor.isOwner || game.user.isGM)) return;
  if (controls.some(c => c.action === "rpbOpen")) return;
  controls.unshift({ icon: "fa-solid fa-compass-drafting fa-fw", label: t("Sheet.Button"), action: "rpbOpen", onClick: () => openBuilder(actor) });
  app.options.actions ??= {};
  app.options.actions.rpbOpen ??= () => openBuilder(actor);
}

/* ---------------- level-up card ---------------- */

const levelBefore = new Map();

function onPreUpdateActor(actor, changed) {
  const lv = foundry.utils.getProperty(changed, "system.details.level.value");
  if (lv !== undefined) levelBefore.set(actor.id, actor.level);
}

async function onUpdateActor(actor, changed, options, userId) {
  if (userId !== game.user.id || options?.rpbApply || actor.type !== "character") return;
  const lv = foundry.utils.getProperty(changed, "system.details.level.value");
  const before = levelBefore.get(actor.id);
  levelBefore.delete(actor.id);
  if (lv === undefined || before === undefined || lv <= before || setting("levelUpCard", true) === false) return;
  const plans = plansOf(actor);
  const plan = plans.find(p => p.id === activePlanId(actor)) ?? plans.find(p => p.base === "sheet");
  if (!plan) return;
  await loadIndex();
  const fresh = refreshSheetPlan(plan, actor);
  const pending = await pendingUpTo(actor, fresh, actor.level);
  if (pending.empty) return;
  const owners = game.users.filter(u => actor.testUserPermission(u, "OWNER")).map(u => u.id);
  const items = [
    ...pending.boosts.map(l => t("Apply.Boosts", { level: l })),
    ...pending.skills.map(s => `${game.i18n.localize(CONFIG.PF2E.skills?.[s.slug]?.label ?? s.slug)} → ${game.i18n.localize(`PF2E.ProficiencyLevel${s.to}`)}`),
    ...pending.feats.map(f => f.name),
    ...(pending.spells ?? []).map(r => `${t("Spells.One")}: ${r.name}`)
  ];
  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor }),
    whisper: owners,
    content: `<div class="rpb-card-msg"><header><i class="fa-solid fa-angles-up"></i> ${t("Card.Title", { name: esc(actor.name), level: actor.level })}</header>
      <p>${t("Card.Body", { plan: esc(fresh.name) })}</p><ul>${items.map(i => `<li>${esc(i)}</li>`).join("")}</ul>
      <div class="btns"><button type="button" data-rpb="apply" data-actor="${actor.uuid}"><i class="fa-solid fa-wand-magic-sparkles"></i> ${t("Card.Apply")}</button>
      <button type="button" data-rpb="open" data-actor="${actor.uuid}"><i class="fa-solid fa-compass-drafting"></i> ${t("Card.Open")}</button></div></div>`,
    flags: { [MID]: { levelUp: { actor: actor.uuid, level: actor.level } } }
  });
}

async function quickApply(actor) {
  const app = openBuilder(actor);
  for (let i = 0; i < 100 && !app.idx; i++) await new Promise(r => setTimeout(r, 100));
  const active = activePlanId(actor);
  if (active && app.plans.some(p => p.id === active)) app.ui.planId = active;
  app.ui.step = "overview";
  app.render();
  return app.apply("current");
}

function wireCards(message, html) {
  const root = html instanceof HTMLElement ? html : html?.[0];
  if (!root || !message.getFlag?.(MID, "levelUp")) return;
  for (const btn of root.querySelectorAll("[data-rpb]")) {
    const actor = fromUuidSync(btn.dataset.actor);
    if (!actor?.isOwner) { btn.disabled = true; continue; }
    btn.addEventListener("click", ev => {
      ev.preventDefault();
      if (btn.dataset.rpb === "apply") quickApply(actor); else openBuilder(actor);
    });
  }
}

/* ---------------- first login ---------------- */

function offerToNewPlayer() {
  if (game.user.isGM || game.user.character || !setting("promptNewPlayers", true) || !canCreateMore()) return;
  setTimeout(async () => {
    const ok = await foundry.applications.api.DialogV2.confirm({
      window: { title: t("Welcome.Title"), icon: "fa-solid fa-compass-drafting" },
      content: `<p>${t("Welcome.Body")}</p>`,
      yes: { label: t("Welcome.Yes") }, no: { label: t("Welcome.Later") },
      rejectClose: false
    }).catch(() => false);
    if (ok) openBuilder(null);
  }, 2500);
}

/* ---------------- hooks ---------------- */

Hooks.once("init", () => {
  registerSettings();
});

Hooks.once("ready", () => {
  if (game.system.id !== "pf2e" && game.system.id !== "sf2e") return;
  installCalmTooltips();
  installChoiceHooks();
  initSocket();
  Hooks.on("renderActorDirectory", directoryButton);
  Hooks.on("getActorSheetHeaderButtons", sheetButtonV1);
  Hooks.on("getHeaderControlsApplicationV2", sheetButtonV2);
  Hooks.on("preUpdateActor", onPreUpdateActor);
  Hooks.on("updateActor", onUpdateActor);
  Hooks.on("renderChatMessageHTML", wireCards);
  // Feats and class features gained on the sheet: their spells too (once per burst of new items).
  const soon = new Map();
  Hooks.on("createItem", (item, _options, userId) => {
    const actor = item.actor;
    if (userId !== game.user.id || item.type !== "feat" || actor?.type !== "character" || !setting("autoClassSpells", true)) return;
    clearTimeout(soon.get(actor.id));
    soon.set(actor.id, setTimeout(async () => {
      soon.delete(actor.id);
      try {
        const done = await syncActorClassSpells(actor);
        if (done.length) ui.notifications.info(t("Spells.Resynced", { list: done.join(", ") }));
      } catch (err) { console.warn(`${MID} | class spells`, err); }
    }, 800));
  });
  ui.actors?.render?.();
  game.rutzBuilder = {
    open: openBuilder,
    familiar: openFamiliar,
    compare: actor => openCompare(actor, plansOf(actor), actor?.level ?? 1),
    quickApply,
    reloadIndex: () => { invalidateIndex(); return loadIndex(); }
  };
  maybeRecommend();
  offerToNewPlayer();
  console.log(`${MID} | ready`);
});
