/* DialogV2 with a safe size: never larger than the screen, content scrolls, buttons stay at the bottom (CSS .rpb-dlg in styles/builder.css), resizable. Same calls as DialogV2.wait / prompt / confirm. */

const MARGIN = 8;

/** After a render: keep the whole window on screen (a tall one is moved up, a wide one left). */
function fit(dialog) {
  requestAnimationFrame(() => {
    const el = dialog?.element;
    if (!el?.isConnected || !dialog.setPosition) return;
    const r = el.getBoundingClientRect();
    const top = Math.max(MARGIN, Math.min(r.top, window.innerHeight - r.height - MARGIN));
    const left = Math.max(MARGIN, Math.min(r.left, window.innerWidth - r.width - MARGIN));
    if (Math.abs(top - r.top) > 1 || Math.abs(left - r.left) > 1) dialog.setPosition({ top, left });
  });
}

function open(method, config = {}) {
  const render = config.render;
  return foundry.applications.api.DialogV2[method]({
    ...config,
    window: { resizable: true, ...(config.window ?? {}) },
    classes: [...(config.classes ?? []), "rpb-dlg"],
    render: (ev, dialog) => { try { render?.(ev, dialog); } finally { fit(dialog ?? ev?.target); } }
  });
}

export const rpbDialog = {
  wait: config => open("wait", config),
  prompt: config => open("prompt", config),
  confirm: config => open("confirm", config)
};
