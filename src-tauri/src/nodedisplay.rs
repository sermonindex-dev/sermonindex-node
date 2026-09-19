//! Node display — the CLI's dashboard, served by the GUI.
//!
//! BORROWED, DELIBERATELY. This is `sermonindex-node-cli/src/dashboard.rs` with
//! one change: where the CLI reads its `/stats` payload out of `Shared`, this
//! reads it out of a string the frontend pushes in. Everything else — the
//! std-only `TcpListener`, the two routes, the headers, the external-file
//! override — is the CLI's own proven code, kept as close to line-for-line as
//! the different state source allows.
//!
//! `assets/dashboard.html` is likewise a byte-for-byte copy of the CLI's file.
//! That is the whole point: the display a person sees on a Pi and the display
//! they see from the desktop app are not "the same design", they are the same
//! file. Any future change to the CLI's dashboard should be copied here rather
//! than reimplemented, and the external override below means it can be tried
//! without rebuilding either one.
//!
//! EXPOSURE, SAID PLAINLY. Like the CLI, this binds `0.0.0.0` — so the display
//! can be opened from a phone or a tablet on the same network, which is most of
//! why anyone wants it. That also means anyone on that network can see this
//! node's statistics. There is nothing private in them (counts, sizes, peer
//! numbers) and no way to control the node through them — the server is
//! read-only and serves exactly two paths. To make it local-only, change
//! `BIND_ADDR` to "127.0.0.1".

use std::io::{Read, Write};
use std::net::TcpListener;
use std::net::TcpStream;
use std::sync::{Mutex, OnceLock};

/// Same port the CLI uses. If it is taken — most likely because the CLI itself
/// is running on this machine — the next few are tried so the two can coexist.
const BASE_PORT: u16 = 8137;
const PORT_TRIES: u16 = 6;
const BIND_ADDR: &str = "0.0.0.0";

const HTML: &str = include_str!("../assets/dashboard.html");

/// The latest `/stats` payload, exactly as the frontend built it. Shaped to
/// match the CLI's `Shared::stats_json`, because the page parsing it is the
/// CLI's page.
fn payload() -> &'static Mutex<String> {
    static P: OnceLock<Mutex<String>> = OnceLock::new();
    P.get_or_init(|| Mutex::new("{}".to_string()))
}

/// The port we actually bound, once the server is up.
fn bound_port() -> &'static Mutex<Option<u16>> {
    static B: OnceLock<Mutex<Option<u16>>> = OnceLock::new();
    B.get_or_init(|| Mutex::new(None))
}

/// Serve an external dashboard.html next to the app's data if present, so the
/// display can be tweaked without recompiling — the CLI does the same.
fn page_html(override_path: Option<std::path::PathBuf>) -> String {
    if let Some(p) = override_path {
        if let Ok(s) = std::fs::read_to_string(p) {
            return s;
        }
    }
    HTML.to_string()
}

fn handle(mut stream: TcpStream, override_path: Option<std::path::PathBuf>) -> std::io::Result<()> {
    let mut buf = [0u8; 2048];
    let n = stream.read(&mut buf)?;
    let req = String::from_utf8_lossy(&buf[..n]);
    let path = req.split_whitespace().nth(1).unwrap_or("/");

    let (ctype, body) = if path.starts_with("/stats") {
        (
            "application/json",
            payload().lock().unwrap_or_else(|e| e.into_inner()).clone(),
        )
    } else {
        ("text/html; charset=utf-8", page_html(override_path))
    };

    let header = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: {ctype}\r\nCache-Control: no-store\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream.write_all(header.as_bytes())?;
    stream.write_all(body.as_bytes())?;
    stream.flush()
}

/// Start the server if it is not already running, and return its URL.
/// Idempotent: pressing the button twice opens a second browser tab, not a
/// second listener.
#[tauri::command]
pub fn node_display_start(app: tauri::AppHandle) -> Result<String, String> {
    if let Some(p) = *bound_port().lock().unwrap_or_else(|e| e.into_inner()) {
        return Ok(format!("http://127.0.0.1:{p}/"));
    }

    // Where a hand-edited dashboard.html may live, resolved once on the main
    // thread — `AppHandle` path lookups are cheap but this keeps the accept
    // loop free of them.
    let override_path = {
        use tauri::Manager;
        app.path()
            .app_data_dir()
            .ok()
            .map(|d| d.join("dashboard.html"))
    };

    let mut listener = None;
    let mut chosen = 0u16;
    for i in 0..PORT_TRIES {
        let p = BASE_PORT + i;
        match TcpListener::bind((BIND_ADDR, p)) {
            Ok(l) => {
                listener = Some(l);
                chosen = p;
                break;
            }
            Err(_) => continue,
        }
    }
    let listener = listener.ok_or_else(|| {
        format!(
            "Could not open a port for the node display (tried {}–{}). Another program may be using them.",
            BASE_PORT,
            BASE_PORT + PORT_TRIES - 1
        )
    })?;

    *bound_port().lock().unwrap_or_else(|e| e.into_inner()) = Some(chosen);

    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let op = override_path.clone();
            std::thread::spawn(move || {
                let _ = handle(stream, op);
            });
        }
    });

    log::info!("[node-display] serving on http://localhost:{chosen}/");
    Ok(format!("http://127.0.0.1:{chosen}/"))
}

/// The host meter, borrowed wholesale from the CLI (`src/system.rs`). It has to
/// live across calls because throughput is a delta between two readings.
fn meter() -> &'static Mutex<crate::system::Meter> {
    static M: OnceLock<Mutex<crate::system::Meter>> = OnceLock::new();
    M.get_or_init(|| Mutex::new(crate::system::Meter::new()))
}

/// Push the latest stats payload.
///
/// The frontend sends the half it knows — `node`, `network`, `trends`,
/// `history` — and this fills in `system` from the CLI's own meter. That split
/// is deliberate: CPU, temperature, memory and NIC throughput are host facts,
/// and a WebView cannot measure any of them. Asking the frontend for numbers it
/// would have to invent is how a dashboard starts lying.
#[tauri::command]
pub fn node_display_push(stats: String) {
    let merged = (|| -> Option<String> {
        let mut v: serde_json::Value = serde_json::from_str(&stats).ok()?;
        // `sample` wants the path whose filesystem should be reported, because
        // "disk used" on a seed node means the library's drive, not the boot
        // volume. The frontend puts it in the payload; if it is missing we fall
        // back to the root, which is still a true answer about *a* disk.
        let storage = v
            .get("node")
            .and_then(|n| n.get("storage_path"))
            .and_then(|x| x.as_str())
            .filter(|s| !s.is_empty())
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| std::path::PathBuf::from("/"));
        let snap = meter()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .sample(&storage);
        let up_bps = v
            .get("node")
            .and_then(|n| n.get("up_bps"))
            .and_then(|x| x.as_f64())
            .unwrap_or(snap.up_bps);
        let system = serde_json::json!({
            "cpu_pct": (snap.cpu_pct as f64 * 10.0).round() / 10.0,
            "temp_c": snap.temp_c.map(|t| (t as f64 * 10.0).round() / 10.0),
            "mem_used": snap.mem_used, "mem_total": snap.mem_total,
            "disk_used": snap.disk_used, "disk_total": snap.disk_total,
            "nic": snap.nic, "up_bps": up_bps, "down_bps": snap.down_bps,
        });
        v.as_object_mut()?.insert("system".to_string(), system);
        serde_json::to_string(&v).ok()
    })()
    .unwrap_or(stats);

    *payload().lock().unwrap_or_else(|e| e.into_inner()) = merged;
}

/// The URL if the server is running, so the UI can show it (for opening the
/// display on a phone on the same network) without starting anything.
#[tauri::command]
pub fn node_display_url() -> Option<String> {
    bound_port()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .map(|p| format!("http://127.0.0.1:{p}/"))
}
