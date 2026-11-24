import { MID, esc, setting, t } from "./util.mjs";
import { rpbDialog } from "./ui/dialog.mjs";

/* Korean tables: names, descriptions and prerequisites are read as the translation module gives them, tuned to Rutz's translation. In Korean with another (or no) PF2e Korean translation active, a one-time note recommends Rutz's. */

/** The suite's own modules (Korean UI, not a translation), in any edition ("<id>-plus", "<id>", "<id>-lite", "<id>-trial"). */
const OWN = new Set([MID, "pf2e-kr-hud", "rutz-crit-cutin", "pf2e-rutz-token", "rutz-immersive-ui"]);
const isOwn = id => OWN.has(id) || OWN.has(String(id).replace(/-(plus|lite|trial)$/, ""));

function isKoreanTranslation(mod) {
  if (!mod?.active || isOwn(mod.id)) return false;
  const langs = [...(mod.languages ?? [])].map(l => l?.lang);
  const text = `${mod.id} ${mod.title ?? ""}`.toLowerCase();
  const korean = langs.includes("ko") || /\b(ko|kr|ko-kr)\b|korean|한글|한국/.test(text);
  const pf2e = /pf2e|pathfinder|패스파인더|babele/.test(text) || [...(mod.relationships?.systems ?? [])].some(s => s.id === "pf2e");
  return korean && pf2e;
}

function isRutz(mod) {
  const id = String(setting("translationModule", "") ?? "").trim();
  if (id) return mod.id === id;
  const authors = [...(mod.authors ?? [])].map(a => `${a?.name ?? ""} ${a?.url ?? ""}`).join(" ").toLowerCase();
  return /rutz/.test(mod.id.toLowerCase()) || /rutz/.test(String(mod.title ?? "").toLowerCase()) || /rutz/.test(authors);
}

export function translationStatus() {
  const mods = [...game.modules].filter(isKoreanTranslation);
  return { rutz: mods.find(isRutz) ?? null, others: mods.filter(m => !isRutz(m)) };
}

export function maybeRecommend() {
  if (game.i18n.lang !== "ko") return;
  if (setting("translationNoticeSeen", false)) return;
  const { rutz, others } = translationStatus();
  if (rutz) return;
  const url = String(setting("translationUrl", "") ?? "").trim();
  const content = `<p>${t("Translation.Body")}</p>
    ${others.length ? `<p>${t("Translation.Others", { list: others.map(m => esc(m.title ?? m.id)).join(", ") })}</p>` : ""}
    ${url ? `<p><a href="${esc(url)}" target="_blank" rel="noopener">${esc(url)}</a></p>` : ""}
    <p class="hint">${t("Translation.Hint")}</p>`;
  rpbDialog.prompt({
    window: { title: t("Translation.Title"), icon: "fa-solid fa-language" },
    content,
    ok: { label: t("Common.Ok") },
    rejectClose: false
  }).finally(() => game.settings.set(MID, "translationNoticeSeen", true));
}
