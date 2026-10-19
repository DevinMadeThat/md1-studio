// The photo editor inside the viewer: Adjust (auto-enhance, light, colour, noise) and Crop
// (aspect, straighten, rotate, flip). Edits preview live; Done saves them as one "look".
import { api, type Disc, type Photo } from "./api";
import { icon } from "./icons";
import {
  adjustIsIdentity,
  colorStage,
  denoise,
  geometryStage,
  loadBitmap,
  lookOf,
  noAdjust,
  type Adjust,
  type Crop,
  type Look,
} from "./look";
import { esc, toast } from "./ui";

type Tab = "adjust" | "crop";
type Handle = "move" | "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

const SLIDERS: { key: keyof Adjust; label: string; group: string; min: number }[] = [
  { key: "brightness", label: "Brightness", group: "Light", min: -100 },
  { key: "contrast", label: "Contrast", group: "Light", min: -100 },
  { key: "warmth", label: "Warmth", group: "Colour", min: -100 },
  { key: "saturation", label: "Saturation", group: "Colour", min: -100 },
  { key: "denoise", label: "Noise & blockiness", group: "Clean up", min: 0 },
];

const ASPECTS: { id: string; label: string; ratio: number | null }[] = [
  { id: "free", label: "Free", ratio: null },
  { id: "orig", label: "Original", ratio: 0 }, // 0 = the photo's own shape
  { id: "1:1", label: "Square", ratio: 1 },
  { id: "4:3", label: "4:3", ratio: 4 / 3 },
  { id: "3:2", label: "3:2", ratio: 3 / 2 },
  { id: "16:9", label: "16:9", ratio: 16 / 9 },
];

const FULL: Crop = { x: 0, y: 0, w: 1, h: 1 };

export interface EditorHost {
  stage: HTMLElement;
  panel: HTMLElement;
  disc: Disc;
  photo: Photo;
  /** Called with the updated disc after saving, or null when cancelled. */
  done: (d: Disc | null) => void;
}

export class PhotoEditor {
  private look: Look;
  private tab: Tab = "adjust";
  private aspect = "free";
  private bm: ImageBitmap | null = null;
  private denoised: { strength: number; data: Uint8ClampedArray } | null = null;
  private frame!: HTMLElement;
  private view!: HTMLCanvasElement;
  private dims = { w: 640, h: 480 }; // size of the geometry result shown on the stage
  private raf = 0;
  private ro: ResizeObserver;
  private autoCache: Adjust["auto"] = null;
  private saving = false;

  constructor(private host: EditorHost) {
    this.look = lookOf(host.photo.edits);
    if (!this.look.adjust) this.look.adjust = noAdjust();
    this.ro = new ResizeObserver(() => this.layout());
    this.ro.observe(host.stage);
    this.renderPanel();
    host.stage.innerHTML = `<div class="ed-frame"><canvas></canvas><div class="crop-box"></div></div>`;
    host.stage.classList.add("editing");
    this.frame = host.stage.querySelector(".ed-frame")!;
    this.view = this.frame.querySelector("canvas")!;
    this.bindCrop();
    loadBitmap(host.photo.jpegPath!).then((bm) => { this.bm = bm; this.redraw(); }, (e) => toast(`Can't open the photo: ${e}`, undefined, "error"));
  }

  destroy() {
    this.ro.disconnect();
    cancelAnimationFrame(this.raf);
    this.host.stage.classList.remove("editing");
  }

  // ------------------------------------------------------------ rendering

  private redraw = () => {
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(() => this.draw());
  };

  private draw() {
    if (!this.bm) return;
    const a = this.look.adjust!;
    let base: Uint8ClampedArray | undefined;
    if (!adjustIsIdentity(a) && a.denoise > 0) {
      if (!this.denoised || this.denoised.strength !== a.denoise) {
        const c = colorStage(this.bm, null);
        const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
        this.denoised = { strength: a.denoise, data: denoise(d, c.width, c.height, a.denoise) };
      }
      base = this.denoised.data;
    }
    const geo = geometryStage(colorStage(this.bm, a, base), this.look, this.tab !== "crop");
    if (this.view.width !== geo.width || this.view.height !== geo.height) {
      this.view.width = geo.width;
      this.view.height = geo.height;
    }
    this.view.getContext("2d")!.drawImage(geo, 0, 0);
    this.dims = { w: geo.width, h: geo.height };
    this.layout();
  }

  private layout() {
    const r = this.host.stage.getBoundingClientRect();
    const pad = this.tab === "crop" ? 48 : 24;
    const s = Math.min((r.width - pad) / this.dims.w, (r.height - pad) / this.dims.h);
    const w = this.dims.w * s, h = this.dims.h * s;
    Object.assign(this.frame.style, { width: `${w}px`, height: `${h}px`, left: `${(r.width - w) / 2}px`, top: `${(r.height - h) / 2}px` });
    this.placeCrop();
  }

  private placeCrop() {
    const box = this.frame.querySelector<HTMLElement>(".crop-box")!;
    box.style.display = this.tab === "crop" ? "block" : "none";
    if (this.tab !== "crop") return;
    const c = this.look.crop ?? FULL;
    Object.assign(box.style, { left: `${c.x * 100}%`, top: `${c.y * 100}%`, width: `${c.w * 100}%`, height: `${c.h * 100}%` });
  }

  // ------------------------------------------------------------ crop interaction

  /** Target width/height ratio in pixels, or null for free. */
  private ratio(): number | null {
    const a = ASPECTS.find((x) => x.id === this.aspect)!;
    if (a.ratio === null) return null;
    const r = a.ratio === 0 ? this.dims.w / this.dims.h : a.ratio;
    // Follow the photo's orientation: portrait photos get portrait crops.
    return this.dims.h > this.dims.w && r > 1 ? 1 / r : r;
  }

  /** Largest rectangle of the chosen ratio around the current crop's centre. */
  private applyAspect() {
    const r = this.ratio();
    if (r === null) return;
    const c = this.look.crop ?? FULL;
    const cx = c.x + c.w / 2, cy = c.y + c.h / 2;
    const k = r * (this.dims.h / this.dims.w); // ratio in normalised units: w = k·h
    let w = 1, h = w / k;
    if (h > 1) { h = 1; w = k; }
    const x = Math.min(Math.max(cx - w / 2, 0), 1 - w);
    const y = Math.min(Math.max(cy - h / 2, 0), 1 - h);
    this.look.crop = { x, y, w, h };
    this.placeCrop();
  }

  private bindCrop() {
    const box = this.frame.querySelector<HTMLElement>(".crop-box")!;
    box.innerHTML = `<i class="third v1"></i><i class="third v2"></i><i class="third h1"></i><i class="third h2"></i>` +
      (["n", "s", "e", "w", "ne", "nw", "se", "sw"] as Handle[]).map((h) => `<b class="hd ${h}" data-h="${h}"></b>`).join("");
    box.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const handle = ((e.target as HTMLElement).dataset.h as Handle) ?? "move";
      const start = { ...(this.look.crop ?? FULL) };
      const fr = this.frame.getBoundingClientRect();
      const x0 = e.clientX, y0 = e.clientY;
      box.setPointerCapture(e.pointerId);
      const move = (ev: PointerEvent) => {
        const dx = (ev.clientX - x0) / fr.width, dy = (ev.clientY - y0) / fr.height;
        this.look.crop = this.dragged(start, handle, dx, dy);
        this.placeCrop();
      };
      const up = () => {
        box.removeEventListener("pointermove", move);
        box.removeEventListener("pointerup", up);
      };
      box.addEventListener("pointermove", move);
      box.addEventListener("pointerup", up);
    });
  }

  private dragged(c: Crop, h: Handle, dx: number, dy: number): Crop {
    const MIN = 0.05;
    if (h === "move") {
      return { ...c, x: Math.min(Math.max(c.x + dx, 0), 1 - c.w), y: Math.min(Math.max(c.y + dy, 0), 1 - c.h) };
    }
    let x1 = c.x, y1 = c.y, x2 = c.x + c.w, y2 = c.y + c.h;
    if (h.includes("w")) x1 = Math.min(Math.max(0, x1 + dx), x2 - MIN);
    if (h.includes("e")) x2 = Math.max(Math.min(1, x2 + dx), x1 + MIN);
    if (h.includes("n")) y1 = Math.min(Math.max(0, y1 + dy), y2 - MIN);
    if (h.includes("s")) y2 = Math.max(Math.min(1, y2 + dy), y1 + MIN);
    const r = this.ratio();
    if (r !== null) {
      const k = r * (this.dims.h / this.dims.w);
      let w = x2 - x1, hh = y2 - y1;
      // Edge drags drive one dimension; corners follow the larger change.
      if (h === "n" || h === "s" || (h.length === 2 && Math.abs(dy) > Math.abs(dx))) w = hh * k;
      else hh = w / k;
      // Keep inside the photo.
      const maxW = h.includes("w") ? x2 : 1 - x1;
      const maxH = h.includes("n") ? y2 : 1 - y1;
      const fit = Math.min(1, maxW / w, maxH / hh);
      w *= fit; hh *= fit;
      if (h.includes("w")) x1 = x2 - w; else x2 = x1 + w;
      if (h.includes("n")) y1 = y2 - hh; else y2 = y1 + hh;
      if (h === "n" || h === "s") { const cx = (c.x + c.x + c.w) / 2; x1 = Math.min(Math.max(cx - w / 2, 0), 1 - w); x2 = x1 + w; }
      if (h === "e" || h === "w") { const cy = (c.y + c.y + c.h) / 2; y1 = Math.min(Math.max(cy - hh / 2, 0), 1 - hh); y2 = y1 + hh; }
    }
    return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
  }

  private rotate(by: number) {
    const turns = ((by / 90) % 4 + 4) % 4;
    let c = this.look.crop;
    for (let i = 0; i < turns && c; i++) c = { x: 1 - c.y - c.h, y: c.x, w: c.h, h: c.w };
    this.look.crop = c;
    this.look.rotation = (((this.look.rotation + by) % 360) + 360) % 360;
    this.redraw();
  }

  private flip() {
    const c = this.look.crop;
    if (c) this.look.crop = { ...c, x: 1 - c.x - c.w };
    this.look.flip = !this.look.flip;
    this.redraw();
  }

  // ------------------------------------------------------------ panel

  private renderPanel() {
    const a = this.look.adjust!;
    const val = (k: keyof Adjust) => Math.round(((a[k] as number) ?? 0) * 100);
    const groups = [...new Set(SLIDERS.map((s) => s.group))];
    const p = this.host.panel;
    p.classList.add("ed-panel");
    p.innerHTML = `
      <div class="ed-tabs seg">
        <button class="${this.tab === "adjust" ? "on" : ""}" data-tab="adjust">Adjust</button>
        <button class="${this.tab === "crop" ? "on" : ""}" data-tab="crop">Crop &amp; straighten</button>
      </div>
      ${this.tab === "adjust" ? `
        <button class="btn auto ${a.auto ? "on" : ""}" data-ed="auto">✨ Auto-enhance${a.auto ? ` <span class="tag">on</span>` : ""}</button>
        ${groups.map((g) => `
          <div class="ed-group">${g}</div>
          ${SLIDERS.filter((s) => s.group === g).map((s) => `
            <label class="slider" title="Double-click to reset">
              <span class="sl-name">${s.label}</span><span class="sl-val" data-val="${s.key}">${val(s.key)}</span>
              <input type="range" min="${s.min}" max="100" step="1" value="${val(s.key)}" data-sl="${s.key}" class="${s.min < 0 ? "centered" : ""}">
            </label>`).join("")}`).join("")}`
      : `
        <div class="ed-group">Aspect ratio</div>
        <div class="ed-aspects">${ASPECTS.map((x) => `<button class="chip ${this.aspect === x.id ? "on" : ""}" data-aspect="${x.id}">${x.label}</button>`).join("")}</div>
        <div class="ed-group">Straighten</div>
        <label class="slider" title="Double-click to reset">
          <span class="sl-name">Angle</span><span class="sl-val" data-val="straighten">${this.look.straighten.toFixed(1)}°</span>
          <input type="range" min="-15" max="15" step="0.1" value="${this.look.straighten}" data-sl="straighten" class="centered">
        </label>
        <div class="ed-group">Turn</div>
        <div class="ed-row">
          <button class="btn small" data-ed="rot-left">${icon.rotateLeft(14)} Left</button>
          <button class="btn small" data-ed="rot-right">${icon.rotateRight(14)} Right</button>
          <button class="btn small ${this.look.flip ? "on" : ""}" data-ed="flip">⇋ Flip</button>
        </div>
        <button class="linkish ed-reset-crop" data-ed="reset-crop">Reset crop &amp; straighten</button>`}
      <div class="ed-foot">
        <button class="btn" data-ed="reset">Reset all</button>
        <span class="spacer"></span>
        <button class="btn" data-ed="cancel">Cancel</button>
        <button class="btn primary" data-ed="done">Done</button>
      </div>
      <div class="muted small ed-note">${esc("Edits never change the files from the camera; they're applied when you export.")}</div>`;

    p.querySelectorAll<HTMLButtonElement>("[data-tab]").forEach((b) => b.addEventListener("click", () => {
      this.tab = b.dataset.tab as Tab;
      this.renderPanel();
      this.redraw();
    }));
    p.querySelectorAll<HTMLInputElement>("[data-sl]").forEach((inp) => {
      const key = inp.dataset.sl!;
      const set = (v: number) => {
        if (key === "straighten") {
          this.look.straighten = v;
          p.querySelector(`[data-val="straighten"]`)!.textContent = `${v.toFixed(1)}°`;
        } else {
          (a as any)[key] = v / 100;
          p.querySelector(`[data-val="${key}"]`)!.textContent = String(Math.round(v));
        }
        this.redraw();
      };
      inp.addEventListener("input", () => set(+inp.value));
      inp.closest("label")!.addEventListener("dblclick", () => { inp.value = "0"; set(0); });
    });
    p.querySelectorAll<HTMLButtonElement>("[data-aspect]").forEach((b) => b.addEventListener("click", () => {
      this.aspect = b.dataset.aspect!;
      p.querySelectorAll("[data-aspect]").forEach((x) => x.classList.toggle("on", x === b));
      this.applyAspect();
    }));
    p.querySelectorAll<HTMLButtonElement>("[data-ed]").forEach((b) => b.addEventListener("click", () => this.action(b.dataset.ed!)));
  }

  private async action(what: string) {
    const a = this.look.adjust!;
    switch (what) {
      case "auto":
        if (a.auto) a.auto = null;
        else {
          try {
            this.autoCache ??= await api.autoLevels(this.host.disc.path, this.host.photo.id);
            a.auto = this.autoCache;
          } catch (e) {
            toast(`Auto-enhance failed: ${e}`, undefined, "error");
          }
        }
        this.renderPanel();
        this.redraw();
        break;
      case "rot-left": this.rotate(-90); break;
      case "rot-right": this.rotate(90); break;
      case "flip": this.flip(); this.renderPanel(); break;
      case "reset-crop":
        this.look.crop = null;
        this.look.straighten = 0;
        this.aspect = "free";
        this.renderPanel();
        this.redraw();
        break;
      case "reset":
        this.look = { rotation: 0, flip: false, straighten: 0, crop: null, adjust: noAdjust() };
        this.aspect = "free";
        this.renderPanel();
        this.redraw();
        break;
      case "cancel":
        this.destroy();
        this.host.done(null);
        break;
      case "done":
        await this.save();
        break;
    }
  }

  async save() {
    if (this.saving) return;
    this.saving = true;
    try {
      const d = await api.editPhotos(this.host.disc.path, [{ photoId: this.host.photo.id, setLook: this.look }]);
      this.destroy();
      this.host.done(d);
    } catch (e) {
      toast(`Couldn't save: ${e}`, undefined, "error");
    } finally {
      this.saving = false;
    }
  }

  cancel() {
    this.action("cancel");
  }
}
