//! MD1 Studio backend: Tauri commands over md1-core.
//!
//! The camera session lives in `AppState::session`; every camera operation runs on a blocking
//! worker thread and holds that lock for its duration, so commands never interleave on the wire.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use md1_core::browse::{self, BrowseEvent, CameraDisc, CameraPhoto};
use md1_core::camera::{self, Camera, Connection, Status, VolumeInfo};
use md1_core::edits::{self, EditPatch};
use md1_core::import::{self, DiscMeta, ImportEvent, ImportOptions};
use md1_core::library::{self, Disc, LibraryMatch, Photo};
use md1_core::transport::{self, PortInfo};
use md1_core::{export, Error};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

const FAST_BAUD: u32 = 115200;

struct Session {
    cam: Camera,
    conn: Connection,
    volume: Option<VolumeInfo>,
    /// What browsing the disc read (listing, indexes, thumbnails); reused by downloads.
    browsed: Option<CameraDisc>,
}

#[derive(Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Settings {
    library_dir: Option<String>,
    #[serde(default)]
    external_discs: Vec<String>,
    last_port: Option<String>,
}

#[derive(Default)]
struct AppState {
    session: Mutex<Option<Session>>,
    settings: Mutex<Settings>,
    cancel: AtomicBool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CameraInfo {
    connection: Connection,
    status: Status,
    volume: Option<VolumeInfo>,
    /// A library disc whose recorded format time and label match the disc in the camera.
    matching_disc: Option<String>,
}

type CmdResult<T> = Result<T, String>;

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

// ---------- settings & library ----------

fn settings_path(app: &AppHandle) -> PathBuf {
    app.path().app_config_dir().unwrap_or_else(|_| PathBuf::from(".")).join("settings.json")
}

fn save_settings(app: &AppHandle, s: &Settings) {
    let p = settings_path(app);
    let _ = fs::create_dir_all(p.parent().unwrap());
    let _ = fs::write(p, serde_json::to_vec_pretty(s).unwrap());
}

fn library_dir(app: &AppHandle, s: &Settings) -> PathBuf {
    s.library_dir.clone().map(PathBuf::from).unwrap_or_else(|| {
        app.path()
            .picture_dir()
            .or_else(|_| app.path().home_dir())
            .unwrap_or_else(|_| PathBuf::from("."))
            .join("MD1 Studio")
    })
}

fn allow_assets(app: &AppHandle, dir: &Path) {
    let _ = app.asset_protocol_scope().allow_directory(dir, true);
}

fn disc_paths(app: &AppHandle) -> Vec<PathBuf> {
    let s = app.state::<AppState>().settings.lock().unwrap().clone();
    let lib = library_dir(app, &s);
    let mut out: Vec<PathBuf> = fs::read_dir(&lib)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| library::is_disc_dir(p))
        .collect();
    out.sort();
    out.extend(s.external_discs.iter().map(PathBuf::from).filter(|p| library::is_disc_dir(p)));
    out
}

fn find_photo(disc: &Disc, id: &str) -> Option<Photo> {
    disc.albums.iter().flat_map(|a| a.photos.iter()).find(|p| p.id == id).cloned()
}

fn sanitize(name: &str) -> String {
    let s: String = name
        .chars()
        .map(|c| if c.is_alphanumeric() || " -_().".contains(c) { c } else { '_' })
        .collect();
    let s = s.trim().trim_matches('.').to_string();
    if s.is_empty() { "Disc".into() } else { s }
}

#[tauri::command]
fn get_settings(app: AppHandle, state: State<AppState>) -> serde_json::Value {
    let s = state.settings.lock().unwrap().clone();
    serde_json::json!({
        "libraryDir": library_dir(&app, &s),
        "externalDiscs": s.external_discs,
        "lastPort": s.last_port,
        "platform": std::env::consts::OS,
    })
}

#[tauri::command]
fn set_library_dir(app: AppHandle, state: State<AppState>, path: String) {
    let mut s = state.settings.lock().unwrap();
    s.library_dir = Some(path.clone());
    save_settings(&app, &s);
    allow_assets(&app, Path::new(&path));
}

#[tauri::command]
async fn list_discs(app: AppHandle) -> CmdResult<Vec<Disc>> {
    tauri::async_runtime::spawn_blocking(move || {
        disc_paths(&app).iter().filter_map(|p| library::scan_disc(p)).collect()
    })
    .await
    .map_err(err)
}

#[tauri::command]
async fn add_disc_folder(app: AppHandle, path: String) -> CmdResult<Disc> {
    let p = PathBuf::from(&path);
    if !library::is_disc_dir(&p) {
        return Err("That folder isn't an MD1 backup: it should contain disc/PIC_MD (a full copy) \
                    or raw/PICnnnnn (photos only)."
            .into());
    }
    {
        let state = app.state::<AppState>();
        let mut s = state.settings.lock().unwrap();
        if !s.external_discs.contains(&path) {
            s.external_discs.push(path.clone());
        }
        save_settings(&app, &s);
    }
    allow_assets(&app, &p);
    tauri::async_runtime::spawn_blocking(move || library::scan_disc(&p).ok_or_else(|| "could not read the folder".into()))
        .await
        .map_err(err)?
}

/// Forget an external backup folder (files are untouched).
#[tauri::command]
fn remove_disc_folder(app: AppHandle, state: State<AppState>, path: String) {
    let mut s = state.settings.lock().unwrap();
    s.external_discs.retain(|p| p != &path);
    save_settings(&app, &s);
}

#[tauri::command]
fn rename_disc(path: String, name: String) -> CmdResult<()> {
    let dir = PathBuf::from(path);
    let mut meta = DiscMeta::load(&dir).unwrap_or_default();
    meta.name = name.trim().to_string();
    meta.save(&dir).map_err(err)
}

// ---------- camera ----------

#[tauri::command]
fn list_ports() -> Vec<PortInfo> {
    transport::list_ports()
}

fn trace_file(app: &AppHandle) -> Option<Box<dyn std::io::Write + Send>> {
    let dir = app.path().app_log_dir().ok()?;
    fs::create_dir_all(&dir).ok()?;
    let name = format!("serial-{}.log", md1_core::dostime::now_utc_iso().replace([':', '.'], "-"));
    Some(Box::new(fs::File::create(dir.join(name)).ok()?))
}

fn matching_disc(app: &AppHandle, vol: &Option<VolumeInfo>) -> Option<String> {
    let fp = vol.as_ref()?.fingerprint();
    disc_paths(app)
        .into_iter()
        .find(|p| DiscMeta::load(p).is_some_and(|m| m.fingerprint == fp))
        .map(|p| p.to_string_lossy().to_string())
}

#[tauri::command]
async fn connect(app: AppHandle, port: String) -> CmdResult<CameraInfo> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let mut slot = state.session.lock().unwrap();
        if let Some(mut old) = slot.take() {
            let _ = old.cam.disconnect();
        }
        let log_app = app.clone();
        let (mut cam, conn) = camera::connect(&port, Some(FAST_BAUD), trace_file(&app), &mut |m| {
            let _ = log_app.emit("connect-log", m);
        })
        .map_err(err)?;
        let status = cam.status().map_err(err)?;
        let volume = cam.volume_info().ok();
        {
            let mut s = state.settings.lock().unwrap();
            s.last_port = Some(port.clone());
            save_settings(&app, &s);
        }
        let info = CameraInfo {
            connection: conn.clone(),
            status,
            matching_disc: matching_disc(&app, &volume),
            volume: volume.clone(),
        };
        *slot = Some(Session { cam, conn, volume, browsed: None });
        Ok(info)
    })
    .await
    .map_err(err)?
}

#[tauri::command]
async fn disconnect(app: AppHandle) -> CmdResult<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let mut slot = state.session.lock().unwrap();
        if let Some(mut s) = slot.take() {
            let _ = s.cam.disconnect();
        }
    })
    .await
    .map_err(err)
}

/// Light status poll. `None` = no session; error = the camera stopped answering (the session is
/// dropped, e.g. it powered off). Skipped while an import holds the session.
#[tauri::command]
async fn camera_status(app: AppHandle) -> CmdResult<Option<CameraInfo>> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let Ok(mut slot) = state.session.try_lock() else { return Err("busy".to_string()) };
        let Some(s) = slot.as_mut() else { return Ok(None) };
        match s.cam.status() {
            Ok(status) => Ok(Some(CameraInfo {
                connection: s.conn.clone(),
                status,
                volume: s.volume.clone(),
                matching_disc: matching_disc(&app, &s.volume),
            })),
            Err(e) => {
                *slot = None;
                Err(format!("The camera stopped answering ({e}). It may have powered off."))
            }
        }
    })
    .await
    .map_err(err)?
}

#[tauri::command]
fn cancel_import(state: State<AppState>) {
    state.cancel.store(true, Ordering::SeqCst);
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CameraContents {
    photos: Vec<CameraPhoto>,
    /// For each photo, the library photo it already is.
    in_library: Vec<Option<LibraryMatch>>,
    /// The library folder that downloads from this disc go into, if it exists yet.
    disc_path: Option<String>,
}

fn contents(app: &AppHandle, b: &CameraDisc) -> CameraContents {
    let discs: Vec<Disc> = disc_paths(app).iter().filter_map(|p| library::scan_disc(p)).collect();
    CameraContents {
        in_library: library::match_camera(&discs, b),
        photos: b.photos.clone(),
        disc_path: matching_disc(app, &b.volume),
    }
}

/// What's on the disc in the camera, with thumbnails and which photos are already in the
/// library. Reads only the listing, index and thumbnail files; `refresh: false` reuses what an
/// earlier call read (it just re-checks the library).
#[tauri::command]
async fn browse_camera(app: AppHandle, refresh: bool) -> CmdResult<CameraContents> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        state.cancel.store(false, Ordering::SeqCst);
        let mut slot = state.session.lock().unwrap();
        let session = slot.as_mut().ok_or("The camera is not connected.")?;
        if refresh || session.browsed.is_none() {
            let cache = session.volume.as_ref().and_then(|v| {
                let key: String = v.fingerprint().chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '_' }).collect();
                Some(app.path().app_cache_dir().ok()?.join("camera").join(key))
            });
            let b = browse::browse(&mut session.cam, cache.as_deref(), &mut |ev: BrowseEvent| {
                let _ = app.emit("browse-event", &ev);
                if state.cancel.load(Ordering::SeqCst) { Err(Error::Cancelled) } else { Ok(()) }
            });
            match b {
                Ok(b) => session.browsed = Some(b),
                Err(Error::Cancelled) => {
                    session.cam.abort();
                    return Err("Cancelled.".into());
                }
                Err(e) => return Err(err(e)),
            }
        }
        Ok(contents(&app, session.browsed.as_ref().unwrap()))
    })
    .await
    .map_err(err)?
}

/// A new folder in the library for a disc seen for the first time: "Disc 1", "Disc 2", …
fn new_disc_dir(app: &AppHandle) -> (PathBuf, String) {
    let lib = library_dir(app, &app.state::<AppState>().settings.lock().unwrap());
    let names: Vec<String> = disc_paths(app)
        .iter()
        .filter_map(|p| library::scan_disc(p).map(|d| d.name))
        .collect();
    let mut k = names.len() + 1;
    loop {
        let name = format!("Disc {k}");
        let dir = lib.join(sanitize(&name));
        if !dir.exists() && !names.contains(&name) {
            return (dir, name);
        }
        k += 1;
    }
}

/// Copy photos from the camera into the library: `paths` (camera paths of PSN files, with their
/// sound) or, when `None`, the whole disc as a full backup. Photos from the same disc always go
/// into that disc's folder (recognized by its label and format time).
#[tauri::command]
async fn download_photos(app: AppHandle, paths: Option<Vec<String>>) -> CmdResult<Disc> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        state.cancel.store(false, Ordering::SeqCst);
        let mut slot = state.session.lock().unwrap();
        let session = slot.as_mut().ok_or("The camera is not connected.")?;

        let (dest, name) = match matching_disc(&app, &session.volume) {
            Some(p) => (PathBuf::from(p), String::new()),
            None => new_disc_dir(&app),
        };
        fs::create_dir_all(&dest).map_err(err)?;
        allow_assets(&app, &dest);

        let opts = ImportOptions { disc_dir: dest.clone(), name, only: paths.map(|p| p.into_iter().collect()) };
        let browsed = session.browsed.clone();
        let result = import::import_disc(&mut session.cam, &opts, browsed.as_ref(), &mut |ev: ImportEvent| {
            let _ = app.emit("import-event", &ev);
            if state.cancel.load(Ordering::SeqCst) {
                Err(Error::Cancelled)
            } else {
                Ok(())
            }
        });
        match result {
            Ok(_) => library::scan_disc(&dest).ok_or_else(|| "download finished but the folder is unreadable".into()),
            Err(Error::Cancelled) => {
                session.cam.abort();
                Err("Download cancelled. Photos copied so far are in the library.".into())
            }
            Err(e) => Err(err(e)),
        }
    })
    .await
    .map_err(err)?
}

// ---------- export ----------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExportItem {
    disc_path: String,
    photo_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ExportSummary {
    written: usize,
    already_there: usize,
    folder: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExportOpts {
    scale: f64,
    sound: bool,
    apply_edits: bool,
    metadata: bool,
}

#[tauri::command]
async fn export_photos(items: Vec<ExportItem>, dest: String, options: ExportOpts) -> CmdResult<ExportSummary> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut discs: Vec<Disc> = Vec::new();
        let mut chosen: Vec<(usize, Photo)> = Vec::new();
        for it in &items {
            let k = match discs.iter().position(|d| d.path == it.disc_path) {
                Some(k) => k,
                None => {
                    discs.push(library::scan_disc(Path::new(&it.disc_path)).ok_or("disc folder not found")?);
                    discs.len() - 1
                }
            };
            if let Some(p) = find_photo(&discs[k], &it.photo_id) {
                chosen.push((k, p));
            }
        }
        let refs: Vec<(&str, &Photo)> = chosen.iter().map(|(k, p)| (discs[*k].name.as_str(), p)).collect();
        let opts = export::ExportOptions {
            scale: options.scale.clamp(1.0, 4.0),
            sound: options.sound,
            apply_edits: options.apply_edits,
            metadata: options.metadata,
        };
        let r = export::export_photos(&refs, Path::new(&dest), &opts).map_err(err)?;
        Ok(ExportSummary { written: r.written.len(), already_there: r.already_there, folder: dest })
    })
    .await
    .map_err(err)?
}

// ---------- metadata edits ----------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PhotoPatch {
    photo_id: String,
    /// Compute auto-enhance levels for this photo and turn auto-enhance on.
    #[serde(default)]
    auto_enhance: bool,
    #[serde(flatten)]
    patch: EditPatch,
}

fn photo_pixels(photo: &Photo) -> Result<image::RgbImage, String> {
    let pmp = fs::read(&photo.pmp_path).map_err(err)?;
    md1_core::formats::extract_jpeg(&pmp)
        .and_then(md1_core::adjust::decode_jpeg)
        .ok_or_else(|| format!("{}: unreadable photo", photo.stem))
}

/// Apply edits (location, date, look, favourite, caption…) to photos of one disc; returns the
/// updated disc.
#[tauri::command]
async fn edit_photos(disc_path: String, patches: Vec<PhotoPatch>) -> CmdResult<Disc> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = PathBuf::from(&disc_path);
        let disc = library::scan_disc(&dir).ok_or("disc folder not found")?;
        let mut list = Vec::new();
        for mut p in patches {
            if p.auto_enhance {
                let photo = find_photo(&disc, &p.photo_id).ok_or("photo not found")?;
                p.patch.set_auto = Some(md1_core::adjust::auto_levels(&photo_pixels(&photo)?));
            }
            list.push((p.photo_id, p.patch));
        }
        edits::apply(&dir, &list)?;
        library::scan_disc(&dir).ok_or_else(|| "disc folder not found".to_string())
    })
    .await
    .map_err(err)?
}

/// Auto-enhance levels for one photo (the editor previews them before saving).
#[tauri::command]
async fn auto_levels(disc_path: String, photo_id: String) -> CmdResult<md1_core::edits::AutoLevels> {
    tauri::async_runtime::spawn_blocking(move || {
        let disc = library::scan_disc(Path::new(&disc_path)).ok_or("disc folder not found")?;
        let photo = find_photo(&disc, &photo_id).ok_or("photo not found")?;
        Ok(md1_core::adjust::auto_levels(&photo_pixels(&photo)?))
    })
    .await
    .map_err(err)?
}

/// Bytes of a file inside a library disc (the frontend decodes photos itself for the editor's
/// live preview; going through IPC avoids cross-origin canvas restrictions).
#[tauri::command]
async fn read_disc_file(app: AppHandle, path: String) -> Result<tauri::ipc::Response, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = fs::canonicalize(&path).map_err(err)?;
        let allowed = disc_paths(&app).into_iter().filter_map(|d| fs::canonicalize(d).ok()).any(|d| p.starts_with(d));
        if !allowed {
            return Err("not a library file".to_string());
        }
        fs::read(&p).map(tauri::ipc::Response::new).map_err(err)
    })
    .await
    .map_err(err)?
}

// ---------- places & maps (OpenStreetMap: Nominatim geocoder, standard tiles) ----------

const USER_AGENT: &str = concat!(
    "MD1Studio/",
    env!("CARGO_PKG_VERSION"),
    " (desktop app for the Sony DSC-MD1; https://github.com/DevinMadeThat/md1-studio)"
);

/// Nominatim's usage policy: at most one request per second, identified by User-Agent.
static LAST_GEOCODE: Mutex<Option<Instant>> = Mutex::new(None);

fn polite_wait() {
    let mut last = LAST_GEOCODE.lock().unwrap();
    if let Some(t) = *last {
        let since = t.elapsed();
        if since < Duration::from_millis(1100) {
            std::thread::sleep(Duration::from_millis(1100) - since);
        }
    }
    *last = Some(Instant::now());
}

fn url_encode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            b' ' => "+".to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

fn get_json(url: &str) -> Result<serde_json::Value, String> {
    polite_wait();
    let mut resp = ureq::get(url)
        .header("User-Agent", USER_AGENT)
        .header("Accept-Language", "en")
        .call()
        .map_err(|e| format!("Place search failed: {e}"))?;
    resp.body_mut().read_json::<serde_json::Value>().map_err(err)
}

#[derive(Serialize)]
struct Place {
    name: String,
    lat: f64,
    lon: f64,
}

#[tauri::command]
async fn geocode(query: String) -> CmdResult<Vec<Place>> {
    tauri::async_runtime::spawn_blocking(move || {
        let url = format!(
            "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&q={}",
            url_encode(query.trim())
        );
        let v = get_json(&url)?;
        Ok(v.as_array()
            .into_iter()
            .flatten()
            .filter_map(|p| {
                Some(Place {
                    name: p["display_name"].as_str()?.to_string(),
                    lat: p["lat"].as_str()?.parse().ok()?,
                    lon: p["lon"].as_str()?.parse().ok()?,
                })
            })
            .collect())
    })
    .await
    .map_err(err)?
}

/// Name of the place at a coordinate (best effort; None when offline or nothing is there).
#[tauri::command]
async fn reverse_geocode(lat: f64, lon: f64) -> CmdResult<Option<String>> {
    tauri::async_runtime::spawn_blocking(move || {
        let url = format!("https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=17&lat={lat}&lon={lon}");
        Ok(get_json(&url).ok().and_then(|v| v["display_name"].as_str().map(str::to_string)))
    })
    .await
    .map_err(err)?
}

/// Follow a short map link (maps.app.goo.gl/…, goo.gl/maps/…) to the full URL, which carries
/// the coordinates. Only http(s) links; at most 5 redirects.
#[tauri::command]
async fn expand_url(url: String) -> CmdResult<String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut current = url.trim().to_string();
        for _ in 0..5 {
            if !(current.starts_with("https://") || current.starts_with("http://")) {
                break;
            }
            let resp = ureq::get(&current)
                .header("User-Agent", USER_AGENT)
                .config()
                .max_redirects(0)
                .http_status_as_error(false)
                .build()
                .call()
                .map_err(err)?;
            match resp.headers().get("location").and_then(|v| v.to_str().ok()) {
                Some(next) if resp.status().is_redirection() => current = next.to_string(),
                _ => break,
            }
        }
        Ok(current)
    })
    .await
    .map_err(err)?
}

/// One 256×256 OpenStreetMap tile (PNG), cached on disk.
#[tauri::command]
async fn map_tile(app: AppHandle, z: u32, x: u32, y: u32) -> Result<tauri::ipc::Response, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if z > 19 || x >= 1 << z || y >= 1 << z {
            return Err("bad tile".to_string());
        }
        let cache = app.path().app_cache_dir().map_err(err)?.join("tiles").join(format!("{z}/{x}/{y}.png"));
        if let Ok(b) = fs::read(&cache) {
            return Ok(tauri::ipc::Response::new(b));
        }
        let mut resp = ureq::get(&format!("https://tile.openstreetmap.org/{z}/{x}/{y}.png"))
            .header("User-Agent", USER_AGENT)
            .call()
            .map_err(err)?;
        let bytes = resp.body_mut().read_to_vec().map_err(err)?;
        let _ = fs::create_dir_all(cache.parent().unwrap());
        let _ = fs::write(&cache, &bytes);
        Ok(tauri::ipc::Response::new(bytes))
    })
    .await
    .map_err(err)?
}

/// Self-test: with MD1_DIAG=1 the frontend checks binary IPC, photo decoding, map tiles and asset
/// fetches from inside the real web view and reports here (see app/README.md).
#[tauri::command]
fn diag_enabled() -> bool {
    std::env::var("MD1_DIAG").is_ok()
}

/// With MD1_DIAG_PORT (e.g. a fake camera's pty), the self-test also connects and browses.
#[tauri::command]
fn diag_port() -> Option<String> {
    std::env::var("MD1_DIAG_PORT").ok()
}

#[tauri::command]
fn diag_report(text: String) {
    eprintln!("DIAG {text}");
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState::default())
        .setup(|app| {
            let handle = app.handle().clone();
            let settings: Settings = fs::read(settings_path(&handle))
                .ok()
                .and_then(|b| serde_json::from_slice(&b).ok())
                .unwrap_or_default();
            let lib = library_dir(&handle, &settings);
            let _ = fs::create_dir_all(&lib);
            allow_assets(&handle, &lib);
            for d in &settings.external_discs {
                allow_assets(&handle, Path::new(d));
            }
            *app.state::<AppState>().settings.lock().unwrap() = settings;
            Ok(())
        })
        .on_window_event(|window, event| {
            // Leave the camera tidy (Sony's session end) when the app closes.
            if let tauri::WindowEvent::Destroyed = event {
                if let Some(state) = window.try_state::<AppState>() {
                    if let Ok(mut slot) = state.session.try_lock() {
                        if let Some(mut s) = slot.take() {
                            let _ = s.cam.disconnect();
                        }
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_settings,
            set_library_dir,
            list_discs,
            add_disc_folder,
            remove_disc_folder,
            rename_disc,
            list_ports,
            connect,
            disconnect,
            camera_status,
            cancel_import,
            browse_camera,
            download_photos,
            export_photos,
            edit_photos,
            auto_levels,
            read_disc_file,
            geocode,
            reverse_geocode,
            map_tile,
            expand_url,
            diag_enabled,
            diag_port,
            diag_report,
        ])
        .run(tauri::generate_context!())
        .expect("error while running MD1 Studio");
}
