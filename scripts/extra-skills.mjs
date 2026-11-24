import { MID, esc, rankLabel, skillLabel, skillSlugs, t } from "./util.mjs";
import { loadIndex } from "./data.mjs";
import { activePlanId, extraSkillsOf, newExtraSkill, planFromActor, plansOf, refreshSheetPlan, saveExtraSkills } from "./plan.mjs";
import { skillAudit } from "./rules.mjs";
import { isAnswering } from "./choices.mjs";
import { rpbDialog } from "./ui/dialog.mjs";

/*
 * Skill ranks gained outside the build (scenario rewards, RP …): extraDialog records one; the live notice has the active GM's client whisper a card ("record as outside the build" / "part of the build") when a sheet rank rises and the audit shows more than the build explains.
 * Card state is read from the actor's flags, so a player owner can answer it too.
 */

const DISMISSED = "extraDismissed";

export const extraLine = r => t("Extra.Line", { skill: skillLabel(r.skill), from: rankLabel(r.from), to: rankLabel(r.to) });

/** Ask for one record. fixed: the skill can't be changed. Returns { skill, from, to, note } or null. */
export async function extraDialog({ skill = null, from = 0, to = 1, fixed = false } = {}) {
  const ranks = [0, 1, 2, 3, 4];
  const sel = (name, cur) => `<select name="${name}">${ranks.map(r => `<option value="${r}" ${r === cur ? "selected" : ""}>${esc(rankLabel(r))}</option>`).join("")}</select>`;
  const skillField = fixed && skill
    ? `<input type="hidden" name="skill" value="${esc(skill)}"><b>${esc(skillLabel(skill))}</b>`
    : `<select name="skill">${skillSlugs().map(s => `<option value="${s}" ${s === skill ? "selected" : ""}>${esc(skillLabel(s))}</option>`).join("")}</select>`;
  const content = `<div class="rpb-extra-form">
    <label><span>${t("Extra.Skill")}</span>${skillField}</label>
    <div class="ranks"><label><span>${t("Extra.From")}</span>${sel("from", from)}</label><i class="fa-solid fa-arrow-right"></i><label><span>${t("Extra.To")}</span>${sel("to", to)}</label></div>
    <label><span>${t("Extra.Note")}</span><input type="text" name="note" maxlength="80" placeholder="${esc(t("Extra.NotePh"))}"></label>
  </div>`;
  const read = form => {
    const el = form.elements;
    return { skill: el.skill.value, from: Number(el.from.value), to: Number(el.to.value), note: el.note.value };
  };
  const res = await rpbDialog.wait({
    window: { title: t("Extra.Title") }, position: { width: 380 }, content, rejectClose: false,
    buttons: [
      { action: "save", label: t("Extra.Save"), icon: "fa-solid fa-floppy-disk", default: true, callback: (_ev, button) => read(button.form) },
      { action: "cancel", label: t("Extra.Cancel") }
    ]
  }).catch(() => null);
  if (!res || typeof res !== "object" || !skillSlugs().includes(res.skill)) return null;
  if (!(res.to > res.from)) { ui.notifications.warn(t("Extra.BadRank")); return null; }
  return res;
}

export async function addExtraSkills(actor, list) {
  await saveExtraSkills(actor, [...extraSkillsOf(actor), ...list.map(r => newExtraSkill({ level: actor.level ?? 1, ...r }))]);
}

export async function removeExtraSkill(actor, id) {
  await saveExtraSkills(actor, extraSkillsOf(actor).filter(r => r.id !== id));
}

/* ---------------- live notice (active GM) ---------------- */

const ranksOf = actor => Object.fromEntries(skillSlugs().map(s => [s, Number(actor.skills?.[s]?.rank ?? actor.system?.skills?.[s]?.rank ?? 0) || 0]));
const seen = new Map(); // actor id → ranks last seen
const pending = new Map(); // actor id → { before, touched, apply, timer }

const isActiveGM = () => (game.users.activeGM ?? game.users.find(u => u.isGM && u.active))?.id === game.user.id;

/** The sheet plan the audit follows (the active one if it follows the sheet, else any sheet plan, else the sheet itself). */
function sheetPlanOf(actor) {
  const plans = plansOf(actor);
  const p = plans.find(x => x.id === activePlanId(actor) && x.base === "sheet") ?? plans.find(x => x.base === "sheet");
  return p ? refreshSheetPlan(p, actor) : planFromActor(actor, actor.name);
}

function onUpdate(actor, changed, options) {
  if (actor?.type !== "character") return;
  const skills = foundry.utils.getProperty(changed, "system.skills");
  const touched = Object.entries(skills ?? {}).filter(([s, v]) => v && typeof v === "object" && "rank" in v && skillSlugs().includes(s)).map(([s]) => s);
  if (!touched.length) return;
  // other clients only keep their snapshot fresh (in case they become the active GM)
  if (!isActiveGM()) { seen.set(actor.id, ranksOf(actor)); return; }
  const p = pending.get(actor.id) ?? { before: seen.get(actor.id) ?? null, touched: new Set(), apply: false };
  for (const s of touched) p.touched.add(s);
  // the builder's own level-ups (any client marks them rpbApply; this client also knows its own apply)
  p.apply ||= !!options?.rpbApply || isAnswering(actor);
  clearTimeout(p.timer);
  p.timer = setTimeout(() => {
    pending.delete(actor.id);
    check(actor, p).catch(err => console.warn(`${MID} | skill notice`, err));
  }, 500);
  pending.set(actor.id, p);
}

async function check(actor, p) {
  const after = ranksOf(actor);
  seen.set(actor.id, after);
  if (p.apply || !p.before) return;
  const changes = [...p.touched].filter(s => after[s] > (p.before[s] ?? 0)).map(s => ({ skill: s, from: p.before[s] ?? 0, to: after[s] }));
  if (!changes.length) return;
  const idx = await loadIndex();
  const plan = sheetPlanOf(actor);
  const extras = extraSkillsOf(actor);
  // only the changed skills differ between the two audits, so a surplus already seen doesn't ask again
  const before = { ...after, ...Object.fromEntries(changes.map(c => [c.skill, c.from])) };
  const now = skillAudit(plan, idx, actor, { ranks: after, extras });
  const was = skillAudit(plan, idx, actor, { ranks: before, extras });
  if (now.excess <= was.excess) return;
  const whisper = game.users.filter(u => u.isGM || actor.testUserPermission(u, "OWNER")).map(u => u.id);
  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor }),
    whisper,
    content: `<div class="rpb-card-msg rpb-extra-card" data-actor="${actor.uuid}">
      <header><i class="fa-solid fa-circle-question"></i> ${t("Extra.CardTitle")}</header>
      <p class="line">${esc(t("Extra.Ask", { name: actor.name, list: changes.map(extraLine).join(", ") }))}</p>
      <div class="btns"><button type="button" data-rpb-extra="record"><i class="fa-solid fa-feather"></i> ${t("Extra.Record")}</button>
      <button type="button" data-rpb-extra="include"><i class="fa-solid fa-check"></i> ${t("Extra.Include")}</button></div></div>`,
    flags: { [MID]: { extraAsk: { actor: actor.uuid, changes, level: actor.level ?? 1 } } }
  });
}

/* ---------------- the card ---------------- */

function cardState(message, actor) {
  if (!actor) return "gone";
  if (extraSkillsOf(actor).some(r => r.msg === message.id)) return "recorded";
  if ((actor.getFlag(MID, DISMISSED) ?? []).includes(message.id)) return "included";
  return "ask";
}

function paint(card, message) {
  const ask = message.getFlag(MID, "extraAsk");
  const actor = fromUuidSync(ask.actor);
  const state = cardState(message, actor);
  const key = { recorded: "Extra.Recorded", included: "Extra.Included" }[state] ?? "Extra.Ask";
  const line = card.querySelector(".line");
  if (line) line.textContent = t(key, { name: actor?.name ?? "", list: (ask.changes ?? []).map(extraLine).join(", ") });
  card.classList.toggle("done", state !== "ask");
  const btns = card.querySelector(".btns");
  if (btns) btns.hidden = state !== "ask";
  for (const b of card.querySelectorAll("[data-rpb-extra]")) b.disabled = !actor?.isOwner;
}

function wireCard(message, html) {
  const ask = message.getFlag?.(MID, "extraAsk");
  const root = html instanceof HTMLElement ? html : html?.[0];
  const card = ask && root?.querySelector(".rpb-extra-card");
  if (!card) return;
  card.dataset.msg = message.id;
  paint(card, message);
  card.addEventListener("click", async ev => {
    const btn = ev.target.closest("[data-rpb-extra]");
    if (!btn || btn.disabled) return;
    ev.preventDefault();
    const actor = fromUuidSync(ask.actor);
    if (!actor?.isOwner || cardState(message, actor) !== "ask") return;
    btn.disabled = true;
    try {
      if (btn.dataset.rpbExtra === "record") await addExtraSkills(actor, (ask.changes ?? []).map(c => ({ ...c, level: ask.level, msg: message.id })));
      else await actor.update({ [`flags.${MID}.${DISMISSED}`]: [...(actor.getFlag(MID, DISMISSED) ?? []), message.id].slice(-30) });
    } catch (err) {
      console.warn(`${MID} | skill notice`, err);
      btn.disabled = false;
    }
  });
}

/** Cards on screen follow the actor's records. */
function repaintCards(actor) {
  for (const card of document.querySelectorAll(`.rpb-extra-card[data-msg]`)) {
    if (card.dataset.actor !== actor.uuid) continue;
    const message = game.messages.get(card.dataset.msg);
    if (message) paint(card, message);
  }
}

/** Called at init. */
export function installExtraSkills() {
  Hooks.on("renderChatMessageHTML", wireCard);
  Hooks.on("updateActor", (actor, changed, options) => {
    const f = changed?.flags?.[MID];
    if (f && (DISMISSED in f || "extraSkills" in f)) repaintCards(actor);
    onUpdate(actor, changed, options);
  });
  Hooks.on("createActor", actor => { if (actor.type === "character") seen.set(actor.id, ranksOf(actor)); });
  Hooks.once("ready", () => {
    for (const a of game.actors ?? []) if (a.type === "character") seen.set(a.id, ranksOf(a));
  });
}
