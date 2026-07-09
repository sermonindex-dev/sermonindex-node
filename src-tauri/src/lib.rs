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
}

impl TorrentState {
    fn new() -> Self {
        Self { handle: None }
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
    let handle = torrent_node::start(data_dir, download_dir).await?;
    let info = handle.info();
    ts.handle = Some(Arc::new(handle));
    log::info!("[Torrent] Session started");
    Ok(info)
}

/// Stop the BitTorrent session
#[tauri::command]
async fn torrent_stop(state: tauri::State<'_, Arc<Mutex<TorrentState>>>) -> Result<(), String> {
    let mut ts = state.lock().await;
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
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
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
                            if let Some(window) = app_handle.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                        "network" => {
                            // Show window and navigate to settings page
                            if let Some(window) = app_handle.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.set_focus();
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
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                })
                .build(app)?;

            Ok(())
        })
        .on_window_event(|window, event| {
            // Hide window instead of closing — keep running in tray
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
