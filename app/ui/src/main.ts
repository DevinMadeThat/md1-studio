import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  api, fileUrl, itemKey, localDate,
  type AddSource, type BrowseEvent, type CameraContents, type CameraInfo, type CameraPhoto, type Disc, type ImportEvent, type Item, type LibAlbum, type Photo, type PortInfo, type Settings, type WriteEvent,
} from "./api";
import { openContactSheet } from "./contactSheet";
import { startSlideshow } from "./slideshow";
import { effectiveTaken, googleMapsUrl, openDateEditor, openExportSheet, openLocationEditor, saveEdits } from "./editors";
import { formatLatLon } from "./geo";
import { icon } from "./icons";
import { hasLook, renderedUrl } from "./look";
import { renderMap } from "./map";
import { PhotoEditor } from "./photoEditor";
import { esc, openModal, prefs, toast } from "./ui";
import { ZoomStage, type ZoomShared } from "./zoom";

// ---------------------------------------------------------------- state

type View =
  | { kind: "camera" }
  | { kind: "library" }
  | { kind: "favorites" }
  | { kind: "import"; at: string }
  | { kind: "album"; id: string }
  | { kind: "disc"; path: string };
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
  albums: [] as LibAlbum[],
  /** Search text (captions, places, dates, file names). */
  query: "",
  showAllImports: false,
  discsOpen: prefs.get("discsOpen", false),
  /** A write to the camera in progress. */
  writing: null as WriteEvent | null,
  /** The user has seen the "writing to the disc" explanation this session. */
  writeOk: false,
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

/** Search: every word must appear in the photo's caption, place, dates, file or disc name. */
function matchesQuery(it: Item) {
  const words = state.query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const p = it.photo;
  const hay = [
    p.edits.caption, p.edits.location?.name, effectiveTaken(p), p.importedAt && localDate(p.importedAt),
    p.importedAt && longDay(p.importedAt), p.stem, it.disc.name, p.info.quality === "FINE" ? "fine" : "standard",
    p.soundSeconds != null ? "sound" : "", p.edits.favorite ? "favourite favorite" : "",
  ].filter(Boolean).join(" ").toLowerCase();
  return words.every((w) => hay.includes(w));
}

const longDay = (iso: string) => new Date(iso).toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" });
const shortDay = (iso: string) => {
  const day = localDate(iso);
  if (day === localDate()) return "Today";
  if (day === localDate(new Date(Date.now() - 864e5).toISOString())) return "Yesterday";
  return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
};
const clockTime = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

interface Session { at: string; items: Item[] }

/** Each import (photos copied in one go), newest first. */
function sessions(): Session[] {
  const by = new Map<string, Item[]>();
  for (const it of allItems()) {
    const at = it.photo.importedAt ?? "";
    by.set(at, [...(by.get(at) ?? []), it]);
  }
  return [...by.entries()].map(([at, items]) => ({ at, items })).sort((a, b) => b.at.localeCompare(a.at));
}

const sessionTitle = (at: string) => (at ? `${shortDay(at)}, ${clockTime(at)}` : "Earlier");

interface Group { title: string; sub: string; items: Item[] }

/** What the grid shows, in display order. */
function groups(): Group[] {
  const keep = (it: Item) => passes(it.photo) && matchesQuery(it);
  const v = state.view;
  if (v.kind === "disc") {
    const d = currentDisc();
    if (!d) return [];
    return d.albums.map((a) => ({
      title: d.albums.length > 1 ? a.name : "",
      sub: "",
      items: a.photos.map((photo) => ({ key: itemKey(d, photo), disc: d, photo })).filter(keep),
    }));
  }
  if (v.kind === "album") {
    const al = state.albums.find((a) => a.id === v.id);
    const all = new Map(allItems().map((it) => [it.key, it]));
    return [{ title: "", sub: "", items: (al?.items ?? []).map((k) => all.get(k)).filter((x): x is Item => !!x).filter(keep) }];
  }
  if (v.kind === "import") {
    return [{ title: "", sub: "", items: allItems().filter((it) => (it.photo.importedAt ?? "") === v.at).filter(keep) }];
  }
  const fav = v.kind === "favorites";
  return sessions().map((s) => ({
    title: s.at ? `Imported ${longDay(s.at)}, ${clockTime(s.at)}` : "Imported earlier",
    sub: [...new Set(s.items.map((it) => it.disc.name))].join(", "),
    items: s.items.filter((it) => keep(it) && (!fav || it.photo.edits.favorite)),
  }));
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
  const v = state.view;
  const all = allItems();
  const nav = (active: boolean, attrs: string, iconHtml: string, title: string, sub: string, cls = "") =>
    `<button class="nav-item ${cls} ${active ? "active" : ""}" ${attrs}>
      <span class="nav-icon">${iconHtml}</span>
      <span class="nav-text"><span class="nav-title">${esc(title)}</span>${sub ? `<span class="nav-sub">${esc(sub)}</span>` : ""}</span>
    </button>`;
  const ss = sessions();
  const shown = state.showAllImports ? ss : ss.slice(0, 6);
  const imports = shown
    .map((x) => nav(v.kind === "import" && v.at === x.at, `data-import="${esc(x.at)}"`, icon.download(15), x.at ? shortDay(x.at) : "Earlier",
      `${plural(x.items.length, "photo")}${x.at ? ` · ${clockTime(x.at)}` : ""}`, "small-item"))
    .join("");
  const thumbOf = (key: string | null | undefined) => {
    const it = key ? all.find((x) => x.key === key) : undefined;
    return it?.photo.jpegPath ? `<img class="nav-thumb" src="${fileUrl(it.photo.thumbPath ?? it.photo.jpegPath)}" alt="">` : icon.photos(15);
  };
  const albums = state.albums
    .map((a) => nav(v.kind === "album" && v.id === a.id, `data-album="${esc(a.id)}"`, thumbOf(a.cover ?? a.items[0]), a.name, plural(a.items.length, "photo"), "small-item"))
    .join("");
  const discs = state.discs
    .map((d) => nav(v.kind === "disc" && v.path === d.path, `data-disc="${esc(d.path)}" title="${esc(d.path)}"`, icon.disc(15), d.name,
      [plural(d.photoCount, "photo"), d.missingPhotos ? `${d.missingPhotos} not downloaded` : ""].filter(Boolean).join(" · "), "small-item"))
    .join("");
  $("#sidebar").innerHTML = `
    <div class="sidebar-top" data-drag></div>
    <div class="nav-section">Camera</div>
    <button class="nav-item ${v.kind === "camera" ? "active" : ""}" data-nav="camera">
      <span class="nav-icon">${icon.camera()}</span>
      <span class="nav-text"><span class="nav-title">DSC-MD1</span><span class="nav-sub">${camLine}</span></span>
      <span class="dot ${cam ? "on" : state.connecting ? "busy" : ""}"></span>
    </button>
    <div class="nav-section">Library</div>
    ${nav(v.kind === "library", `data-nav="library"`, icon.photos(), "All photos", plural(all.length, "photo"))}
    ${nav(v.kind === "favorites", `data-nav="favorites"`, `<span class="nav-star">★</span>`, "Favourites", plural(all.filter((it) => it.photo.edits.favorite).length, "photo"))}
    ${ss.length ? `<div class="nav-section">Imports</div>${imports}${ss.length > 6 ? `<button class="nav-add" data-action="toggle-imports">${state.showAllImports ? "Show fewer" : `Show all ${ss.length}`}</button>` : ""}` : ""}
    <div class="nav-section">Albums <button class="nav-section-btn" data-action="new-album" title="New album">${icon.plus(13)}</button></div>
    ${albums || `<div class="nav-empty">Select photos, then “Add to album”.</div>`}
    <button class="nav-section nav-toggle" data-action="toggle-discs">${state.discsOpen ? "▾" : "▸"} MiniDiscs <span class="muted">${state.discs.length}</span></button>
    ${state.discsOpen ? `${discs}<button class="nav-add" data-action="add-folder">${icon.plus(14)} Add backup folder…</button>` : ""}
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
  const w = state.writing;
  if (w) {
    bar = `<div class="actionbar">
      <div class="ab-progress">
        <div class="progress"><i style="width:${w.count ? ((w.index - 1) / w.count) * 100 : 3}%"></i></div>
        <div class="progress-meta"><span id="write-label">${esc(w.label)}</span><span>${w.count ? `${w.index} of ${w.count} files` : ""}</span></div>
      </div>
    </div>`;
  } else if (imp) {
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
      ${chosen.length ? `<div class="ab-cam">
        <span class="muted small">On the camera:</span>
        <button class="btn small icon-btn" data-action="cam-rotate-left" title="Rotate left on the camera">${icon.rotateLeft(14)}</button>
        <button class="btn small icon-btn" data-action="cam-rotate-right" title="Rotate right on the camera">${icon.rotateRight(14)}</button>
        <button class="btn small" data-action="cam-protect" title="Protect (or unprotect) on the camera">${icon.lock(13)} ${chosen.every((r) => r.p.protected) ? "Unprotect" : "Protect"}</button>
      </div>` : ""}
      <button class="btn primary" data-action="download" ${target.length ? "" : "disabled"}>${icon.download(15)} ${chosen.length ? `Download ${plural(chosen.length, "photo")}` : fresh.length ? `Download ${fresh.length} new` : "Download"}</button>
    </div>`;
  }

  const head = cs.contents && rows.length
    ? `<h3 class="album-head">On the camera <span class="muted">${plural(rows.length, "photo")}${rows.length - fresh.length ? ` · ${rows.length - fresh.length} already in your library` : ""}</span>
         <button class="linkish refresh-link" data-action="browse-refresh" ${imp?.running || state.writing ? "disabled" : ""}>${icon.refresh(12)} Refresh</button>
         <button class="linkish refresh-link" data-action="cam-add-files" ${imp?.running || state.writing ? "disabled" : ""}>${icon.plus(12)} Add pictures to the camera…</button></h3>
       <p class="muted small cam-hint">Click to choose photos, shift-click for a range. Thumbnails are the camera's own (80 × 60); double-click one that's already in your library to open it.</p>`
    : "";

  $("#main").innerHTML = `
    <header class="toolbar" data-drag>
      <div class="tb-title">Camera <span class="tb-sub">DSC-MD1 · firmware ${esc(cam.connection.camera_id.trim().split(/\s+/).pop())}</span></div>
      <button class="btn" data-action="disconnect" ${imp?.running || cs.browsing || state.writing ? "disabled" : ""}>Disconnect</button>
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
    ${p.thumb ? `<img src="${p.thumb}" alt="${esc(p.stem)}" draggable="false" class="rot${p.rotation * 90}">` : `<div class="noimg">no thumbnail</div>`}
    <button class="tile-check" data-cam-select="${esc(p.id)}" title="Select">${icon.check(13)}</button>
    <span class="lib-badge" title="Already in your library">${icon.check(11)} In library</span>
    <div class="tile-badges">
      ${p.rotation ? `<span class="badge plain" title="Turned on the camera">${p.rotation === 3 ? `${icon.rotateLeft(11)} 90°` : `${icon.rotateRight(11)} ${p.rotation * 90}°`}</span>` : ""}
      ${p.protected ? `<span class="badge plain" title="Protected: the camera won't delete it (it shows no mark for this)">${icon.lock(11)}</span>` : ""}
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
  keepScroll(JSON.stringify(state.view), drawGrid);
}

/** The photos the current view covers (before filters and search). */
function scopeItems(): Item[] {
  const v = state.view;
  if (v.kind === "disc") { const d = currentDisc(); return d ? discItems(d) : []; }
  if (v.kind === "album") {
    const al = currentAlbum();
    const all = new Map(allItems().map((it) => [it.key, it]));
    return (al?.items ?? []).map((k) => all.get(k)).filter((x): x is Item => !!x);
  }
  if (v.kind === "import") return allItems().filter((it) => (it.photo.importedAt ?? "") === v.at);
  if (v.kind === "favorites") return allItems().filter((it) => it.photo.edits.favorite);
  return allItems();
}

const currentAlbum = () => (state.view.kind === "album" ? state.albums.find((a) => a.id === (state.view as any).id) : undefined);

function viewTitle(): string {
  const v = state.view;
  if (v.kind === "disc") return currentDisc()?.name ?? "";
  if (v.kind === "album") return currentAlbum()?.name ?? "";
  if (v.kind === "import") return v.at ? `Imported ${longDay(v.at)}, ${clockTime(v.at)}` : "Imported earlier";
  if (v.kind === "favorites") return "Favourites";
  return "All photos";
}

function drawGrid() {
  const d = currentDisc();
  const al = currentAlbum();
  const gs = groups().filter((g) => g.items.length);
  const sel = state.selection;
  const selItems = selectedItems();
  const scope = scopeItems();
  const shown = gs.flatMap((g) => g.items);
  const count = (f: (p: Photo) => boolean) => scope.filter((it) => f(it.photo)).length;
  const subtitle = [
    plural(scope.length, "photo"),
    count((p) => p.soundSeconds != null) ? `${count((p) => p.soundSeconds != null)} with sound` : null,
    count((p) => p.info.quality === "FINE") ? `${count((p) => p.info.quality === "FINE")} fine` : null,
  ].filter(Boolean).join(" · ");
  const renameable = !!(d || al);
  const title = renameable
    ? state.renaming
      ? `<input id="rename" class="field rename" value="${esc(viewTitle())}">`
      : `<span class="disc-name" data-action="rename" title="Click to rename">${esc(viewTitle())}</span>`
    : esc(viewTitle());

  const body = gs.length
    ? gs.map((g) => `${g.title ? `<h3 class="album-head">${esc(g.title)}${g.sub ? ` <span class="muted">${esc(g.sub)} · ${plural(g.items.length, "photo")}</span>` : ` <span class="muted">${plural(g.items.length, "photo")}</span>`}</h3>` : ""}<div class="grid">${g.items.map(tile).join("")}</div>`).join("")
    : scope.length
      ? `<div class="empty">${state.query ? `Nothing matches “${esc(state.query)}”.` : `No ${{ all: "photos", favorites: "favourites (press F in the viewer, or ★ in the selection bar)", sound: "photos with sound", fine: "fine-quality photos" }[state.filter]} here.`}</div>`
      : al
        ? `<div class="empty">This album is empty. Select photos anywhere in the library and choose “Add to album”.</div>`
        : state.view.kind === "favorites"
          ? `<div class="empty">No favourites yet. Press F in the viewer, or ★ in the selection bar.</div>`
          : `<div class="empty">Your library is empty. Connect the camera to pick photos to download${state.discs.length ? "" : ", or add a backup folder made with md1tool"}.</div>`;

  $("#main").innerHTML = `
    <header class="toolbar" data-drag>
      <div class="tb-title">${title}<span class="tb-sub">${subtitle}</span></div>
      <div class="search">${icon.search(13)}<input id="search" class="field" placeholder="Search" value="${esc(state.query)}" spellcheck="false"></div>
      <div class="seg">
        ${(["all", "favorites", "sound", "fine"] as Filter[]).map((f) => `<button class="${state.filter === f ? "on" : ""}" data-filter="${f}">${{ all: "All", favorites: "★", sound: "Sound", fine: "Fine" }[f]}</button>`).join("")}
      </div>
      ${d ? `<button class="btn icon-btn" data-action="reveal-disc" title="Show in ${state.settings?.platform === "macos" ? "Finder" : "file manager"}">${icon.finder()}</button>` : ""}
      ${al ? `<button class="btn icon-btn" data-action="delete-album" title="Delete this album (the photos stay in the library)">${icon.trash()}</button>` : ""}
      <button class="btn icon-btn" data-action="slideshow" title="Slideshow with sound" ${shown.length ? "" : "disabled"}>${icon.play(15)}</button>
      <button class="btn icon-btn" data-action="contact-sheet" title="Contact sheet (to print)" ${shown.length ? "" : "disabled"}>${icon.grid()}</button>
      <button class="btn" data-action="export" ${scope.length ? "" : "disabled"}>${icon.export(15)} ${sel.size ? `Export ${sel.size}` : "Export all"}…</button>
    </header>
    ${sel.size ? `<div class="selbar">
      <span class="selcount">${plural(sel.size, "photo")} selected</span>
      <button class="btn small" data-action="sel-location">${icon.pin(14)} Location…</button>
      <button class="btn small" data-action="sel-date">${icon.calendar(14)} Date &amp; time…</button>
      <button class="btn small icon-btn" data-action="sel-rotate-left" title="Rotate left">${icon.rotateLeft(14)}</button>
      <button class="btn small icon-btn" data-action="sel-rotate-right" title="Rotate right">${icon.rotateRight(14)}</button>
      <button class="btn small" data-action="sel-favorite" title="Favourite (F)">★ ${selItems.length && selItems.every((it) => it.photo.edits.favorite) ? "Unfavourite" : "Favourite"}</button>
      <button class="btn small" data-action="sel-auto" title="Auto-enhance colour and brightness">✨ Enhance</button>
      <button class="btn small" data-action="sel-album" title="Add to an album">${icon.photos(14)} Album…</button>
      ${al ? `<button class="btn small" data-action="sel-unalbum">Remove from album</button>` : ""}
      ${state.camera ? `<button class="btn small" data-action="sel-to-camera" title="Copy these photos onto the disc in the camera">${icon.camera(14)} To camera…</button>` : ""}
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
  if (renameable && state.renaming) {
    const inp = $<HTMLInputElement>("#rename");
    inp.focus();
    inp.select();
    const finish = async (save: boolean) => {
      if (!state.renaming) return;
      state.renaming = false;
      const name = inp.value.trim();
      if (save && name && name !== viewTitle()) {
        if (d) {
          await api.renameDisc(d.path, name);
          await refreshDiscs();
        } else if (al) {
          al.name = name;
          await saveAlbums();
        }
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
          <button class="btn icon-btn" data-v="copy" title="Copy the photo (⌘C)">${icon.copy(15)}</button>
          <button class="btn icon-btn" data-v="slideshow" title="Slideshow from here">${icon.play(15)}</button>
          ${state.camera ? `<button class="btn icon-btn" data-v="to-camera" title="Send to the camera">${icon.camera(15)}</button>` : ""}
          ${currentAlbum() ? `<button class="btn icon-btn" data-v="cover" title="Use as the album's cover">${icon.photos(15)}</button>` : ""}
          <button class="btn icon-btn" data-v="reveal" title="Show the file">${icon.finder(15)}</button>
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

// ---------------------------------------------------------------- albums

async function saveAlbums() {
  try {
    await api.saveAlbums(state.albums);
  } catch (e) {
    toast(`Couldn't save albums: ${e}`, undefined, "error");
  }
}

function newAlbumId() {
  return `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** Ask for an album (or a new one) and add `keys` to it. */
function addToAlbum(keys: string[]) {
  const m = openModal(
    `Add ${plural(keys.length, "photo")} to an album`,
    `${state.albums.length ? `<div class="loc-results">${state.albums.map((a) => `<button class="loc-item" data-al="${esc(a.id)}">${icon.photos(14)}<span>${esc(a.name)} <span class="muted">· ${plural(a.items.length, "photo")}</span></span></button>`).join("")}</div>` : ""}
     <label class="small muted">New album</label>
     <div class="connect-row"><input id="al-name" class="field grow" placeholder="e.g. Summer 1998"><button class="btn primary" id="al-new">Create &amp; add</button></div>`,
  );
  const add = async (al: LibAlbum) => {
    const have = new Set(al.items);
    keys.forEach((k) => { if (!have.has(k)) al.items.push(k); });
    al.cover ??= al.items[0] ?? null;
    await saveAlbums();
    m.close();
    toast(`Added to “${al.name}”.`, { label: "Open", run: () => { state.view = { kind: "album", id: al.id }; state.selection.clear(); render(); } });
    render();
  };
  m.el.querySelectorAll<HTMLButtonElement>("[data-al]").forEach((b) => b.addEventListener("click", () => add(state.albums.find((a) => a.id === b.dataset.al)!)));
  const create = () => {
    const name = m.el.querySelector<HTMLInputElement>("#al-name")!.value.trim();
    if (!name) return;
    const al: LibAlbum = { id: newAlbumId(), name, cover: null, items: [], created: new Date().toISOString() };
    state.albums.push(al);
    add(al);
  };
  m.el.querySelector("#al-new")!.addEventListener("click", create);
  m.el.querySelector<HTMLInputElement>("#al-name")!.addEventListener("keydown", (e) => { if (e.key === "Enter") create(); });
  m.el.querySelector<HTMLInputElement>("#al-name")!.focus();
}

// ---------------------------------------------------------------- writing to the camera

/** Explain once per session what writing to the disc means; resolves false if the user backs out. */
function confirmWrite(what: string, extra = ""): Promise<{ fine: boolean; fill: boolean } | null> {
  const cam = state.camera;
  const onBattery = !!cam && cam.status.power < 5;
  return new Promise((resolve) => {
    let result: { fine: boolean; fill: boolean } | null = null;
    const m = openModal(
      what,
      `<p class="small">This writes to the MiniDisc in the camera. Each file is read back afterwards to check it. <b>Switch the camera off and on</b> when it's done so it shows the changes.</p>
       ${onBattery ? `<div class="callout small">The camera is running on its battery (${cam!.status.power}/5). Sony recommends the AC adapter for writing: if the camera switches itself off mid-write, the album could be left half-updated.</div>` : ""}
       ${extra}
       <div class="modal-actions"><span class="spacer"></span><button class="btn" id="w-cancel">Cancel</button><button class="btn primary" id="w-go">Write to the disc</button></div>`,
      { onClose: () => resolve(result) },
    );
    m.el.querySelector("#w-cancel")!.addEventListener("click", m.close);
    m.el.querySelector("#w-go")!.addEventListener("click", () => {
      result = {
        fine: m.el.querySelector<HTMLInputElement>('input[name="w-q"][value="fine"]')?.checked ?? false,
        fill: m.el.querySelector<HTMLInputElement>('input[name="w-fit"][value="fill"]')?.checked ?? false,
      };
      if (m.el.querySelector("#w-q")) prefs.set("toCamera", result);
      m.close();
    });
  });
}

async function runCameraWrite(job: () => Promise<CameraContents>, done: string) {
  state.writing = { label: "Preparing…", index: 0, count: 0 };
  render();
  try {
    state.cam.contents = await job();
    toast(done);
  } catch (e) {
    toast(`Writing to the camera failed: ${e}`, undefined, "error");
    try { state.cam.contents = await api.browseCamera(true); } catch { /* keep the old view */ }
  } finally {
    state.writing = null;
    render();
  }
}

async function sendToCamera(sources: AddSource[]) {
  if (!state.camera || !sources.length) return;
  const last = prefs.get("toCamera", { fine: false, fill: false });
  const choice = await confirmWrite(
    `Copy ${plural(sources.length, "picture")} to the camera`,
    `<div id="w-q" class="choice"><label><input type="radio" name="w-q" value="std" ${last.fine ? "" : "checked"}> Standard quality <span class="muted">(about 60 KB each, like the camera's STD)</span></label>
       <label><input type="radio" name="w-q" value="fine" ${last.fine ? "checked" : ""}> Fine quality <span class="muted">(about 120 KB each)</span></label></div>
     <div class="choice"><label><input type="radio" name="w-fit" value="fit" ${last.fill ? "" : "checked"}> Fit the whole picture in 640 × 480 <span class="muted">(black bars if it's not 4:3)</span></label>
       <label><input type="radio" name="w-fit" value="fill" ${last.fill ? "checked" : ""}> Fill the frame <span class="muted">(crops the edges)</span></label></div>
     <div class="muted small">They're added at the end of the album. Library photos go with your edits applied.</div>`,
  );
  if (!choice) return;
  state.view = { kind: "camera" };
  await runCameraWrite(() => api.cameraAddPhotos(sources, choice.fine, choice.fill), `Copied ${plural(sources.length, "picture")} to the camera. Switch it off and on to see ${sources.length === 1 ? "it" : "them"}.`);
}

async function markOnCamera(change: { rotateBy?: number; protect?: boolean }) {
  const ids = [...state.cam.selection];
  if (!ids.length) return;
  if (!state.writeOk) {
    const ok = await confirmWrite(change.protect != null ? (change.protect ? "Protect photos on the camera" : "Unprotect photos on the camera") : "Rotate photos on the camera");
    if (!ok) return;
    state.writeOk = true;
  }
  const what = change.protect != null ? (change.protect ? "Protected" : "Unprotected") : "Rotated";
  await runCameraWrite(() => api.cameraMark(ids, change), `${what} ${plural(ids.length, "photo")} on the camera. Switch it off and on to see the change.`);
}

// ---------------------------------------------------------------- clipboard

/** Put the photo (with its edits) on the clipboard as a PNG. */
async function copyToClipboard(it: Item) {
  if (!it.photo.jpegPath) return;
  try {
    const png = (async () => {
      const img = new Image();
      img.src = await renderedUrl(it.photo);
      await img.decode();
      const c = document.createElement("canvas");
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      c.getContext("2d")!.drawImage(img, 0, 0);
      return new Promise<Blob>((ok, bad) => c.toBlob((b) => (b ? ok(b) : bad(new Error("no image"))), "image/png"));
    })();
    await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
    toast("Copied the photo. Paste it into any app.");
  } catch (e) {
    toast(`Couldn't copy: ${e}`, undefined, "error");
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
  const el = t.closest<HTMLElement>("[data-action],[data-nav],[data-disc],[data-import],[data-album],[data-filter],[data-select],[data-photo],[data-cam],[data-v]");
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
      case "copy": if (it) copyToClipboard(it); break;
      case "cover": {
        const al = currentAlbum();
        if (al && it) { al.cover = it.key; await saveAlbums(); toast(`“${al.name}” now uses this photo as its cover.`); renderSidebar(); }
        break;
      }
      case "to-camera": if (it) sendToCamera([{ discPath: it.disc.path, photoId: it.photo.id }]); break;
      case "slideshow": if (it) { const list = viewer.list; const i = viewer.index; closeViewer(); startSlideshow(list, i); } break;
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
  const goTo = (v: View) => {
    state.view = v;
    state.selection.clear();
    state.anchor = null;
    state.renaming = false;
    render();
  };
  if (el.dataset.nav) return goTo({ kind: el.dataset.nav as "camera" | "library" | "favorites" });
  if (el.dataset.disc) return goTo({ kind: "disc", path: el.dataset.disc });
  if (el.dataset.import !== undefined) return goTo({ kind: "import", at: el.dataset.import });
  if (el.dataset.album) return goTo({ kind: "album", id: el.dataset.album });
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
    case "export": exportItems(state.selection.size ? selectedItems() : visibleItems()); break;
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
    case "toggle-imports": state.showAllImports = !state.showAllImports; renderSidebar(); break;
    case "toggle-discs": state.discsOpen = !state.discsOpen; prefs.set("discsOpen", state.discsOpen); renderSidebar(); break;
    case "new-album": {
      const al: LibAlbum = { id: newAlbumId(), name: "Untitled album", cover: null, items: [], created: new Date().toISOString() };
      state.albums.push(al);
      await saveAlbums();
      state.view = { kind: "album", id: al.id };
      state.selection.clear();
      state.renaming = true;
      render();
      break;
    }
    case "delete-album": {
      const al = currentAlbum();
      if (!al) break;
      state.albums = state.albums.filter((a) => a.id !== al.id);
      await saveAlbums();
      state.view = { kind: "library" };
      render();
      toast(`Deleted the album “${al.name}”. Its photos are still in the library.`, {
        label: "Undo",
        run: async () => { state.albums.push(al); await saveAlbums(); state.view = { kind: "album", id: al.id }; render(); },
      });
      break;
    }
    case "sel-album": addToAlbum([...state.selection]); break;
    case "sel-unalbum": {
      const al = currentAlbum();
      if (!al) break;
      al.items = al.items.filter((k) => !state.selection.has(k));
      if (al.cover && !al.items.includes(al.cover)) al.cover = al.items[0] ?? null;
      state.selection.clear();
      await saveAlbums();
      render();
      break;
    }
    case "sel-to-camera": sendToCamera(selectedItems().map((it) => ({ discPath: it.disc.path, photoId: it.photo.id }))); break;
    case "slideshow": {
      const list = state.selection.size ? visibleItems().filter((it) => state.selection.has(it.key)) : visibleItems();
      startSlideshow(list, 0);
      break;
    }
    case "contact-sheet": {
      const list = state.selection.size ? visibleItems().filter((it) => state.selection.has(it.key)) : visibleItems();
      openContactSheet(list, viewTitle());
      break;
    }
    case "cam-rotate-left": markOnCamera({ rotateBy: -1 }); break;
    case "cam-rotate-right": markOnCamera({ rotateBy: 1 }); break;
    case "cam-protect": {
      const chosen = cameraRows().filter((r) => state.cam.selection.has(r.p.id));
      markOnCamera({ protect: !chosen.every((r) => r.p.protected) });
      break;
    }
    case "cam-add-files": {
      const files = await open({ multiple: true, title: "Pictures to copy to the camera", filters: [{ name: "Pictures", extensions: ["jpg", "jpeg", "png", "tif", "tiff", "bmp", "gif", "webp"] }] });
      if (!files) break;
      sendToCamera((Array.isArray(files) ? files : [files]).map((file) => ({ file })));
      break;
    }
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
  if (t.id === "search") {
    state.query = t.value;
    const pos = t.selectionStart;
    renderGrid();
    const again = document.getElementById("search") as HTMLInputElement | null;
    again?.focus();
    if (again && pos != null) again.setSelectionRange(pos, pos);
    return;
  }
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
  else if ((e.metaKey || e.ctrlKey) && e.key === "c") { e.preventDefault(); const it = viewerItem(); if (it) copyToClipboard(it); }
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
  await listen<WriteEvent>("write-event", (e) => {
    state.writing = e.payload;
    if (state.view.kind === "camera") renderCamera();
  });
  state.albums = (await api.getAlbums()).albums ?? [];
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
