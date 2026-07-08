/**
 * SermonIndex Torrent Service (PoC)
 *
 * Thin frontend wrapper around the native Rust BitTorrent node (librqbit)
 * running in Tauri. This replaces the previous embedded P2P stack:
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

// ─── Log capture ring buffer (last 200 entries) ─────────────────────────
const LOG_BUFFER_SIZE = 200;
const logBuffer = [];

function captureLog(level, ...args) {
  const msg = args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
  const entry = { t: Date.now(), level, msg };
  logBuffer.push(entry);
  if (logBuffer.length > LOG_BUFFER_SIZE) logBuffer.shift();
  if (level === 'error') console.error(...args);
  else if (level === 'warn') console.warn(...args);
  else console.log(...args);
}

const torrentLog = {
  info: (...args) => captureLog('info', ...args),
  warn: (...args) => captureLog('warn', ...args),
  error: (...args) => captureLog('error', ...args),
};

/**
 * Get captured log entries (for remote admin or the Connections panel)
 */
export function getLogs(count = 50) {
  return logBuffer.slice(-count);
}

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
  try {
    const status = await invoke('torrent_start');
    torrentLog.info(`[Torrent] Session started (port ${status?.tcp_listen_port ?? '?'}, ${status?.torrent_count ?? 0} torrents)`);
    return status;
  } catch (err) {
    torrentLog.error('[Torrent] Failed to start session:', err);
    throw err;
  }
}

/** Stop the torrent session. */
export async function stopSession() {
  try {
    const res = await invoke('torrent_stop');
    torrentLog.info('[Torrent] Session stopped');
    return res;
  } catch (err) {
    torrentLog.warn('[Torrent] Stop error:', err);
    throw err;
  }
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
  try {
    const res = await invoke('torrent_seed_file', { filePath, name });
    torrentLog.info(`[Torrent] Seeding: ${res?.name} (${res?.info_hash})`);
    return res;
  } catch (err) {
    torrentLog.error(`[Torrent] Seed failed for ${filePath}:`, err);
    throw err;
  }
}

/** Seed a file already in the app's downloads folder, by filename. */
export async function seedDownloaded(filename, name = null) {
  try {
    const res = await invoke('torrent_seed_downloaded', { filename, name });
    torrentLog.info(`[Torrent] Seeding downloaded file: ${res?.name} (${res?.info_hash})`);
    return res;
  } catch (err) {
    torrentLog.error(`[Torrent] Seed failed for ${filename}:`, err);
    throw err;
  }
}

/**
 * Add a torrent by magnet link, .torrent URL, or local .torrent path.
 * Downloads into the app downloads folder, then seeds.
 * Returns { id, info_hash, name }.
 */
export async function addTorrent(source) {
  try {
    const res = await invoke('torrent_add', { source });
    torrentLog.info(`[Torrent] Added: ${res?.name} (${res?.info_hash})`);
    return res;
  } catch (err) {
    // A canonical .torrent that 404s is expected for the handful of sermons
    // whose .torrent was never uploaded — the downloadManager falls through to
    // legacy self-seeding, so this isn't a real failure. Downgrade it from a
    // red error to a warn so it doesn't look alarming in the Live Log. Still
    // rethrow: other callers rely on the rejection to drive their fallback.
    const msg = String(err?.message || err);
    if (msg.includes('404')) {
      torrentLog.warn('[Torrent] Add failed (canonical .torrent 404, using fallback):', err);
    } else {
      torrentLog.error('[Torrent] Add failed:', err);
    }
    throw err;
  }
}

/** List all torrents with live stats. */
export async function listTorrents() {
  return invoke('torrent_list');
}

/** Remove a torrent (optionally deleting its files). */
export async function removeTorrent(id, deleteFiles = false) {
  const res = await invoke('torrent_remove', { id, deleteFiles });
  torrentLog.info(`[Torrent] Removed torrent ${id}${deleteFiles ? ' (files deleted)' : ''}`);
  return res;
}

/**
 * Remove any persisted torrents whose backing file no longer exists on disk.
 * librqbit persists its torrent list across restarts, so torrents for sermons
 * the user has deleted otherwise linger forever (often showing 0.0%). Returns
 * the number of torrents removed.
 */
export async function pruneMissing() {
  return invoke('torrent_prune_missing');
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
  logs: getLogs,
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
