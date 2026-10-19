// Types mirror the Rust structs serialized by src-tauri (serde field names kept as-is).
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import type { Adjust, AutoLevels, Crop, Look } from "./look";

export interface PortInfo {
  path: string;
  description: string;
  is_usb: boolean;
  likely_adapter: boolean;
}

export interface Connection {
  port: string;
  found_at_baud: number;
  baud: number;
  camera_id: string;
}

export interface Status {
  mode: number;
  mode_name: string;
  pictures: number;
  pictures2: number;
  power: number;
  clock: string;
  clock_set: boolean;
}

export interface DosTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export interface VolumeInfo {
  label: string;
  created: DosTime;
  modified: DosTime;
  unit_sectors: number;
  total_units: number;
  free_units: number;
  total_bytes: number;
  free_bytes: number;
}

export interface CameraInfo {
  connection: Connection;
  status: Status;
  volume: VolumeInfo | null;
  matchingDisc: string | null;
}

export interface PhotoInfo {
  quality: string;
  width: number;
  height: number;
  shutter_tv100: number | null;
  shutter: string | null;
  exposure_seconds: number | null;
  flash: boolean | null;
  jpeg_len: number;
}

export interface Location {
  lat: number;
  lon: number;
  name?: string | null;
}

export interface PhotoEdits {
  location?: Location | null;
  /** "YYYY-MM-DD HH:MM:SS", local time */
  taken?: string | null;
  /** clockwise degrees */
  rotation?: number;
  flip?: boolean;
  straighten?: number;
  crop?: Crop | null;
  adjust?: Adjust | null;
  favorite?: boolean;
  caption?: string | null;
}

export interface EditPatch {
  setLocation?: Location;
  clearLocation?: boolean;
  setTaken?: string;
  clearTaken?: boolean;
  rotateBy?: number;
  setLook?: Look;
  /** Compute auto-enhance for the photo and turn it on (batch). */
  autoEnhance?: boolean;
  clearAuto?: boolean;
  setFavorite?: boolean;
  /** "" clears */
  setCaption?: string;
}

export interface ExportOptions {
  scale: number;
  sound: boolean;
  applyEdits: boolean;
  metadata: boolean;
}

export interface Place {
  name: string;
  lat: number;
  lon: number;
}

export interface Photo {
  id: string;
  album: string;
  number: number;
  stem: string;
  pmpPath: string;
  jpegPath: string | null;
  wavPath: string | null;
  soundSeconds: number | null;
  info: PhotoInfo;
  fileBytes: number;
  created: string | null;
  clockUnset: boolean;
  inIndex: boolean;
  protected: boolean;
  edits: PhotoEdits;
}

export interface Album {
  name: string;
  photos: Photo[];
}

export interface Disc {
  path: string;
  name: string;
  cameraId: string;
  volumeLabel: string;
  formatted: string;
  imports: string[];
  kind: "mirror" | "photos";
  albums: Album[];
  photoCount: number;
  soundCount: number;
  fineCount: number;
}

export interface Settings {
  libraryDir: string;
  externalDiscs: string[];
  lastPort: string | null;
  platform: string;
}

export type ImportEvent =
  | { kind: "volume"; label: string; free_bytes: number; total_bytes: number }
  | { kind: "listing"; folders: number; files: number; bytes: number; to_copy: number; bytes_to_copy: number }
  | { kind: "file"; index: number; count: number; path: string; size: number }
  | { kind: "progress"; file_bytes: number; file_size: number; done_bytes: number; total_bytes: number; rate: number }
  | { kind: "retry"; path: string; error: string }
  | { kind: "converting" }
  | { kind: "done"; copied: number; skipped: number; failed: string[] };

export interface ExportSummary {
  written: number;
  alreadyThere: number;
  folder: string;
}

export const api = {
  settings: () => invoke<Settings>("get_settings"),
  setLibraryDir: (path: string) => invoke<void>("set_library_dir", { path }),
  listDiscs: () => invoke<Disc[]>("list_discs"),
  addDiscFolder: (path: string) => invoke<Disc>("add_disc_folder", { path }),
  removeDiscFolder: (path: string) => invoke<void>("remove_disc_folder", { path }),
  renameDisc: (path: string, name: string) => invoke<void>("rename_disc", { path, name }),
  listPorts: () => invoke<PortInfo[]>("list_ports"),
  connect: (port: string) => invoke<CameraInfo>("connect", { port }),
  disconnect: () => invoke<void>("disconnect"),
  cameraStatus: () => invoke<CameraInfo | null>("camera_status"),
  importDisc: (name: string, into: string | null) => invoke<Disc>("import_disc", { name, into }),
  cancelImport: () => invoke<void>("cancel_import"),
  exportPhotos: (items: { discPath: string; photoId: string }[], dest: string, options: ExportOptions) =>
    invoke<ExportSummary>("export_photos", { items, dest, options }),
  autoLevels: (discPath: string, photoId: string) => invoke<AutoLevels>("auto_levels", { discPath, photoId }),
  editPhotos: (discPath: string, patches: ({ photoId: string } & EditPatch)[]) =>
    invoke<Disc>("edit_photos", { discPath, patches }),
  geocode: (query: string) => invoke<Place[]>("geocode", { query }),
  reverseGeocode: (lat: number, lon: number) => invoke<string | null>("reverse_geocode", { lat, lon }),
  expandUrl: (url: string) => invoke<string>("expand_url", { url }),
  mapTile: (z: number, x: number, y: number) => invoke<ArrayBuffer>("map_tile", { z, x, y }),
};

export const fileUrl = (path: string) => convertFileSrc(path);
