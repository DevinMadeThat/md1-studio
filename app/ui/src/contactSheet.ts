// Contact sheets (Sony's Album Utility printed these): pages of thumbnails with a title and a
// label under each photo, saved as 300 dpi JPEG pages to print from any app.
import { save } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { api, type Item } from "./api";
import { effectiveTaken } from "./editors";
import { renderedUrl } from "./look";
import { esc, openModal, prefs, toast } from "./ui";

type Label = "date" | "caption" | "number" | "none";
interface Options { columns: number; label: Label; paper: "letter" | "a4" }

const PAPER = { letter: [2550, 3300], a4: [2480, 3508] } as const;

function labelFor(it: Item, label: Label): string {
  const p = it.photo;
  if (label === "caption") return p.edits.caption || p.edits.location?.name || "";
  if (label === "date") return effectiveTaken(p) ?? (p.created ? p.created.slice(11) : "");
  if (label === "number") return `${it.disc.name} · ${p.stem}`;
  return "";
}

const loadImage = (url: string) =>
  new Promise<HTMLImageElement>((ok, bad) => {
    const img = new Image();
    img.onload = () => ok(img);
    img.onerror = bad;
    img.src = url;
  });

async function renderPages(items: Item[], title: string, o: Options, onProgress: (n: number) => void): Promise<Blob[]> {
  const [W, H] = PAPER[o.paper];
  const margin = 150, gap = 40, head = 170;
  const cellW = (W - 2 * margin - (o.columns - 1) * gap) / o.columns;
  const imgH = (cellW * 3) / 4;
  const labelH = o.label === "none" ? 0 : 56;
  const cellH = imgH + labelH + gap;
  const rows = Math.max(1, Math.floor((H - 2 * margin - head) / cellH));
  const perPage = rows * o.columns;
  const pages: Blob[] = [];
  const total = Math.ceil(items.length / perPage);
  for (let pg = 0; pg < total; pg++) {
    const c = document.createElement("canvas");
    c.width = W;
    c.height = H;
    const g = c.getContext("2d")!;
    g.fillStyle = "#fff";
    g.fillRect(0, 0, W, H);
    g.fillStyle = "#111";
    g.font = "600 64px -apple-system, system-ui, sans-serif";
    g.fillText(title, margin, margin + 60);
    g.fillStyle = "#777";
    g.font = "36px -apple-system, system-ui, sans-serif";
    g.fillText(`${items.length} photos${total > 1 ? ` · page ${pg + 1} of ${total}` : ""}`, margin, margin + 115);
    const slice = items.slice(pg * perPage, (pg + 1) * perPage);
    for (let k = 0; k < slice.length; k++) {
      const it = slice[k];
      const x = margin + (k % o.columns) * (cellW + gap);
      const y = margin + head + Math.floor(k / o.columns) * cellH;
      g.fillStyle = "#eee";
      g.fillRect(x, y, cellW, imgH);
      if (it.photo.jpegPath) {
        try {
          const img = await loadImage(await renderedUrl(it.photo, 800));
          const s = Math.min(cellW / img.naturalWidth, imgH / img.naturalHeight);
          const w = img.naturalWidth * s, h = img.naturalHeight * s;
          g.imageSmoothingQuality = "high";
          g.drawImage(img, x + (cellW - w) / 2, y + (imgH - h) / 2, w, h);
        } catch { /* leave the grey box */ }
      }
      const text = labelFor(it, o.label);
      if (text) {
        g.fillStyle = "#333";
        g.font = "30px -apple-system, system-ui, sans-serif";
        let t = text;
        while (t.length > 1 && g.measureText(t).width > cellW) t = t.slice(0, -2) + "…";
        g.fillText(t, x, y + imgH + 40);
      }
      onProgress(pg * perPage + k + 1);
    }
    pages.push(await new Promise<Blob>((ok, bad) => c.toBlob((b) => (b ? ok(b) : bad(new Error("render failed"))), "image/jpeg", 0.9)));
  }
  return pages;
}

const toBase64 = (b: Blob) =>
  new Promise<string>((ok) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result).split(",")[1] ?? "");
    r.readAsDataURL(b);
  });

export function openContactSheet(items: Item[], title: string) {
  const o: Options = { columns: 4, label: "date", paper: "letter", ...prefs.get<Partial<Options>>("contactSheet", {}) };
  const m = openModal(
    `Contact sheet of ${items.length} photo${items.length === 1 ? "" : "s"}`,
    `<label class="small muted">Title</label>
     <input id="cs-title" class="field" value="${esc(title)}">
     <div class="cs-row">
       <label>Photos per row <select id="cs-cols" class="field">${[3, 4, 5, 6].map((n) => `<option ${o.columns === n ? "selected" : ""}>${n}</option>`).join("")}</select></label>
       <label>Under each photo <select id="cs-label" class="field">
         ${(["date", "caption", "number", "none"] as Label[]).map((l) => `<option value="${l}" ${o.label === l ? "selected" : ""}>${{ date: "Date taken", caption: "Caption or place", number: "Disc and file", none: "Nothing" }[l]}</option>`).join("")}
       </select></label>
       <label>Paper <select id="cs-paper" class="field"><option value="letter" ${o.paper === "letter" ? "selected" : ""}>US Letter</option><option value="a4" ${o.paper === "a4" ? "selected" : ""}>A4</option></select></label>
     </div>
     <div class="muted small">Saved as 300 dpi JPEG pages; open them in Preview (or any image viewer) to print.</div>
     <div class="modal-actions"><span id="cs-status" class="muted small"></span><span class="spacer"></span>
       <button class="btn" id="cs-cancel">Cancel</button><button class="btn primary" id="cs-go">Save…</button></div>`,
  );
  const q = <T extends HTMLElement>(s: string) => m.el.querySelector<T>(s)!;
  q("#cs-cancel").addEventListener("click", m.close);
  q("#cs-go").addEventListener("click", async () => {
    o.columns = +q<HTMLSelectElement>("#cs-cols").value;
    o.label = q<HTMLSelectElement>("#cs-label").value as Label;
    o.paper = q<HTMLSelectElement>("#cs-paper").value as Options["paper"];
    prefs.set("contactSheet", o);
    const name = q<HTMLInputElement>("#cs-title").value.trim() || "Contact sheet";
    const path = await save({ title: "Save contact sheet", defaultPath: `${name.replace(/[\\/:*?"<>|]/g, "_")}.jpg`, filters: [{ name: "JPEG", extensions: ["jpg"] }] });
    if (!path) return;
    const btn = q<HTMLButtonElement>("#cs-go");
    btn.disabled = true;
    try {
      const pages = await renderPages(items, name, o, (n) => { q("#cs-status").textContent = `Drawing ${n} of ${items.length}…`; });
      const base = path.replace(/\.jpe?g$/i, "");
      const paths = pages.length === 1 ? [`${base}.jpg`] : pages.map((_, i) => `${base} ${i + 1}.jpg`);
      for (let i = 0; i < pages.length; i++) await api.saveFile(paths[i], await toBase64(pages[i]));
      m.close();
      toast(`Saved ${pages.length === 1 ? "the contact sheet" : `${pages.length} pages`}.`, { label: "Show", run: () => revealItemInDir(paths[0]) });
    } catch (e) {
      toast(`Couldn't make the contact sheet: ${e}`, undefined, "error");
      btn.disabled = false;
    }
  });
}
