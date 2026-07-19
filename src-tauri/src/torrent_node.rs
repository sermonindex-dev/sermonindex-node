//! SermonIndex Torrent Node — BitTorrent-based P2P sermon distribution.
//!
//! This replaces the hand-rolled libp2p/IPFS stack with librqbit, the engine
//! behind the rqbit client. Why BitTorrent:
//!   - Battle-tested mainline DHT (millions of nodes, no bootstrap infra of our own)
//!   - Public trackers as a second discovery mechanism
//!   - UPnP port forwarding (plus our own NAT-PMP/PCP fallback in `natpmp.rs`)
//!     to open an inbound port on home routers. NOTE: there is no hole punching
//!     here — librqbit implements neither BEP 55 nor uTP-based NAT traversal,
//!     and we deliberately run TCP-only (uTP is still marked unstable upstream).
//!     Inbound reachability therefore depends on UPnP / NAT-PMP / manual forward.
//!   - Volunteers can also seed with ANY standard torrent client (qBittorrent,
//!     Transmission, ...) using the same .torrent files / magnets
//!
//! Flow:
//!   Seeding:   torrent_seed_file(path)  -> creates .torrent, seeds it, returns magnet
//!   Fetching:  torrent_add(magnet/.torrent) -> downloads from swarm, then keeps seeding
//!
//! HTTP (Archive.org / Bunny CDN) remains the guaranteed fallback in the JS
//! downloadManager: download over HTTP if the swarm is empty, then seed the
//! completed file here so the swarm grows.

use std::collections::HashSet;
use std::num::NonZeroU32;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

use librqbit::api::TorrentIdOrHash;
use librqbit::limits::LimitsConfig;
use librqbit::spawn_utils::BlockingSpawner;
use librqbit::{
    create_torrent, AddTorrent, AddTorrentOptions, CreateTorrentOptions, ListenerMode,
    ListenerOptions, Session, SessionOptions,
};
use serde::Serialize;

/// Well-known public trackers. Used in addition to the mainline DHT.
/// These are announce-only rendezvous points — they never store file data.
pub const DEFAULT_TRACKERS: &[&str] = &[
    "udp://tracker.opentrackr.org:1337/announce",
    "udp://open.demonii.com:1337/announce",
    "udp://tracker.torrent.eu.org:451/announce",
    "udp://exodus.desync.com:6969/announce",
];

/// TCP listen port range. The first free port in this range is used and
/// forwarded via UPnP when possible.
///
/// librqbit 8 took this range directly (`listen_port_range`) and probed it
/// internally. librqbit 9 accepts only a single `listen_addr`, so `start()`
/// walks this range itself, retrying on "address already in use".
const LISTEN_PORT_RANGE: std::ops::Range<u16> = 42800..42840;

/// Blocking threads allowed for piece hashing during .torrent creation.
/// Matches librqbit's own internal default (DEFAULT_BLOCKING_THREADS_IF_NOT_SET).
const BLOCKING_THREADS: usize = 8;

pub struct TorrentHandle {
    pub session: Arc<Session>,
    started_at: Instant,
    /// NAT-PMP/PCP mapping status: "trying" | "mapped via <gw>" | "unavailable"
    natpmp_status: Arc<std::sync::Mutex<String>>,
    /// librqbit 9 requires an explicit blocking-thread spawner for
    /// `create_torrent` (it hashes pieces on blocking threads). Built once at
    /// session start so concurrent seeds share one concurrency limit.
    spawner: BlockingSpawner,
}

#[derive(Serialize, Clone)]
pub struct SessionInfo {
    pub running: bool,
    pub tcp_listen_port: Option<u16>,
    pub uptime_secs: u64,
    pub torrent_count: usize,
    /// "trying" | "mapped via <gateway>" | "unavailable"
    pub natpmp: String,
}

#[derive(Serialize)]
pub struct SeedResult {
    pub id: Option<usize>,
    pub info_hash: String,
    pub magnet: String,
    pub torrent_file: String,
    pub name: String,
}

#[derive(Serialize)]
pub struct AddResult {
    pub id: Option<usize>,
    pub info_hash: String,
    pub name: Option<String>,
}

#[derive(Serialize)]
pub struct TorrentInfo {
    pub id: usize,
    pub info_hash: String,
    pub name: Option<String>,
    /// Full librqbit stats: state, progress_bytes, total_bytes, finished,
    /// uploaded_bytes, live.{download_speed, upload_speed, snapshot.peer_stats}
    pub stats: serde_json::Value,
}

fn default_tracker_urls() -> HashSet<url::Url> {
    DEFAULT_TRACKERS
        .iter()
        .filter_map(|t| url::Url::parse(t).ok())
        .collect()
}

fn default_trackers_vec() -> Vec<String> {
    DEFAULT_TRACKERS.iter().map(|s| s.to_string()).collect()
}

/// Build a magnet URI from an info hash + display name, including our trackers.
pub fn build_magnet(info_hash: &str, name: &str) -> String {
    let mut magnet = format!(
        "magnet:?xt=urn:btih:{}&dn={}",
        info_hash,
        urlencoding::encode(name)
    );
    for t in DEFAULT_TRACKERS {
        magnet.push_str("&tr=");
        magnet.push_str(&urlencoding::encode(t));
    }
    magnet
}

/// True when a `Session::new_with_opts` failure is an "address already in use"
/// bind failure — the only class of error that retrying on another port fixes.
///
/// CAVEAT (verified against librqbit 9.0.0-rc.0): librqbit flattens the
/// underlying `io::Error` into anyhow context *strings*, so the typed
/// `downcast_ref::<io::Error>()` below never actually matches today. The string
/// match is what does the work. It covers the wording on all three platforms we
/// ship:
///   Linux/macOS -> "Address already in use"
///   Windows     -> "Only one usage of each socket address ... is normally permitted"
/// Any error we do NOT recognise is surfaced immediately instead of silently
/// retried, so an unexpected failure is loud rather than hidden behind 40
/// retries. If librqbit ever changes this wording the app fails to start with
/// the full error logged (and the existing self-healing restart retries) —
/// noisy, but never a silent wedge.
fn is_port_unavailable(e: &anyhow::Error) -> bool {
    if e.chain().any(|c| {
        c.downcast_ref::<std::io::Error>()
            .is_some_and(|io| io.kind() == std::io::ErrorKind::AddrInUse)
    }) {
        return true;
    }
    let text = format!("{e:#}").to_ascii_lowercase();
    text.contains("address already in use")
        || text.contains("address in use")
        || text.contains("eaddrinuse")
        || text.contains("only one usage of each socket address")
}

/// Build the session options for one bind attempt on `port`.
///
/// Rebuilt per attempt because `SessionOptions` is not `Clone`.
fn build_session_options(port: u16, upload_bps: Option<NonZeroU32>) -> SessionOptions {
    SessionOptions {
        fastresume: true,
        // Session-wide throttling. Only the UPLOAD side is capped (download_bps
        // stays None); the user's opt-in "Limit upload speed" setting feeds this.
        // librqbit applies this via a governor rate limiter before every upload.
        ratelimits: LimitsConfig {
            upload_bps,
            download_bps: None,
        },
        // NO torrent-list persistence. librqbit's own persistence would resume
        // every past torrent on start and RE-DOWNLOAD any file the user deleted
        // (canonical torrents have CDN webseeds, so deleted files silently came
        // back). Instead the app re-seeds exactly the files present on disk at
        // startup (downloadManager.reseedExisting) — the downloads folder is the
        // single source of truth, so deleting a file truly removes it.
        persistence: None,
        // librqbit 9 replaced `listen_port_range` + `enable_upnp_port_forwarding`
        // with this struct. It MUST be Some(..): `SessionOptions::listen`
        // defaults to None, which starts NO LISTENER AT ALL — the session would
        // still download but would never accept incoming peers, silently
        // killing our seeding usefulness.
        listen: Some(ListenerOptions {
            // TCP only. uTP exists in 9 but upstream still defaults to TcpOnly
            // with a "once uTP is stable" TODO, so we do not opt in.
            mode: ListenerMode::TcpOnly,
            // [::] — dual-stack, accepts IPv4-mapped connections too.
            listen_addr: (std::net::Ipv6Addr::UNSPECIFIED, port).into(),
            enable_upnp_port_forwarding: true,
            ipv4_only: false,
            ..Default::default()
        }),
        // Session-wide extra trackers, announced for every torrent.
        trackers: default_tracker_urls(),
        // Local Service Discovery is NEW in librqbit 9 and defaults to ON. It
        // multicasts on the user's LAN advertising which torrents this node
        // holds, so nearby nodes can peer directly at local speed. Genuinely
        // useful (e.g. several nodes in one church/office), but it is network
        // chatter nobody consented to and it reveals which sermons a machine is
        // sharing to everyone on the same network. Keep the v8 behaviour our
        // users actually agreed to; revisit later as an explicit opt-in setting.
        disable_local_service_discovery: true,
        // IMPORTANT: `..Default::default()` is load-bearing for DHT. In
        // librqbit 9 DHT is `dht: Option<DhtSessionConfig>` and **None DISABLES
        // DHT ENTIRELY** (session.rs: `if let Some(dht_config) = opts.dht.take()`).
        // SessionOptions' explicit Default impl sets
        // `dht: Some(DhtSessionConfig::default())`, and DhtSessionConfig::default()
        // sets `persistence: Some(..)`. That reproduces librqbit 8's
        // `disable_dht: false` + `disable_dht_persistence: false`.
        // DO NOT set `dht: None` here — it looks inert but turns off peer
        // discovery for the whole network.
        ..Default::default()
    }
}

/// Start the torrent session.
///  - `data_dir`   — ~/.sermonindex (session persistence + DHT cache live under it)
///  - `download_dir` — default output folder for fetched torrents (~/.sermonindex/downloads)
///  - `upload_bps`  — session-wide UPLOAD rate limit in bytes/sec, or `None` for
///                    unlimited. Applied atomically at session creation so a peer
///                    can never receive data above the cap even before the frontend
///                    has had a chance to (re)apply it.
pub async fn start(
    data_dir: PathBuf,
    download_dir: PathBuf,
    upload_bps: Option<NonZeroU32>,
) -> Result<TorrentHandle, String> {
    std::fs::create_dir_all(&download_dir)
        .map_err(|e| format!("Failed to create download dir: {e}"))?;
    // NOTE: we intentionally do NOT create a torrent-session/ dir — persistence
    // is disabled (see below), so it would just be an empty unused folder.
    let _ = &data_dir;

    // librqbit 9 binds exactly one port, so we walk LISTEN_PORT_RANGE ourselves
    // and retry when the port is taken (second instance, lingering TIME_WAIT
    // socket, unrelated app). librqbit 8 did this internally.
    let mut last_err: Option<String> = None;
    let mut session: Option<Arc<Session>> = None;

    for port in LISTEN_PORT_RANGE {
        match Session::new_with_opts(download_dir.clone(), build_session_options(port, upload_bps))
            .await
        {
            Ok(s) => {
                session = Some(s);
                log::info!("[Torrent] Session started on TCP port {port}");
                break;
            }
            Err(e) => {
                let detail = format!("{e:#}");
                if is_port_unavailable(&e) {
                    log::warn!("[Torrent] Port {port} unavailable ({detail}); trying next port");
                    last_err = Some(detail);
                    continue;
                }
                // Not a bind failure — changing the port cannot help, so surface
                // it immediately rather than burning 40 doomed session inits.
                return Err(format!("Failed to start torrent session: {detail}"));
            }
        }
    }

    let session = session.ok_or_else(|| {
        format!(
            "Failed to start torrent session: no free port in {}..{} (last error: {})",
            LISTEN_PORT_RANGE.start,
            LISTEN_PORT_RANGE.end,
            last_err.as_deref().unwrap_or("none")
        )
    })?;

    log::info!("[Torrent] Session listening on {:?}", session.listen_addr());

    // NAT-PMP/PCP fallback: librqbit already tries UPnP; many routers
    // (especially with UPnP disabled) accept NAT-PMP/PCP instead.
    // Runs in the background and renews the mapping every hour.
    let natpmp_status = Arc::new(std::sync::Mutex::new("trying".to_string()));
    if let Some(port) = session.listen_addr().map(|a| a.port()) {
        let status = natpmp_status.clone();
        tokio::spawn(async move {
            loop {
                match crate::natpmp::try_mapping(port, port).await {
                    Some(m) => {
                        log::info!(
                            "[Torrent] NAT-PMP/PCP mapped port {} via {}",
                            m.tcp_external_port, m.gateway
                        );
                        *status.lock().unwrap_or_else(|e| e.into_inner()) = format!("mapped via {}", m.gateway);
                        // Mapping lifetime is 2h — renew hourly.
                        tokio::time::sleep(std::time::Duration::from_secs(3600)).await;
                    }
                    None => {
                        *status.lock().unwrap_or_else(|e| e.into_inner()) = "unavailable".to_string();
                        // Router may appear later (network change) — retry in 30 min.
                        tokio::time::sleep(std::time::Duration::from_secs(1800)).await;
                    }
                }
            }
        });
    } else {
        *natpmp_status.lock().unwrap_or_else(|e| e.into_inner()) = "unavailable".to_string();
    }

    Ok(TorrentHandle {
        session,
        started_at: Instant::now(),
        natpmp_status,
        // Must be constructed inside the tokio runtime (it inspects the current
        // runtime flavor to decide whether block_in_place is legal).
        spawner: BlockingSpawner::new(BLOCKING_THREADS),
    })
}

impl TorrentHandle {
    pub async fn stop(&self) {
        self.session.stop().await;
    }

    pub fn info(&self) -> SessionInfo {
        let torrent_count = self.session.with_torrents(|iter| iter.count());
        SessionInfo {
            running: true,
            // Field name + u16 shape kept deliberately: the frontend
            // (heartbeat.js, ConnectionsPanel reachability probe) reads
            // `status.tcp_listen_port` as a plain port number.
            tcp_listen_port: self.session.listen_addr().map(|a| a.port()),
            uptime_secs: self.started_at.elapsed().as_secs(),
            torrent_count,
            natpmp: self.natpmp_status.lock().unwrap_or_else(|e| e.into_inner()).clone(),
        }
    }

    /// Apply a session-wide UPLOAD rate limit to the *running* session.
    /// `bytes_per_sec == 0` removes the cap (unlimited). Values above u32::MAX
    /// are clamped. `Session.ratelimits` is a public `librqbit::limits::Limits`
    /// whose `set_upload_bps` atomically swaps the active governor limiter, so
    /// the change takes effect live without restarting the session.
    pub fn set_upload_limit(&self, bytes_per_sec: u64) {
        let bps: Option<NonZeroU32> = if bytes_per_sec == 0 {
            None
        } else {
            NonZeroU32::new(bytes_per_sec.min(u32::MAX as u64) as u32)
        };
        self.session.ratelimits.set_upload_bps(bps);
    }

    /// Create a .torrent for an existing local file and start seeding it.
    /// The file is NOT copied — it is seeded in place from its parent folder.
    /// The .torrent file is saved into `torrents_dir` for sharing/publishing.
    pub async fn seed_file(
        &self,
        file_path: &Path,
        name: Option<String>,
        torrents_dir: &Path,
    ) -> Result<SeedResult, String> {
        if !file_path.is_file() {
            return Err(format!("Not a file: {}", file_path.display()));
        }
        let file_name = file_path
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or("Cannot determine file name")?
            .to_string();
        let display_name = name.unwrap_or_else(|| file_name.clone());

        // Hash the file into a torrent (2 MiB pieces by default).
        // librqbit 9 added the third `&BlockingSpawner` argument — hashing runs
        // on blocking threads and the caller now supplies the concurrency limit.
        let created = create_torrent(
            file_path,
            CreateTorrentOptions {
                name: Some(&display_name),
                ..Default::default()
            },
            &self.spawner,
        )
        .await
        .map_err(|e| format!("create_torrent failed: {e:#}"))?;

        let info_hash = created.info_hash().as_string();
        let bytes = created
            .as_bytes()
            .map_err(|e| format!("torrent serialize failed: {e:#}"))?;

        // Save the .torrent for publishing (catalog, website, other clients).
        std::fs::create_dir_all(torrents_dir)
            .map_err(|e| format!("Failed to create torrents dir: {e}"))?;
        let torrent_file = torrents_dir.join(format!("{info_hash}.torrent"));
        std::fs::write(&torrent_file, &bytes)
            .map_err(|e| format!("Failed to write .torrent: {e}"))?;

        // Seed in place: output folder = the file's parent directory.
        // overwrite:true makes librqbit hash-check the existing file instead
        // of refusing to touch it — it sees 100% complete and seeds.
        let output_folder = file_path
            .parent()
            .ok_or("File has no parent directory")?
            .to_string_lossy()
            .to_string();

        let response = self
            .session
            .add_torrent(
                AddTorrent::from_bytes(bytes),
                Some(AddTorrentOptions {
                    overwrite: true,
                    output_folder: Some(output_folder),
                    trackers: Some(default_trackers_vec()),
                    ..Default::default()
                }),
            )
            .await
            .map_err(|e| format!("add_torrent (seed) failed: {e:#}"))?;

        let id = response.into_handle().map(|h| h.id());

        log::info!("[Torrent] Seeding {display_name} ({info_hash})");

        Ok(SeedResult {
            id,
            info_hash: info_hash.clone(),
            magnet: build_magnet(&info_hash, &display_name),
            torrent_file: torrent_file.to_string_lossy().to_string(),
            name: display_name,
        })
    }

    /// Add a torrent to download (and afterwards seed).
    /// `source` may be a magnet link, an http(s) URL to a .torrent,
    /// or a local path to a .torrent file.
    pub async fn add(
        &self,
        source: &str,
        output_folder: Option<String>,
    ) -> Result<AddResult, String> {
        let add = if source.starts_with("magnet:")
            || source.starts_with("http://")
            || source.starts_with("https://")
        {
            AddTorrent::from_url(source)
        } else {
            let bytes =
                std::fs::read(source).map_err(|e| format!("Cannot read {source}: {e}"))?;
            AddTorrent::from_bytes(bytes)
        };

        let response = self
            .session
            .add_torrent(
                add,
                Some(AddTorrentOptions {
                    overwrite: true,
                    output_folder,
                    trackers: Some(default_trackers_vec()),
                    ..Default::default()
                }),
            )
            .await
            .map_err(|e| format!("add_torrent failed: {e:#}"))?;

        let handle = response
            .into_handle()
            .ok_or("Torrent was added in list-only mode (no handle)")?;

        Ok(AddResult {
            id: Some(handle.id()),
            info_hash: handle.info_hash().as_string(),
            name: handle.name(),
        })
    }

    /// List all managed torrents with their live stats.
    pub fn list(&self) -> Vec<TorrentInfo> {
        self.session.with_torrents(|iter| {
            iter.map(|(id, t)| TorrentInfo {
                id,
                info_hash: t.info_hash().as_string(),
                name: t.name(),
                stats: serde_json::to_value(t.stats()).unwrap_or(serde_json::Value::Null),
            })
            .collect()
        })
    }

    /// Remove a torrent from the session, optionally deleting its files.
    pub async fn remove(&self, id: usize, delete_files: bool) -> Result<(), String> {
        self.session
            .delete(TorrentIdOrHash::Id(id), delete_files)
            .await
            .map_err(|e| format!("delete failed: {e:#}"))
    }

    /// Reconcile the persisted torrent list against files on disk.
    ///
    /// librqbit resumes its whole torrent list on restart (Json persistence),
    /// so torrents whose backing file the user has since deleted linger and
    /// show "Downloading 0.0%" forever. For each managed torrent whose expected
    /// file (`downloads_dir/<name>`) is missing, remove it from the session
    /// (without deleting files — there are none). Returns the count removed.
    pub async fn remove_missing(&self, downloads_dir: &Path) -> Result<usize, String> {
        // Collect the IDs to drop first: `delete` is async, so we can't await
        // inside the `with_torrents` closure. A torrent with no name can't be
        // located on disk, so we leave it alone (conservative).
        let to_remove: Vec<usize> = self.session.with_torrents(|iter| {
            iter.filter_map(|(id, t)| {
                let name = t.name()?;
                // The file may live in the legacy flat root OR in its shard
                // subfolder (downloads/<shard>/<name>). Present in EITHER means
                // keep the torrent — only prune when it exists in neither.
                let flat = downloads_dir.join(&name);
                let sharded = downloads_dir.join(crate::shard_for(&name)).join(&name);
                if flat.exists() || sharded.exists() {
                    None
                } else {
                    Some(id)
                }
            })
            .collect()
        });

        let mut removed = 0usize;
        for id in to_remove {
            match self.session.delete(TorrentIdOrHash::Id(id), false).await {
                Ok(()) => {
                    removed += 1;
                    log::info!("[Torrent] Pruned missing torrent id={id} (file deleted)");
                }
                Err(e) => {
                    log::warn!("[Torrent] Failed to prune torrent id={id}: {e:#}");
                }
            }
        }
        Ok(removed)
    }

    /// Session-wide stats (download/upload speeds, peers, uptime).
    pub fn session_stats(&self) -> serde_json::Value {
        serde_json::to_value(self.session.stats_snapshot()).unwrap_or(serde_json::Value::Null)
    }
}
