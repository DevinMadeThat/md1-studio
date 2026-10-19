// Live-preview version of crates/md1-core/src/adjust.rs: noise cleanup → colour → geometry.
// The formulas must stay identical to the Rust ones (exports are rendered there).
import { invoke } from "@tauri-apps/api/core";
import type { Photo, PhotoEdits } from "./api";

export interface Crop { x: number; y: number; w: number; h: number }
export interface AutoLevels { lo: number[]; hi: number[]; gamma: number }
export interface Adjust {
  auto?: AutoLevels | null;
  brightness: number;
  contrast: number;
  warmth: number;
  saturation: number;
  denoise: number;
}
export interface Look {
  rotation: number;
  flip: boolean;
  straighten: number;
  crop?: Crop | null;
  adjust?: Adjust | null;
}

export const noAdjust = (): Adjust => ({ auto: null, brightness: 0, contrast: 0, warmth: 0, saturation: 0, denoise: 0 });

export const adjustIsIdentity = (a?: Adjust | null) =>
  !a || (!a.auto && !a.brightness && !a.contrast && !a.warmth && !a.saturation && !a.denoise);

export function lookOf(e: PhotoEdits): Look {
  return {
    rotation: e.rotation ?? 0,
    flip: !!e.flip,
    straighten: e.straighten ?? 0,
    crop: e.crop ?? null,
    adjust: e.adjust ? { ...noAdjust(), ...e.adjust } : null,
  };
}

/** Needs pixels re-rendered (anything beyond a plain rotation). */
export const hasLook = (e: PhotoEdits) => !!(e.flip || e.straighten || e.crop || !adjustIsIdentity(e.adjust));

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

export function colorLuts(a: Adjust): Uint8Array[] {
  const warm = [1 + 0.12 * a.warmth, 1, 1 - 0.12 * a.warmth];
  const g = 2 ** (-1.2 * a.brightness);
  return [0, 1, 2].map((c) => {
    const lut = new Uint8Array(256);
    for (let x = 0; x < 256; x++) {
      let v = x / 255;
      if (a.auto) {
        v = clamp01((v - a.auto.lo[c]) / Math.max(a.auto.hi[c] - a.auto.lo[c], 0.05));
        v = v ** a.auto.gamma;
      }
      v = clamp01(v * warm[c]);
      v = v ** g;
      v = clamp01(0.5 + (v - 0.5) * (1 + a.contrast));
      lut[x] = Math.round(v * 255);
    }
    return lut;
  });
}

/** In place on RGBA data. */
export function applyColor(d: Uint8ClampedArray, a: Adjust) {
  const [lr, lg, lb] = colorLuts(a);
  const s = 1 + a.saturation;
  for (let i = 0; i < d.length; i += 4) {
    const r = lr[d[i]], g = lg[d[i + 1]], b = lb[d[i + 2]];
    if (a.saturation === 0) {
      d[i] = r; d[i + 1] = g; d[i + 2] = b;
    } else {
      const y = 0.299 * r + 0.587 * g + 0.114 * b;
      d[i] = Math.round(Math.min(255, Math.max(0, y + (r - y) * s)));
      d[i + 1] = Math.round(Math.min(255, Math.max(0, y + (g - y) * s)));
      d[i + 2] = Math.round(Math.min(255, Math.max(0, y + (b - y) * s)));
    }
  }
}

/** 5×5 bilateral filter on RGBA data; returns a new array. */
export function denoise(src: Uint8ClampedArray, w: number, h: number, strength: number): Uint8ClampedArray {
  if (strength <= 0) return src;
  const sr = 3 + 27 * Math.min(1, strength);
  const range = new Float64Array(65026);
  for (let d2 = 0; d2 <= 65025; d2++) range[d2] = Math.exp(-d2 / (2 * sr * sr));
  const spatial = new Float64Array(25);
  for (let dy = 0; dy < 5; dy++) for (let dx = 0; dx < 5; dx++) spatial[dy * 5 + dx] = Math.exp(-((dx - 2) ** 2 + (dy - 2) ** 2) / (2 * 1.5 * 1.5));
  const out = new Uint8ClampedArray(src.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const r0 = src[i], g0 = src[i + 1], b0 = src[i + 2];
      let sR = 0, sG = 0, sB = 0, sW = 0;
      for (let dy = -2; dy <= 2; dy++) {
        const yy = Math.min(h - 1, Math.max(0, y + dy));
        for (let dx = -2; dx <= 2; dx++) {
          const xx = Math.min(w - 1, Math.max(0, x + dx));
          const j = (yy * w + xx) * 4;
          const r = src[j], g = src[j + 1], b = src[j + 2];
          const d2 = Math.floor(((r - r0) ** 2 + (g - g0) ** 2 + (b - b0) ** 2) / 3);
          const wt = spatial[(dy + 2) * 5 + dx + 2] * range[d2];
          sR += wt * r; sG += wt * g; sB += wt * b; sW += wt;
        }
      }
      out[i] = Math.round(sR / sW);
      out[i + 1] = Math.round(sG / sW);
      out[i + 2] = Math.round(sB / sW);
      out[i + 3] = 255;
    }
  }
  return out;
}

export function straightenScale(w: number, h: number, deg: number) {
  const a = Math.abs((deg * Math.PI) / 180);
  return Math.max((w * Math.cos(a) + h * Math.sin(a)) / w, (w * Math.sin(a) + h * Math.cos(a)) / h);
}

// ------------------------------------------------------------------ loading & rendering

const bitmaps = new Map<string, Promise<ImageBitmap>>();

/** Decoded original photo (read through the backend, so canvases aren't cross-origin tainted). */
export function loadBitmap(path: string): Promise<ImageBitmap> {
  let p = bitmaps.get(path);
  if (!p) {
    p = invoke<ArrayBuffer>("read_disc_file", { path }).then((buf) => createImageBitmap(new Blob([buf], { type: "image/jpeg" })));
    p.catch(() => bitmaps.delete(path));
    bitmaps.set(path, p);
  }
  return p;
}

const canvas = (w: number, h: number) => {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
};
const ctx2d = (c: HTMLCanvasElement) => c.getContext("2d", { willReadFrequently: true })!;

/** Denoised + colour-adjusted pixels at the original size (the expensive part, cached by callers). */
export function colorStage(bm: ImageBitmap, a: Adjust | null | undefined, denoised?: Uint8ClampedArray): HTMLCanvasElement {
  const c = canvas(bm.width, bm.height);
  const g = ctx2d(c);
  g.drawImage(bm, 0, 0);
  if (adjustIsIdentity(a)) return c;
  const img = g.getImageData(0, 0, c.width, c.height);
  const base = denoised ?? denoise(img.data, c.width, c.height, a!.denoise);
  if (base !== img.data) img.data.set(base);
  applyColor(img.data, a!);
  g.putImageData(img, 0, 0);
  return c;
}

/** Straighten, flip, rotate, and (unless `crop` is false) crop. */
export function geometryStage(src: HTMLCanvasElement, look: Look, crop = true): HTMLCanvasElement {
  const w = src.width, h = src.height;
  let c = src;
  if (look.straighten || look.flip) {
    c = canvas(w, h);
    const g = ctx2d(c);
    g.imageSmoothingQuality = "high";
    g.translate(w / 2, h / 2);
    // Same order as adjust.rs: straighten, then flip the straightened picture (outermost here,
    // because canvas transforms apply to the drawing in reverse order of the calls).
    if (look.flip) g.scale(-1, 1);
    if (look.straighten) {
      g.rotate((look.straighten * Math.PI) / 180);
      const s = straightenScale(w, h, look.straighten);
      g.scale(s, s);
    }
    g.drawImage(src, -w / 2, -h / 2);
  }
  const rot = ((look.rotation % 360) + 360) % 360;
  if (rot) {
    const turned = rot % 180 !== 0;
    const r = canvas(turned ? h : w, turned ? w : h);
    const g = ctx2d(r);
    g.translate(r.width / 2, r.height / 2);
    g.rotate((rot * Math.PI) / 180);
    g.drawImage(c, -w / 2, -h / 2);
    c = r;
  }
  if (crop && look.crop) {
    const { x, y, w: cw, h: ch } = look.crop;
    const px = Math.round(x * c.width), py = Math.round(y * c.height);
    const pw = Math.max(1, Math.round(cw * c.width)), ph = Math.max(1, Math.round(ch * c.height));
    const r = canvas(pw, ph);
    ctx2d(r).drawImage(c, px, py, pw, ph, 0, 0, pw, ph);
    c = r;
  }
  return c;
}

export function scaledCanvas(src: HTMLCanvasElement, maxW: number): HTMLCanvasElement {
  if (src.width <= maxW) return src;
  const r = canvas(maxW, Math.round((src.height * maxW) / src.width));
  const g = ctx2d(r);
  g.imageSmoothingQuality = "high";
  g.drawImage(src, 0, 0, r.width, r.height);
  return r;
}

const rendered = new Map<string, Promise<string>>();

/** Blob URL of the photo with its look applied (cached per look). `maxW` for thumbnails. */
export function renderedUrl(p: Photo, maxW = 0): Promise<string> {
  const look = lookOf(p.edits);
  const key = `${p.jpegPath}|${maxW}|${JSON.stringify(look)}`;
  let u = rendered.get(key);
  if (!u) {
    u = loadBitmap(p.jpegPath!).then(async (bm) => {
      let c = geometryStage(colorStage(bm, look.adjust), look);
      if (maxW) c = scaledCanvas(c, maxW);
      const blob = await new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("render failed"))), "image/jpeg", 0.92));
      return URL.createObjectURL(blob);
    });
    u.catch(() => rendered.delete(key));
    rendered.set(key, u);
  }
  return u;
}
