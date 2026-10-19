//! MD1 Studio backend: Tauri commands over md1-core.
//!
//! The camera session lives in `AppState::session`; every camera operation runs on a blocking
//! worker thread and holds that lock for its duration, so commands never interleave on the wire.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use md1_core::camera::{self, Camera, Connection, Status, VolumeInfo};
use md1_core::import::{self, DiscMeta, ImportEvent, ImportOptions};
use md1_core::library::{self, Disc, Photo};
use md1_core::transport::{self, PortInfo};
use md1_core::{export, Error};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

const FAST_BAUD: u32 = 115200;

struct Session {
    cam: Camera,
    conn: Connection,
    volume: Option<VolumeInfo>,
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
        *slot = Some(Session { cam, conn, volume });
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

/// Copy the disc in the camera into the library (or into `into`, an existing disc folder).
#[tauri::command]
async fn import_disc(app: AppHandle, name: String, into: Option<String>) -> CmdResult<Disc> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        state.cancel.store(false, Ordering::SeqCst);
        let mut slot = state.session.lock().unwrap();
        let session = slot.as_mut().ok_or("The camera is not connected.")?;

        let dest = match into {
            Some(p) => PathBuf::from(p),
            None => {
                let lib = library_dir(&app, &state.settings.lock().unwrap());
                let base = sanitize(&name);
                let mut d = lib.join(&base);
                let mut k = 2;
                while d.exists() {
                    d = lib.join(format!("{base} {k}"));
                    k += 1;
                }
                d
            }
        };
        fs::create_dir_all(&dest).map_err(err)?;
        allow_assets(&app, &dest);
        if let Some(parent) = dest.parent() {
            allow_assets(&app, parent);
        }

        let opts = ImportOptions { disc_dir: dest.clone(), name };
        let result = import::import_disc(&mut session.cam, &opts, &mut |ev: ImportEvent| {
            let _ = app.emit("import-event", &ev);
            if state.cancel.load(Ordering::SeqCst) {
                Err(Error::Cancelled)
            } else {
                Ok(())
            }
        });
        match result {
            Ok(_) => library::scan_disc(&dest).ok_or_else(|| "import finished but the folder is unreadable".into()),
            Err(Error::Cancelled) => {
                session.cam.abort();
                Err("Import cancelled. Files copied so far are kept; importing again resumes.".into())
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

#[tauri::command]
async fn export_photos(items: Vec<ExportItem>, dest: String, exif: bool) -> CmdResult<ExportSummary> {
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
        let r = export::export_photos(&refs, Path::new(&dest), exif).map_err(err)?;
        Ok(ExportSummary { written: r.written.len(), already_there: r.already_there, folder: dest })
    })
    .await
    .map_err(err)?
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
            import_disc,
            export_photos,
        ])
        .run(tauri::generate_context!())
        .expect("error while running MD1 Studio");
}
