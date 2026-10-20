import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  api, fileUrl, itemKey,
  type BrowseEvent, type CameraContents, type CameraInfo, type CameraPhoto, type Disc, type ImportEvent, type Item, type Photo, type PortInfo, type Settings,
} from "./api";
import { effectiveTaken, googleMapsUrl, openDateEditor, openExportSheet, openLocationEditor, saveEdits } from "./editors";
import { formatLatLon } from "./geo";
import { icon } from "./icons";
import { hasLook, renderedUrl } from "./look";
import { renderMap } from "./map";
import { PhotoEditor } from "./photoEditor";
import { esc, prefs, toast } from "./ui";
import { ZoomStage, type ZoomShared } from "./zoom";

// ---------------------------------------------------------------- state

type View = { kind: "camera" } | { kind: "library" } | { kind: "disc"; path: string };
type Filter = "all" | "favorites" | "sound" | "fine";

interface ImportState {
  running: boolean;
  label: string;
  done: number;
  total: number;
  rate: number;
  log: string[];
  error: string | null;
  /** Photos asked for (null = the whole disc). */
  count: number | null;
}

const state = {
  settings: null as Settings | null,
  discs: [] as Disc[],
  view: { kind: "library" } as View,
  ports: [] as PortInfo[],
  port: "",
  manualPort: false,
  camera: null as CameraInfo | null,
  connecting: false,
  connectLog: [] as string[],
  connectError: null as string | null,
  imp: null as ImportState | null,
  filter: "all" as Filter,
  /** Library selection: item keys. */
  selection: new Set<string>(),
  /** Last photo clicked: the start of a shift-click range. */
  anchor: null as string | null,
  renaming: false,
  /** The disc in the camera, seen through its thumbnails. */
  cam: {
    contents: null as CameraContents | null,
    browsing: false,
    done: 0,
    total: 0,
    error: null as string | null,
    /** Camera photo ids. */
    selection: new Set<string>(),
    anchor: null as string | null,
    /** Camera paths copied during the current download. */
    stored: new Set<string>(),
  },
};

const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector<T>(sel)!;
const fmtBytes = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n >= 1e3 ? `${Math.round(n / 1e3)} KB` : `${n} B`;
const fmtSecs = (s: number) => {
  s = Math.max(0, Math.round(s));
  return s >= 60 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}` : `0:${String(s).padStart(2, "0")}`;
};
const fmtDuration = (s: number) => (s < 90 ? `${Math.max(1, Math.round(s / 5) * 5)} seconds` : `${Math.round(s / 60)} minutes`);
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
/** Typical read speed at 115,200 baud (2 KB blocks); used until a download measures it. */
const TYPICAL_RATE = 9000;

// ---------------------------------------------------------------- library items

const discItems = (d: Disc): Item[] => d.albums.flatMap((a) => a.photos.map((photo) => ({ key: itemKey(d, photo), disc: d, photo })));
const allItems = (): Item[] => state.discs.flatMap(discItems);
const itemByKey = (key: string) => allItems().find((it) => it.key === key);
const currentDisc = () => (state.view.kind === "disc" ? state.discs.find((d) => d.path === (state.view as any).path) : undefined);

function passes(p: Photo) {
  if (state.filter === "favorites") return !!p.edits.favorite;
  if (state.filter === "sound") return p.soundSeconds != null;
  if (state.filter === "fine") return p.info.quality === "FINE";
  return true;
}

/** "2026-10-19" in local time. */
const localDay = (iso: string) => {
  const t = new Date(iso);
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
};
const longDay = (iso: string) => new Date(iso).toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" });

interface Group { title: string; sub: string; items: Item[] }

/** What the grid shows, in display order: the whole library by import (newest first), or one
 * disc folder by album. */
function groups(): Group[] {
  if (state.view.kind === "disc") {
    const d = currentDisc();
    if (!d) return [];
    return d.albums.map((a) => ({
      title: d.albums.length > 1 ? a.name : "",
      sub: "",
      items: a.photos.filter(passes).map((photo) => ({ key: itemKey(d, photo), disc: d, photo })),
    }));
  }
  const byKey = new Map<string, Group & { at: string }>();
  for (const it of allItems()) {
    if (!passes(it.photo)) continue;
    const at = it.photo.importedAt ?? "";
    const k = `${at ? localDay(at) : ""}|${it.disc.path}`;
    let g = byKey.get(k);
    if (!g) {
      g = { title: at ? `Imported ${longDay(at)}` : "Imported earlier", sub: it.disc.name, items: [], at };
      byKey.set(k, g);
    }
    if (at > g.at) g.at = at;
    g.items.push(it);
  }
  return [...byKey.values()].sort((a, b) => b.at.localeCompare(a.at) || a.sub.localeCompare(b.sub));
}

const visibleItems = () => groups().flatMap((g) => g.items);

/** Replace discs after an edit or a download. */
function applyDiscs(updated: Disc[]) {
  for (const d of updated) {
    const i = state.discs.findIndex((x) => x.path === d.path);
    if (i >= 0) state.discs[i] = d;
    else state.discs.push(d);
  }
}

// ---------------------------------------------------------------- sidebar

function renderSidebar() {
  const cam = state.camera;
  const camLine = cam
    ? `${plural(cam.status.pictures, "photo")} · ${cam.connection.baud === 115200 ? "fast link" : `${cam.connection.baud} baud`}`
    : state.connecting ? "Connecting…" : "Not connected";
  const total = state.discs.reduce((n, d) => n + d.photoCount, 0);
  const discs = state.discs
    .map((d) => {
      const active = state.view.kind === "disc" && state.view.path === d.path;
      const sub = [plural(d.photoCount, "photo"), d.missingPhotos ? `${d.missingPhotos} not downloaded` : d.soundCount ? `${d.soundCount} with sound` : ""].filter(Boolean).join(" · ");
      return `<button class="nav-item small-item ${active ? "active" : ""}" data-disc="${esc(d.path)}" title="${esc(d.path)}">
        <span class="nav-icon">${icon.disc(15)}</span>
        <span class="nav-text"><span class="nav-title">${esc(d.name)}</span><span class="nav-sub">${sub}</span></span>
      </button>`;
    })
    .join("");
  $("#sidebar").innerHTML = `
    <div class="sidebar-top" data-drag></div>
    <div class="nav-section">Camera</div>
    <button class="nav-item ${state.view.kind === "camera" ? "active" : ""}" data-nav="camera">
      <span class="nav-icon">${icon.camera()}</span>
      <span class="nav-text"><span class="nav-title">DSC-MD1</span><span class="nav-sub">${camLine}</span></span>
      <span class="dot ${cam ? "on" : state.connecting ? "busy" : ""}"></span>
    </button>
    <div class="nav-section">Library</div>
    <button class="nav-item ${state.view.kind === "library" ? "active" : ""}" data-nav="library">
      <span class="nav-icon">${icon.photos()}</span>
      <span class="nav-text"><span class="nav-title">All photos</span><span class="nav-sub">${plural(total, "photo")}</span></span>
    </button>
    ${state.discs.length ? `<div class="nav-section">Discs</div>${discs}` : ""}
    <button class="nav-add" data-action="add-folder">${icon.plus(14)} Add backup folder…</button>
    <div class="sidebar-foot">
      <div class="foot-label">Library folder</div>
      <button class="foot-path" data-action="reveal-library" title="${esc(state.settings?.libraryDir)}">${icon.folder(13)} <span>${esc(shortPath(state.settings?.libraryDir ?? ""))}</span></button>
      <button class="foot-change" data-action="change-library">Change…</button>
    </div>`;
}

function shortPath(p: string) {
  return p.replace(/^\/Users\/[^/]+/, "~").replace(/^C:\\Users\\[^\\]+/i, "~");
}

// ---------------------------------------------------------------- camera view

function powerBar(power: number) {
  const segs = [1, 2, 3, 4, 5].map((i) => `<i class="${i <= power ? "on" : ""} ${power < 3 ? "low" : ""}"></i>`).join("");
  return `<span class="power">${segs}</span>`;
}

function renderConnect() {
  const opts = state.ports
    .map((p) => `<option value="${esc(p.path)}" ${p.path === state.port ? "selected" : ""}>${esc(p.path.replace("/dev/", ""))}${p.description ? ` — ${esc(p.description)}` : ""}${p.likely_adapter ? " ★" : ""}</option>`)
    .join("");
  $("#main").innerHTML = `
    <header class="toolbar" data-drag><div class="tb-title">Camera</div></header>
    <div class="page">
      <section class="hero">
        <div class="hero-art">${icon.camera(44)}</div>
        <h1>Connect your DSC-MD1</h1>
        <p class="lede">See the photos on the disc, then copy the ones you want, with their recorded sound. Nothing on the disc is changed.</p>
        <ol class="steps">
          <li><b>Cable</b> — USB-serial adapter + DB9 ↔ 3.5 mm cable into the camera's <b>DIGITAL I/O</b> jack (the lowest of the three).</li>
          <li><b>Playback mode</b> — function switch to <b>再生</b> (PLAY).</li>
          <li><b>IrDA off</b> — MENU → 準備 (SETUP) → IrDA → <b>OFF</b>. With IrDA on, the jack is silent.</li>
        </ol>
        <div class="connect-row">
          ${state.manualPort
            ? `<input id="port-input" class="field grow" placeholder="/dev/cu.usbserial-…" value="${esc(state.port)}" spellcheck="false">`
            : `<select id="port-select" class="field grow">${opts || `<option value="">No serial ports found — plug in the adapter</option>`}</select>`}
          <button class="btn icon-btn" data-action="refresh-ports" title="Refresh ports">${icon.refresh()}</button>
          <button class="btn primary" data-action="connect" ${state.connecting || !state.port ? "disabled" : ""}>${state.connecting ? `<span class="spinner"></span> Connecting…` : "Connect"}</button>
        </div>
        <button class="linkish" data-action="toggle-manual">${state.manualPort ? "Choose from the list" : "Enter a port path by hand"}</button>
        ${state.connectError ? `<div class="callout error">${esc(state.connectError)}</div>` : ""}
        ${state.connectLog.length ? `<pre class="log">${esc(state.connectLog.join("\n"))}</pre>` : ""}
      </section>
    </div>`;
}

/** Camera photos with what the library knows about them. */
function cameraRows() {
  const c = state.cam.contents;
  if (!c) return [];
  return c.photos.map((p, i) => {
    const m = c.inLibrary[i];
    const inLib = !!m || state.cam.stored.has(p.path);
    return { p, match: m, inLib };
  });
}

/** Library items for camera photos that are already downloaded, in camera order. */
function cameraLibraryItems(): Item[] {
  const out: Item[] = [];
  for (const { match } of cameraRows()) {
    const d = match && state.discs.find((x) => x.path === match.discPath);
    const photo = d && d.albums.flatMap((a) => a.photos).find((x) => x.id === match!.photoId);
    if (d && photo) out.push({ key: itemKey(d, photo), disc: d, photo });
  }
  return out;
}

function renderCamera() {
  keepScroll(state.camera ? "camera" : "connect", drawCamera);
}

function drawCamera() {
  const cam = state.camera;
  if (!cam) return renderConnect();
  const imp = state.imp;
  const cs = state.cam;
  const rows = cameraRows();
  const fresh = rows.filter((r) => !r.inLib);
  const chosen = rows.filter((r) => cs.selection.has(r.p.id));
  const bytesOf = (list: typeof rows) => list.reduce((n, r) => n + r.p.size + (r.p.soundSize ?? 0), 0);
  const rate = imp?.rate || TYPICAL_RATE;

  const strip = camStrip(cam);

  let body: string;
  if (cs.browsing) {
    const pct = cs.total ? Math.min(100, (cs.done / cs.total) * 100) : 0;
    body = `<div class="browse-wait">
      <div class="muted">Reading the camera's thumbnails…</div>
      <div class="progress" id="browse-progress"><i style="width:${pct.toFixed(1)}%"></i></div>
      <div class="muted small" id="browse-meta">${cs.total ? `${fmtBytes(cs.done)} of ${fmtBytes(cs.total)}` : "Listing the disc"}</div>
    </div>`;
  } else if (cs.error) {
    body = `<div class="callout error">${esc(cs.error)}</div><button class="btn" data-action="browse">Try again</button>`;
  } else if (!cs.contents) {
    body = `<button class="btn primary" data-action="browse">${icon.photos(15)} Show photos on the camera</button>`;
  } else if (!rows.length) {
    body = `<div class="empty">There are no photos on this disc.</div>`;
  } else {
    body = `<div class="grid cam-grid">${rows.map((r) => camTile(r.p, r.inLib)).join("")}</div>`;
  }

  let bar = "";
  if (imp) {
    const pct = imp.total ? Math.min(100, (imp.done / imp.total) * 100) : 0;
    const eta = imp.rate > 0 ? (imp.total - imp.done) / imp.rate : 0;
    bar = `<div class="actionbar">
      <div class="ab-progress" id="imp-progress">${importProgressHtml(imp, pct, eta)}</div>
      ${imp.running ? `<button class="btn" data-action="cancel-import">Stop</button>` : `<button class="btn" data-action="import-done">OK</button>`}
    </div>`;
  } else if (cs.contents && rows.length) {
    const target = chosen.length ? chosen : fresh;
    bar = `<div class="actionbar">
      <div class="ab-text">
        ${chosen.length
          ? `<b>${plural(chosen.length, "photo")} selected</b>`
          : fresh.length ? `<b>${plural(fresh.length, "new photo")}</b> not in your library yet` : `<b>Everything on this disc is in your library.</b>`}
        ${target.length ? `<span class="muted"> · ${fmtBytes(bytesOf(target))} · about ${fmtDuration(bytesOf(target) / rate)}</span>` : ""}
        <div class="ab-links">
          ${fresh.length && fresh.length !== chosen.length ? `<button class="linkish" data-action="cam-select-new">Select new</button>` : ""}
          <button class="linkish" data-action="cam-select-all">Select all</button>
          ${chosen.length ? `<button class="linkish" data-action="cam-clear">Clear</button>` : ""}
          <button class="linkish" data-action="backup-disc" title="Copy every file on the disc, including index files, so the disc can be restored later">Back up the whole disc…</button>
        </div>
      </div>
      <button class="btn primary" data-action="download" ${target.length ? "" : "disabled"}>${icon.download(15)} ${chosen.length ? `Download ${plural(chosen.length, "photo")}` : fresh.length ? `Download ${fresh.length} new` : "Download"}</button>
    </div>`;
  }

  const head = cs.contents && rows.length
    ? `<h3 class="album-head">On the camera <span class="muted">${plural(rows.length, "photo")}${rows.length - fresh.length ? ` · ${rows.length - fresh.length} already in your library` : ""}</span>
         <button class="linkish refresh-link" data-action="browse-refresh" ${imp?.running ? "disabled" : ""}>${icon.refresh(12)} Refresh</button></h3>
       <p class="muted small cam-hint">Click to choose photos, shift-click for a range. Thumbnails are the camera's own (80 × 60); double-click one that's already in your library to open it.</p>`
    : "";

  $("#main").innerHTML = `
    <header class="toolbar" data-drag>
      <div class="tb-title">Camera <span class="tb-sub">DSC-MD1 · firmware ${esc(cam.connection.camera_id.trim().split(/\s+/).pop())}</span></div>
      <button class="btn" data-action="disconnect" ${imp?.running || cs.browsing ? "disabled" : ""}>Disconnect</button>
    </header>
    ${strip}
    <div class="page cam-page">${head}${body}</div>
    ${bar}`;
}

function camStrip(cam: CameraInfo) {
  const v = cam.volume;
  return `<div class="camstrip">
      <span title="Battery">${powerBar(cam.status.power)}${cam.status.power < 3 ? ` <span class="warn-text">low</span>` : ""}</span>
      <span><span class="muted">Mode</span> ${esc(cam.status.mode_name)}</span>
      <span><span class="muted">Clock</span> ${cam.status.clock_set ? esc(cam.status.clock) : "not set"}</span>
      ${v ? `<span><span class="muted">Disc</span> ${esc(v.label || "unlabelled")} · ${fmtBytes(v.free_bytes)} free</span>` : ""}
      <span class="spacer"></span>
      <span class="muted small">${esc(cam.connection.port.replace("/dev/", ""))} · ${cam.connection.baud.toLocaleString()} baud</span>
    </div>`;
}

function camTile(p: CameraPhoto, inLib: boolean) {
  const sel = state.cam.selection.has(p.id);
  return `<div class="tile cam-tile ${sel ? "selected" : ""} ${inLib ? "in-lib" : ""}" data-cam="${esc(p.id)}" data-cam-path="${esc(p.path)}" tabindex="0">
    ${p.thumb ? `<img src="${p.thumb}" alt="${esc(p.stem)}" draggable="false">` : `<div class="noimg">no thumbnail</div>`}
    <button class="tile-check" data-cam-select="${esc(p.id)}" title="Select">${icon.check(13)}</button>
    <span class="lib-badge" title="Already in your library">${icon.check(11)} In library</span>
    <div class="tile-badges">
      ${p.protected ? `<span class="badge plain" title="Protected on the camera">${icon.lock(11)}</span>` : ""}
      ${p.soundSeconds != null ? `<span class="badge sound" title="Has sound (${p.soundSeconds.toFixed(1)} s)">${icon.sound(12)}</span>` : ""}
      ${p.quality === "FINE" ? `<span class="badge">FINE</span>` : ""}
      ${!p.inIndex ? `<span class="badge warn" title="Not in the camera's album index">hidden</span>` : ""}
    </div>
    <div class="tile-num">${p.position + 1}</div>
  </div>`;
}

function importProgressHtml(imp: ImportState, pct: number, eta: number) {
  return `
    <div class="progress"><i style="width:${pct.toFixed(1)}%"></i></div>
    <div class="progress-meta">
      <span>${esc(imp.error ?? imp.label)}</span>
      <span>${imp.total ? `${fmtBytes(imp.done)} of ${fmtBytes(imp.total)}` : ""}${imp.running && imp.rate > 0 ? ` · ${fmtBytes(imp.rate)}/s · ${fmtSecs(eta)} left` : ""}</span>
    </div>`;
}

function updateImportProgress() {
  const imp = state.imp;
  const el = document.getElementById("imp-progress");
  if (!imp || !el) return;
  const pct = imp.total ? Math.min(100, (imp.done / imp.total) * 100) : 0;
  const eta = imp.rate > 0 ? (imp.total - imp.done) / imp.rate : 0;
  el.innerHTML = importProgressHtml(imp, pct, eta);
}

// ---------------------------------------------------------------- library grid

function tile(it: Item) {
  const p = it.photo;
  const selected = state.selection.has(it.key);
  return `<div class="tile ${selected ? "selected" : ""}" data-photo="${esc(it.key)}" tabindex="0">
    ${p.jpegPath
      ? hasLook(p.edits)
        ? `<img alt="${esc(p.stem)}" data-render="${esc(it.key)}" class="pending">`
        : `<img loading="lazy" src="${fileUrl(p.jpegPath)}" alt="${esc(p.stem)}" class="rot${p.edits.rotation ?? 0}">`
      : `<div class="noimg">no image</div>`}
    ${p.edits.favorite ? `<span class="tile-fav" title="Favourite">★</span>` : ""}
    <button class="tile-check" data-select="${esc(it.key)}" title="Select (shift-click for a range)">${icon.check(13)}</button>
    <div class="tile-badges">
      ${p.edits.caption ? `<span class="badge plain" title="${esc(p.edits.caption)}">“”</span>` : ""}
      ${p.edits.location ? `<span class="badge plain" title="${esc(p.edits.location.name || formatLatLon(p.edits.location))}">${icon.pin(12)}</span>` : ""}
      ${p.soundSeconds != null ? `<span class="badge sound" title="Has sound (${p.soundSeconds.toFixed(1)} s)">${icon.sound(12)}</span>` : ""}
      ${p.info.quality === "FINE" ? `<span class="badge">FINE</span>` : ""}
      ${!p.inIndex ? `<span class="badge warn" title="Not in the camera's album index">hidden</span>` : ""}
    </div>
    <div class="tile-num">${p.number + 1}</div>
  </div>`;
}

function renderGrid() {
  keepScroll(state.view.kind === "disc" ? `disc:${state.view.path}` : "library", drawGrid);
}

function drawGrid() {
  const d = currentDisc();
  const gs = groups().filter((g) => g.items.length);
  const sel = state.selection;
  const selItems = selectedItems();
  const scope = d ? discItems(d) : allItems();
  const count = (f: (p: Photo) => boolean) => scope.filter((it) => f(it.photo)).length;
  const subtitle = [
    plural(scope.length, "photo"),
    count((p) => p.soundSeconds != null) ? `${count((p) => p.soundSeconds != null)} with sound` : null,
    count((p) => p.info.quality === "FINE") ? `${count((p) => p.info.quality === "FINE")} fine` : null,
  ].filter(Boolean).join(" · ");
  const title = d
    ? state.renaming
      ? `<input id="rename" class="field rename" value="${esc(d.name)}">`
      : `<span class="disc-name" data-action="rename" title="Click to rename">${esc(d.name)}</span>`
    : `All photos`;

  const body = gs.length
    ? gs.map((g) => `${g.title ? `<h3 class="album-head">${esc(g.title)}${g.sub ? ` <span class="muted">${esc(g.sub)} · ${plural(g.items.length, "photo")}</span>` : ` <span class="muted">${plural(g.items.length, "photo")}</span>`}</h3>` : ""}<div class="grid">${g.items.map(tile).join("")}</div>`).join("")
    : scope.length
      ? `<div class="empty">No ${{ all: "photos", favorites: "favourites (press F in the viewer, or ★ in the selection bar)", sound: "photos with sound", fine: "fine-quality photos" }[state.filter]} here.</div>`
      : `<div class="empty">Your library is empty. Connect the camera to pick photos to download${state.discs.length ? "" : ", or add a backup folder made with md1tool"}.</div>`;

  $("#main").innerHTML = `
    <header class="toolbar" data-drag>
      <div class="tb-title">${title}<span class="tb-sub">${subtitle}</span></div>
      <div class="seg">
        ${(["all", "favorites", "sound", "fine"] as Filter[]).map((f) => `<button class="${state.filter === f ? "on" : ""}" data-filter="${f}">${{ all: "All", favorites: "★", sound: "Sound", fine: "Fine" }[f]}</button>`).join("")}
      </div>
      ${d ? `<button class="btn icon-btn" data-action="reveal-disc" title="Show in ${state.settings?.platform === "macos" ? "Finder" : "file manager"}">${icon.finder()}</button>` : ""}
      <button class="btn" data-action="export" ${scope.length ? "" : "disabled"}>${icon.export(15)} ${sel.size ? `Export ${sel.size}` : "Export all"}…</button>
    </header>
    ${sel.size ? `<div class="selbar">
      <span class="selcount">${plural(sel.size, "photo")} selected</span>
      <button class="btn small" data-action="sel-location">${icon.pin(14)} Location…</button>
      <button class="btn small" data-action="sel-date">${icon.calendar(14)} Date &amp; time…</button>
      <button class="btn small icon-btn" data-action="sel-rotate-left" title="Rotate left">${icon.rotateLeft(14)}</button>
      <button class="btn small icon-btn" data-action="sel-rotate-right" title="Rotate right">${icon.rotateRight(14)}</button>
      <button class="btn small" data-action="sel-favorite" title="Favourite (F)">★ ${selItems.length && selItems.every((it) => it.photo.edits.favorite) ? "Unfavourite" : "Favourite"}</button>
      <button class="btn small" data-action="sel-auto" title="Auto-enhance colour and brightness">✨ Auto-enhance</button>
      <span class="spacer"></span>
      <button class="linkish" data-action="select-all">Select all</button>
      <button class="linkish" data-action="clear-selection">Clear</button>
    </div>` : ""}
    <div class="page">
      ${d?.kind === "photos" ? `<div class="callout">This backup holds photo files only (it was made before full-disc copies), so it has no sound recordings or shot times.</div>` : ""}
      ${d?.missingPhotos ? `<div class="callout">${plural(d.missingPhotos, "photo")} on this disc ${d.missingPhotos === 1 ? "hasn't" : "haven't"} been downloaded. Put the disc in the camera and connect to pick them.</div>` : ""}
      ${body}
    </div>`;
  fillRenderedTiles();
  if (d && state.renaming) {
    const inp = $<HTMLInputElement>("#rename");
    inp.focus();
    inp.select();
    const finish = async (save: boolean) => {
      if (!state.renaming) return;
      state.renaming = false;
      if (save && inp.value.trim() && inp.value.trim() !== d.name) {
        await api.renameDisc(d.path, inp.value.trim());
        await refreshDiscs();
      }
      render();
    };
    inp.addEventListener("keydown", (e) => { if (e.key === "Enter") finish(true); if (e.key === "Escape") finish(false); });
    inp.addEventListener("blur", () => finish(true));
  }
}

/** Tiles of edited photos show a rendered preview (generated in the background, cached). */
function fillRenderedTiles() {
  document.querySelectorAll<HTMLImageElement>("img[data-render]").forEach((img) => {
    const it = itemByKey(img.dataset.render!);
    if (!it) return;
    renderedUrl(it.photo, 480).then((u) => { img.src = u; img.classList.remove("pending"); }, () => { img.src = fileUrl(it.photo.jpegPath!); });
  });
}

function selectedItems(): Item[] {
  return allItems().filter((it) => state.selection.has(it.key));
}

// ---------------------------------------------------------------- viewer

const viewer = {
  open: false,
  list: [] as Item[],
  index: 0,
  /** Where the list comes from (re-read after edits). */
  source: visibleItems as () => Item[],
  audio: null as HTMLAudioElement | null,
  raf: 0,
  stage: null as ZoomStage | null,
  editor: null as PhotoEditor | null,
};
/** Zoom/pan carried from photo to photo while the viewer is open. */
const zoom: ZoomShared = { z: 1, nx: 0, ny: 0 };
const playback = { auto: prefs.get("autoplay", false), loop: prefs.get("loop", false) };

const viewerItem = () => viewer.list[viewer.index];

function openViewer(key: string, source: () => Item[] = visibleItems) {
  viewer.source = source;
  viewer.list = source();
  viewer.index = Math.max(0, viewer.list.findIndex((it) => it.key === key));
  viewer.open = true;
  state.anchor = key;
  // Zoomed-in views start fresh; a smaller-than-fit size is kept from last time.
  Object.assign(zoom, { z: Math.min(1, prefs.get("viewerScale", 1)), nx: 0, ny: 0 });
  renderViewer(true);
}

function closeViewer() {
  if (viewer.editor) {
    viewer.editor.destroy();
    viewer.editor = null;
    $("#viewer").classList.remove("editing");
  }
  viewer.open = false;
  stopAudio();
  viewer.stage?.destroy();
  viewer.stage = null;
  $("#viewer").classList.remove("show");
  render();
}

function stopAudio() {
  if (viewer.audio) { viewer.audio.pause(); viewer.audio = null; }
  cancelAnimationFrame(viewer.raf);
}

function go(delta: number) {
  const i = viewer.index + delta;
  if (i < 0 || i >= viewer.list.length) return;
  viewer.index = i;
  state.anchor = viewer.list[i].key;
  renderViewer(true);
}

/** After an edit: refresh the photo list from the updated discs and redraw in place. */
function viewerDiscsUpdated(discs: Disc[]) {
  applyDiscs(discs);
  const key = viewerItem()?.key;
  viewer.list = viewer.source();
  viewer.index = Math.max(0, viewer.list.findIndex((it) => it.key === key));
  renderViewer(false);
}

function fact(label: string, value: string) {
  return `<dt>${label}</dt><dd>${value}</dd>`;
}

function zoomLabel(z: number) {
  if (z <= 1) prefs.set("viewerScale", Math.round(z * 100) / 100);
  const b = document.getElementById("zoom-badge");
  if (!b) return;
  b.classList.toggle("show", Math.abs(z - 1) > 0.01);
  b.querySelector("span")!.textContent = `${Math.round(z * 100)}%`;
}

function renderViewer(navigated: boolean) {
  stopAudio();
  viewer.stage?.destroy();
  viewer.stage = null;
  const it = viewerItem();
  if (!it) return closeViewer();
  const { photo: p, disc: d } = it;
  const taken = effectiveTaken(p);
  const takenHtml = taken
    ? `${esc(taken)}${p.edits.taken ? ` <span class="tag">edited</span>` : ""}`
    : p.created
      ? `${esc(p.created.slice(11))} <span class="muted">(camera clock not set: time since it was switched on)</span>`
      : `<span class="muted">unknown</span>`;
  const loc = p.edits.location;
  const el = $("#viewer");
  el.innerHTML = `
    <div class="v-top" data-drag>
      <button class="v-btn" data-v="close" title="Close (Esc)">${icon.close(18)}</button>
      <div class="v-title" data-drag>${esc(d.name)} · ${esc(p.album)} · photo ${p.number + 1}</div>
      <button class="v-btn fav ${p.edits.favorite ? "on" : ""}" data-v="favorite" title="Favourite (F)">★</button>
      <button class="btn v-edit" data-v="edit" title="Adjust, crop and straighten (E)">${icon.edit(14)} Edit</button>
      <div class="v-count" data-drag>${viewer.index + 1} / ${viewer.list.length}</div>
    </div>
    <div class="v-body">
      <button class="v-nav left" data-v="prev" ${viewer.index === 0 ? "disabled" : ""}>${icon.left(26)}</button>
      <div class="v-stage" id="v-stage">
        ${p.jpegPath ? `<img id="v-img" ${hasLook(p.edits) ? "" : `src="${fileUrl(p.jpegPath)}"`} alt="" draggable="false">` : ""}
        <div class="zoom-badge" id="zoom-badge" title="Pinch or ⌘+ / ⌘− to zoom · drag to pan · double-click or 0 to fit"><span>100%</span><button data-v="zoom-reset" title="Fit (0)">Fit</button></div>
      </div>
      <button class="v-nav right" data-v="next" ${viewer.index >= viewer.list.length - 1 ? "disabled" : ""}>${icon.right(26)}</button>
      <aside class="v-info">
        <div class="v-section first">
          <div class="v-section-head">${icon.calendar(14)} Taken
            <button class="linkish" data-v="edit-date">${p.edits.taken ? "Change" : "Set"}</button></div>
          <div class="v-taken">${takenHtml}</div>
        </div>

        <div class="v-section">
          <textarea class="caption" id="v-caption" rows="2" placeholder="Add a caption…" spellcheck="true">${esc(p.edits.caption ?? "")}</textarea>
        </div>

        <div class="v-section">
          <div class="v-section-head">${icon.rotateRight(14)} Rotate
            <span class="v-rot">
              <button class="v-btn small" data-v="rotate-left" title="Rotate left ([)">${icon.rotateLeft(15)}</button>
              <button class="v-btn small" data-v="rotate-right" title="Rotate right (])">${icon.rotateRight(15)}</button>
            </span></div>
        </div>

        <dl class="facts">
          ${fact("Quality", p.info.quality === "FINE" ? "Fine" : p.info.quality === "STD" ? "Standard" : esc(p.info.quality))}
          ${fact("Shutter", p.info.shutter ? `${esc(p.info.shutter)} s` : "—")}
          ${fact("Flash", p.info.flash == null ? "—" : p.info.flash ? `${icon.flash(13)} fired` : "off")}
          ${fact("File", `${esc(p.stem)}.PMP · ${fmtBytes(p.fileBytes)}`)}
          ${p.importedAt ? fact("Imported", esc(new Date(p.importedAt).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }))) : ""}
          ${p.protected ? fact("Protected", "yes") : ""}
          ${!p.inIndex ? fact("Index", `<span class="warn-text">not in the album index — the camera won't show it</span>`) : ""}
        </dl>
        <div class="v-actions">
          <button class="btn" data-v="export">${icon.export(15)} Export…</button>
          <button class="btn" data-v="reveal">${icon.finder(15)} Show file</button>
        </div>

        <div class="v-bottom">
          <div class="v-section">
            <div class="v-section-head">${icon.pin(14)} Location
              <button class="linkish" data-v="edit-location">${loc ? "Change" : "Add"}</button></div>
            ${loc
              ? `<div class="map small-map" id="v-map"></div>
                 <div class="v-place" title="${esc(loc.name || "")}">${esc(loc.name || formatLatLon(loc))}</div>
                 <div class="small muted v-coords">${formatLatLon(loc)} · <a href="#" data-v="open-map">Google Maps ${icon.external(11)}</a></div>`
              : `<button class="map small-map map-empty" data-v="edit-location">${icon.pin(18)}<span>Add a location</span></button>
                 <div class="v-place muted">No location</div>
                 <div class="small muted v-coords">Search a place or paste coordinates</div>`}
          </div>

          <div class="v-section">
            <div class="v-section-head">${icon.sound(14)} Sound
              <span class="v-head-note">${p.soundSeconds != null ? `${p.soundSeconds.toFixed(1)} s` : ""}</span></div>
            <div class="player ${p.wavPath ? "" : "none"}">
              <button class="play" data-v="play" title="Play sound (Space)" ${p.wavPath ? "" : "disabled"}>${icon.play(22)}</button>
              <div class="wave">${p.wavPath ? `<canvas id="wave"></canvas>` : `<span class="muted small">No sound recorded with this photo</span>`}</div>
              <div class="ptime">${p.wavPath ? `<span id="ptime">0:00</span> / ${fmtSecs(p.soundSeconds ?? 0)}` : "&nbsp;"}</div>
            </div>
            <div class="toggles">
              <label class="switch"><input type="checkbox" data-pref="autoplay" ${playback.auto ? "checked" : ""}><i></i> Play sound automatically</label>
              <label class="switch"><input type="checkbox" data-pref="loop" ${playback.loop ? "checked" : ""}><i></i> ${icon.loop(13)} Loop sound</label>
            </div>
          </div>
        </div>
      </aside>
    </div>`;
  el.classList.add("show");
  const img = document.getElementById("v-img") as HTMLImageElement | null;
  if (img && p.jpegPath && hasLook(p.edits)) {
    // Edited: show the rendered photo (rotation already applied) once it's ready.
    renderedUrl(p).then((u) => {
      if (viewerItem()?.key !== it.key || !document.body.contains(img)) return;
      img.onload = () => {
        viewer.stage?.destroy();
        viewer.stage = new ZoomStage($("#v-stage"), img, img.naturalWidth, img.naturalHeight, 0, zoom, zoomLabel);
      };
      img.src = u;
    });
  } else if (img) {
    viewer.stage = new ZoomStage($("#v-stage"), img, p.info.width || 640, p.info.height || 480, p.edits.rotation ?? 0, zoom, zoomLabel);
  }
  const cap = document.getElementById("v-caption") as HTMLTextAreaElement | null;
  cap?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); cap.blur(); }
    if (e.key === "Escape") { e.stopPropagation(); cap.value = p.edits.caption ?? ""; cap.blur(); }
  });
  cap?.addEventListener("blur", async () => {
    const v = cap.value.trim();
    if (v === (p.edits.caption ?? "")) return;
    try {
      applyDiscs([await api.editPhotos(d.path, [{ photoId: p.id, setCaption: v }])]);
      viewer.list = viewer.source();
      viewer.index = Math.max(0, viewer.list.findIndex((x) => x.key === it.key));
    } catch (e) {
      toast(`Couldn't save the caption: ${e}`, undefined, "error");
    }
  });
  if (loc) renderMap($("#v-map"), loc.lat, loc.lon, 14);
  if (p.wavPath) {
    drawWave(p.wavPath);
    if (navigated && playback.auto) togglePlay();
  }
}

const waveCache = new Map<string, Float32Array>();
async function drawWave(path: string) {
  const canvas = document.getElementById("wave") as HTMLCanvasElement | null;
  if (!canvas) return;
  let peaks = waveCache.get(path);
  if (!peaks) {
    try {
      const bytes = await api.readDiscFile(path);
      const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      const ctx = new OfflineAudioContext(1, 1, 44100);
      const audio = await ctx.decodeAudioData(buf);
      const data = audio.getChannelData(0);
      const n = 160;
      peaks = new Float32Array(n);
      const step = Math.floor(data.length / n);
      for (let i = 0; i < n; i++) {
        let m = 0;
        for (let j = i * step; j < (i + 1) * step; j++) m = Math.max(m, Math.abs(data[j]));
        peaks[i] = m;
      }
      const max = Math.max(...peaks, 0.001);
      peaks = peaks.map((x) => x / max);
      waveCache.set(path, peaks);
    } catch {
      return;
    }
  }
  const c = document.getElementById("wave") as HTMLCanvasElement | null;
  if (c) paintWave(c, peaks, viewer.audio && viewer.audio.duration ? viewer.audio.currentTime / viewer.audio.duration : 0);
}

function paintWave(canvas: HTMLCanvasElement, peaks: Float32Array, progress: number) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const g = canvas.getContext("2d")!;
  g.scale(dpr, dpr);
  const bw = w / peaks.length;
  const css = getComputedStyle(document.documentElement);
  for (let i = 0; i < peaks.length; i++) {
    const bh = Math.max(2, peaks[i] * (h - 4));
    g.fillStyle = i / peaks.length < progress ? css.getPropertyValue("--accent") : "rgba(255,255,255,0.25)";
    g.fillRect(i * bw + 0.5, (h - bh) / 2, Math.max(1, bw - 1.5), bh);
  }
}

function togglePlay() {
  const p = viewerItem()?.photo;
  if (!p?.wavPath) return;
  const btn = document.querySelector<HTMLButtonElement>('[data-v="play"]');
  if (viewer.audio && !viewer.audio.paused) {
    viewer.audio.pause();
    if (btn) btn.innerHTML = icon.play(22);
    cancelAnimationFrame(viewer.raf);
    return;
  }
  if (!viewer.audio) {
    const a = new Audio(fileUrl(p.wavPath));
    a.loop = playback.loop;
    viewer.audio = a;
    a.addEventListener("ended", () => {
      if (btn) btn.innerHTML = icon.play(22);
      cancelAnimationFrame(viewer.raf);
      const c = document.getElementById("wave") as HTMLCanvasElement | null;
      const peaks = waveCache.get(p.wavPath!);
      if (c && peaks) paintWave(c, peaks, 0);
      const t = document.getElementById("ptime");
      if (t) t.textContent = "0:00";
      viewer.audio = null;
    });
  }
  viewer.audio.play().catch((e) => toast(`Could not play the sound: ${e}`, undefined, "error"));
  if (btn) btn.innerHTML = icon.pause(22);
  const tick = () => {
    const a = viewer.audio;
    if (!a) return;
    const c = document.getElementById("wave") as HTMLCanvasElement | null;
    const peaks = waveCache.get(p.wavPath!);
    if (c && peaks && a.duration) paintWave(c, peaks, a.currentTime / a.duration);
    const t = document.getElementById("ptime");
    if (t) t.textContent = fmtSecs(a.currentTime);
    viewer.raf = requestAnimationFrame(tick);
  };
  cancelAnimationFrame(viewer.raf);
  tick();
}

function openEditor() {
  const it = viewerItem();
  if (!it?.photo.jpegPath || viewer.editor) return;
  stopAudio();
  viewer.stage?.destroy();
  viewer.stage = null;
  $("#viewer").classList.add("editing");
  viewer.editor = new PhotoEditor({
    stage: $("#v-stage"),
    panel: $(".v-info"),
    disc: it.disc,
    photo: it.photo,
    done: (nd) => {
      viewer.editor = null;
      $("#viewer").classList.remove("editing");
      if (nd) viewerDiscsUpdated([nd]);
      else renderViewer(false);
    },
  });
}

async function edit(items: Item[], patch: Parameters<typeof saveEdits>[1], what: string) {
  try {
    const discs = await saveEdits(items, patch);
    applyDiscs(discs);
    return discs;
  } catch (e) {
    toast(`Couldn't ${what}: ${e}`, undefined, "error");
    return null;
  }
}

// ---------------------------------------------------------------- actions

async function refreshDiscs() {
  state.discs = await api.listDiscs();
}

async function refreshPorts() {
  state.ports = await api.listPorts();
  if (!state.port || (!state.manualPort && !state.ports.some((p) => p.path === state.port))) {
    const last = state.settings?.lastPort;
    state.port =
      (last && state.ports.some((p) => p.path === last) ? last : undefined) ??
      state.ports.find((p) => p.likely_adapter)?.path ??
      state.ports[0]?.path ??
      (state.manualPort ? state.port : "");
  }
}

function resetCamera() {
  state.camera = null;
  state.imp = null;
  Object.assign(state.cam, { contents: null, browsing: false, done: 0, total: 0, error: null, anchor: null });
  state.cam.selection.clear();
  state.cam.stored.clear();
}

async function connect() {
  if (!state.port) return;
  state.connecting = true;
  state.connectError = null;
  state.connectLog = [];
  render();
  try {
    const info = await api.connect(state.port);
    resetCamera();
    state.camera = info;
  } catch (e) {
    state.connectError = String(e);
  } finally {
    state.connecting = false;
    render();
  }
  if (state.camera) browse(false);
}

async function browse(refresh: boolean) {
  const cs = state.cam;
  Object.assign(cs, { browsing: true, done: 0, total: 0, error: null });
  render();
  try {
    cs.contents = await api.browseCamera(refresh);
    const ids = new Set(cs.contents.photos.map((p) => p.id));
    [...cs.selection].forEach((id) => { if (!ids.has(id)) cs.selection.delete(id); });
  } catch (e) {
    cs.error = `Couldn't read the photo list: ${e}`;
  } finally {
    cs.browsing = false;
    render();
  }
}

function onBrowseEvent(ev: BrowseEvent) {
  if (ev.kind !== "reading") return;
  Object.assign(state.cam, { done: ev.done, total: ev.total });
  const bar = document.querySelector<HTMLElement>("#browse-progress i");
  if (bar) bar.style.width = `${Math.min(100, (ev.done / Math.max(1, ev.total)) * 100).toFixed(1)}%`;
  const meta = document.getElementById("browse-meta");
  if (meta) meta.textContent = `${fmtBytes(ev.done)} of ${fmtBytes(ev.total)}`;
}

/** Copy photos into the library: `paths` of chosen photos, or null for a whole-disc backup. */
async function download(paths: string[] | null) {
  state.imp = { running: true, label: "Starting…", done: 0, total: 0, rate: 0, log: [], error: null, count: paths?.length ?? null };
  state.cam.stored.clear();
  render();
  try {
    const disc = await api.downloadPhotos(paths);
    applyDiscs([disc]);
    await refreshDiscs();
    state.cam.selection.clear();
    state.imp = null;
    toast(paths ? `Downloaded ${plural(paths.length, "photo")}.` : "The whole disc is backed up.", {
      label: "Show",
      run: () => { state.view = { kind: "library" }; state.selection.clear(); render(); },
    });
  } catch (e) {
    if (state.imp) state.imp.error = String(e);
    await refreshDiscs();
  } finally {
    if (state.imp) state.imp.running = false;
    try {
      if (state.cam.contents) state.cam.contents = await api.browseCamera(false);
    } catch { /* keep the old view */ }
    state.cam.stored.clear();
    try { state.camera = (await api.cameraStatus()) ?? state.camera; } catch { /* keep the old info */ }
    render();
  }
}

function onImportEvent(ev: ImportEvent) {
  const imp = state.imp;
  if (!imp) return;
  switch (ev.kind) {
    case "listing":
      imp.total = ev.bytes_to_copy;
      if (ev.to_copy === 0) imp.label = "Nothing new to copy.";
      break;
    case "file": {
      const name = ev.path.split("/").pop() ?? "";
      imp.label = name.startsWith("PSN") ? `Photo ${ev.index} of ${ev.count}: ${name}` : name.startsWith("NRA") ? `Sound: ${name}` : `Index: ${name}`;
      break;
    }
    case "progress":
      imp.done = ev.done_bytes;
      imp.rate = ev.rate;
      break;
    case "stored":
      if (/\/PSN\d+\.PMP$/.test(ev.path)) {
        state.cam.stored.add(ev.path);
        document.querySelector(`[data-cam-path="${CSS.escape(ev.path)}"]`)?.classList.add("in-lib", "just");
      }
      break;
    case "retry":
      imp.log.push(`Retrying ${ev.path}: ${ev.error}`);
      break;
    case "converting":
      imp.label = "Converting photos and sound…";
      imp.done = imp.total;
      break;
  }
  updateImportProgress();
}

async function exportItems(items: Item[]) {
  const choice = await openExportSheet(items.map((it) => it.photo));
  if (!choice) return;
  const dest = await open({ directory: true, title: "Export photos to…" });
  if (!dest || Array.isArray(dest)) return;
  toast(`Exporting ${plural(items.length, "photo")}…`);
  try {
    const r = await api.exportPhotos(items.map((it) => ({ discPath: it.disc.path, photoId: it.photo.id })), dest, choice);
    toast(
      r.written ? `Exported ${plural(r.written, "file")}${r.alreadyThere ? ` (${r.alreadyThere} already there)` : ""}.` : "Everything was already exported there.",
      { label: "Show", run: () => revealItemInDir(dest) },
    );
  } catch (e) {
    toast(`Export failed: ${e}`, undefined, "error");
  }
}

// ---------------------------------------------------------------- render + events

/** Which page is showing, so a redraw of the same page keeps its scroll position. */
let shownPage = "";

function keepScroll(page: string, draw: () => void) {
  const top = shownPage === page ? document.querySelector(".page")?.scrollTop ?? 0 : 0;
  draw();
  shownPage = page;
  const el = document.querySelector(".page");
  if (el && top) el.scrollTop = top;
}

function render() {
  renderSidebar();
  if (state.view.kind === "camera") return renderCamera();
  if (state.view.kind === "disc" && !currentDisc()) state.view = { kind: "library" };
  renderGrid();
}

/** Click, shift-click (range) and ⌘/Ctrl-click (toggle) selection over an ordered list of ids. */
function pick(set: Set<string>, ids: string[], anchor: string | null, id: string, e: MouseEvent, toggle: boolean): string {
  if (e.shiftKey) {
    const a = ids.indexOf(anchor ?? id);
    const b = ids.indexOf(id);
    const [lo, hi] = a < 0 ? [b, b] : [Math.min(a, b), Math.max(a, b)];
    ids.slice(lo, hi + 1).forEach((x) => set.add(x));
    document.getSelection()?.removeAllRanges();
    return anchor ?? id;
  }
  if (toggle) set.has(id) ? set.delete(id) : set.add(id);
  return id;
}

document.addEventListener("dblclick", (e) => {
  const t = (e.target as HTMLElement).closest<HTMLElement>("[data-cam]");
  if (!t || !t.classList.contains("in-lib")) return;
  const i = state.cam.contents?.photos.findIndex((p) => p.id === t.dataset.cam) ?? -1;
  const m = i >= 0 ? state.cam.contents!.inLibrary[i] : null;
  if (!m) return;
  state.cam.selection.delete(t.dataset.cam!);
  openViewer(`${m.discPath}::${m.photoId}`, cameraLibraryItems);
});

document.addEventListener("click", async (e) => {
  const t = e.target as HTMLElement;
  const el = t.closest<HTMLElement>("[data-action],[data-nav],[data-disc],[data-filter],[data-select],[data-photo],[data-cam],[data-v]");
  if (!el) return;
  const me = e as MouseEvent;

  if (el.dataset.v) {
    const it = viewerItem();
    switch (el.dataset.v) {
      case "close": closeViewer(); break;
      case "prev": go(-1); break;
      case "next": go(1); break;
      case "play": togglePlay(); break;
      case "zoom-reset": viewer.stage?.reset(); break;
      case "edit": openEditor(); break;
      case "favorite": {
        if (!it) break;
        const nd = await edit([it], () => ({ setFavorite: !it.photo.edits.favorite }), "save");
        if (nd) viewerDiscsUpdated(nd);
        break;
      }
      case "export": if (it) exportItems([it]); break;
      case "reveal": if (it) revealItemInDir(it.photo.jpegPath ?? it.photo.pmpPath); break;
      case "edit-location": if (it) openLocationEditor([it], viewerDiscsUpdated); break;
      case "edit-date": if (it) openDateEditor([it], viewerDiscsUpdated); break;
      case "open-map": e.preventDefault(); if (it?.photo.edits.location) openUrl(googleMapsUrl(it.photo.edits.location)); break;
      case "rotate-left":
      case "rotate-right": {
        if (!it) break;
        const nd = await edit([it], () => ({ rotateBy: el.dataset.v === "rotate-left" ? -90 : 90 }), "rotate");
        if (nd) viewerDiscsUpdated(nd);
        break;
      }
    }
    return;
  }
  if (el.dataset.nav) {
    state.view = el.dataset.nav === "camera" ? { kind: "camera" } : { kind: "library" };
    state.selection.clear();
    state.anchor = null;
    render();
    return;
  }
  if (el.dataset.disc) { state.view = { kind: "disc", path: el.dataset.disc }; state.selection.clear(); state.anchor = null; state.filter = "all"; render(); return; }
  if (el.dataset.filter) { state.filter = el.dataset.filter as Filter; render(); return; }

  // Camera tiles: clicking chooses photos to download.
  if (el.dataset.cam && !state.imp?.running) {
    const cs = state.cam;
    const ids = cs.contents?.photos.map((p) => p.id) ?? [];
    cs.anchor = pick(cs.selection, ids, cs.anchor, el.dataset.cam, me, true);
    renderCamera();
    return;
  }

  const pickKey = el.dataset.select ?? el.dataset.photo;
  if (pickKey) {
    e.stopPropagation();
    if (!me.shiftKey && !el.dataset.select && !me.metaKey && !me.ctrlKey && !state.selection.size) {
      openViewer(pickKey);
      return;
    }
    state.anchor = pick(state.selection, visibleItems().map((it) => it.key), state.anchor, pickKey, me, true);
    render();
    return;
  }

  const d = currentDisc();
  const scope = () => (d ? discItems(d) : allItems());
  switch (el.dataset.action) {
    case "connect": await connect(); break;
    case "disconnect":
      await api.disconnect();
      resetCamera();
      render();
      break;
    case "refresh-ports": await refreshPorts(); render(); break;
    case "toggle-manual": state.manualPort = !state.manualPort; if (!state.manualPort) await refreshPorts(); render(); break;
    case "browse": browse(false); break;
    case "browse-refresh": browse(true); break;
    case "cam-select-new": cameraRows().filter((r) => !r.inLib).forEach((r) => state.cam.selection.add(r.p.id)); renderCamera(); break;
    case "cam-select-all": cameraRows().forEach((r) => state.cam.selection.add(r.p.id)); renderCamera(); break;
    case "cam-clear": state.cam.selection.clear(); renderCamera(); break;
    case "download": {
      const rows = cameraRows();
      const chosen = rows.filter((r) => state.cam.selection.has(r.p.id));
      const list = (chosen.length ? chosen : rows.filter((r) => !r.inLib)).map((r) => r.p.path);
      if (list.length) await download(list);
      break;
    }
    case "backup-disc": await download(null); break;
    case "cancel-import": await api.cancelImport(); break;
    case "import-done": state.imp = null; render(); break;
    case "add-folder": {
      const dir = await open({ directory: true, title: "Choose a disc backup folder (contains disc/ or raw/)" });
      if (!dir || Array.isArray(dir)) break;
      try {
        const disc = await api.addDiscFolder(dir);
        await refreshDiscs();
        state.view = { kind: "disc", path: disc.path };
        render();
      } catch (err) {
        toast(String(err), undefined, "error");
      }
      break;
    }
    case "change-library": {
      const dir = await open({ directory: true, title: "Choose where downloaded photos are stored" });
      if (!dir || Array.isArray(dir)) break;
      await api.setLibraryDir(dir);
      state.settings = await api.settings();
      await refreshDiscs();
      render();
      break;
    }
    case "reveal-library": if (state.settings) revealItemInDir(state.settings.libraryDir); break;
    case "reveal-disc": if (d) revealItemInDir(d.path); break;
    case "rename": state.renaming = true; render(); break;
    case "export": exportItems(state.selection.size ? selectedItems() : scope()); break;
    case "clear-selection": state.selection.clear(); render(); break;
    case "sel-location": openLocationEditor(selectedItems(), (nd) => { applyDiscs(nd); render(); }); break;
    case "sel-date": openDateEditor(selectedItems(), (nd) => { applyDiscs(nd); render(); }); break;
    case "sel-favorite": {
      const chosen = selectedItems();
      const on = !chosen.every((it) => it.photo.edits.favorite);
      if (await edit(chosen, () => ({ setFavorite: on }), "save")) render();
      break;
    }
    case "sel-auto": {
      const n = state.selection.size;
      toast(`Auto-enhancing ${plural(n, "photo")}…`);
      if (await edit(selectedItems(), () => ({ autoEnhance: true }), "auto-enhance")) {
        render();
        toast(`Auto-enhanced ${plural(n, "photo")}. Open one and press Edit to fine-tune or turn it off.`);
      }
      break;
    }
    case "sel-rotate-left":
    case "sel-rotate-right": {
      const by = el.dataset.action === "sel-rotate-left" ? -90 : 90;
      if (await edit(selectedItems(), () => ({ rotateBy: by }), "rotate")) render();
      break;
    }
    case "select-all": visibleItems().forEach((it) => state.selection.add(it.key)); render(); break;
  }
});

document.addEventListener("change", (e) => {
  const t = e.target as HTMLInputElement;
  if (t.dataset.pref === "autoplay") {
    playback.auto = t.checked;
    prefs.set("autoplay", t.checked);
    if (t.checked && !viewer.audio) togglePlay();
  }
  if (t.dataset.pref === "loop") {
    playback.loop = t.checked;
    prefs.set("loop", t.checked);
    if (viewer.audio) viewer.audio.loop = t.checked;
  }
  if (t.id === "port-select") state.port = t.value;
});

document.addEventListener("input", (e) => {
  const t = e.target as HTMLInputElement;
  if (t.id === "port-input") {
    state.port = t.value.trim();
    const btn = document.querySelector<HTMLButtonElement>('[data-action="connect"]');
    if (btn) btn.disabled = !state.port || state.connecting;
  }
});

document.addEventListener("keydown", (e) => {
  if (document.querySelector(".modal-back")) return; // a sheet is open; it handles its own keys
  const typing = (e.target as HTMLElement).matches?.("input, textarea, select");
  if (!viewer.open) {
    if (typing) return;
    const target = e.target as HTMLElement;
    if (e.key === "Enter" && target.classList?.contains("tile") && target.dataset.photo) openViewer(target.dataset.photo);
    if (state.view.kind === "camera") {
      if (e.key === "Escape" && state.cam.selection.size) { state.cam.selection.clear(); renderCamera(); }
      if ((e.metaKey || e.ctrlKey) && e.key === "a" && state.cam.contents) {
        e.preventDefault();
        state.cam.contents.photos.forEach((p) => state.cam.selection.add(p.id));
        renderCamera();
      }
      return;
    }
    if (e.key === "Escape" && state.selection.size) { state.selection.clear(); render(); }
    if ((e.metaKey || e.ctrlKey) && e.key === "a") {
      e.preventDefault();
      visibleItems().forEach((it) => state.selection.add(it.key));
      render();
    }
    return;
  }
  if (viewer.editor) {
    if (typing) return;
    if (e.key === "Escape") viewer.editor.cancel();
    else if (e.key === "Enter") viewer.editor.save();
    return;
  }
  if (typing) return;
  const z = viewer.stage;
  if (e.key === "Escape") closeViewer();
  else if (e.key === "ArrowLeft") go(-1);
  else if (e.key === "ArrowRight") go(1);
  else if (e.key === " ") { e.preventDefault(); togglePlay(); }
  else if (e.key === "+" || e.key === "=") { e.preventDefault(); z?.zoomBy(1.25); }
  else if (e.key === "-") { e.preventDefault(); z?.zoomBy(0.8); }
  else if (e.key === "0") { e.preventDefault(); z?.reset(); }
  else if (e.key === "e" || e.key === "E") { e.preventDefault(); openEditor(); }
  else if (e.key === "f" || e.key === "F") document.querySelector<HTMLButtonElement>('[data-v="favorite"]')?.click();
  else if (e.key === "[" || e.key === "]") document.querySelector<HTMLButtonElement>(`[data-v="${e.key === "[" ? "rotate-left" : "rotate-right"}"]`)?.click();
});

// Window dragging: the toolbar, the sidebar's top strip and the viewer's top bar move the
// window (the title bar is hidden on macOS); double-click zooms it like a title bar.
document.addEventListener("mousedown", (e) => {
  if (e.button !== 0) return;
  const t = e.target as HTMLElement;
  if (!t.closest("[data-drag]") || t.closest("button, input, select, textarea, a, label, .seg, .disc-name")) return;
  e.preventDefault();
  const w = getCurrentWindow();
  if (e.detail === 2) w.toggleMaximize();
  else w.startDragging();
});

// Keep the camera awake and the status fresh; notice when it is switched off.
setInterval(async () => {
  if (!state.camera || state.imp?.running || state.cam.browsing) return;
  try {
    const info = await api.cameraStatus();
    state.camera = info;
    if (!info) resetCamera();
    renderSidebar();
    const strip = document.querySelector(".camstrip");
    if (strip && info) strip.outerHTML = camStrip(info);
    else if (!info && state.view.kind === "camera") render();
  } catch (e) {
    if (String(e) === "busy") return;
    resetCamera();
    toast(String(e), undefined, "error");
    render();
  }
}, 15000);

async function init() {
  document.documentElement.classList.add(`os-${navigator.userAgent.includes("Mac") ? "macos" : "other"}`);
  await listen<string>("connect-log", (e) => {
    state.connectLog.push(e.payload);
    const log = document.querySelector(".log");
    if (log) log.textContent = state.connectLog.join("\n");
    else if (state.view.kind === "camera") renderCamera();
  });
  await listen<ImportEvent>("import-event", (e) => onImportEvent(e.payload));
  await listen<BrowseEvent>("browse-event", (e) => onBrowseEvent(e.payload));
  state.settings = await api.settings();
  await Promise.all([refreshDiscs(), refreshPorts()]);
  state.view = state.discs.length ? { kind: "library" } : { kind: "camera" };
  render();
  if (await invoke<boolean>("diag_enabled")) runDiag();
}

async function runDiag() {
  const out: string[] = [];
  const say = (s: string) => out.push(s);
  const p = allItems().map((it) => it.photo).find((x) => x.jpegPath);
  if (!p) return invoke("diag_report", { text: "no photo" });
  try {
    const r: any = await invoke("read_disc_file", { path: p.jpegPath });
    say(`read_disc_file -> ${Object.prototype.toString.call(r)} len=${r?.byteLength ?? r?.length}`);
    const bm = await createImageBitmap(new Blob([r instanceof ArrayBuffer ? r : new Uint8Array(r)], { type: "image/jpeg" }));
    say(`bitmap ${bm.width}x${bm.height}`);
  } catch (e) { say(`read/decode error ${e}`); }
  try {
    const r: any = await invoke("map_tile", { z: 2, x: 1, y: 1 });
    say(`map_tile -> ${Object.prototype.toString.call(r)} len=${r?.byteLength ?? r?.length}`);
  } catch (e) { say(`map_tile error ${e}`); }
  try {
    const f = await fetch(fileUrl(p.jpegPath!));
    say(`fetch asset -> ${f.status} ${(await f.arrayBuffer()).byteLength}`);
  } catch (e) { say(`fetch asset error ${e}`); }
  const port = await invoke<string | null>("diag_port");
  if (port) {
    try {
      await api.connect(port);
      const c = await api.browseCamera(true);
      say(`browse -> ${c.photos.length} photos, ${c.inLibrary.filter(Boolean).length} in library, thumbs ${c.photos.filter((x) => x.thumb?.startsWith("data:image/jpeg")).length}`);
      const img = new Image();
      await new Promise((ok, bad) => { img.onload = ok; img.onerror = bad; img.src = c.photos[0].thumb!; });
      say(`thumb decodes ${img.naturalWidth}x${img.naturalHeight}`);
      await api.disconnect();
    } catch (e) { say(`browse error ${e}`); }
  }
  await invoke("diag_report", { text: out.join(" | ") });
}

init().catch((e) => {
  document.body.innerHTML = `<pre style="padding:24px">MD1 Studio failed to start:\n${esc(e)}</pre>`;
});
