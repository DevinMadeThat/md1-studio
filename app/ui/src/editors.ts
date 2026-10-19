// Editors for photo metadata: location and date/time, for one photo or many at once.
import { api, type Disc, type Location, type Photo } from "./api";
import { formatLatLon, parseCoordinates } from "./geo";
import { icon } from "./icons";
import { renderMap } from "./map";
import { esc, openModal, prefs, toast } from "./ui";

const label = (photos: Photo[]) => (photos.length === 1 ? `photo ${photos[0].number + 1}` : `${photos.length} photos`);

/** "Space Needle, 400, Broad Street, South Lake Union, …" → "Space Needle, 400, Broad Street" */
const shortName = (name: string) => name.split(",").slice(0, 3).map((s) => s.trim()).join(", ");

export const googleMapsUrl = (l: Location) => `https://www.google.com/maps?q=${l.lat},${l.lon}`;

// ------------------------------------------------------------------ location

export function openLocationEditor(disc: Disc, photos: Photo[], onSaved: (d: Disc) => void) {
  const existing = photos.map((p) => p.edits.location).filter((l): l is Location => !!l);
  const same = existing.length === photos.length && existing.every((l) => l.lat === existing[0].lat && l.lon === existing[0].lon);
  let chosen: Location | null = same ? { ...existing[0] } : null;
  const recent = prefs.get<Location[]>("recentPlaces", []);

  const m = openModal(
    `Location for ${label(photos)}`,
    `<div class="loc-search">
       <span class="loc-search-icon">${icon.search(15)}</span>
       <input id="loc-q" class="field grow" spellcheck="false" autocomplete="off"
         placeholder="Search a place, or paste coordinates or a Google Maps link">
       <button class="btn" id="loc-go">Find</button>
     </div>
     <div class="muted small loc-hint">Examples: <i>Pike Place Market</i> · <i>47.6097, -122.3422</i> · <i>47°36'35"N 122°20'32"W</i> · a maps.google.com or maps.app.goo.gl link</div>
     <div id="loc-results" class="loc-results"></div>
     <div id="loc-chosen" class="loc-chosen"></div>
     ${existing.length && !same ? `<div class="callout small">These photos have different locations now; applying sets them all to the one chosen here.</div>` : ""}
     <div class="modal-actions">
       ${existing.length ? `<button class="btn danger-text" id="loc-remove">Remove location</button>` : ""}
       <span class="spacer"></span>
       <button class="btn" id="loc-cancel">Cancel</button>
       <button class="btn primary" id="loc-apply" disabled>Apply</button>
     </div>`,
  );
  const $ = <T extends HTMLElement>(s: string) => m.el.querySelector<T>(s)!;
  const q = $<HTMLInputElement>("#loc-q");
  const results = $("#loc-results");
  const chosenEl = $("#loc-chosen");

  const showResults = (items: { name: string; lat: number; lon: number }[], heading?: string) => {
    results.innerHTML = items.length
      ? `${heading ? `<div class="loc-heading">${esc(heading)}</div>` : ""}${items
          .map((p, i) => `<button class="loc-item" data-i="${i}">${icon.pin(14)}<span>${esc(p.name)}</span></button>`)
          .join("")}`
      : "";
    results.querySelectorAll<HTMLButtonElement>(".loc-item").forEach((b) =>
      b.addEventListener("click", () => {
        const p = items[+b.dataset.i!];
        choose({ lat: p.lat, lon: p.lon, name: shortName(p.name) });
        results.querySelectorAll(".loc-item").forEach((x) => x.classList.toggle("on", x === b));
      }),
    );
  };

  const choose = (loc: Location | null) => {
    chosen = loc;
    $<HTMLButtonElement>("#loc-apply").disabled = !loc;
    if (!loc) { chosenEl.innerHTML = ""; return; }
    chosenEl.innerHTML = `
      <div class="map" id="loc-map"></div>
      <div class="loc-fields">
        <label class="small muted">Name shown with the photo</label>
        <input id="loc-name" class="field" value="${esc(loc.name ?? "")}" placeholder="e.g. Grandma's house">
        <div class="loc-coords small muted">${formatLatLon(loc)} · <a href="#" id="loc-open">Open in Google Maps ${icon.external(11)}</a></div>
      </div>`;
    renderMap($("#loc-map"), loc.lat, loc.lon, 15);
    $<HTMLInputElement>("#loc-name").addEventListener("input", (e) => {
      if (chosen) chosen.name = (e.target as HTMLInputElement).value.trim() || null;
    });
    $("#loc-open").addEventListener("click", async (e) => {
      e.preventDefault();
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      openUrl(googleMapsUrl(loc));
    });
  };

  const search = async () => {
    const text = q.value.trim();
    if (!text) return;
    const go = $<HTMLButtonElement>("#loc-go");
    go.disabled = true;
    results.innerHTML = `<div class="loc-heading"><span class="spinner dark"></span> Looking…</div>`;
    try {
      let ll = parseCoordinates(text);
      if (!ll && /^https?:\/\//i.test(text)) ll = parseCoordinates(await api.expandUrl(text));
      if (ll) {
        results.innerHTML = "";
        const loc: Location = { ...ll, name: null };
        choose(loc);
        const name = await api.reverseGeocode(ll.lat, ll.lon).catch(() => null);
        if (name && chosen === loc && !loc.name) {
          loc.name = shortName(name);
          const inp = m.el.querySelector<HTMLInputElement>("#loc-name");
          if (inp && !inp.value) inp.value = loc.name;
        }
        return;
      }
      if (/^https?:\/\//i.test(text)) {
        results.innerHTML = `<div class="loc-heading">No coordinates found in that link.</div>`;
        return;
      }
      const found = await api.geocode(text);
      if (!found.length) {
        results.innerHTML = `<div class="loc-heading">Nothing found for “${esc(text)}”. Try adding a city, or paste coordinates.</div>`;
        return;
      }
      showResults(found);
      results.querySelector<HTMLButtonElement>(".loc-item")?.click();
    } catch (e) {
      results.innerHTML = `<div class="loc-heading">${esc(String(e))}</div>`;
    } finally {
      go.disabled = false;
    }
  };

  q.addEventListener("keydown", (e) => { if (e.key === "Enter") search(); });
  // Pasting coordinates or a link searches straight away.
  q.addEventListener("paste", () => setTimeout(() => { if (parseCoordinates(q.value) || /^https?:\/\//i.test(q.value.trim())) search(); }, 0));
  $("#loc-go").addEventListener("click", search);
  $("#loc-cancel").addEventListener("click", m.close);

  const save = async (patch: { setLocation?: Location; clearLocation?: boolean }) => {
    try {
      const d = await api.editPhotos(disc.path, photos.map((p) => ({ photoId: p.id, ...patch })));
      m.close();
      onSaved(d);
    } catch (e) {
      toast(`Couldn't save: ${e}`, undefined, "error");
    }
  };
  $("#loc-apply").addEventListener("click", () => {
    if (!chosen) return;
    const loc = { lat: chosen.lat, lon: chosen.lon, name: chosen.name || null };
    prefs.set("recentPlaces", [loc, ...recent.filter((r) => r.lat !== loc.lat || r.lon !== loc.lon)].slice(0, 8));
    save({ setLocation: loc });
  });
  m.el.querySelector("#loc-remove")?.addEventListener("click", () => save({ clearLocation: true }));

  if (chosen) choose(chosen);
  else if (recent.length) showResults(recent.map((r) => ({ name: r.name || formatLatLon(r), lat: r.lat, lon: r.lon })), "Recent places");
  q.focus();
}

// ------------------------------------------------------------------ date & time

const toSecs = (s: string) => {
  const [d, t = "00:00:00"] = s.replace("T", " ").split(" ");
  const [Y, M, D] = d.split("-").map(Number);
  const [h, mi, se = 0] = t.split(":").map(Number);
  return Date.UTC(Y, M - 1, D, h, mi, se) / 1000;
};
const fromSecs = (n: number) => new Date(n * 1000).toISOString().slice(0, 19).replace("T", " ");

/** The date/time to show for a photo: the user's edit, else the camera's if its clock was set. */
export const effectiveTaken = (p: Photo) => p.edits.taken ?? (p.clockUnset ? null : p.created);

export function openDateEditor(disc: Disc, photos: Photo[], onSaved: (d: Disc) => void) {
  const ordered = [...photos].sort((a, b) => (a.created ?? "").localeCompare(b.created ?? "") || a.number - b.number);
  const canKeep = photos.length > 1 && photos.every((p) => p.created);
  const first = ordered[0];
  const start = effectiveTaken(first) ?? (first.created ? `${new Date().getFullYear()}-01-01 ${first.created.slice(11)}` : "");
  let mode: "keep" | "same" = canKeep ? "keep" : "same";

  const m = openModal(
    `Date & time for ${label(photos)}`,
    `<label class="small muted">${photos.length > 1 && canKeep ? "Date and time of the earliest photo" : "Date and time taken"}</label>
     <input id="dt" class="field dt" type="datetime-local" step="1" value="${esc(start.replace(" ", "T"))}">
     ${photos.length > 1 ? `
       <div class="choice">
         <label ${canKeep ? "" : `class="disabled"`}><input type="radio" name="dtmode" value="keep" ${mode === "keep" ? "checked" : ""} ${canKeep ? "" : "disabled"}>
           Keep the time between shots <span class="muted">(uses the camera's recorded times; good for a whole roll)</span></label>
         <label><input type="radio" name="dtmode" value="same" ${mode === "same" ? "checked" : ""}> Same date and time for every photo</label>
       </div>` : ""}
     ${first.clockUnset ? `<div class="callout small">The camera's clock wasn't set, so it recorded only the time since it was switched on (e.g. ${esc(first.created?.slice(11) ?? "")}). The gaps between shots are still right within one session.</div>` : ""}
     <div id="dt-preview" class="dt-preview"></div>
     <div class="modal-actions">
       ${photos.some((p) => p.edits.taken) ? `<button class="btn danger-text" id="dt-clear">Use camera time</button>` : ""}
       <span class="spacer"></span>
       <button class="btn" id="dt-cancel">Cancel</button>
       <button class="btn primary" id="dt-apply">Apply</button>
     </div>`,
  );
  const $ = <T extends HTMLElement>(s: string) => m.el.querySelector<T>(s)!;
  const input = $<HTMLInputElement>("#dt");

  const plan = (): { photo: Photo; taken: string }[] | null => {
    const v = input.value;
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)) return null;
    const base = toSecs(v);
    if (mode === "keep" && canKeep) {
      const c0 = toSecs(first.created!);
      return ordered.map((p) => ({ photo: p, taken: fromSecs(base + (toSecs(p.created!) - c0)) }));
    }
    return ordered.map((p) => ({ photo: p, taken: fromSecs(base) }));
  };
  const preview = () => {
    const p = plan();
    $<HTMLButtonElement>("#dt-apply").disabled = !p;
    $("#dt-preview").innerHTML = p && photos.length > 1
      ? `<div class="loc-heading">Result</div>${p.slice(0, 8).map((x) => `<div class="dt-row"><span>Photo ${x.photo.number + 1}</span><span>${esc(x.taken)}</span></div>`).join("")}${p.length > 8 ? `<div class="muted small">…and ${p.length - 8} more</div>` : ""}`
      : "";
  };
  input.addEventListener("input", preview);
  m.el.querySelectorAll<HTMLInputElement>('input[name="dtmode"]').forEach((r) =>
    r.addEventListener("change", () => { mode = r.value as "keep" | "same"; preview(); }),
  );
  const save = async (patches: ({ photoId: string; setTaken?: string; clearTaken?: boolean })[]) => {
    try {
      const d = await api.editPhotos(disc.path, patches);
      m.close();
      onSaved(d);
    } catch (e) {
      toast(`Couldn't save: ${e}`, undefined, "error");
    }
  };
  $("#dt-apply").addEventListener("click", () => {
    const p = plan();
    if (p) save(p.map((x) => ({ photoId: x.photo.id, setTaken: x.taken })));
  });
  m.el.querySelector("#dt-clear")?.addEventListener("click", () => save(photos.map((p) => ({ photoId: p.id, clearTaken: true }))));
  $("#dt-cancel").addEventListener("click", m.close);
  preview();
  input.focus();
}

// ------------------------------------------------------------------ export

export interface ExportChoice {
  scale: number;
  sound: boolean;
  applyEdits: boolean;
  metadata: boolean;
}

/** Ask how to export; resolves with the choice (remembered for next time) or null. */
export function openExportSheet(photos: Photo[]): Promise<ExportChoice | null> {
  const saved = prefs.get<ExportChoice>("export", { scale: 1, sound: true, applyEdits: true, metadata: true });
  const anySound = photos.some((p) => p.wavPath);
  const anyEdits = photos.some((p) => Object.keys(p.edits).length);
  return new Promise((resolve) => {
    let result: ExportChoice | null = null;
    const m = openModal(
      `Export ${label(photos)}`,
      `<div class="ed-group">Size</div>
       <div class="ex-sizes">
         ${[1, 2, 3].map((s) => `
           <label class="ex-size"><input type="radio" name="scale" value="${s}" ${saved.scale === s ? "checked" : ""}>
             <b>${s === 1 ? "Original" : `${s}× larger`}</b><span class="muted small">${640 * s} × ${480 * s}${s > 1 ? " · smooth upscale" : ""}</span></label>`).join("")}
       </div>
       <div class="choice ex-opts">
         <label><input type="checkbox" id="ex-edits" ${saved.applyEdits ? "checked" : ""} ${anyEdits ? "" : "disabled"}> Apply my edits <span class="muted">(colour, crop, straighten, rotation)</span></label>
         <label><input type="checkbox" id="ex-meta" ${saved.metadata ? "checked" : ""}> Include details <span class="muted">(date, location, caption, favourite, camera settings)</span></label>
         <label><input type="checkbox" id="ex-sound" ${saved.sound ? "checked" : ""} ${anySound ? "" : "disabled"}> Save sound as a .wav next to each photo</label>
       </div>
       <div class="modal-actions">
         <span class="muted small">Files are named after the disc, album and photo number.</span>
         <span class="spacer"></span>
         <button class="btn" id="ex-cancel">Cancel</button>
         <button class="btn primary" id="ex-go">Choose folder…</button>
       </div>`,
      { onClose: () => resolve(result) },
    );
    m.el.querySelector("#ex-cancel")!.addEventListener("click", m.close);
    m.el.querySelector("#ex-go")!.addEventListener("click", () => {
      const q = <T extends HTMLElement>(s: string) => m.el.querySelector<T>(s)!;
      result = {
        scale: +(m.el.querySelector<HTMLInputElement>('input[name="scale"]:checked')?.value ?? 1),
        sound: q<HTMLInputElement>("#ex-sound").checked,
        applyEdits: q<HTMLInputElement>("#ex-edits").checked,
        metadata: q<HTMLInputElement>("#ex-meta").checked,
      };
      prefs.set("export", result);
      m.close();
    });
  });
}
