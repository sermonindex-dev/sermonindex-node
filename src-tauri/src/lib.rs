use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::Manager;
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri_plugin_autostart::MacosLauncher;
use tokio::sync::Mutex;

mod bitswap;
mod ipfs_node;
mod natpmp;

/// Global state for the IPFS node handle
struct IpfsState {
    handle: Option<ipfs_node::IpfsHandle>,
}

impl IpfsState {
    fn new() -> Self {
        Self { handle: None }
    }
}

/// Get the app data directory for storing IPFS blocks and catalog data
fn get_app_data_dir() -> PathBuf {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    home.join(".sermonindex")
}

/// Get the downloads storage path
#[tauri::command]
fn get_storage_path() -> Result<String, String> {
    let path = get_app_data_dir().join("downloads");
    // Ensure the directory exists
    fs::create_dir_all(&path).map_err(|e| format!("Failed to create storage dir: {}", e))?;
    Ok(path.to_string_lossy().to_string())
}

/// Save a downloaded sermon file to disk from base64-encoded data
/// Using base64 to avoid massive JSON arrays that crash IPC for large files
#[tauri::command]
fn save_sermon_file(filename: String, data_b64: String) -> Result<String, String> {
    use base64::Engine;
    let path = get_app_data_dir().join("downloads");
    fs::create_dir_all(&path).map_err(|e| format!("Failed to create downloads dir: {}", e))?;
    let file_path = path.join(&filename);
    let bytes = base64::engine::general_purpose::STANDARD.decode(&data_b64)
        .map_err(|e| format!("Failed to decode base64: {}", e))?;
    fs::write(&file_path, &bytes).map_err(|e| format!("Failed to write file: {}", e))?;
    Ok(file_path.to_string_lossy().to_string())
}

/// Create/truncate a file for chunked writing (used for large files)
#[tauri::command]
fn create_sermon_file(filename: String) -> Result<String, String> {
    let path = get_app_data_dir().join("downloads");
    fs::create_dir_all(&path).map_err(|e| format!("Failed to create downloads dir: {}", e))?;
    let file_path = path.join(&filename);
    // Create or truncate the file
    fs::File::create(&file_path).map_err(|e| format!("Failed to create file: {}", e))?;
    Ok(file_path.to_string_lossy().to_string())
}

/// Append a base64-encoded chunk to an existing file
#[tauri::command]
fn append_sermon_chunk(filename: String, chunk_b64: String) -> Result<(), String> {
    use base64::Engine;
    use std::io::Write;
    let file_path = get_app_data_dir().join("downloads").join(&filename);
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
    let path = get_app_data_dir().join("downloads").join(&filename);
    path.exists()
}

/// List all downloaded files on disk
#[tauri::command]
fn list_downloaded_files() -> Result<Vec<String>, String> {
    let path = get_app_data_dir().join("downloads");
    if !path.exists() {
        return Ok(vec![]);
    }
    let mut files = vec![];
    if let Ok(entries) = fs::read_dir(&path) {
        for entry in entries.flatten() {
            if let Ok(meta) = entry.metadata() {
                if meta.is_file() {
                    if let Some(name) = entry.file_name().to_str() {
                        files.push(name.to_string());
                    }
                }
            }
        }
    }
    Ok(files)
}

/// Get the catalog cache file path
#[tauri::command]
fn get_catalog_path() -> Result<String, String> {
    let path = get_app_data_dir().join("catalog.json");
    Ok(path.to_string_lossy().to_string())
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

/// Get disk usage of the IPFS storage directory
#[tauri::command]
fn get_storage_usage() -> Result<StorageInfo, String> {
    let path = get_app_data_dir().join("ipfs");
    if !path.exists() {
        return Ok(StorageInfo {
            bytes: 0,
            formatted: "0 B".to_string(),
            file_count: 0,
        });
    }

    let mut total_bytes: u64 = 0;
    let mut file_count: u64 = 0;

    fn walk_dir(dir: &PathBuf, total: &mut u64, count: &mut u64) {
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

/// Delete a downloaded sermon file
#[tauri::command]
fn delete_sermon_file(filename: String) -> Result<(), String> {
    let path = get_app_data_dir().join("downloads").join(&filename);
    if path.exists() {
        fs::remove_file(&path).map_err(|e| format!("Failed to delete file: {}", e))?;
    }
    Ok(())
}

/// Get file size of a downloaded sermon (for integrity checks)
#[tauri::command]
fn get_file_size(filename: String) -> Result<u64, String> {
    let path = get_app_data_dir().join("downloads").join(&filename);
    if !path.exists() {
        return Err("File not found".to_string());
    }
    let meta = fs::metadata(&path).map_err(|e| format!("Failed to read metadata: {}", e))?;
    Ok(meta.len())
}

/// Get the absolute file path of a downloaded sermon (for local playback via asset protocol)
#[tauri::command]
fn get_sermon_file_path(filename: String) -> Result<String, String> {
    let path = get_app_data_dir().join("downloads").join(&filename);
    if !path.exists() {
        return Err("File not found".to_string());
    }
    Ok(path.to_string_lossy().to_string())
}

/// Export a downloaded sermon file to the user's Desktop with a readable name
#[tauri::command]
fn export_sermon_file(filename: String, dest_name: String) -> Result<String, String> {
    let src = get_app_data_dir().join("downloads").join(&filename);
    if !src.exists() {
        return Err("Source file not found".to_string());
    }
    let desktop = dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Desktop");
    if !desktop.exists() {
        // Fallback to home directory if Desktop doesn't exist
        let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
        let dest = home.join(&dest_name);
        fs::copy(&src, &dest).map_err(|e| format!("Failed to export: {}", e))?;
        return Ok(dest.to_string_lossy().to_string());
    }
    let dest = desktop.join(&dest_name);
    fs::copy(&src, &dest).map_err(|e| format!("Failed to export: {}", e))?;
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
        has_enough: available_bytes >= 2_200_000_000_000, // 2.2 TB
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
// IPFS Tauri Commands — exposed to the frontend via invoke()
// ============================================================

/// Start the native IPFS node
#[tauri::command]
async fn ipfs_start(state: tauri::State<'_, Arc<Mutex<IpfsState>>>) -> Result<String, String> {
    let mut ipfs = state.lock().await;
    if ipfs.handle.is_some() {
        return Ok("already_running".to_string());
    }

    // Read announce address from settings (for manual port-forward users)
    let announce_address = load_settings()
        .ok()
        .and_then(|json_str| serde_json::from_str::<serde_json::Value>(&json_str).ok())
        .and_then(|v| v.get("announceAddress").and_then(|a| a.as_str().map(String::from)))
        .filter(|s| !s.is_empty());

    let storage_path = get_app_data_dir().join("ipfs-native");
    let handle = ipfs_node::start_node(storage_path, announce_address).await?;
    let diag = handle.diagnostics().await;
    let peer_id = diag.peer_id.clone();
    ipfs.handle = Some(handle);

    log::info!("[IPFS] Native node started: {}", peer_id);
    Ok(peer_id)
}

/// Stop the native IPFS node
#[tauri::command]
async fn ipfs_stop(state: tauri::State<'_, Arc<Mutex<IpfsState>>>) -> Result<(), String> {
    let mut ipfs = state.lock().await;
    if let Some(handle) = ipfs.handle.take() {
        handle.stop().await;
        log::info!("[IPFS] Native node stopped");
    }
    Ok(())
}

/// Check if the IPFS node is running
#[tauri::command]
async fn ipfs_is_running(state: tauri::State<'_, Arc<Mutex<IpfsState>>>) -> Result<bool, String> {
    let ipfs = state.lock().await;
    Ok(ipfs.handle.is_some())
}

/// Add a file to IPFS (pin it). Takes base64-encoded data.
#[tauri::command]
async fn ipfs_add_file(
    state: tauri::State<'_, Arc<Mutex<IpfsState>>>,
    data_b64: String,
    sermon_id: Option<String>,
) -> Result<String, String> {
    use base64::Engine;
    let ipfs = state.lock().await;
    let handle = ipfs.handle.as_ref().ok_or("IPFS not running")?;

    let bytes = base64::engine::general_purpose::STANDARD.decode(&data_b64)
        .map_err(|e| format!("Invalid base64: {e}"))?;

    handle.add_file(bytes, sermon_id).await
}

/// Get a file from IPFS by CID. Returns base64-encoded data.
#[tauri::command]
async fn ipfs_get_file(
    state: tauri::State<'_, Arc<Mutex<IpfsState>>>,
    cid: String,
) -> Result<String, String> {
    use base64::Engine;
    let ipfs = state.lock().await;
    let handle = ipfs.handle.as_ref().ok_or("IPFS not running")?;

    let bytes = handle.get_file(cid).await?;
    Ok(base64::engine::general_purpose::STANDARD.encode(&bytes))
}

/// Announce/provide a CID on the DHT
#[tauri::command]
async fn ipfs_provide(
    state: tauri::State<'_, Arc<Mutex<IpfsState>>>,
    cid: String,
) -> Result<(), String> {
    let ipfs = state.lock().await;
    let handle = ipfs.handle.as_ref().ok_or("IPFS not running")?;
    handle.provide(cid).await
}

/// Get node diagnostics
#[tauri::command]
async fn ipfs_diagnostics(
    state: tauri::State<'_, Arc<Mutex<IpfsState>>>,
) -> Result<ipfs_node::NodeDiagnostics, String> {
    let ipfs = state.lock().await;
    let handle = ipfs.handle.as_ref().ok_or("IPFS not running")?;
    Ok(handle.diagnostics().await)
}

/// List all pinned CIDs
#[tauri::command]
async fn ipfs_list_pinned(
    state: tauri::State<'_, Arc<Mutex<IpfsState>>>,
) -> Result<Vec<String>, String> {
    let ipfs = state.lock().await;
    let handle = ipfs.handle.as_ref().ok_or("IPFS not running")?;
    Ok(handle.list_pinned().await)
}

/// Remove a pinned CID
#[tauri::command]
async fn ipfs_remove_pin(
    state: tauri::State<'_, Arc<Mutex<IpfsState>>>,
    cid: String,
) -> Result<(), String> {
    let ipfs = state.lock().await;
    let handle = ipfs.handle.as_ref().ok_or("IPFS not running")?;
    handle.remove_pin(cid).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Initialize tokio runtime for async IPFS operations
    let ipfs_state = Arc::new(Mutex::new(IpfsState::new()));

    tauri::Builder::default()
        .manage(ipfs_state)
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec!["--minimized"]),
        ))
        .setup(|app| {
            // Create the data directory on startup
            let data_dir = get_app_data_dir();
            let _ = fs::create_dir_all(&data_dir);
            let _ = fs::create_dir_all(data_dir.join("ipfs"));
            let _ = fs::create_dir_all(data_dir.join("downloads"));

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
            let node_status_item = MenuItemBuilder::with_id("node_status", "Node Running")
                .enabled(false)
                .build(app)?;
            let show_item = MenuItemBuilder::with_id("show", "Show SermonIndex")
                .build(app)?;
            let ipfs_item = MenuItemBuilder::with_id("ipfs", "IPFS Settings")
                .build(app)?;
            let quit_item = MenuItemBuilder::with_id("quit", "Quit")
                .build(app)?;

            let tray_menu = MenuBuilder::new(app)
                .item(&node_status_item)
                .separator()
                .item(&show_item)
                .item(&ipfs_item)
                .separator()
                .item(&quit_item)
                .build()?;

            // Load tray icon (white on transparent for menu bar)
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
                        "ipfs" => {
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
            get_catalog_path,
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
            save_sermon_file,
            create_sermon_file,
            append_sermon_chunk,
            check_file_exists,
            list_downloaded_files,
            delete_sermon_file,
            get_file_size,
            get_sermon_file_path,
            export_sermon_file,
            // ── Native IPFS commands ──
            ipfs_start,
            ipfs_stop,
            ipfs_is_running,
            ipfs_add_file,
            ipfs_get_file,
            ipfs_provide,
            ipfs_diagnostics,
            ipfs_list_pinned,
            ipfs_remove_pin,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
