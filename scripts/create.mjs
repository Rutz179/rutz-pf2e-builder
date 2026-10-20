import { MID, randomId, setting, sluggify, t } from "./util.mjs";

/* ======================================================================== *
 * Making the character itself.
 *
 * Players usually may not create actors. Then the active GM's client makes
 * it for them (over the module socket): a character owned by that player,
 * set as their assigned character, other players' access as the world
 * setting says (by default: the same as the other player characters here),
 * the token set up from the world's default token settings. The player's own
 * client then fills it in, so PF2e's questions appear on their screen.
 *
 * One main character per player by default (setting; GMs are not limited).
 * Portraits are uploaded with the player's own upload permission, shrunk
 * first so big pictures don't weigh on everyone's loading.
 * ======================================================================== */

const SOCKET = `module.${MID}`;
const waiting = new Map();

export function charactersOf(user) {
  return game.actors.filter(a => a.type === "character"
    && (a.getFlag(MID, "createdBy") === user.id || user.character?.id === a.id));
}

export function creationLimit() {
  return Math.max(0, Number(setting("charactersPerPlayer", 1)) || 0);
}

export function canCreateMore(user = game.user) {
  if (user.isGM) return true;
  const limit = creationLimit();
  return limit === 0 || charactersOf(user).length < limit;
}

function ownershipDefault() {
  const L = CONST.DOCUMENT_OWNERSHIP_LEVELS;
  const mode = setting("ownership", "world");
  if (mode !== "world") return L[mode] ?? L.NONE;
  // Like the other player characters of this world (most common setting among them).
  const counts = new Map();
  for (const a of game.actors) {
    if (a.type !== "character" || !a.hasPlayerOwner) continue;
    const d = a.ownership?.default ?? L.NONE;
    counts.set(d, (counts.get(d) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? L.NONE;
}

function prototypeToken(name, img, tokenImg, ring) {
  let base = {};
  try { base = foundry.utils.deepClone(game.settings.get("core", "defaultToken") ?? {}); } catch (_) { base = {}; }
  const token = foundry.utils.mergeObject(base, {
    name,
    actorLink: true,
    disposition: CONST.TOKEN_DISPOSITIONS.FRIENDLY,
    sight: { enabled: true }
  }, { inplace: false });
  if (tokenImg || img) token.texture = { ...(token.texture ?? {}), src: tokenImg || img };
  if (ring && img) token.ring = { ...(token.ring ?? {}), enabled: true, subject: { ...(token.ring?.subject ?? {}), texture: img } };
  return token;
}

async function folderId() {
  const name = String(setting("folder", "") ?? "").trim();
  if (!name || !game.user.isGM) return null;
  const existing = game.folders.find(f => f.type === "Actor" && f.name === name);
  if (existing) return existing.id;
  const made = await Folder.create({ name, type: "Actor", color: "#7a5c1e" });
  return made?.id ?? null;
}

/** Create the actor (GM, or a player allowed to create actors). */
export async function makeActor({ userId, name, img, tokenImg, ring = true }) {
  const L = CONST.DOCUMENT_OWNERSHIP_LEVELS;
  const user = game.users.get(userId) ?? game.user;
  const data = {
    name: name || t("Create.DefaultName"),
    type: "character",
    ownership: { default: ownershipDefault(), [user.id]: L.OWNER },
    prototypeToken: prototypeToken(name, img, tokenImg, ring),
    flags: { [MID]: { createdBy: user.id } }
  };
  if (img) data.img = img;
  const folder = await folderId();
  if (folder) data.folder = folder;
  const actor = await Actor.create(data);
  if (actor && !user.isGM && !user.character) await user.update({ character: actor.id });
  return actor;
}

/** Ask for a new character: made here if allowed, otherwise by the GM's client. */
export async function requestActor(data) {
  if (game.user.isGM || game.user.can("ACTOR_CREATE")) return makeActor({ ...data, userId: data.userId ?? game.user.id });
  if (!game.users.activeGM) throw new Error(t("Create.NoGM"));
  const requestId = randomId();
  const result = new Promise((resolve, reject) => {
    waiting.set(requestId, { resolve, reject });
    setTimeout(() => { if (waiting.delete(requestId)) reject(new Error(t("Create.Timeout"))); }, 20000);
  });
  game.socket.emit(SOCKET, { type: "create", requestId, userId: game.user.id, data });
  const actorId = await result;
  for (let i = 0; i < 50 && !game.actors.get(actorId); i++) await new Promise(r => setTimeout(r, 100));
  const actor = game.actors.get(actorId);
  if (!actor) throw new Error(t("Create.Timeout"));
  for (let i = 0; i < 30 && !actor.isOwner; i++) await new Promise(r => setTimeout(r, 100));
  return actor;
}

export function initSocket() {
  game.socket.on(SOCKET, async msg => {
    if (msg?.type === "create") {
      if (!game.users.activeGM?.isSelf) return;
      const user = game.users.get(msg.userId);
      let reply;
      try {
        if (!user) throw new Error("unknown user");
        if (!canCreateMore(user)) throw new Error(t("Create.Limit", { n: creationLimit() }));
        const actor = await makeActor({ ...msg.data, userId: user.id });
        reply = { type: "created", requestId: msg.requestId, to: user.id, actorId: actor.id };
      } catch (err) {
        reply = { type: "failed", requestId: msg.requestId, to: msg.userId, error: String(err?.message ?? err) };
      }
      game.socket.emit(SOCKET, reply);
      return;
    }
    if ((msg?.type === "created" || msg?.type === "failed") && msg.to === game.user.id) {
      const w = waiting.get(msg.requestId);
      if (!w) return;
      waiting.delete(msg.requestId);
      if (msg.type === "created") w.resolve(msg.actorId); else w.reject(new Error(msg.error));
    }
  });
}

/* ---------------- pictures ---------------- */

async function shrink(file, max) {
  if (!/^image\/(png|jpe?g|webp)$/.test(file.type)) return file;
  try {
    const bmp = await createImageBitmap(file);
    const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
    if (k >= 1 && file.type === "image/webp") return file;
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(bmp.width * k));
    c.height = Math.max(1, Math.round(bmp.height * k));
    c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
    return await new Promise(r => c.toBlob(b => r(b ?? file), "image/webp", 0.9));
  } catch (_) {
    return file;
  }
}

function filePicker() {
  return foundry.applications?.apps?.FilePicker?.implementation ?? globalThis.FilePicker;
}

async function ensureDir(FP, dir) {
  let cur = "";
  for (const part of dir.split("/").filter(Boolean)) {
    cur = cur ? `${cur}/${part}` : part;
    try { await FP.createDirectory("data", cur, {}); } catch (_) { /* exists or not ours to make */ }
  }
}

export function canUpload() {
  return game.user.isGM || game.user.can("FILES_UPLOAD");
}

/** Upload a picture for a character; returns its path. */
export async function uploadImage(file, { kind = "portrait", name = "character" } = {}) {
  if (!canUpload()) throw new Error(t("Create.NoUpload"));
  const FP = filePicker();
  const blob = await shrink(file, kind === "token" ? 512 : 1400);
  const ext = blob.type === "image/webp" ? "webp" : (file.name.split(".").pop() || "png");
  const dir = String(setting("imageFolder", "") || `worlds/${game.world.id}/characters`).replace(/\/+$/, "");
  await ensureDir(FP, dir);
  const fname = `${sluggify(name) || "character"}-${kind}-${Date.now().toString(36)}.${ext}`;
  const res = await FP.upload("data", dir, new File([blob], fname, { type: blob.type || file.type }), {}, { notify: false });
  if (res === false || res?.status === "error") throw new Error(res?.message ?? t("Create.UploadFailed"));
  return res?.path ?? `${dir}/${fname}`;
}
