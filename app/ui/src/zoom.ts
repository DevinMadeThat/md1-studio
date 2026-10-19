// Pinch-zoom and pan for the viewer's photo.
//
// Zoom 1 = the photo fitted to the stage; below 1 it is smaller than the stage. The zoom level and the pan position (as a fraction of
// the photo's size) live in a shared object, so moving to the next photo keeps looking at the
// same part of the frame at the same magnification.

export interface ZoomShared {
  z: number;
  /** pan offset as a fraction of the displayed (zoomed) photo width / height */
  nx: number;
  ny: number;
}

/** Below 1 the photo is smaller than the stage; it stays centred. */
const MIN = 0.2;
const MAX = 8;

export class ZoomStage {
  private sw = 0;
  private sh = 0;
  private bw = 0; // fitted photo size at zoom 1, after rotation
  private bh = 0;
  private tx = 0;
  private ty = 0;
  private gestureStart = 0;
  private inGesture = false;
  private drag: { x: number; y: number; tx: number; ty: number } | null = null;
  private ro: ResizeObserver;
  private off: (() => void)[] = [];

  constructor(
    private stage: HTMLElement,
    private img: HTMLElement,
    private natW: number,
    private natH: number,
    private rotation: number,
    private shared: ZoomShared,
    private onChange: (z: number) => void,
  ) {
    this.ro = new ResizeObserver(() => this.layout());
    this.ro.observe(stage);
    const on = <K extends keyof HTMLElementEventMap>(t: K, f: (e: HTMLElementEventMap[K]) => void, o?: AddEventListenerOptions) => {
      stage.addEventListener(t, f as EventListener, o);
      this.off.push(() => stage.removeEventListener(t, f as EventListener));
    };
    on("wheel", (e) => this.onWheel(e), { passive: false });
    // WebKit (the macOS app's web view) reports trackpad pinches as gesture events.
    on("gesturestart" as any, (e: any) => { e.preventDefault(); this.inGesture = true; this.gestureStart = this.shared.z; });
    on("gesturechange" as any, (e: any) => { e.preventDefault(); this.zoomTo(this.gestureStart * e.scale, e.clientX, e.clientY); });
    on("gestureend" as any, (e: any) => { e.preventDefault(); this.inGesture = false; });
    on("mousedown", (e) => this.onDown(e));
    on("dblclick", (e) => {
      if (Math.abs(this.shared.z - 1) > 0.01) this.reset();
      else this.zoomTo(2.5, e.clientX, e.clientY);
    });
    const move = (e: MouseEvent) => this.onMove(e);
    const up = () => { this.drag = null; this.stage.classList.remove("dragging"); };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    this.off.push(() => window.removeEventListener("mousemove", move), () => window.removeEventListener("mouseup", up));
    this.layout();
  }

  destroy() {
    this.ro.disconnect();
    this.off.forEach((f) => f());
  }

  get zoom() {
    return this.shared.z;
  }

  layout() {
    const r = this.stage.getBoundingClientRect();
    if (!r.width || !r.height) return;
    this.sw = r.width;
    this.sh = r.height;
    const turned = this.rotation % 180 !== 0;
    const w0 = turned ? this.natH : this.natW;
    const h0 = turned ? this.natW : this.natH;
    const pad = 24;
    const s = Math.min((this.sw - pad) / w0, (this.sh - pad) / h0);
    this.bw = w0 * s;
    this.bh = h0 * s;
    const iw = this.natW * s, ih = this.natH * s;
    Object.assign(this.img.style, {
      width: `${iw}px`,
      height: `${ih}px`,
      left: `${(this.sw - iw) / 2}px`,
      top: `${(this.sh - ih) / 2}px`,
    });
    this.tx = this.shared.nx * this.bw * this.shared.z;
    this.ty = this.shared.ny * this.bh * this.shared.z;
    this.apply();
  }

  private clamp() {
    const z = this.shared.z;
    const mx = Math.max(0, (this.bw * z - this.sw) / 2);
    const my = Math.max(0, (this.bh * z - this.sh) / 2);
    this.tx = Math.max(-mx, Math.min(mx, this.tx));
    this.ty = Math.max(-my, Math.min(my, this.ty));
    this.shared.nx = this.bw ? this.tx / (this.bw * z) : 0;
    this.shared.ny = this.bh ? this.ty / (this.bh * z) : 0;
  }

  private apply() {
    this.clamp();
    this.img.style.transform = `translate(${this.tx}px, ${this.ty}px) scale(${this.shared.z}) rotate(${this.rotation}deg)`;
    this.stage.classList.toggle("zoomed", this.shared.z > 1.01);
    this.onChange(this.shared.z);
  }

  /** Zoom so the point under (clientX, clientY) stays put. */
  zoomTo(z: number, clientX?: number, clientY?: number) {
    z = Math.max(MIN, Math.min(MAX, z));
    const r = this.stage.getBoundingClientRect();
    const cx = (clientX ?? r.left + r.width / 2) - (r.left + r.width / 2);
    const cy = (clientY ?? r.top + r.height / 2) - (r.top + r.height / 2);
    const k = z / this.shared.z;
    this.tx = cx - (cx - this.tx) * k;
    this.ty = cy - (cy - this.ty) * k;
    this.shared.z = z;
    this.apply();
  }

  zoomBy(factor: number) {
    this.zoomTo(this.shared.z * factor);
  }

  reset() {
    this.shared.z = 1;
    this.tx = this.ty = 0;
    this.apply();
  }

  private onWheel(e: WheelEvent) {
    e.preventDefault();
    if (e.ctrlKey) {
      // Trackpad pinch in Chromium-based web views (and ctrl + mouse wheel).
      if (!this.inGesture) this.zoomTo(this.shared.z * Math.exp(-e.deltaY * 0.01), e.clientX, e.clientY);
    } else if (this.shared.z > 1.01) {
      this.tx -= e.deltaX;
      this.ty -= e.deltaY;
      this.apply();
    }
  }

  private onDown(e: MouseEvent) {
    if (e.button !== 0 || this.shared.z <= 1.01) return;
    e.preventDefault();
    this.drag = { x: e.clientX, y: e.clientY, tx: this.tx, ty: this.ty };
    this.stage.classList.add("dragging");
  }

  private onMove(e: MouseEvent) {
    if (!this.drag) return;
    this.tx = this.drag.tx + (e.clientX - this.drag.x);
    this.ty = this.drag.ty + (e.clientY - this.drag.y);
    this.apply();
  }
}
