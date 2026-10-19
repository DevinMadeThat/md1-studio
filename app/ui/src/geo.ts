// Coordinates from whatever people paste: decimal pairs, degrees/minutes/seconds,
// Google / Apple Maps links, geo: URIs.

export interface LatLon {
  lat: number;
  lon: number;
}

const valid = (lat: number, lon: number): LatLon | null =>
  Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : null;

/** One coordinate: "47.62", "-122.3", "47.62° N", "47°37'13.8\"N", "122 20 57 W". */
function parseOne(s: string): { value: number; hemi: string | null } | null {
  const hemiMatch = s.match(/[NSEW]/i);
  const hemi = hemiMatch ? hemiMatch[0].toUpperCase() : null;
  const nums = s.replace(/[NSEW]/gi, " ").match(/-?\d+(?:[.,]\d+)?/g);
  if (!nums || nums.length > 3) return null;
  const [d, m = "0", sec = "0"] = nums.map((n) => n.replace(",", "."));
  let value = Math.abs(parseFloat(d)) + parseFloat(m) / 60 + parseFloat(sec) / 3600;
  if (d.startsWith("-") || hemi === "S" || hemi === "W") value = -value;
  return { value, hemi };
}

export function parseCoordinates(input: string): LatLon | null {
  const s = input.trim();
  if (!s) return null;

  // Google Maps: the place pin (!3d…!4d…) is more exact than the viewport centre (@lat,lon).
  let m = s.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/);
  if (m) return valid(+m[1], +m[2]);
  m = s.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (m) return valid(+m[1], +m[2]);
  // ?q=lat,lon  ?ll=  ?query=  ?center=  (Google, Apple Maps), and geo:lat,lon
  m = s.match(/(?:[?&](?:q|ll|query|center|sll|daddr)=|^geo:)\s*(-?\d+(?:\.\d+)?)\s*(?:,|%2C)\s*(-?\d+(?:\.\d+)?)/i);
  if (m) return valid(+m[1], +m[2]);
  if (/^https?:\/\//i.test(s)) return null;

  // Two coordinates separated by a comma, or by the hemisphere letter of the first.
  let parts: string[] | null = null;
  const byHemi = s.match(/^(.*?[NS])\s*,?\s*(.*[EW].*)$/i);
  if (byHemi) parts = [byHemi[1], byHemi[2]];
  else if (s.includes(",")) {
    const c = s.split(",");
    if (c.length === 2) parts = c;
  } else {
    const c = s.split(/\s+/);
    if (c.length === 2) parts = c;
  }
  if (!parts) return null;
  const a = parseOne(parts[0]);
  const b = parseOne(parts[1]);
  if (!a || !b) return null;
  // "122.3 W, 47.6 N" — swap if the hemispheres say so.
  if ((a.hemi === "E" || a.hemi === "W") && (b.hemi === "N" || b.hemi === "S")) return valid(b.value, a.value);
  return valid(a.value, b.value);
}

export function formatLatLon({ lat, lon }: LatLon): string {
  return `${Math.abs(lat).toFixed(5)}° ${lat >= 0 ? "N" : "S"}, ${Math.abs(lon).toFixed(5)}° ${lon >= 0 ? "E" : "W"}`;
}

/** Web-Mercator tile coordinates (fractional) for zoom z. */
export function tileXY(lat: number, lon: number, z: number) {
  const n = 2 ** z;
  const r = (lat * Math.PI) / 180;
  return {
    x: ((lon + 180) / 360) * n,
    y: ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n,
  };
}
