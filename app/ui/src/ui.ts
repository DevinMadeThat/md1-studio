// Small shared UI helpers: escaping, toasts, modal sheets, remembered preferences.

export const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

let toastTimer = 0;
export function toast(msg: string, action?: { label: string; run: () => void }, kind: "info" | "error" = "info") {
  const t = document.getElementById("toast")!;
  t.className = `toast show ${kind}`;
  t.innerHTML = `<span>${esc(msg)}</span>${action ? `<button class="toast-action">${esc(action.label)}</button>` : ""}`;
  if (action) t.querySelector("button")!.addEventListener("click", () => { action.run(); t.classList.remove("show"); });
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => t.classList.remove("show"), kind === "error" ? 9000 : 6000);
}

export interface Modal {
  el: HTMLElement;
  close: () => void;
}

/** A centred sheet over everything (including the viewer). Esc or a click outside closes it. */
export function openModal(title: string, body: string, opts: { onClose?: () => void } = {}): Modal {
  const back = document.createElement("div");
  back.className = "modal-back";
  back.innerHTML = `<div class="modal" role="dialog" aria-label="${esc(title)}"><h2>${esc(title)}</h2>${body}</div>`;
  document.body.appendChild(back);
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") { e.stopPropagation(); close(); }
  };
  const close = () => {
    document.removeEventListener("keydown", onKey, true);
    back.remove();
    opts.onClose?.();
  };
  document.addEventListener("keydown", onKey, true);
  back.addEventListener("mousedown", (e) => { if (e.target === back) close(); });
  return { el: back.querySelector(".modal")!, close };
}

// Preferences that only matter on this computer (viewer zoom, autoplay…). Storage can be
// unavailable; everything falls back to defaults.
export const prefs = {
  get<T>(key: string, fallback: T): T {
    try {
      const v = localStorage.getItem(`md1.${key}`);
      return v === null ? fallback : (JSON.parse(v) as T);
    } catch {
      return fallback;
    }
  },
  set(key: string, value: unknown) {
    try {
      localStorage.setItem(`md1.${key}`, JSON.stringify(value));
    } catch {
      /* not persisted */
    }
  },
};

/** A yes/no sheet. `type`: the user must type this word first; `countdown`: seconds before the
 * button works (for things that can't be undone). Resolves true only for the OK button. */
export function confirmBox(
  title: string,
  body: string,
  ok: string,
  opts: { danger?: boolean; type?: string; countdown?: number; cancel?: string } = {},
): Promise<boolean> {
  return new Promise((resolve) => {
    let yes = false;
    const m = openModal(
      title,
      `${body}
       ${opts.type ? `<label class="small muted">Type <b>${esc(opts.type)}</b> to continue</label><input id="cb-type" class="field" autocomplete="off" spellcheck="false">` : ""}
       <div class="modal-actions"><span class="spacer"></span>
         <button class="btn" id="cb-cancel">${esc(opts.cancel ?? "Cancel")}</button>
         <button class="btn ${opts.danger ? "danger" : "primary"}" id="cb-ok">${esc(ok)}</button></div>`,
      { onClose: () => resolve(yes) },
    );
    const okBtn = m.el.querySelector<HTMLButtonElement>("#cb-ok")!;
    const typed = m.el.querySelector<HTMLInputElement>("#cb-type");
    let left = opts.countdown ?? 0;
    const update = () => {
      const typedOk = !typed || typed.value.trim().toUpperCase() === opts.type!.toUpperCase();
      okBtn.disabled = !typedOk || left > 0;
      okBtn.textContent = left > 0 ? `${ok} (${left})` : ok;
    };
    if (left > 0) {
      const t = setInterval(() => { left -= 1; update(); if (left <= 0) clearInterval(t); }, 1000);
    }
    typed?.addEventListener("input", update);
    typed?.addEventListener("keydown", (e) => { if (e.key === "Enter" && !okBtn.disabled) okBtn.click(); });
    m.el.querySelector("#cb-cancel")!.addEventListener("click", m.close);
    okBtn.addEventListener("click", () => { yes = true; m.close(); });
    update();
    (typed ?? m.el.querySelector<HTMLButtonElement>("#cb-cancel"))!.focus();
  });
}
