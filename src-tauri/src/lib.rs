use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex as StdMutex;
use tauri::Manager;
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri_plugin_autostart::MacosLauncher;
use tokio::sync::Mutex;

mod natpmp;
mod torrent_node;

/// Global state for the BitTorrent session handle.
/// Arc so commands can clone it out and release the lock before long awaits.
struct TorrentState {
    handle: Option<Arc<torrent_node::TorrentHandle>>,
    /// Background liveness-ping task (see `spawn_liveness_ping`). Lives here
    /// beside the session handle so it starts and stops with the session.
    liveness: Option<tauri::async_runtime::JoinHandle<()>>,
}

impl TorrentState {
    fn new() -> Self {
        Self { handle: None, liveness: None }
    }
}

/// Clone the torrent handle out of state (releases the lock immediately).
async fn get_torrent_handle(
    state: &tauri::State<'_, Arc<Mutex<TorrentState>>>,
) -> Result<Arc<torrent_node::TorrentHandle>, String> {
    let ts = state.lock().await;
    ts.handle
        .clone()
        .ok_or_else(|| "Torrent session not running".to_string())
}

/// Get the app data directory for storing sermon files and catalog data
fn get_app_data_dir() -> PathBuf {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    home.join(".sermonindex")
}

/// Process-global override for where downloaded sermons are written.
/// When `None`, downloads default to `~/.sermonindex/downloads`. Seed nodes
/// pick a large external drive via `set_storage_dir`, which sets this (and
/// persists it to settings.json). `const Mutex::new` is valid since Rust
/// 1.63; this crate targets 1.77, so it compiles.
static STORAGE_OVERRIDE: StdMutex<Option<PathBuf>> = StdMutex::new(None);

/// The directory downloaded sermons are written to. Honours the storage
/// override (chosen drive) if one is set; otherwise the default downloads dir.
/// Every command that touches the downloads folder routes through this so that
/// changing the storage location takes effect everywhere at once.
fn downloads_dir() -> PathBuf {
    if let Ok(guard) = STORAGE_OVERRIDE.lock() {
        if let Some(p) = guard.as_ref() {
            return p.clone();
        }
    }
    get_app_data_dir().join("downloads")
}

// ── Local storage sharding ──────────────────────────────────────────────────
// Group downloaded files into subfolders by the first two alphanumeric chars of
// their id (the filename stem), e.g. downloads/ar/aRkm….mp3. A flat folder of
// 33k+ files is slow to enumerate — badly so on the exFAT external drives seed
// nodes use, and FAT32 has a hard ~65k-per-folder limit. Sharding keeps any one
// folder to a few thousand entries.
//
// This is a LOCAL detail only. A single-file torrent's `name` is the basename,
// so the folder a file lives in NEVER affects the infohash — the swarm identity
// is byte-for-byte identical whether the file is stored flat or sharded. The
// seed path points librqbit at the shard folder so it verifies existing bytes
// instead of re-fetching them.

/// Two-character shard folder name for a given filename.
pub(crate) fn shard_for(filename: &str) -> String {
    let stem = std::path::Path::new(filename)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(filename);
    let mut chars = stem.chars().filter(|c| c.is_ascii_alphanumeric());
    let a = chars.next().unwrap_or('0').to_ascii_lowercase();
    let b = chars.next().unwrap_or('0').to_ascii_lowercase();
    let mut s = String::with_capacity(2);
    s.push(a);
    s.push(b);
    s
}

/// Reduce a caller-supplied filename to its final path component, neutralizing
/// any directory traversal (`..`, absolute paths). Sermon files are always a
/// bare `<id>.<ext>`, so this never changes legitimate input — it just prevents
/// a crafted `filename` from escaping the downloads folder.
fn leaf(filename: &str) -> String {
    std::path::Path::new(filename)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_string()
}

/// Path a NEW download should be written to (sharded), creating the shard dir.
fn target_path(filename: &str) -> PathBuf {
    let name = leaf(filename);
    let dir = downloads_dir().join(shard_for(&name));
    let _ = fs::create_dir_all(&dir);
    dir.join(name)
}

/// Resolve an EXISTING download, tolerant of both layouts: prefer the sharded
/// path, fall back to the legacy flat path (files downloaded before sharding),
/// and if neither exists yet return the sharded target so callers can create it.
fn resolve_path(filename: &str) -> PathBuf {
    let name = leaf(filename);
    let sharded = downloads_dir().join(shard_for(&name)).join(&name);
    if sharded.exists() {
        return sharded;
    }
    let flat = downloads_dir().join(&name);
    if flat.exists() {
        return flat;
    }
    sharded
}

/// Get the downloads storage path
#[tauri::command]
fn get_storage_path() -> Result<String, String> {
    let path = downloads_dir();
    // Ensure the directory exists
    fs::create_dir_all(&path).map_err(|e| format!("Failed to create storage dir: {}", e))?;
    Ok(path.to_string_lossy().to_string())
}

/// Persist the chosen storage directory into settings.json (key "storage_dir"),
/// preserving any other settings. Reuses the same settings.json file the
/// frontend save_settings/load_settings commands read and write.
fn persist_storage_dir_setting(path: &str) -> Result<(), String> {
    let settings_path = get_app_data_dir().join("settings.json");
    fs::create_dir_all(settings_path.parent().unwrap())
        .map_err(|e| format!("Failed to create dir: {}", e))?;
    // Read the current settings (default to an empty object) and set the key.
    let mut value: serde_json::Value = if settings_path.exists() {
        let text = fs::read_to_string(&settings_path)
            .map_err(|e| format!("Failed to read settings: {}", e))?;
        serde_json::from_str(&text).unwrap_or_else(|_| serde_json::json!({}))
    } else {
        serde_json::json!({})
    };
    if !value.is_object() {
        value = serde_json::json!({});
    }
    if let Some(obj) = value.as_object_mut() {
        obj.insert("storage_dir".to_string(), serde_json::Value::String(path.to_string()));
    }
    let serialized = serde_json::to_string_pretty(&value)
        .map_err(|e| format!("Failed to serialize settings: {}", e))?;
    fs::write(&settings_path, serialized)
        .map_err(|e| format!("Failed to write settings: {}", e))?;
    Ok(())
}

/// Set the storage directory downloads are written to. Validates the path,
/// creates it, updates the process-global override, and persists it to
/// settings.json so it survives restarts. Only affects FUTURE downloads —
/// existing files are intentionally left where they are.
#[tauri::command]
fn set_storage_dir(path: String) -> Result<String, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("Storage path is empty".to_string());
    }
    let dir = PathBuf::from(trimmed);
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create storage dir: {}", e))?;
    // Update the in-memory override so all downloads_dir() callers pick it up.
    if let Ok(mut guard) = STORAGE_OVERRIDE.lock() {
        *guard = Some(dir.clone());
    } else {
        return Err("Failed to update storage override".to_string());
    }
    // Persist so the choice survives a restart (used by the setup closure).
    persist_storage_dir_setting(trimmed)?;
    Ok(dir.to_string_lossy().to_string())
}

/// Get the storage directory downloads are currently written to.
#[tauri::command]
fn get_storage_dir() -> String {
    downloads_dir().to_string_lossy().to_string()
}

/// Save a downloaded sermon file to disk from base64-encoded data
/// Using base64 to avoid massive JSON arrays that crash IPC for large files
#[tauri::command]
fn save_sermon_file(filename: String, data_b64: String) -> Result<String, String> {
    use base64::Engine;
    // Sharded write target (creates downloads/<shard>/ as needed).
    let file_path = target_path(&filename);
    let bytes = base64::engine::general_purpose::STANDARD.decode(&data_b64)
        .map_err(|e| format!("Failed to decode base64: {}", e))?;
    fs::write(&file_path, &bytes).map_err(|e| format!("Failed to write file: {}", e))?;
    Ok(file_path.to_string_lossy().to_string())
}

/// Create/truncate a file for chunked writing (used for large files)
#[tauri::command]
fn create_sermon_file(filename: String) -> Result<String, String> {
    // Sharded write target (creates downloads/<shard>/ as needed).
    let file_path = target_path(&filename);
    // Create or truncate the file
    fs::File::create(&file_path).map_err(|e| format!("Failed to create file: {}", e))?;
    Ok(file_path.to_string_lossy().to_string())
}

/// Append a base64-encoded chunk to an existing file
#[tauri::command]
fn append_sermon_chunk(filename: String, chunk_b64: String) -> Result<(), String> {
    use base64::Engine;
    use std::io::Write;
    let file_path = resolve_path(&filename);
    let bytes = base64::engine::general_purpose::STANDARD.decode(&chunk_b64)
        .map_err(|e| format!("Failed to decode base64 chunk: {}", e))?;
    let mut file = fs::OpenOptions::new()
        .append(true)
        .open(&file_path)
        .map_err(|e| format!("Failed to open file for append: {}", e))?;
    file.write_all(&bytes).map_err(|e| format!("Failed to append chunk: {}", e))?;
    Ok(())
}

/// Check if a downloaded file exists on disk
#[tauri::command]
fn check_file_exists(filename: String) -> bool {
    // Sharded location OR legacy flat location.
    resolve_path(&filename).exists()
}

/// List all downloaded files on disk
#[tauri::command]
fn list_downloaded_files() -> Result<Vec<String>, String> {
    let path = downloads_dir();
    if !path.exists() {
        return Ok(vec![]);
    }
    let mut files = vec![];
    let mut seen = std::collections::HashSet::new();
    if let Ok(entries) = fs::read_dir(&path) {
        for entry in entries.flatten() {
            if let Ok(meta) = entry.metadata() {
                if meta.is_file() {
                    // Legacy flat file in the downloads root.
                    if let Some(name) = entry.file_name().to_str() {
                        if seen.insert(name.to_string()) {
                            files.push(name.to_string());
                        }
                    }
                } else if meta.is_dir() {
                    // One level deep: a shard subfolder (downloads/<shard>/<file>).
                    // Skip "speaker-images" — those are exported portraits, not
                    // sermon files, and must never be mistaken for one.
                    if entry.file_name().to_str() == Some("speaker-images") {
                        continue;
                    }
                    if let Ok(sub) = fs::read_dir(entry.path()) {
                        for e2 in sub.flatten() {
                            if let Ok(m2) = e2.metadata() {
                                if m2.is_file() {
                                    if let Some(n2) = e2.file_name().to_str() {
                                        if seen.insert(n2.to_string()) {
                                            files.push(n2.to_string());
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    Ok(files)
}

/// Save catalog data to disk
#[tauri::command]
fn save_catalog(data: String) -> Result<(), String> {
    let path = get_app_data_dir().join("catalog.json");
    fs::create_dir_all(path.parent().unwrap()).map_err(|e| format!("Failed to create dir: {}", e))?;
    fs::write(&path, data).map_err(|e| format!("Failed to write catalog: {}", e))?;
    Ok(())
}

/// Load catalog data from disk
#[tauri::command]
fn load_catalog() -> Result<String, String> {
    let path = get_app_data_dir().join("catalog.json");
    if path.exists() {
        fs::read_to_string(&path).map_err(|e| format!("Failed to read catalog: {}", e))
    } else {
        Ok("[]".to_string())
    }
}

/// Save download state to disk
#[tauri::command]
fn save_download_state(data: String) -> Result<(), String> {
    let path = get_app_data_dir().join("download-state.json");
    fs::create_dir_all(path.parent().unwrap()).map_err(|e| format!("Failed to create dir: {}", e))?;
    fs::write(&path, data).map_err(|e| format!("Failed to write download state: {}", e))?;
    Ok(())
}

/// Load download state from disk
#[tauri::command]
fn load_download_state() -> Result<String, String> {
    let path = get_app_data_dir().join("download-state.json");
    if path.exists() {
        fs::read_to_string(&path).map_err(|e| format!("Failed to read download state: {}", e))
    } else {
        Ok("{}".to_string())
    }
}

/// Save app settings to disk
#[tauri::command]
fn save_settings(data: String) -> Result<(), String> {
    let path = get_app_data_dir().join("settings.json");
    fs::create_dir_all(path.parent().unwrap()).map_err(|e| format!("Failed to create dir: {}", e))?;
    fs::write(&path, data).map_err(|e| format!("Failed to write settings: {}", e))?;
    Ok(())
}

/// Load app settings from disk
#[tauri::command]
fn load_settings() -> Result<String, String> {
    let path = get_app_data_dir().join("settings.json");
    if path.exists() {
        fs::read_to_string(&path).map_err(|e| format!("Failed to read settings: {}", e))
    } else {
        Ok("{}".to_string())
    }
}

/// Read the persisted, opt-in BitTorrent upload-speed cap from settings.json.
/// Returns the limit in BYTES/sec (as NonZeroU32), or `None` (= unlimited) when
/// the cap is off, unset, or zero. The frontend persists two keys:
///   `upload_limit_enabled` (bool) and `upload_limit_kbps` (number, KB/s).
/// Reading it here lets `torrent_start` apply the cap atomically at session
/// creation, so it also covers re-enabling P2P from the toggle.
fn persisted_upload_limit_bps() -> Option<std::num::NonZeroU32> {
    let settings_path = get_app_data_dir().join("settings.json");
    let text = fs::read_to_string(&settings_path).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    // Off (or the key never set) → unlimited.
    if value.get("upload_limit_enabled").and_then(|v| v.as_bool()) != Some(true) {
        return None;
    }
    let kbps = value
        .get("upload_limit_kbps")
        .and_then(|v| v.as_f64())
        .unwrap_or(0.0);
    if kbps <= 0.0 {
        return None;
    }
    let bps = (kbps * 1024.0) as u64;
    std::num::NonZeroU32::new(bps.min(u32::MAX as u64) as u32)
}

// ============================================================
// Liveness ping — keeps the dashboard from showing us OFFLINE
// ============================================================
//
// The JS heartbeat runs on a 5-minute setInterval in the webview, which macOS
// App Nap throttles hard once the window is hidden. The dashboard treats a node
// as offline at `now - last_seen > 15min`, so a perfectly healthy seeding node
// would go dark. This task pings from the Rust side, which App Nap can't touch.
//
// It is deliberately NOT the heartbeat: `/api/node/ping` only bumps
// `last_seen` + `is_online`. It never rewrites the node's stats, never touches
// `shared_sermons`, and never counts toward `total_heartbeats` — so the two
// coexist and the JS beat remains the sole source of the full node record.

/// Ping cadence. Well under the dashboard's 15-minute offline cutoff, so a node
/// survives a couple of dropped pings before it is ever marked offline.
const LIVENESS_PING_SECS: u64 = 180;
const LIVENESS_PING_URL: &str = "https://app.sermonindex.net/api/node/ping";

/// The node id to ping with — but ONLY once the user has accepted the
/// first-launch conditions. The frontend mirrors that consent into
/// settings.json as `conditions_agreed` precisely because Rust cannot read the
/// localStorage flag the UI gates on. `None` means "stay completely silent":
/// no consent yet, no node id, or an unreadable/!malformed settings file.
fn liveness_ping_node_id() -> Option<String> {
    let settings_path = get_app_data_dir().join("settings.json");
    let text = fs::read_to_string(&settings_path).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    // Consent gate — anything other than an explicit `true` means don't transmit.
    if value.get("conditions_agreed").and_then(|v| v.as_bool()) != Some(true) {
        return None;
    }
    let node_id = value.get("node_id").and_then(|v| v.as_str())?.trim().to_string();
    if node_id.is_empty() {
        return None;
    }
    Some(node_id)
}

/// Spawn the liveness-ping loop. Every failure is swallowed and logged — this
/// task must never panic, never block startup, and never affect shutdown.
/// The returned handle is stored in `TorrentState` and aborted by `torrent_stop`.
fn spawn_liveness_ping() -> tauri::async_runtime::JoinHandle<()> {
    tauri::async_runtime::spawn(async move {
        // One client for the life of the task (connection reuse); short timeout
        // so a hung request can never stack up behind the next tick.
        let client = match reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(10))
            .build()
        {
            Ok(c) => c,
            Err(e) => {
                log::warn!("[Liveness] HTTP client build failed, ping disabled: {e}");
                return;
            }
        };

        let mut ticker = tokio::time::interval(std::time::Duration::from_secs(LIVENESS_PING_SECS));
        // If the machine sleeps, don't fire a burst of catch-up pings on wake.
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

        loop {
            // First tick completes immediately, so the session start is announced
            // right away and then every LIVENESS_PING_SECS thereafter.
            ticker.tick().await;

            // Re-read every tick: consent can be granted (or the node id created)
            // while the app is already running.
            let node_id = match liveness_ping_node_id() {
                Some(id) => id,
                None => continue, // no consent / no id → skip this tick entirely
            };

            // Hand-built body rather than `.json()` so we don't need reqwest's
            // optional `json` feature; serde_json handles escaping.
            let body = match serde_json::to_string(&serde_json::json!({ "node_id": node_id })) {
                Ok(b) => b,
                Err(e) => {
                    log::debug!("[Liveness] body encode failed: {e}");
                    continue;
                }
            };

            match client
                .post(LIVENESS_PING_URL)
                .header("Content-Type", "application/json")
                .body(body)
                .send()
                .await
            {
                Ok(resp) if resp.status().is_success() => {
                    log::debug!("[Liveness] ping ok");
                }
                Ok(resp) => {
                    // A 404 here just means the edge script hasn't been redeployed
                    // with /api/node/ping yet — harmless, the JS heartbeat carries on.
                    log::debug!("[Liveness] ping returned HTTP {}", resp.status());
                }
                Err(e) => {
                    log::debug!("[Liveness] ping failed (offline?): {e}");
                }
            }
        }
    })
}

/// Whether "Background Seeding" is enabled (keep running in the tray when the
/// window is closed). Defaults to `true` when unset, so existing installs and
/// first launches keep the current behaviour; only an explicit `false` changes
/// it. Read fresh on each window-close so toggling takes effect without a restart.
fn persisted_background_mode() -> bool {
    let settings_path = get_app_data_dir().join("settings.json");
    let text = match fs::read_to_string(&settings_path) {
        Ok(t) => t,
        Err(_) => return true,
    };
    let value: serde_json::Value = match serde_json::from_str(&text) {
        Ok(v) => v,
        Err(_) => return true,
    };
    value
        .get("background_mode")
        .and_then(|v| v.as_bool())
        .unwrap_or(true)
}

/// Bring the main window back to the user: un-minimize FIRST, then show, then
/// focus. Order matters — a window that was minimized (yellow button / taskbar)
/// is still "visible" as far as `show()` is concerned, so `show()` alone is a
/// no-op and the window appears stuck in the Dock/taskbar. Every path that
/// restores the window (tray menu, tray click, Dock reopen, second launch)
/// routes through here so they all behave identically.
fn show_main_window<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Get disk usage of the sermon downloads directory
#[tauri::command]
fn get_storage_usage() -> Result<StorageInfo, String> {
    let path = downloads_dir();
    if !path.exists() {
        return Ok(StorageInfo {
            bytes: 0,
            formatted: "0 B".to_string(),
            file_count: 0,
        });
    }

    let mut total_bytes: u64 = 0;
    let mut file_count: u64 = 0;

    fn walk_dir(dir: &std::path::Path, total: &mut u64, count: &mut u64) {
        if let Ok(entries) = fs::read_dir(dir) {
            for entry in entries.flatten() {
                if let Ok(meta) = entry.metadata() {
                    if meta.is_file() {
                        *total += meta.len();
                        *count += 1;
                    } else if meta.is_dir() {
                        walk_dir(&entry.path(), total, count);
                    }
                }
            }
        }
    }

    walk_dir(&path, &mut total_bytes, &mut file_count);

    Ok(StorageInfo {
        bytes: total_bytes,
        formatted: format_bytes(total_bytes),
        file_count,
    })
}

#[derive(Serialize, Deserialize)]
struct StorageInfo {
    bytes: u64,
    formatted: String,
    file_count: u64,
}

fn format_bytes(bytes: u64) -> String {
    if bytes == 0 {
        return "0 B".to_string();
    }
    let units = ["B", "KB", "MB", "GB", "TB"];
    let k = 1024_f64;
    let i = (bytes as f64).log(k).floor() as usize;
    let i = i.min(units.len() - 1);
    format!("{:.1} {}", bytes as f64 / k.powi(i as i32), units[i])
}

/// Get the app version
#[tauri::command]
fn get_app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// Open a folder in the system file manager
#[tauri::command]
fn open_folder(path: String) -> Result<(), String> {
    use std::process::Command;

    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("Failed to open folder: {}", e))?;
    }
    #[cfg(target_os = "windows")]
    {
        Command::new("explorer")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("Failed to open folder: {}", e))?;
    }
    #[cfg(target_os = "linux")]
    {
        Command::new("xdg-open")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("Failed to open folder: {}", e))?;
    }
    Ok(())
}

/// Open a downloaded file in the OS default application (e.g. QuickTime for
/// video). Used for videos whose codec the in-app WebView player can't decode
/// (Opus-in-MP4) but which native players handle fine. Resolves the file in the
/// downloads folder (shard- or flat-aware).
#[tauri::command]
fn open_downloaded_file(filename: String) -> Result<(), String> {
    use std::process::Command;
    let path = resolve_path(&filename);
    if !path.exists() {
        return Err("File not found".to_string());
    }
    let p = path.to_string_lossy().to_string();
    #[cfg(target_os = "macos")]
    {
        Command::new("open").arg(&p).spawn().map_err(|e| format!("Failed to open file: {}", e))?;
    }
    #[cfg(target_os = "windows")]
    {
        Command::new("cmd").args(["/C", "start", "", &p]).spawn().map_err(|e| format!("Failed to open file: {}", e))?;
    }
    #[cfg(target_os = "linux")]
    {
        Command::new("xdg-open").arg(&p).spawn().map_err(|e| format!("Failed to open file: {}", e))?;
    }
    Ok(())
}

/// Stream a remote media URL in a native media player rather than the browser.
/// Used for undownloaded video whose codec the in-app WebView can't decode
/// (Opus-in-MP4). NOTE: plain `open <https-url>` would launch the default *browser*
/// (also a WebView on macOS → same failure), so on macOS we target the system
/// media player explicitly.
#[tauri::command]
fn open_url_in_player(url: String) -> Result<(), String> {
    use std::process::Command;
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("Invalid URL".to_string());
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .args(["-a", "QuickTime Player", &url])
            .spawn()
            .map_err(|e| format!("Failed to open player: {}", e))?;
    }
    #[cfg(target_os = "windows")]
    {
        Command::new("cmd").args(["/C", "start", "", &url]).spawn().map_err(|e| format!("Failed to open player: {}", e))?;
    }
    #[cfg(target_os = "linux")]
    {
        Command::new("xdg-open").arg(&url).spawn().map_err(|e| format!("Failed to open player: {}", e))?;
    }
    Ok(())
}

/// Fetch a URL as text via the native HTTP client — bypasses webview CORS.
/// Restricted to SermonIndex-controlled hosts (used for the torrent master list).
#[tauri::command]
async fn fetch_text(url: String) -> Result<String, String> {
    const ALLOWED: &[&str] = &[
        "https://sermonindex1.b-cdn.net/",
        "https://sermonindex2.b-cdn.net/",
        "https://www.sermonindex.net/",
        "https://app.sermonindex.net/",
        "https://analytics.sermonindex.net/",
    ];
    if !ALLOWED.iter().any(|p| url.starts_with(p)) {
        return Err("URL not allowed".to_string());
    }
    let resp = reqwest::get(&url).await.map_err(|e| format!("fetch failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    resp.text().await.map_err(|e| format!("read failed: {e}"))
}

// ── Canonical master-list signature verification ────────────────────────────
// The master list is the trust anchor: it maps sermon -> infohash/magnet, and the
// app only ever joins swarms listed there. Serving it over HTTPS alone is not
// enough — anyone able to write to the CDN path could swap in false infohashes.
// So it is signed offline with an ed25519 key and published with a detached
// signature (master-list.json.sig, base64 of the 64-byte signature) over the RAW
// BYTES of the JSON. Raw bytes, not re-serialized JSON, so there is no
// canonicalization mismatch to exploit.
//
// The public key is compiled into this binary — replacing it requires shipping a
// new (code-signed) build, which is exactly the property we want.
//
// Generate with: node scripts/gen-masterlist-key.mjs   (see SECURITY.md)
const MASTER_LIST_PUBKEY_B64: &str = "ftEG8YFMh/SgY7kGKz2qGfZgKaLY/k4uvOzRgmJSk7o=";

/// Verify the detached ed25519 signature of the master list.
/// `data` is the exact JSON text as received; `signature_b64` is the contents of
/// master-list.json.sig. Returns Ok(true) only on a valid signature — every other
/// outcome is an Err, so the caller cannot mistake a failure for a pass.
#[tauri::command]
fn verify_master_list(data: String, signature_b64: String) -> Result<bool, String> {
    use base64::Engine;
    use ed25519_dalek::{Signature, VerifyingKey};

    if MASTER_LIST_PUBKEY_B64 == "REPLACE_ME_AFTER_KEYGEN" {
        return Err(
            "Master-list public key not configured — run scripts/gen-masterlist-key.mjs and \
             paste the public key into MASTER_LIST_PUBKEY_B64 (see SECURITY.md)"
                .to_string(),
        );
    }

    let pk_bytes = base64::engine::general_purpose::STANDARD
        .decode(MASTER_LIST_PUBKEY_B64.trim())
        .map_err(|e| format!("Bad master-list public key (not base64): {}", e))?;
    let pk_arr: [u8; 32] = pk_bytes
        .as_slice()
        .try_into()
        .map_err(|_| format!("Bad master-list public key: expected 32 bytes, got {}", pk_bytes.len()))?;
    let verifying_key = VerifyingKey::from_bytes(&pk_arr)
        .map_err(|e| format!("Bad master-list public key: {}", e))?;

    // Tolerate the trailing newline the signer writes.
    let sig_bytes = base64::engine::general_purpose::STANDARD
        .decode(signature_b64.trim())
        .map_err(|e| format!("Signature is not valid base64: {}", e))?;
    let signature = Signature::from_slice(&sig_bytes)
        .map_err(|e| format!("Malformed signature: {}", e))?;

    // verify_strict rejects weak/small-order keys that plain verify would accept.
    verifying_key
        .verify_strict(data.as_bytes(), &signature)
        .map_err(|_| "Master list signature INVALID — refusing to trust this list".to_string())?;

    Ok(true)
}

/// Open a URL in the system default browser (used by the Donate banner)
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    if !url.starts_with("https://") && !url.starts_with("http://") {
        return Err("Only http(s) URLs allowed".to_string());
    }
    use std::process::Command;
    #[cfg(target_os = "macos")]
    let res = Command::new("open").arg(&url).spawn();
    #[cfg(target_os = "windows")]
    let res = Command::new("cmd").args(["/C", "start", "", &url]).spawn();
    #[cfg(target_os = "linux")]
    let res = Command::new("xdg-open").arg(&url).spawn();
    res.map_err(|e| format!("Failed to open URL: {}", e))?;
    Ok(())
}

// ─── Global IPv6 discovery (for the inbound-reachability probe) ─────────────
//
// The node binds dual-stack `[::]:42800`, so on a connection with real IPv6 it
// can accept IPv6 peers even when IPv4 inbound is impossible (CGNAT: Starlink,
// T-Mobile Home Internet, most mobile broadband). To *measure* that honestly the
// edge probe has to dial our IPv6 address back, which means we first have to
// know which address the outside world should dial.

/// Well-known global IPv6 resolvers used purely as *route-selection* targets.
/// Nothing is ever sent to them: a connected UDP socket only records a
/// destination locally so the kernel can pick a route and a source address.
const V6_ROUTE_TARGETS: [&str; 2] = [
    "[2001:4860:4860::8888]:53", // Google Public DNS
    "[2606:4700:4700::1111]:53", // Cloudflare
];

/// Could a peer somewhere else on the public internet actually dial this
/// address? Everything below is a hand-check of the reserved ranges, because
/// `Ipv6Addr::is_global()` is unstable on stable Rust and must not be used.
fn is_globally_routable_v6(ip: &std::net::Ipv6Addr) -> bool {
    // ::1 (loopback), :: (unspecified) and ff00::/8 (multicast) all have stable
    // std helpers, so use them rather than re-deriving the bit patterns.
    if ip.is_loopback() || ip.is_unspecified() || ip.is_multicast() {
        return false;
    }

    let o = ip.octets();   // 16 bytes, network order
    let s = ip.segments(); // 8 u16 groups, network order

    // Link-local, fe80::/10. A /10 fixes the top 10 bits of the address, which
    // all live in the first 16-bit group. 0xffc0 == 1111_1111_1100_0000 keeps
    // exactly those 10 bits; the prefix value is 0xfe80. This still matches
    // febf:: (the last address in the block) and does NOT match fec0::
    // (site-local, handled separately just below).
    if s[0] & 0xffc0 == 0xfe80 {
        return false;
    }

    // Deprecated site-local, fec0::/10 (RFC 3879). Same /10 mask as link-local
    // (0xffc0 keeps the top 10 bits); the prefix value is 0xfec0. Formally
    // abandoned and never routed on the public internet, so it can't be dialled.
    if s[0] & 0xffc0 == 0xfec0 {
        return false;
    }

    // Unique-local, fc00::/7. A /7 fixes the top 7 bits, which live entirely in
    // the first octet. 0xfe == 1111_1110 keeps those 7 bits; the prefix value is
    // 0xfc == 1111_1100. So both fc00::/8 and fd00::/8 match, which is right —
    // the /7 covers the pair. These are private, never routed between sites.
    if o[0] & 0xfe == 0xfc {
        return false;
    }

    // IPv4-mapped, ::ffff:0:0/96 — 80 zero bits, then 16 one bits, then the
    // IPv4 address. Bytes 0..=9 must be zero and bytes 10,11 must be 0xff.
    if o[..10].iter().all(|&b| b == 0) && o[10] == 0xff && o[11] == 0xff {
        return false;
    }

    // IPv4-compatible ::a.b.c.d (deprecated) and anything else in ::/96 —
    // 96 leading zero bits, i.e. the first 12 bytes are all zero.
    if o[..12].iter().all(|&b| b == 0) {
        return false;
    }

    // Documentation prefix 2001:db8::/32 — reserved for examples, never routed.
    if s[0] == 0x2001 && s[1] == 0x0db8 {
        return false;
    }

    true
}

/// This machine's globally-routable IPv6 source address(es), or an empty vec.
///
/// Uses the dependency-free "connected UDP socket" trick: binding `[::]:0` and
/// then `connect()`ing to a global address SENDS NO PACKETS — `connect` on a UDP
/// socket only stores the peer locally, which forces the OS to run its route
/// lookup and bind the source address it would really use for global IPv6
/// egress. `local_addr()` then reports exactly the address a remote peer should
/// dial. Every failure mode (no IPv6 stack, no default route, no global address)
/// simply yields fewer entries; this never errors.
#[tauri::command]
fn local_ipv6() -> Vec<String> {
    use std::net::{SocketAddr, UdpSocket};
    let mut found: Vec<String> = Vec::new();
    for target in V6_ROUTE_TARGETS {
        let sock = match UdpSocket::bind("[::]:0") {
            Ok(s) => s,
            Err(_) => continue, // no IPv6 stack at all
        };
        if sock.connect(target).is_err() {
            continue; // no route to global IPv6
        }
        if let Ok(SocketAddr::V6(v6)) = sock.local_addr() {
            let ip = *v6.ip();
            if is_globally_routable_v6(&ip) {
                let s = ip.to_string();
                if !found.contains(&s) {
                    found.push(s);
                }
            }
        }
    }
    found
}

/// Delete a downloaded sermon file
#[tauri::command]
fn delete_sermon_file(filename: String) -> Result<(), String> {
    // Remove from BOTH possible layouts so a file can't linger in one and be
    // re-adopted as an orphan. Deletion is idempotent — absent is not an error.
    let name = leaf(&filename);
    let sharded = downloads_dir().join(shard_for(&name)).join(&name);
    let flat = downloads_dir().join(&name);
    for p in [sharded, flat] {
        if p.exists() {
            fs::remove_file(&p).map_err(|e| format!("Failed to delete file: {}", e))?;
        }
    }
    Ok(())
}

/// Get file size of a downloaded sermon (for integrity checks)
#[tauri::command]
fn get_file_size(filename: String) -> Result<u64, String> {
    let path = resolve_path(&filename);
    if !path.exists() {
        return Err("File not found".to_string());
    }
    let meta = fs::metadata(&path).map_err(|e| format!("Failed to read metadata: {}", e))?;
    Ok(meta.len())
}

/// Get the absolute file path of a downloaded sermon (for local playback via asset protocol)
#[tauri::command]
fn get_sermon_file_path(filename: String) -> Result<String, String> {
    let path = resolve_path(&filename);
    if !path.exists() {
        return Err("File not found".to_string());
    }
    Ok(path.to_string_lossy().to_string())
}

/// Sanitize a string so it's safe as a file/folder name on all platforms.
fn sanitize_name(s: &str) -> String {
    let cleaned: String = s
        .chars()
        .map(|c| if "/\\:*?\"<>|".contains(c) || c.is_control() { '-' } else { c })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.').to_string();
    let mut out = if trimmed.is_empty() { "Unknown".to_string() } else { trimmed };
    out.truncate(120);
    out
}

/// The base folder exports are written into (Desktop, or home if no Desktop).
fn export_base_dir() -> PathBuf {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    let desktop = home.join("Desktop");
    if desktop.exists() { desktop } else { home }
}

/// Export ONE downloaded sermon into Desktop/<Speaker>/<Title>.<ext>.
/// Copies (not hardlinks) so it works across drives; returns the speaker folder.
#[tauri::command]
fn export_sermon(filename: String, speaker: String, title: String) -> Result<String, String> {
    let src = resolve_path(&filename);
    if !src.exists() {
        return Err("Source file not found".to_string());
    }
    let ext = std::path::Path::new(&filename)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("mp3")
        .to_string();
    let dir = export_base_dir().join(sanitize_name(&speaker));
    fs::create_dir_all(&dir).map_err(|e| format!("create dir: {e}"))?;
    let dest = dir.join(format!("{}.{}", sanitize_name(&title), ext));
    fs::copy(&src, &dest).map_err(|e| format!("Failed to export: {e}"))?;
    Ok(dir.to_string_lossy().to_string())
}

#[derive(Deserialize)]
struct ExportItem {
    filename: String,
    title: String,
}

#[derive(Serialize)]
struct ExportResult {
    folder: String,
    exported: usize,
    failed: usize,
}

/// Export ALL of a speaker's downloaded sermons into one Desktop/<Speaker>/ folder,
/// each named <Title>.<ext>. Titles that collide get the file id appended so
/// nothing is silently overwritten. Missing source files are counted as failed
/// rather than aborting the whole batch.
#[tauri::command]
fn export_speaker(speaker: String, items: Vec<ExportItem>) -> Result<ExportResult, String> {
    let dir = export_base_dir().join(sanitize_name(&speaker));
    fs::create_dir_all(&dir).map_err(|e| format!("create dir: {e}"))?;
    let mut exported = 0usize;
    let mut failed = 0usize;
    for it in &items {
        let src = resolve_path(&it.filename);
        if !src.exists() {
            failed += 1;
            continue;
        }
        let path = std::path::Path::new(&it.filename);
        let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("mp3").to_string();
        let base = sanitize_name(&it.title);
        let mut dest = dir.join(format!("{}.{}", base, ext));
        if dest.exists() {
            // Disambiguate duplicate titles with the (unique) file id stem.
            let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("copy");
            dest = dir.join(format!("{} [{}].{}", base, stem, ext));
        }
        match fs::copy(&src, &dest) {
            Ok(_) => exported += 1,
            Err(_) => failed += 1,
        }
    }
    Ok(ExportResult {
        folder: dir.to_string_lossy().to_string(),
        exported,
        failed,
    })
}

/// Download a speaker portrait natively (bypasses WebView CORS) and save it to
/// <downloads>/speaker-images/<name>.<ext>. Only the known SermonIndex image
/// hosts are allowed. Returns the saved file path.
#[tauri::command]
async fn download_speaker_image(url: String, name: String) -> Result<String, String> {
    const ALLOWED: &[&str] = &[
        "https://www.sermonindex.net/",
        "https://sermonindex1.b-cdn.net/",
        "https://sermonindex2.b-cdn.net/",
    ];
    if !ALLOWED.iter().any(|p| url.starts_with(p)) {
        return Err("URL not allowed".to_string());
    }
    let resp = reqwest::get(&url).await.map_err(|e| format!("fetch failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    let bytes = resp.bytes().await.map_err(|e| format!("read failed: {e}"))?;
    if bytes.len() < 100 {
        return Err("image not found".to_string());
    }
    let dir = downloads_dir().join("speaker-images");
    fs::create_dir_all(&dir).map_err(|e| format!("create dir: {e}"))?;
    // Extension from the URL path (alphanumeric, ≤4 chars), else png.
    let ext = url
        .split('?')
        .next()
        .and_then(|u| u.rsplit('.').next())
        .filter(|e| e.len() <= 4 && e.chars().all(|c| c.is_ascii_alphanumeric()))
        .unwrap_or("png");
    let dest = dir.join(format!("{}.{}", sanitize_name(&name), ext));
    fs::write(&dest, bytes.as_ref()).map_err(|e| format!("write failed: {e}"))?;
    Ok(dest.to_string_lossy().to_string())
}

/// Check available disk space at a given path
#[tauri::command]
fn check_disk_space(path: String) -> Result<DiskSpaceInfo, String> {
    use std::process::Command;

    // Use 'df' on macOS/Linux to check available space
    let output = Command::new("df")
        .arg("-k")
        .arg(&path)
        .output()
        .map_err(|e| format!("Failed to check disk space: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let lines: Vec<&str> = stdout.lines().collect();

    if lines.len() < 2 {
        return Err("Could not parse disk space info".to_string());
    }

    // Parse the second line (first is header)
    let parts: Vec<&str> = lines[1].split_whitespace().collect();
    if parts.len() < 4 {
        return Err("Could not parse disk space info".to_string());
    }

    let available_kb: u64 = parts[3].parse().unwrap_or(0);
    let available_bytes = available_kb * 1024;
    let available_tb = available_bytes as f64 / (1024.0 * 1024.0 * 1024.0 * 1024.0);

    Ok(DiskSpaceInfo {
        available_bytes,
        available_formatted: format_bytes(available_bytes),
        available_tb: format!("{:.2}", available_tb),
        has_enough: available_bytes >= 600_000_000_000, // 600 GB (library measured ~437 GB actual + headroom)
    })
}

#[derive(Serialize, Deserialize)]
struct DiskSpaceInfo {
    available_bytes: u64,
    available_formatted: String,
    available_tb: String,
    has_enough: bool,
}

// ============================================================
// BitTorrent Tauri Commands — exposed to the frontend via invoke()
// ============================================================

/// Start the BitTorrent session (DHT + trackers + UPnP)
#[tauri::command]
async fn torrent_start(
    state: tauri::State<'_, Arc<Mutex<TorrentState>>>,
) -> Result<torrent_node::SessionInfo, String> {
    let mut ts = state.lock().await;
    if let Some(handle) = ts.handle.as_ref() {
        return Ok(handle.info());
    }
    let data_dir = get_app_data_dir();
    // Route the torrent session's output through the configurable storage dir
    // so seeded/downloaded torrents land on the seed node's chosen drive.
    let download_dir = downloads_dir();
    // Apply the user's opt-in upload cap at creation (None = unlimited).
    let upload_bps = persisted_upload_limit_bps();
    let handle = torrent_node::start(data_dir, download_dir, upload_bps).await?;
    let info = handle.info();
    ts.handle = Some(Arc::new(handle));
    log::info!("[Torrent] Session started (upload cap: {:?} bytes/s)", upload_bps);
    // Start the Rust-side liveness ping alongside the session (once). It is
    // consent-gated internally, so spawning it here transmits nothing until the
    // user has accepted the conditions.
    if ts.liveness.is_none() {
        ts.liveness = Some(spawn_liveness_ping());
        log::info!("[Liveness] Ping task started ({}s interval)", LIVENESS_PING_SECS);
    }
    Ok(info)
}

/// Set the session-wide BitTorrent UPLOAD rate limit at runtime.
/// `bytes_per_sec == 0` means unlimited (removes the cap). Takes effect live on
/// the running session; if no session is running this is a no-op error the
/// frontend ignores (the cap is re-read from settings.json at next start).
#[tauri::command]
async fn set_upload_limit(
    state: tauri::State<'_, Arc<Mutex<TorrentState>>>,
    bytes_per_sec: u64,
) -> Result<(), String> {
    let handle = get_torrent_handle(&state).await?;
    handle.set_upload_limit(bytes_per_sec);
    log::info!("[Torrent] Upload cap set to {} bytes/s (0 = unlimited)", bytes_per_sec);
    Ok(())
}

/// Stop the BitTorrent session
#[tauri::command]
async fn torrent_stop(state: tauri::State<'_, Arc<Mutex<TorrentState>>>) -> Result<(), String> {
    let mut ts = state.lock().await;
    // Stop the liveness ping first — nothing should keep reporting us as online
    // once the session is going down.
    if let Some(task) = ts.liveness.take() {
        task.abort();
        log::info!("[Liveness] Ping task stopped");
    }
    if let Some(handle) = ts.handle.take() {
        handle.stop().await;
        log::info!("[Torrent] Session stopped");
    }
    Ok(())
}

/// Get session status (running, port, uptime, torrent count)
#[tauri::command]
async fn torrent_status(
    state: tauri::State<'_, Arc<Mutex<TorrentState>>>,
) -> Result<torrent_node::SessionInfo, String> {
    let ts = state.lock().await;
    match ts.handle.as_ref() {
        Some(handle) => Ok(handle.info()),
        None => Ok(torrent_node::SessionInfo {
            running: false,
            tcp_listen_port: None,
            uptime_secs: 0,
            torrent_count: 0,
            natpmp: "inactive".to_string(),
        }),
    }
}

/// Create a .torrent for a local file (absolute path) and seed it in place.
/// Returns { info_hash, magnet, torrent_file, name }.
#[tauri::command]
async fn torrent_seed_file(
    state: tauri::State<'_, Arc<Mutex<TorrentState>>>,
    file_path: String,
    name: Option<String>,
) -> Result<torrent_node::SeedResult, String> {
    let handle = get_torrent_handle(&state).await?;
    let torrents_dir = get_app_data_dir().join("torrents");
    handle
        .seed_file(PathBuf::from(&file_path).as_path(), name, &torrents_dir)
        .await
}

/// Seed a file that's already in the app's downloads folder (by filename).
#[tauri::command]
async fn torrent_seed_downloaded(
    state: tauri::State<'_, Arc<Mutex<TorrentState>>>,
    filename: String,
    name: Option<String>,
) -> Result<torrent_node::SeedResult, String> {
    let handle = get_torrent_handle(&state).await?;
    // Resolve to wherever the file actually is (shard or legacy flat). seed_file
    // uses this file's parent as librqbit's output folder, so seeding is
    // self-consistent with the shard layout.
    let file_path = resolve_path(&filename);
    let torrents_dir = get_app_data_dir().join("torrents");
    handle.seed_file(&file_path, name, &torrents_dir).await
}

/// Add a torrent by magnet link, .torrent URL, or local .torrent path.
/// Downloads into the app downloads folder, then seeds.
#[tauri::command]
async fn torrent_add(
    state: tauri::State<'_, Arc<Mutex<TorrentState>>>,
    source: String,
    filename: Option<String>,
) -> Result<torrent_node::AddResult, String> {
    let handle = get_torrent_handle(&state).await?;
    // When we know the target filename (seeding a file we just downloaded), point
    // librqbit at THAT file's shard folder so it verifies the existing bytes and
    // seeds, instead of re-downloading them from the CDN webseed into the flat
    // root. Without a filename (e.g. a pasted magnet), use the session default.
    let output_folder = filename.as_ref().map(|f| {
        resolve_path(f)
            .parent()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|| downloads_dir().to_string_lossy().to_string())
    });
    handle.add(&source, output_folder).await
}

/// List all torrents with live stats (progress, speeds, peers)
#[tauri::command]
async fn torrent_list(
    state: tauri::State<'_, Arc<Mutex<TorrentState>>>,
) -> Result<Vec<torrent_node::TorrentInfo>, String> {
    let handle = get_torrent_handle(&state).await?;
    Ok(handle.list())
}

/// Remove a torrent (optionally deleting its files)
#[tauri::command]
async fn torrent_remove(
    state: tauri::State<'_, Arc<Mutex<TorrentState>>>,
    id: usize,
    delete_files: bool,
) -> Result<(), String> {
    let handle = get_torrent_handle(&state).await?;
    handle.remove(id, delete_files).await
}

/// Prune persisted torrents whose backing file is no longer on disk.
/// Returns the number of torrents removed from the session.
#[tauri::command]
async fn torrent_prune_missing(
    state: tauri::State<'_, Arc<Mutex<TorrentState>>>,
) -> Result<usize, String> {
    let handle = get_torrent_handle(&state).await?;
    let downloads_dir = downloads_dir();
    handle.remove_missing(&downloads_dir).await
}

/// Session-wide stats (speeds, peer counts, uptime)
#[tauri::command]
async fn torrent_session_stats(
    state: tauri::State<'_, Arc<Mutex<TorrentState>>>,
) -> Result<serde_json::Value, String> {
    let handle = get_torrent_handle(&state).await?;
    Ok(handle.session_stats())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let torrent_state = Arc::new(Mutex::new(TorrentState::new()));

    tauri::Builder::default()
        // MUST be first: if another instance is already running, this one exits
        // and the existing window is shown instead (duplicate sessions corrupt
        // torrent state and confuse volunteers).
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // The first instance may be hidden in the tray or minimized — restore
            // it rather than leaving the user staring at nothing after re-launching.
            show_main_window(app);
        }))
        // Auto-updater: checks the CDN endpoint for signed releases; the
        // process plugin lets the frontend relaunch after installing one.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(torrent_state)
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec!["--minimized"]),
        ))
        .setup(|app| {
            // Create the data directory on startup
            let data_dir = get_app_data_dir();
            let _ = fs::create_dir_all(&data_dir);
            let _ = fs::create_dir_all(data_dir.join("downloads"));
            let _ = fs::create_dir_all(data_dir.join("torrents"));

            // Restore the seed node's chosen storage directory (if any) BEFORE
            // the torrent session can start, so downloads/seeding land on the
            // selected drive. Reads settings.json → "storage_dir".
            {
                let settings_path = data_dir.join("settings.json");
                if settings_path.exists() {
                    if let Ok(text) = fs::read_to_string(&settings_path) {
                        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
                            if let Some(dir) = value.get("storage_dir").and_then(|v| v.as_str()) {
                                let dir = dir.trim();
                                if !dir.is_empty() {
                                    let path = PathBuf::from(dir);
                                    let _ = fs::create_dir_all(&path);
                                    if let Ok(mut guard) = STORAGE_OVERRIDE.lock() {
                                        *guard = Some(path);
                                    }
                                    log::info!("[Storage] Using configured storage dir: {}", dir);
                                }
                            }
                        }
                    }
                }
            }

            // Enable logging in all builds (Info for release, Debug for dev)
            let log_level = if cfg!(debug_assertions) {
                log::LevelFilter::Debug
            } else {
                log::LevelFilter::Info
            };
            app.handle().plugin(
                tauri_plugin_log::Builder::default()
                    .level(log_level)
                    .build(),
            )?;

            // System tray — app keeps running in background when window is closed
            let node_status_item = MenuItemBuilder::with_id("node_status", "🟢 Node Running")
                .enabled(false)
                .build(app)?;
            let show_item = MenuItemBuilder::with_id("show", "Show SermonIndex")
                .build(app)?;
            let network_item = MenuItemBuilder::with_id("network", "Network Settings")
                .build(app)?;
            let quit_item = MenuItemBuilder::with_id("quit", "Quit")
                .build(app)?;

            let tray_menu = MenuBuilder::new(app)
                .item(&node_status_item)
                .separator()
                .item(&show_item)
                .item(&network_item)
                .separator()
                .item(&quit_item)
                .build()?;

            // Load tray icon (black seed glyph on transparent; template mode
            // below lets macOS recolor it for light/dark menu bars)
            let tray_icon = {
                let tray_icon_bytes = include_bytes!("../icons/tray-icon@2x.png");
                let img = image::load_from_memory(tray_icon_bytes)
                    .unwrap_or_else(|_| image::DynamicImage::new_rgba8(44, 44));
                let rgba = img.to_rgba8();
                let (w, h) = rgba.dimensions();
                tauri::image::Image::new_owned(rgba.into_raw(), w, h)
            };

            let _tray = TrayIconBuilder::new()
                .icon(tray_icon)
                // Template icon: macOS renders it black and auto-inverts on
                // dark menu bars, matching every native menu bar item.
                .icon_as_template(true)
                .tooltip("SermonIndex Node Software — Running")
                .menu(&tray_menu)
                .on_menu_event(move |app_handle, event| {
                    match event.id().as_ref() {
                        "show" => {
                            show_main_window(app_handle);
                        }
                        "network" => {
                            // Show window and navigate to settings page
                            show_main_window(app_handle);
                            if let Some(window) = app_handle.get_webview_window("main") {
                                let _ = window.eval("window.__navigateToSettings && window.__navigateToSettings()");
                            }
                        }
                        "quit" => {
                            app_handle.exit(0);
                        }
                        _ => {}
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    // Double-click or single click on tray to show window
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event {
                        show_main_window(tray.app_handle());
                    }
                })
                .build(app)?;

            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the window: honour the "Background Seeding" setting.
            // ON (default): hide to the tray and keep seeding/port-forwarding.
            // OFF: actually quit so the node stops sharing when the user closes it.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if persisted_background_mode() {
                    let _ = window.hide();
                    api.prevent_close();
                } else {
                    window.app_handle().exit(0);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_storage_path,
            set_storage_dir,
            get_storage_dir,
            save_catalog,
            load_catalog,
            save_download_state,
            load_download_state,
            save_settings,
            load_settings,
            get_storage_usage,
            get_app_version,
            check_disk_space,
            open_folder,
            open_downloaded_file,
            open_url_in_player,
            open_url,
            fetch_text,
            local_ipv6,
            verify_master_list,
            save_sermon_file,
            create_sermon_file,
            append_sermon_chunk,
            check_file_exists,
            list_downloaded_files,
            delete_sermon_file,
            get_file_size,
            get_sermon_file_path,
            export_sermon,
            export_speaker,
            download_speaker_image,
            // ── BitTorrent commands ──
            torrent_start,
            torrent_stop,
            torrent_status,
            torrent_seed_file,
            torrent_seed_downloaded,
            torrent_add,
            torrent_list,
            torrent_remove,
            torrent_prune_missing,
            torrent_session_stats,
            set_upload_limit,
        ])
        // Build (not run) so we can observe process-level RunEvents below.
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|_app_handle, _event| {
            // macOS: when the window is hidden to the tray (red-button close in
            // Background Seeding mode) the app stays in the Dock. Clicking the
            // Dock icon fires `Reopen`; re-show and focus the window so the Dock
            // behaves like the tray's "Show SermonIndex" item. Without this a
            // user who closed to the tray would click the Dock and see nothing.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = _event {
                show_main_window(_app_handle);
            }
        });
}
