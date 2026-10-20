// Full-screen slideshow. Each photo stays up for the chosen time, or for as long as the sound
// recorded with it lasts (the camera's own slideshow plays the sound too).
import { getCurrentWindow } from "@tauri-apps/api/window";
import { fileUrl, type Item } from "./api";
import { effectiveTaken } from "./editors";
import { icon } from "./icons";
import { hasLook, renderedUrl } from "./look";
import { esc, prefs } from "./ui";

interface Options { seconds: number; sound: boolean; loop: boolean }

export function startSlideshow(items: Item[], start = 0) {
  if (!items.length) return;
  const opts: Options = { seconds: 5, sound: true, loop: false, ...prefs.get<Partial<Options>>("slideshow", {}) };
  const save = () => prefs.set("slideshow", opts);
  let index = Math.max(0, Math.min(start, items.length - 1));
  let paused = false;
  let timer = 0;
  let audio: HTMLAudioElement | null = null;
  let hideControls = 0;
  let front = 0;

  const el = document.createElement("div");
  el.className = "slideshow";
  el.innerHTML = `
    <div class="ss-stage"><img class="ss-img" alt=""><img class="ss-img" alt=""></div>
    <div class="ss-caption"></div>
    <div class="ss-controls">
      <button data-ss="prev" title="Previous (←)">${icon.left(20)}</button>
      <button data-ss="pause" title="Pause (Space)"></button>
      <button data-ss="next" title="Next (→)">${icon.right(20)}</button>
      <span class="ss-sep"></span>
      <label title="Seconds per photo">${icon.clock(14)}<select data-ss="seconds">${[3, 5, 8, 12].map((s) => `<option value="${s}" ${opts.seconds === s ? "selected" : ""}>${s} s</option>`).join("")}</select></label>
      <button data-ss="sound" title="Play recorded sound"></button>
      <button data-ss="loop" title="Start again at the end">${icon.loop(16)}</button>
      <span class="ss-count"></span>
      <button data-ss="close" title="End slideshow (Esc)">${icon.close(18)}</button>
    </div>`;
  document.body.appendChild(el);
  const imgs = [...el.querySelectorAll<HTMLImageElement>(".ss-img")];
  const $ = (s: string) => el.querySelector<HTMLElement>(s)!;
  const fullscreen = (on: boolean) => {
    try { getCurrentWindow().setFullscreen(on).catch(() => {}); } catch { /* not in a Tauri window */ }
  };
  fullscreen(true);

  const paintControls = () => {
    $('[data-ss="pause"]').innerHTML = paused ? icon.play(20) : icon.pause(20);
    $('[data-ss="sound"]').innerHTML = icon.sound(16);
    $('[data-ss="sound"]').classList.toggle("off", !opts.sound);
    $('[data-ss="loop"]').classList.toggle("off", !opts.loop);
    $(".ss-count").textContent = `${index + 1} / ${items.length}`;
  };

  const stopSound = () => { audio?.pause(); audio = null; };

  const schedule = (ms: number) => {
    clearTimeout(timer);
    if (!paused) timer = window.setTimeout(() => go(1), ms);
  };

  const show = async () => {
    const { photo: p } = items[index];
    stopSound();
    clearTimeout(timer);
    const src = !p.jpegPath ? "" : hasLook(p.edits) ? await renderedUrl(p).catch(() => fileUrl(p.jpegPath!)) : fileUrl(p.jpegPath);
    const next = imgs[1 - front];
    next.className = `ss-img rot${hasLook(p.edits) ? 0 : p.edits.rotation ?? 0}`;
    next.src = src;
    await next.decode().catch(() => {});
    next.classList.add("on");
    imgs[front].classList.remove("on");
    front = 1 - front;
    const bits = [p.edits.caption, p.edits.location?.name, effectiveTaken(p)].filter(Boolean) as string[];
    $(".ss-caption").innerHTML = bits.map((b, i) => `<span class="${i ? "muted" : ""}">${esc(b)}</span>`).join("");
    paintControls();
    let ms = opts.seconds * 1000;
    if (opts.sound && p.wavPath) {
      audio = new Audio(fileUrl(p.wavPath));
      if (!paused) audio.play().catch(() => {});
      ms = Math.max(ms, (p.soundSeconds ?? 0) * 1000 + 800);
    }
    schedule(ms);
  };

  const go = (d: number) => {
    let i = index + d;
    if (i >= items.length) {
      if (!opts.loop) return close();
      i = 0;
    }
    if (i < 0) i = opts.loop ? items.length - 1 : 0;
    index = i;
    show();
  };

  const togglePause = () => {
    paused = !paused;
    if (paused) { clearTimeout(timer); audio?.pause(); }
    else { audio?.play().catch(() => {}); schedule(opts.seconds * 1000); }
    paintControls();
  };

  const onKey = (e: KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === "Escape") close();
    else if (e.key === "ArrowRight") go(1);
    else if (e.key === "ArrowLeft") go(-1);
    else if (e.key === " ") { e.preventDefault(); togglePause(); }
  };
  const onMove = () => {
    el.classList.add("show-controls");
    clearTimeout(hideControls);
    hideControls = window.setTimeout(() => el.classList.remove("show-controls"), 2200);
  };

  el.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-ss]");
    if (!b) return;
    switch (b.dataset.ss) {
      case "prev": go(-1); break;
      case "next": go(1); break;
      case "pause": togglePause(); break;
      case "close": close(); break;
      case "sound": opts.sound = !opts.sound; save(); if (!opts.sound) stopSound(); paintControls(); break;
      case "loop": opts.loop = !opts.loop; save(); paintControls(); break;
    }
  });
  $('[data-ss="seconds"]').addEventListener("change", (e) => { opts.seconds = +(e.target as HTMLSelectElement).value; save(); });
  document.addEventListener("keydown", onKey, true);
  el.addEventListener("mousemove", onMove);

  function close() {
    clearTimeout(timer);
    stopSound();
    document.removeEventListener("keydown", onKey, true);
    fullscreen(false);
    el.remove();
  }

  onMove();
  show();
}
