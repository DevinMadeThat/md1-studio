import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { api, fileUrl, type CameraInfo, type Disc, type ImportEvent, type Photo, type PortInfo, type Settings } from "./api";
import { effectiveTaken, googleMapsUrl, openDateEditor, openLocationEditor } from "./editors";
import { formatLatLon } from "./geo";
import { icon } from "./icons";
import { renderMap } from "./map";
import { esc, prefs, toast } from "./ui";
import { ZoomStage, type ZoomShared } from "./zoom";

// ---------------------------------------------------------------- state

type View = { kind: "camera" } | { kind: "disc"; path: string };
type Filter = "all" | "sound" | "fine";

interface ImportState {
  running: boolean;
  label: string;
  file: string;
  fileIndex: number;
  fileCount: number;
  done: number;
  total: number;
  rate: number;
  log: string[];
  error: string | null;
  result: Disc | null;
}

const state = {
  settings: null as Settings | null,
  discs: [] as Disc[],
  view: { kind: "camera" } as View,
  ports: [] as PortInfo[],
  port: "",
  manualPort: false,
  camera: null as CameraInfo | null,
  connecting: false,
  connectLog: [] as string[],
  connectError: null as string | null,
  importMode: "update" as "update" | "new",
  importName: "",
  imp: null as ImportState | null,
  filter: "all" as Filter,
  selection: new Set<string>(),
  /** Last photo clicked: the start of a shift-click range. */
  anchor: null as string | null,
  renaming: false,
};

/** Replace a disc after an edit, keeping the user's place. */
function updateDisc(d: Disc) {
  state.discs = state.discs.map((x) => (x.path === d.path ? d : x));
}

const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector<T>(sel)!;
const fmtBytes = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n >= 1e3 ? `${Math.round(n / 1e3)} KB` : `${n} B`;
const fmtSecs = (s: number) => {
  s = Math.max(0, Math.round(s));
  return s >= 60 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}` : `0:${String(s).padStart(2, "0")}`;
};
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

const currentDisc = () => (state.view.kind === "disc" ? state.discs.find((d) => d.path === (state.view as any).path) : undefined);

function visiblePhotos(d: Disc): Photo[] {
  const all = d.albums.flatMap((a) => a.photos);
  if (state.filter === "sound") return all.filter((p) => p.soundSeconds != null);
  if (state.filter === "fine") return all.filter((p) => p.info.quality === "FINE");
  return all;
}

// ---------------------------------------------------------------- sidebar

function renderSidebar() {
  const cam = state.camera;
  const camLine = cam
    ? `${esc(cam.status.pictures)} photos · ${cam.connection.baud === 115200 ? "fast link" : `${cam.connection.baud} baud`}`
    : state.connecting ? "Connecting…" : "Not connected";
  const discs = state.discs
    .map((d) => {
      const active = state.view.kind === "disc" && state.view.path === d.path;
      return `<button class="nav-item ${active ? "active" : ""}" data-disc="${esc(d.path)}" title="${esc(d.path)}">
        <span class="nav-icon">${icon.disc()}</span>
        <span class="nav-text"><span class="nav-title">${esc(d.name)}</span>
        <span class="nav-sub">${plural(d.photoCount, "photo")}${d.soundCount ? ` · ${d.soundCount} with sound` : ""}</span></span>
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
    ${discs || `<div class="nav-empty">No discs yet</div>`}
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

function renderCamera() {
  const cam = state.camera;
  const main = $("#main");
  if (!cam) {
    const opts = state.ports
      .map((p) => `<option value="${esc(p.path)}" ${p.path === state.port ? "selected" : ""}>${esc(p.path.replace("/dev/", ""))}${p.description ? ` — ${esc(p.description)}` : ""}${p.likely_adapter ? " ★" : ""}</option>`)
      .join("");
    main.innerHTML = `
      <header class="toolbar" data-drag><div class="tb-title">Camera</div></header>
      <div class="page">
        <section class="hero">
          <div class="hero-art">${icon.camera(44)}</div>
          <h1>Connect your DSC-MD1</h1>
          <p class="lede">Copy every photo and its recorded sound off the MiniDisc, byte for byte. Nothing on the disc is changed.</p>
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
    return;
  }

  const v = cam.volume;
  const match = cam.matchingDisc ? state.discs.find((d) => d.path === cam.matchingDisc) : undefined;
  const usedPct = v && v.total_bytes ? Math.round(((v.total_bytes - v.free_bytes) / v.total_bytes) * 100) : 0;
  const imp = state.imp;
  if (!state.importName) state.importName = match?.name ?? `Disc ${state.discs.length + 1}`;
  const statusCard = `
    <section class="card">
      <div class="card-head">${icon.camera(18)}<h2>Camera</h2><span class="pill ok">Connected</span></div>
      <dl class="facts">
        <dt>Model</dt><dd>DSC-MD1 · firmware ${esc(cam.connection.camera_id.trim().split(/\s+/).pop())} <span class="muted small">(${esc(cam.connection.camera_id.replace(/\s+/g, " ").trim())})</span></dd>
        <dt>Port</dt><dd>${esc(cam.connection.port.replace("/dev/", ""))} · ${cam.connection.baud.toLocaleString()} baud</dd>
        <dt>Mode</dt><dd>${esc(cam.status.mode_name)}</dd>
        <dt>Power</dt><dd>${powerBar(cam.status.power)} ${cam.status.power < 3 ? `<span class="warn-text">low</span>` : ""}</dd>
        <dt>Clock</dt><dd>${cam.status.clock_set ? esc(cam.status.clock) : `<span class="muted">not set</span>`}</dd>
      </dl>
      <div class="card-actions"><button class="btn" data-action="disconnect" ${imp?.running ? "disabled" : ""}>Disconnect</button></div>
    </section>`;
  const discCard = `
    <section class="card">
      <div class="card-head">${icon.disc(18)}<h2>Disc in the camera</h2></div>
      <dl class="facts">
        <dt>Photos</dt><dd>${cam.status.pictures} in the current album</dd>
        ${v ? `<dt>Label</dt><dd>${esc(v.label || "—")}</dd>
        <dt>Formatted</dt><dd>${v.created.year > 1980 ? `${v.created.year}-${String(v.created.month).padStart(2, "0")}-${String(v.created.day).padStart(2, "0")}` : `<span class="muted">unknown (clock not set)</span>`}</dd>
        <dt>Space</dt><dd><span class="meter"><i style="width:${usedPct}%"></i></span> ${fmtBytes(v.free_bytes)} free of ${fmtBytes(v.total_bytes)}</dd>` : ""}
      </dl>
    </section>`;

  let importCard: string;
  if (imp?.running || imp?.error || imp?.result) {
    const pct = imp.total ? Math.min(100, (imp.done / imp.total) * 100) : 0;
    const eta = imp.rate > 0 ? (imp.total - imp.done) / imp.rate : 0;
    importCard = `
      <section class="card wide">
        <div class="card-head">${icon.export(18)}<h2>${imp.running ? "Importing…" : imp.error ? "Import stopped" : "Import complete"}</h2></div>
        <div id="imp-progress">${importProgressHtml(imp, pct, eta)}</div>
        ${imp.error ? `<div class="callout error">${esc(imp.error)}</div>` : ""}
        <div class="card-actions">
          ${imp.running ? `<button class="btn" data-action="cancel-import">Cancel</button>` : ""}
          ${imp.result ? `<button class="btn primary" data-open-disc="${esc(imp.result.path)}">Open “${esc(imp.result.name)}”</button>` : ""}
          ${!imp.running ? `<button class="btn" data-action="import-again">${imp.error ? "Try again" : "Done"}</button>` : ""}
        </div>
      </section>`;
  } else {
    importCard = `
      <section class="card wide">
        <div class="card-head">${icon.export(18)}<h2>Import this disc</h2></div>
        <p class="muted small">Copies every file on the disc into your library (photos, sound, thumbnails and the disc's index files, so it can be restored later). Photos already imported are skipped. At 115,200 baud a photo takes about 10 seconds.</p>
        ${match ? `
          <div class="choice">
            <label><input type="radio" name="imode" value="update" ${state.importMode === "update" ? "checked" : ""}> Update <b>${esc(match.name)}</b> <span class="muted">— this disc was imported before</span></label>
            <label><input type="radio" name="imode" value="new" ${state.importMode === "new" ? "checked" : ""}> Import as a new disc</label>
          </div>` : ""}
        <div class="connect-row">
          <input id="import-name" class="field grow" value="${esc(state.importName)}" placeholder="Disc name" ${match && state.importMode === "update" ? "disabled" : ""}>
          <button class="btn primary" data-action="import">${icon.export(15)} Import</button>
        </div>
      </section>`;
  }

  main.innerHTML = `
    <header class="toolbar" data-drag><div class="tb-title">Camera</div></header>
    <div class="page"><div class="cards">${statusCard}${discCard}${importCard}</div></div>`;
}

function importProgressHtml(imp: ImportState, pct: number, eta: number) {
  return `
    <div class="progress"><i style="width:${pct.toFixed(1)}%"></i></div>
    <div class="progress-meta">
      <span>${esc(imp.label)}</span>
      <span>${imp.total ? `${fmtBytes(imp.done)} of ${fmtBytes(imp.total)}` : ""}${imp.running && imp.rate > 0 ? ` · ${fmtBytes(imp.rate)}/s · ${fmtSecs(eta)} left` : ""}</span>
    </div>
    ${imp.log.length ? `<pre class="log small">${esc(imp.log.slice(-6).join("\n"))}</pre>` : ""}`;
}

function updateImportProgress() {
  const imp = state.imp;
  const el = document.getElementById("imp-progress");
  if (!imp || !el) return;
  const pct = imp.total ? Math.min(100, (imp.done / imp.total) * 100) : 0;
  const eta = imp.rate > 0 ? (imp.total - imp.done) / imp.rate : 0;
  el.innerHTML = importProgressHtml(imp, pct, eta);
}

// ---------------------------------------------------------------- disc view

function renderDisc(d: Disc) {
  const photos = visiblePhotos(d);
  const albums = d.albums.length > 1;
  const sel = state.selection;
  const tiles = (list: Photo[]) =>
    list
      .map((p) => {
        const selected = sel.has(p.id);
        return `<div class="tile ${selected ? "selected" : ""}" data-photo="${esc(p.id)}" tabindex="0">
          ${p.jpegPath ? `<img loading="lazy" src="${fileUrl(p.jpegPath)}" alt="${esc(p.stem)}" class="rot${p.edits.rotation ?? 0}">` : `<div class="noimg">no image</div>`}
          <button class="tile-check" data-select="${esc(p.id)}" title="Select (shift-click for a range)">${icon.check(13)}</button>
          <div class="tile-badges">
            ${p.edits.location ? `<span class="badge plain" title="${esc(p.edits.location.name || formatLatLon(p.edits.location))}">${icon.pin(12)}</span>` : ""}
            ${p.soundSeconds != null ? `<span class="badge sound" title="Has sound (${p.soundSeconds.toFixed(1)} s)">${icon.sound(12)}</span>` : ""}
            ${p.info.quality === "FINE" ? `<span class="badge">FINE</span>` : ""}
            ${!p.inIndex ? `<span class="badge warn" title="Not in the camera's album index">hidden</span>` : ""}
          </div>
          <div class="tile-num">${p.number + 1}</div>
        </div>`;
      })
      .join("");
  const body = albums
    ? d.albums
        .map((a) => {
          const list = a.photos.filter((p) => photos.includes(p));
          return list.length ? `<h3 class="album-head">${esc(a.name)} <span class="muted">${plural(list.length, "photo")}</span></h3><div class="grid">${tiles(list)}</div>` : "";
        })
        .join("")
    : `<div class="grid">${tiles(photos)}</div>`;

  const subtitle = [
    plural(d.photoCount, "photo"),
    d.soundCount ? `${d.soundCount} with sound` : null,
    d.fineCount ? `${d.fineCount} fine` : null,
  ].filter(Boolean).join(" · ");

  $("#main").innerHTML = `
    <header class="toolbar" data-drag>
      <div class="tb-title">
        ${state.renaming
          ? `<input id="rename" class="field rename" value="${esc(d.name)}">`
          : `<span class="disc-name" data-action="rename" title="Click to rename">${esc(d.name)}</span>`}
        <span class="tb-sub">${subtitle}</span>
      </div>
      <div class="seg">
        ${(["all", "sound", "fine"] as Filter[]).map((f) => `<button class="${state.filter === f ? "on" : ""}" data-filter="${f}">${{ all: "All", sound: "Sound", fine: "Fine" }[f]}</button>`).join("")}
      </div>
      <button class="btn icon-btn" data-action="reveal-disc" title="Show in ${state.settings?.platform === "macos" ? "Finder" : "file manager"}">${icon.finder()}</button>
      <button class="btn" data-action="export">${icon.export(15)} ${sel.size ? `Export ${sel.size}` : "Export all"}…</button>
    </header>
    ${sel.size ? `<div class="selbar">
      <span class="selcount">${plural(sel.size, "photo")} selected</span>
      <button class="btn small" data-action="sel-location">${icon.pin(14)} Location…</button>
      <button class="btn small" data-action="sel-date">${icon.calendar(14)} Date &amp; time…</button>
      <button class="btn small icon-btn" data-action="sel-rotate-left" title="Rotate left">${icon.rotateLeft(14)}</button>
      <button class="btn small icon-btn" data-action="sel-rotate-right" title="Rotate right">${icon.rotateRight(14)}</button>
      <span class="spacer"></span>
      <button class="linkish" data-action="select-all">Select all</button>
      <button class="linkish" data-action="clear-selection">Clear</button>
    </div>` : ""}
    <div class="page">
      ${d.kind === "photos" ? `<div class="callout">This backup holds photo files only (it was made before full-disc copies). Put this disc back in the camera and import it to add its sound recordings, thumbnails and shot times.</div>` : ""}
      ${photos.length ? body : `<div class="empty">No ${state.filter === "sound" ? "photos with sound" : state.filter === "fine" ? "fine-quality photos" : "photos"} on this disc.</div>`}
    </div>`;
  if (state.renaming) {
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

// ---------------------------------------------------------------- viewer

const viewer = {
  open: false,
  list: [] as Photo[],
  index: 0,
  disc: null as Disc | null,
  audio: null as HTMLAudioElement | null,
  raf: 0,
  stage: null as ZoomStage | null,
};
/** Zoom/pan carried from photo to photo while the viewer is open. */
const zoom: ZoomShared = { z: 1, nx: 0, ny: 0 };
const playback = { auto: prefs.get("autoplay", false), loop: prefs.get("loop", false) };

function openViewer(d: Disc, id: string) {
  viewer.disc = d;
  viewer.list = visiblePhotos(d);
  viewer.index = Math.max(0, viewer.list.findIndex((p) => p.id === id));
  viewer.open = true;
  state.anchor = id;
  // Zoomed-in views start fresh; a smaller-than-fit size is kept from last time.
  Object.assign(zoom, { z: Math.min(1, prefs.get("viewerScale", 1)), nx: 0, ny: 0 });
  renderViewer(true);
}

function closeViewer() {
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
  state.anchor = viewer.list[i].id;
  renderViewer(true);
}

/** After an edit: refresh the photo list from the updated disc and redraw in place. */
function viewerDiscUpdated(d: Disc) {
  updateDisc(d);
  const id = viewer.list[viewer.index]?.id;
  viewer.disc = d;
  viewer.list = visiblePhotos(d);
  viewer.index = Math.max(0, viewer.list.findIndex((p) => p.id === id));
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
  const p = viewer.list[viewer.index];
  const d = viewer.disc!;
  if (!p) return closeViewer();
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
      <div class="v-count" data-drag>${viewer.index + 1} / ${viewer.list.length}</div>
    </div>
    <div class="v-body">
      <button class="v-nav left" data-v="prev" ${viewer.index === 0 ? "disabled" : ""}>${icon.left(26)}</button>
      <div class="v-stage" id="v-stage">
        ${p.jpegPath ? `<img id="v-img" src="${fileUrl(p.jpegPath)}" alt="" draggable="false">` : ""}
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
  const img = document.getElementById("v-img");
  if (img) {
    viewer.stage = new ZoomStage($("#v-stage"), img, p.info.width || 640, p.info.height || 480, p.edits.rotation ?? 0, zoom, zoomLabel);
  }
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
      const buf = await (await fetch(fileUrl(path))).arrayBuffer();
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
  const p = viewer.list[viewer.index];
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

async function rotate(d: Disc, ids: string[], by: number) {
  try {
    return await api.editPhotos(d.path, ids.map((photoId) => ({ photoId, rotateBy: by })));
  } catch (e) {
    toast(`Couldn't rotate: ${e}`, undefined, "error");
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

async function connect() {
  if (!state.port) return;
  state.connecting = true;
  state.connectError = null;
  state.connectLog = [];
  render();
  try {
    state.camera = await api.connect(state.port);
    state.importName = "";
    state.imp = null;
    state.importMode = "update";
  } catch (e) {
    state.connectError = String(e);
  } finally {
    state.connecting = false;
    render();
  }
}

async function runImport() {
  const cam = state.camera;
  if (!cam) return;
  const into = cam.matchingDisc && state.importMode === "update" ? cam.matchingDisc : null;
  const nameInput = document.getElementById("import-name") as HTMLInputElement | null;
  const name = into ? state.discs.find((d) => d.path === into)?.name ?? "" : (nameInput?.value.trim() || `Disc ${state.discs.length + 1}`);
  state.imp = { running: true, label: "Reading the disc's folders…", file: "", fileIndex: 0, fileCount: 0, done: 0, total: 0, rate: 0, log: [], error: null, result: null };
  render();
  try {
    const disc = await api.importDisc(name, into);
    state.imp.result = disc;
    state.imp.label = "All files copied and converted.";
    await refreshDiscs();
  } catch (e) {
    state.imp.error = String(e);
  } finally {
    state.imp.running = false;
    try { state.camera = (await api.cameraStatus()) ?? null; } catch { /* keep the old info */ }
    render();
  }
}

function onImportEvent(ev: ImportEvent) {
  const imp = state.imp;
  if (!imp) return;
  switch (ev.kind) {
    case "listing":
      imp.total = ev.bytes_to_copy;
      imp.log.push(`${plural(ev.files, "file")} on the disc (${fmtBytes(ev.bytes)}); ${ev.to_copy} to copy, ${ev.files - ev.to_copy} already in the library.`);
      break;
    case "file":
      imp.fileIndex = ev.index;
      imp.fileCount = ev.count;
      imp.file = ev.path;
      imp.label = `File ${ev.index} of ${ev.count}: ${ev.path.split("/").pop()}`;
      break;
    case "progress":
      imp.done = ev.done_bytes;
      imp.rate = ev.rate;
      break;
    case "retry":
      imp.log.push(`Retrying ${ev.path}: ${ev.error}`);
      break;
    case "converting":
      imp.label = "Converting photos and sound…";
      imp.done = imp.total;
      break;
    case "done":
      imp.log.push(`Copied ${ev.copied}, skipped ${ev.skipped}${ev.failed.length ? `, failed: ${ev.failed.join(", ")}` : ""}.`);
      break;
  }
  updateImportProgress();
}

async function exportPhotos(d: Disc, ids: string[]) {
  const dest = await open({ directory: true, title: "Export photos and sound to…" });
  if (!dest || Array.isArray(dest)) return;
  try {
    const r = await api.exportPhotos(ids.map((photoId) => ({ discPath: d.path, photoId })), dest, true);
    toast(
      r.written ? `Exported ${plural(r.written, "file")}${r.alreadyThere ? ` (${r.alreadyThere} already there)` : ""}.` : "Everything was already exported there.",
      { label: "Show", run: () => revealItemInDir(dest) },
    );
  } catch (e) {
    toast(`Export failed: ${e}`, undefined, "error");
  }
}

// ---------------------------------------------------------------- render + events

function render() {
  renderSidebar();
  const d = currentDisc();
  if (state.view.kind === "disc" && d) renderDisc(d);
  else {
    state.view = { kind: "camera" };
    renderCamera();
  }
}

document.addEventListener("click", async (e) => {
  const t = e.target as HTMLElement;
  const el = t.closest<HTMLElement>("[data-action],[data-nav],[data-disc],[data-filter],[data-select],[data-photo],[data-open-disc],[data-v]");
  if (!el) return;
  const d = currentDisc();

  if (el.dataset.v) {
    const p = viewer.list[viewer.index];
    const vd = viewer.disc;
    switch (el.dataset.v) {
      case "close": closeViewer(); break;
      case "prev": go(-1); break;
      case "next": go(1); break;
      case "play": togglePlay(); break;
      case "zoom-reset": viewer.stage?.reset(); break;
      case "export": if (vd && p) exportPhotos(vd, [p.id]); break;
      case "reveal": if (p) revealItemInDir(p.jpegPath ?? p.pmpPath); break;
      case "edit-location": if (vd && p) openLocationEditor(vd, [p], viewerDiscUpdated); break;
      case "edit-date": if (vd && p) openDateEditor(vd, [p], viewerDiscUpdated); break;
      case "open-map": e.preventDefault(); if (p?.edits.location) openUrl(googleMapsUrl(p.edits.location)); break;
      case "rotate-left":
      case "rotate-right": {
        if (!vd || !p) break;
        const nd = await rotate(vd, [p.id], el.dataset.v === "rotate-left" ? -90 : 90);
        if (nd) viewerDiscUpdated(nd);
        break;
      }
    }
    return;
  }
  if (el.dataset.nav === "camera") { state.view = { kind: "camera" }; state.selection.clear(); render(); return; }
  if (el.dataset.disc) { state.view = { kind: "disc", path: el.dataset.disc }; state.selection.clear(); state.anchor = null; state.filter = "all"; render(); return; }
  if (el.dataset.openDisc) { state.view = { kind: "disc", path: el.dataset.openDisc }; render(); return; }
  if (el.dataset.filter) { state.filter = el.dataset.filter as Filter; render(); return; }
  const me = e as MouseEvent;
  const pickId = el.dataset.select ?? el.dataset.photo;
  if (pickId && d) {
    e.stopPropagation();
    const list = visiblePhotos(d).map((p) => p.id);
    if (me.shiftKey) {
      // Range from the last photo clicked (or opened) to this one, added to the selection.
      const a = list.indexOf(state.anchor ?? pickId);
      const b = list.indexOf(pickId);
      const [lo, hi] = a < 0 ? [b, b] : [Math.min(a, b), Math.max(a, b)];
      list.slice(lo, hi + 1).forEach((id) => state.selection.add(id));
      document.getSelection()?.removeAllRanges();
    } else if (el.dataset.select || me.metaKey || me.ctrlKey || state.selection.size) {
      state.selection.has(pickId) ? state.selection.delete(pickId) : state.selection.add(pickId);
      state.anchor = pickId;
    } else {
      openViewer(d, pickId);
      return;
    }
    state.anchor = me.shiftKey ? state.anchor ?? pickId : pickId;
    render();
    return;
  }

  switch (el.dataset.action) {
    case "connect": await connect(); break;
    case "disconnect":
      await api.disconnect();
      state.camera = null;
      state.imp = null;
      render();
      break;
    case "refresh-ports": await refreshPorts(); render(); break;
    case "toggle-manual": state.manualPort = !state.manualPort; if (!state.manualPort) await refreshPorts(); render(); break;
    case "import": await runImport(); break;
    case "cancel-import": await api.cancelImport(); break;
    case "import-again": state.imp = null; state.importName = ""; render(); break;
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
      const dir = await open({ directory: true, title: "Choose where imported discs are stored" });
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
    case "export": if (d) exportPhotos(d, state.selection.size ? [...state.selection] : d.albums.flatMap((a) => a.photos.map((p) => p.id))); break;
    case "clear-selection": state.selection.clear(); render(); break;
    case "sel-location": if (d) openLocationEditor(d, selectedPhotos(d), (nd) => { updateDisc(nd); render(); }); break;
    case "sel-date": if (d) openDateEditor(d, selectedPhotos(d), (nd) => { updateDisc(nd); render(); }); break;
    case "sel-rotate-left":
    case "sel-rotate-right": {
      if (!d) break;
      const nd = await rotate(d, [...state.selection], el.dataset.action === "sel-rotate-left" ? -90 : 90);
      if (nd) { updateDisc(nd); render(); }
      break;
    }
    case "select-all": if (d) { visiblePhotos(d).forEach((p) => state.selection.add(p.id)); render(); } break;
  }
});

function selectedPhotos(d: Disc): Photo[] {
  return d.albums.flatMap((a) => a.photos).filter((p) => state.selection.has(p.id));
}

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
  if (t.name === "imode") { state.importMode = t.value as "update" | "new"; render(); }
});

document.addEventListener("input", (e) => {
  const t = e.target as HTMLInputElement;
  if (t.id === "port-input") {
    state.port = t.value.trim();
    const btn = document.querySelector<HTMLButtonElement>('[data-action="connect"]');
    if (btn) btn.disabled = !state.port || state.connecting;
  }
  if (t.id === "import-name") state.importName = t.value;
});

document.addEventListener("keydown", (e) => {
  if (document.querySelector(".modal-back")) return; // a sheet is open; it handles its own keys
  const typing = (e.target as HTMLElement).matches?.("input, textarea, select");
  if (!viewer.open) {
    if (e.key === "Enter" && (e.target as HTMLElement).classList?.contains("tile")) {
      const d = currentDisc();
      const id = (e.target as HTMLElement).dataset.photo;
      if (d && id) openViewer(d, id);
    }
    if (e.key === "Escape" && state.selection.size) { state.selection.clear(); render(); }
    if ((e.metaKey || e.ctrlKey) && e.key === "a" && !typing && currentDisc()) {
      e.preventDefault();
      visiblePhotos(currentDisc()!).forEach((p) => state.selection.add(p.id));
      render();
    }
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
  if (!state.camera || state.imp?.running) return;
  try {
    const info = await api.cameraStatus();
    state.camera = info;
    if (state.view.kind === "camera" && !document.querySelector("input:focus")) render();
    else renderSidebar();
  } catch (e) {
    if (String(e) === "busy") return;
    state.camera = null;
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
    else renderCamera();
  });
  await listen<ImportEvent>("import-event", (e) => onImportEvent(e.payload));
  state.settings = await api.settings();
  await Promise.all([refreshDiscs(), refreshPorts()]);
  if (state.discs.length) state.view = { kind: "disc", path: state.discs[0].path };
  render();
}

init().catch((e) => {
  document.body.innerHTML = `<pre style="padding:24px">MD1 Studio failed to start:\n${esc(e)}</pre>`;
});
