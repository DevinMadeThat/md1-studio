// A small static map (OpenStreetMap tiles, fetched and cached by the backend) with a pin.
import { api } from "./api";
import { tileXY } from "./geo";

const tileCache = new Map<string, Promise<string>>();

function tileUrl(z: number, x: number, y: number): Promise<string> {
  const key = `${z}/${x}/${y}`;
  let p = tileCache.get(key);
  if (!p) {
    p = api.mapTile(z, x, y).then((buf) => URL.createObjectURL(new Blob([buf], { type: "image/png" })));
    p.catch(() => tileCache.delete(key));
    tileCache.set(key, p);
  }
  return p;
}

/** Fill `el` (sized by CSS) with map tiles centred on lat/lon, with a pin in the middle. */
export async function renderMap(el: HTMLElement, lat: number, lon: number, zoom = 15) {
  const w = el.clientWidth || 280;
  const h = el.clientHeight || 160;
  const { x, y } = tileXY(lat, lon, zoom);
  const px = x * 256, py = y * 256; // pin position in world pixels
  const left = px - w / 2, top = py - h / 2;
  const n = 2 ** zoom;
  const token = `${lat},${lon},${zoom}`;
  el.dataset.token = token;
  el.innerHTML = `<div class="map-tiles"></div><div class="map-pin"></div><div class="map-attr">© OpenStreetMap</div>`;
  const layer = el.querySelector<HTMLElement>(".map-tiles")!;
  const jobs: Promise<void>[] = [];
  for (let ty = Math.floor(top / 256); ty <= Math.floor((top + h) / 256); ty++) {
    for (let tx = Math.floor(left / 256); tx <= Math.floor((left + w) / 256); tx++) {
      if (ty < 0 || ty >= n) continue;
      const wx = ((tx % n) + n) % n;
      const img = document.createElement("img");
      img.style.left = `${tx * 256 - left}px`;
      img.style.top = `${ty * 256 - top}px`;
      img.alt = "";
      layer.appendChild(img);
      jobs.push(
        tileUrl(zoom, wx, ty).then(
          (u) => { if (el.dataset.token === token) img.src = u; },
          () => { el.classList.add("offline"); },
        ),
      );
    }
  }
  await Promise.all(jobs);
}
