/**
 * SermonIndex Torrent Service (PoC)
 *
 * Thin frontend wrapper around the native Rust BitTorrent node (librqbit)
 * running in Tauri. This is the pivot away from the IPFS stack:
 *
 *  - Mainline DHT (millions of nodes — no SermonIndex bootstrap servers needed)
 *  - Public trackers as a second peer-discovery mechanism
 *  - UPnP port forwarding that works on typical home routers
 *  - Volunteers can ALSO seed with any standard client (qBittorrent,
 *    Transmission) using the same magnets / .torrent files
 *
 * Strategy: HTTP (Archive.org / Bunny CDN) stays as the guaranteed download
 * path. Once a file is downloaded, seed it here so the swarm grows and the
 * network becomes progressively more redundant.
 *
 * PoC console helpers (open devtools):
 *   await torrentPoc.start()
 *   await torrentPoc.seedDownloaded('some-file.mp3')   // file in downloads folder
 *   await torrentPoc.seed('/absolute/path/file.mp4')   // any local file
 *   await torrentPoc.add('magnet:?xt=...')             // download from swarm
 *   await torrentPoc.list()
 *   await torrentPoc.watch()                           // poll progress every 2s
 */

let _tauriInvoke = null;

async function invoke(cmd, args = {}) {
  if (!_tauriInvoke) {
    try {
      const tauri = await import('@tauri-apps/api/core');
      _tauriInvoke = tauri.invoke;
    } catch (e) {
      throw new Error('Tauri API not available — torrents require the native app');
    }
  }
  return _tauriInvoke(cmd, args);
}

/** Start the torrent session (DHT + trackers + UPnP). Idempotent. */
export async function startSession() {
  return invoke('torrent_start');
}

/** Stop the torrent session. */
export async function stopSession() {
  return invoke('torrent_stop');
}

/** { running, tcp_listen_port, uptime_secs, torrent_count } */
export async function getStatus() {
  return invoke('torrent_status');
}

/**
 * Create a .torrent for a local file (absolute path) and seed it in place.
 * Returns { id, info_hash, magnet, torrent_file, name }.
 * Hashing a large file can take a little while — that's normal.
 */
export async function seedFile(filePath, name = null) {
  return invoke('torrent_seed_file', { filePath, name });
}

/** Seed a file already in the app's downloads folder, by filename. */
export async function seedDownloaded(filename, name = null) {
  return invoke('torrent_seed_downloaded', { filename, name });
}

/**
 * Add a torrent by magnet link, .torrent URL, or local .torrent path.
 * Downloads into the app downloads folder, then seeds.
 * Returns { id, info_hash, name }.
 */
export async function addTorrent(source) {
  return invoke('torrent_add', { source });
}

/** List all torrents with live stats. */
export async function listTorrents() {
  return invoke('torrent_list');
}

/** Remove a torrent (optionally deleting its files). */
export async function removeTorrent(id, deleteFiles = false) {
  return invoke('torrent_remove', { id, deleteFiles });
}

/** Session-wide stats (speeds, peers, uptime). */
export async function getSessionStats() {
  return invoke('torrent_session_stats');
}

// ─── PoC devtools console helpers ───────────────────────────────────────────

function formatTorrent(t) {
  const s = t.stats || {};
  const live = s.live || {};
  const pct = s.total_bytes ? ((100 * s.progress_bytes) / s.total_bytes).toFixed(1) : '?';
  return {
    id: t.id,
    name: t.name,
    infoHash: t.info_hash,
    state: s.state,
    progress: `${pct}%`,
    downSpeed: live.download_speed?.human_readable ?? '-',
    upSpeed: live.upload_speed?.human_readable ?? '-',
    peers: live.snapshot?.peer_stats?.live ?? 0,
    uploadedBytes: s.uploaded_bytes,
    finished: s.finished,
  };
}

let _watchInterval = null;

const torrentPoc = {
  start: startSession,
  stop: stopSession,
  status: getStatus,
  seed: seedFile,
  seedDownloaded,
  add: addTorrent,
  list: async () => {
    const torrents = await listTorrents();
    const rows = torrents.map(formatTorrent);
    console.table(rows);
    return torrents;
  },
  remove: removeTorrent,
  sessionStats: getSessionStats,
  watch: async (intervalMs = 2000) => {
    if (_watchInterval) clearInterval(_watchInterval);
    _watchInterval = setInterval(async () => {
      try {
        const torrents = await listTorrents();
        console.table(torrents.map(formatTorrent));
      } catch (e) {
        console.warn('[torrentPoc] watch error:', e);
      }
    }, intervalMs);
    console.log('[torrentPoc] watching... call torrentPoc.unwatch() to stop');
  },
  unwatch: () => {
    if (_watchInterval) clearInterval(_watchInterval);
    _watchInterval = null;
  },
};

if (typeof window !== 'undefined') {
  window.torrentPoc = torrentPoc;
}

export default torrentPoc;
