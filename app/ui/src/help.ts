// Help: how-to topics, the English cheat sheets (cheatsheet/ in the repo, bundled at build time)
// and a search over both plus the translated camera menus, buttons and messages.
import cheat from "../../../cheatsheet/md1_cheatsheet_data.json";
import { icon } from "./icons";
import { esc } from "./ui";

const sheetUrls = {
  ...import.meta.glob("../../../cheatsheet/MD1-cheatsheet-*.png", { eager: true, query: "?url", import: "default" }),
  ...import.meta.glob("../../../cheatsheet/MD1-menu-map-*.png", { eager: true, query: "?url", import: "default" }),
} as Record<string, string>;

export interface Sheet { file: string; title: string; url: string }

const SHEET_TITLES: [RegExp, string][] = [
  [/cheatsheet-1/, "Quick how-to: shooting, playback, sound, fine mode"],
  [/cheatsheet-2.*part(\d)of(\d)/, "Buttons, switches and jacks ($1 of $2)"],
  [/cheatsheet-3/, "Camera (shooting) menu"],
  [/cheatsheet-4.*part(\d)of(\d)/, "Playback and audio menus ($1 of $2)"],
  [/cheatsheet-5.*part(\d)of(\d)/, "On-screen messages ($1 of $2)"],
  [/cheatsheet-6.*part(\d)of(\d)/, "Icons and common words ($1 of $2)"],
  [/menu-map-1/, "Menu map: camera"],
  [/menu-map-2/, "Menu map: playback"],
  [/menu-map-3/, "Menu map: audio"],
];

export const sheets: Sheet[] = Object.entries(sheetUrls)
  .map(([path, url]) => {
    const file = path.split("/").pop()!;
    const hit = SHEET_TITLES.find(([re]) => re.test(file));
    const m = hit && file.match(hit[0]);
    const title = hit && m ? hit[1].replace(/\$(\d)/g, (_, k) => m[+k] ?? "") : file;
    return { file, title, url };
  })
  .sort((a, b) => a.file.localeCompare(b.file));

export interface Topic { id: string; title: string; summary: string; keywords: string; body: string }

const menu = (path: string) => `<span class="menu-path">${path}</span>`;

export const topics: Topic[] = [
  {
    id: "connect",
    title: "Connect the camera",
    summary: "Cable, jack, playback mode, IrDA off.",
    keywords: "cable serial usb rs232 port jack digital i/o irda connect ftdi com ttyusb dialout not found no answer",
    body: `<ol>
      <li><b>Power</b>: the AC adapter or a charged battery (a session stalls if the camera switches itself off).</li>
      <li><b>Function switch</b> to <b>再生/オーディオ</b> (playback).</li>
      <li><b>Infrared off</b>: ${menu("MENU → 準備 (Setup) → IrDA → OFF")}. While IrDA is on, the cable jack is ignored.</li>
      <li>Optional: ${menu("準備 → パワーセーブ → OFF")} so the screen doesn't sleep.</li>
      <li>Plug the 3.5 mm plug into <b>DIGITAL I/O</b> (デジタルI/O): jog-dial side, under the rubber flap, the lowest of the three openings. Not the headphone jack on the other side.</li>
      <li>In the app: <b>Camera</b> → pick the port (the USB adapter is listed first, marked ★) → <b>Connect</b>.</li>
    </ol>
    <p>While connected the camera shows “PC” and ignores its own buttons.</p>
    <p class="muted">Ports: macOS <code>/dev/cu.usbserial-…</code>; Windows <code>COM3</code> etc. (Device Manager → Ports); Linux <code>/dev/ttyUSB0</code> (your user must be in the <code>dialout</code> or <code>uucp</code> group).</p>`,
  },
  {
    id: "download",
    title: "Download photos",
    summary: "See the camera's thumbnails, pick photos, or back up the whole disc.",
    keywords: "download import copy thumbnails new photos pick select back up backup whole disc mirror sound",
    body: `<p>On the <b>Camera</b> screen the app reads the camera's own thumbnails (about 4 KB a photo) and marks the photos already in your library <b>In library</b>.</p>
    <ul>
      <li><b>Download new</b> copies everything not in your library; or click photos (shift-click for a range) and <b>Download N photos</b>. Sound recorded with a photo comes with it.</li>
      <li><b>Back up the whole disc…</b> copies every file, including the index files, so the disc could be restored exactly.</li>
      <li>At 115,200 baud a photo takes about 10 seconds.</li>
      <li>Reading thumbnails takes a few seconds per photo the first time; the app remembers them, so the same disc shows instantly next time. To skip it, untick <b>Show the camera's photos automatically</b> and press <b>Show photos on the camera</b> when you want them.</li>
    </ul>`,
  },
  {
    id: "fine",
    title: "Take FINE photos (Free mode)",
    summary: "Diary mode allows standard quality only; switch the disc to Free mode.",
    keywords: "fine quality free mode diary album mode アルバムモード フリーモード ダイアリー 画質 standard std high quality",
    body: `<p>Each disc has an <b>album mode</b>. The camera's Camera screen shows the current one.</p>
    <ul>
      <li><b>Diary mode</b> (ダイアリーモード, the default after formatting): standard quality only; space is kept for about 40 minutes of sound.</li>
      <li><b>Free mode</b> (フリーモード): photos and sound share the disc freely; up to 1000 photos per album; <b>FINE</b> allowed.</li>
    </ul>
    <p>To switch, on the camera: ${menu("MENU → 準備 (Setup) → アルバムモード (Album mode) → フリーモード (Free mode) → 実行 (Execute)")}.</p>
    <p><b>It's one-way</b>: a disc can't go back to Diary mode except by formatting it. Then choose FINE in ${menu("MENU → カメラ → 画質モード (Picture quality) → FINE")}.</p>`,
  },
  {
    id: "clock",
    title: "Set the camera's clock",
    summary: "Only on the camera itself; the cable can't set it.",
    keywords: "clock date time 日時設定 set time battery backup 1980 1950 not set",
    body: `<p>On the camera: ${menu("MENU → 準備 (Setup) → 日時設定 (Date/time set)")}. Turn the jog dial to change each field and press it to go to the next; the clock starts after the minutes.</p>
    <p>No command over the cable sets the clock (several were tried; see the project's lab notebook).</p>
    <p>The camera's small rechargeable backup cell is often flat by now, so the time is lost whenever the main battery comes out. For photos taken without the clock, set dates in the library: select them → <b>Date &amp; time…</b> → <b>Keep the time between shots</b>.</p>`,
  },
  {
    id: "format",
    title: "Format a disc",
    summary: "Erases everything. What happens, step by step.",
    keywords: "format erase wipe new disc quick format フォーマット clear reset pc",
    body: `<p><b>Formatting erases every photo and sound on the disc.</b> Download what you want to keep first (or <b>Back up the whole disc…</b>).</p>
    <ol>
      <li>Camera screen → <b>Format disc…</b>, then confirm three times.</li>
      <li>The camera works silently for <b>about 50 seconds</b>. Keep it switched on.</li>
      <li>The app then disconnects. <b>The camera keeps showing “PC”</b>: that's expected.</li>
      <li><b>Switch the camera off and on.</b> It now has an empty disc in <b>Diary mode</b>.</li>
      <li>For FINE photos, switch the disc to Free mode (see “Take FINE photos”).</li>
      <li>Take one photo before sending pictures from the app: that creates the album the app adds to.</li>
    </ol>
    <p class="muted">The camera can also format from ${menu("MENU → 準備 (Setup) → フォーマット")} (about 50 seconds).</p>`,
  },
  {
    id: "send",
    title: "Send pictures to the camera",
    summary: "Any picture or library photo, fitted to 640 × 480.",
    keywords: "send upload copy to camera add pictures jpeg png tiff fit fill quality write",
    body: `<ul>
      <li>From the library: select photos → <b>To camera…</b> (your edits are applied). From files: Camera screen → <b>Add pictures to the camera…</b> (JPEG, PNG, TIFF, BMP, GIF, WebP).</li>
      <li>Choose <b>standard</b> or <b>fine</b> quality, and <b>fit</b> (black bars if the shape isn't 4:3) or <b>fill</b> (crops the edges).</li>
      <li>They're added at the end of the album. <b>Switch the camera off and on</b> to see them.</li>
      <li>Every file written is read back to check it. Use the AC adapter if you can: if the camera switches off mid-write, the album could be left half-updated.</li>
      <li>A freshly formatted disc has no album until the camera takes its first photo.</li>
    </ul>`,
  },
  {
    id: "camera-edit",
    title: "Rotate, protect or delete on the camera",
    summary: "Changes the camera's own album.",
    keywords: "rotate protect lock delete erase remove camera album key",
    body: `<p>On the Camera screen, select photos, then use the <b>On the camera</b> buttons. Switch the camera off and on to see the change.</p>
    <ul>
      <li><b>Rotate</b>: the camera shows the photo turned. Photos turned on the camera arrive turned in the library too.</li>
      <li><b>Protect</b>: the camera refuses to delete or rotate the photo. It shows <b>no mark</b> for this; its delete menu shows a red message instead.</li>
      <li><b>Delete</b>: removes the photo and its sound from the disc. The app warns you (and asks you to type DELETE) if a photo isn't in your library. Protected photos are left alone.</li>
    </ul>`,
  },
  {
    id: "sound",
    title: "Sound with photos",
    summary: "Photos can carry about 6 seconds of sound.",
    keywords: "sound audio voice record narration 音声 ナレーション wav play loop autoplay",
    body: `<p>The camera can record a few seconds of sound with each shot (see the quick how-to cheat sheet). The app downloads and decodes it: photos with sound have a blue speaker badge; the viewer plays it (Space), with optional auto-play and loop. Export can save a .wav next to each photo.</p>`,
  },
  {
    id: "library",
    title: "Library, imports and albums",
    summary: "All photos, Imports by date, Albums, search, slideshow.",
    keywords: "library imports albums collection cover search find slideshow contact sheet print favourite delete trash",
    body: `<ul>
      <li><b>All photos</b> shows everything, newest import first; <b>Imports</b> lists each download by date and time.</li>
      <li><b>Albums</b>: select photos → <b>Album…</b>. In an album, the viewer can set its cover.</li>
      <li><b>Search</b> finds captions, places, dates (e.g. “1998-07”), file names.</li>
      <li><b>Slideshow</b> (▶): each photo stays up while its sound plays. <b>Contact sheet</b> (grid button): printable pages.</li>
      <li><b>Delete</b> (⌫) moves photos to the Trash; nothing on the camera changes.</li>
      <li>Each MiniDisc's files live in its own folder (listed under <b>MiniDiscs</b>), named after the day it was first imported.</li>
    </ul>`,
  },
  {
    id: "keys",
    title: "Keyboard shortcuts",
    summary: "Viewer and grid keys.",
    keywords: "keyboard shortcuts keys hotkeys",
    body: `<table class="keys">
      <tr><td>← →</td><td>Previous / next photo</td></tr><tr><td>Space</td><td>Play the sound</td></tr>
      <tr><td>E</td><td>Edit (adjust, crop, straighten)</td></tr><tr><td>F</td><td>Favourite</td></tr>
      <tr><td>[ ]</td><td>Rotate left / right</td></tr><tr><td>⌘C</td><td>Copy the photo</td></tr>
      <tr><td>+ − 0</td><td>Zoom in / out / fit</td></tr><tr><td>⌫</td><td>Delete (to the Trash)</td></tr>
      <tr><td>⌘A</td><td>Select all</td></tr><tr><td>Esc</td><td>Close / clear selection</td></tr></table>`,
  },
  {
    id: "trouble",
    title: "Troubleshooting",
    summary: "No answer, frozen “PC” screen, slow transfers.",
    keywords: "trouble problem error no answer not found frozen stuck pc screen slow timeout battery reset hang",
    body: `<ul>
      <li><b>No answer</b>: IrDA is on, the plug is in the wrong jack, the camera is asleep or not in playback, or it's still at a speed set earlier (the app tries 9,600 and 115,200).</li>
      <li><b>Stuck on “PC”</b> after the app disconnects: switch the camera off and on.</li>
      <li><b>Frozen, power switch does nothing</b>: remove the battery for a few seconds.</li>
      <li><b>“The camera stopped answering”</b>: it probably switched itself off; switch it on and connect again.</li>
      <li><b>Battery too low to write</b>: the app refuses to write below level 3 of 5; use the AC adapter.</li>
    </ul>`,
  },
];

export interface Hit { kind: "menu" | "control" | "message" | "word"; title: string; ja: string; text: string }

/** Everything in the translated camera data, flattened for searching. */
const entries: Hit[] = (() => {
  const out: Hit[] = [];
  const c = cheat as any;
  for (const m of c.menus ?? []) {
    for (const t of m.tabs ?? []) {
      for (const it of t.items ?? []) {
        const opts = (it.options ?? []).map((o: any) => o.en).filter(Boolean).join(" · ");
        out.push({
          kind: "menu",
          title: `${m.menu_en ?? m.mode} › ${t.en} › ${it.en}`,
          ja: `${t.ja ?? ""} › ${it.ja ?? ""}`,
          text: [it.what, opts && `Options: ${opts}`, it.note].filter(Boolean).join(" — "),
        });
      }
    }
  }
  for (const b of c.body_controls ?? []) out.push({ kind: "control", title: b.en, ja: b.ja ?? "", text: [b.where, b.note].filter(Boolean).join(" — ") });
  for (const s of c.messages ?? []) out.push({ kind: "message", title: s.en, ja: s.ja ?? "", text: s.action ?? "" });
  for (const w of c.common_words ?? []) out.push({ kind: "word", title: w.en, ja: w.ja ?? "", text: "" });
  for (const w of c.screen_indicators ?? []) out.push({ kind: "word", title: w.en, ja: w.ja_or_symbol ?? "", text: "" });
  return out;
})();

const words = (q: string) => q.toLowerCase().split(/\s+/).filter(Boolean);
const matches = (hay: string, q: string) => words(q).every((w) => hay.toLowerCase().includes(w));

export function search(q: string) {
  return {
    topics: topics.filter((t) => matches(`${t.title} ${t.summary} ${t.keywords} ${t.body.replace(/<[^>]+>/g, " ")}`, q)),
    entries: entries.filter((e) => matches(`${e.title} ${e.ja} ${e.text}`, q)).slice(0, 40),
    sheets: sheets.filter((s) => matches(`${s.title} ${s.file}`, q)),
  };
}

const KIND = { menu: "Camera menu", control: "Button or jack", message: "On-screen message", word: "Word on screen" };

export function renderHelp(q: string, topicId: string | null): string {
  const topic = topics.find((t) => t.id === topicId);
  if (topic) {
    return `<div class="help-article">
      <button class="linkish" data-help-back>${icon.left(12)} All help</button>
      <h1>${esc(topic.title)}</h1>${topic.body}
    </div>`;
  }
  const card = (t: Topic) => `<button class="help-card" data-help-topic="${t.id}"><b>${esc(t.title)}</b><span class="muted small">${esc(t.summary)}</span></button>`;
  const sheet = (s: Sheet) => `<button class="help-sheet" data-help-sheet="${esc(s.file)}"><img src="${s.url}" alt="" loading="lazy"><span>${esc(s.title)}</span></button>`;
  if (!q.trim()) {
    return `<h3 class="album-head">How to</h3><div class="help-cards">${topics.map(card).join("")}</div>
      <h3 class="album-head">English cheat sheets <span class="muted">every button, menu and message on the camera</span></h3>
      <div class="help-sheets">${sheets.map(sheet).join("")}</div>`;
  }
  const r = search(q);
  const none = !r.topics.length && !r.entries.length && !r.sheets.length;
  return none
    ? `<div class="empty">Nothing found for “${esc(q)}”. Try a word from the camera's screen (Japanese works too), or browse the cheat sheets.</div>`
    : `${r.topics.length ? `<h3 class="album-head">How to</h3><div class="help-cards">${r.topics.map(card).join("")}</div>` : ""}
      ${r.entries.length ? `<h3 class="album-head">On the camera</h3><div class="help-hits">${r.entries
        .map((e) => `<div class="help-hit"><div><span class="pill">${KIND[e.kind]}</span> <b>${esc(e.title)}</b> <span class="muted">${esc(e.ja)}</span></div>${e.text ? `<div class="small">${esc(e.text)}</div>` : ""}</div>`)
        .join("")}</div>` : ""}
      ${r.sheets.length ? `<h3 class="album-head">Cheat sheets</h3><div class="help-sheets">${r.sheets.map(sheet).join("")}</div>` : ""}`;
}

/** A cheat sheet full screen: fit to width, scroll to read, + / − or ⌘-scroll / pinch to zoom. */
export function openSheet(file: string) {
  const s = sheets.find((x) => x.file === file);
  if (!s) return;
  let z = 1;
  const el = document.createElement("div");
  el.className = "sheet-view";
  el.innerHTML = `
    <div class="v-top"><button class="v-btn" data-sv="close" title="Close (Esc)">${icon.close(18)}</button>
      <div class="v-title">${esc(s.title)}</div>
      <button class="v-btn" data-sv="out" title="Zoom out (−)">−</button><button class="v-btn" data-sv="fit" title="Fit width (0)">${icon.zoomOut(15)}</button><button class="v-btn" data-sv="in" title="Zoom in (+)">+</button></div>
    <div class="sv-scroll"><img src="${s.url}" alt="${esc(s.title)}"></div>`;
  document.body.appendChild(el);
  const scroll = el.querySelector<HTMLElement>(".sv-scroll")!;
  const img = el.querySelector<HTMLImageElement>("img")!;
  const apply = (nz: number, cx = scroll.clientWidth / 2, cy = scroll.clientHeight / 2) => {
    nz = Math.min(4, Math.max(0.5, nz));
    const fx = (scroll.scrollLeft + cx) / Math.max(1, scroll.scrollWidth), fy = (scroll.scrollTop + cy) / Math.max(1, scroll.scrollHeight);
    z = nz;
    img.style.width = `${Math.min(1100, scroll.clientWidth - 40) * z}px`;
    scroll.scrollLeft = fx * scroll.scrollWidth - cx;
    scroll.scrollTop = fy * scroll.scrollHeight - cy;
  };
  const close = () => { document.removeEventListener("keydown", onKey, true); el.remove(); };
  const onKey = (e: KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === "Escape") close();
    else if (e.key === "+" || e.key === "=") apply(z * 1.25);
    else if (e.key === "-") apply(z / 1.25);
    else if (e.key === "0") apply(1);
  };
  scroll.addEventListener("wheel", (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    const r = scroll.getBoundingClientRect();
    apply(z * Math.exp(-e.deltaY * 0.01), e.clientX - r.left, e.clientY - r.top);
  }, { passive: false });
  el.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-sv]");
    if (b?.dataset.sv === "close") close();
    if (b?.dataset.sv === "in") apply(z * 1.25);
    if (b?.dataset.sv === "out") apply(z / 1.25);
    if (b?.dataset.sv === "fit") apply(1);
  });
  document.addEventListener("keydown", onKey, true);
  apply(1);
}
