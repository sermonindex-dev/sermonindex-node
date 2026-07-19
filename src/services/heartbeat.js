/**
 * SermonIndex Node Heartbeat Service
 *
 * Periodically reports this node's status to the si-app API.
 * On each heartbeat response, receives:
 *   - Remote config (source mode, P2P toggle, announcements, etc.)
 *   - Available content packs (images, transcripts, etc.)
 *
 * The API uses Bunny CDN geo-headers for location when available,
 * falling back to client-side IP geolocation.
 */

const API_BASE = 'https://app.sermonindex.net';
// Beat every 5 min. The dashboard treats a node as online if seen within ~15 min,
// so a 5-min cadence tolerates two missed beats (sleep/network blip) before the
// node ever drops out. Combined with retry-on-failure and wake/online listeners
// below, this keeps the node reliably "online".
const HEARTBEAT_INTERVAL = 5 * 60 * 1000; // 5 minutes
const HEARTBEAT_RETRY_MS = 30 * 1000;     // retry once ~30s after a failed beat

let intervalId = null;
let _retrying = false;         // guards a single pending retry
let _listenersAttached = false; // wake/online listeners attached once
let _nodeId = null;
let _getStatsFn = null;
let _startTime = Date.now();
let _onConfigUpdate = null;    // Callback when remote config changes

// Real app version (from Rust CARGO_PKG_VERSION), fetched once at module load so
// heartbeats report the actual running version instead of a hardcoded string.
let _appVersion = '';
(async () => {
  try {
    const tauri = await import('@tauri-apps/api/core').catch(() => null);
    if (tauri) _appVersion = (await tauri.invoke('get_app_version').catch(() => '')) || '';
  } catch { /* non-Tauri / dev — leave blank */ }
})();
let _onContentPacks = null;    // Callback when content packs are available
let _getSermonInfoFn = null;   // Callback to get sermon info by ID (for seeded torrent reporting)
let _lastConfig = null;        // Cache last config to detect changes
let _onRemoteCommand = null;   // Callback for remote admin commands

/**
 * Generate or retrieve a persistent node ID.
 * The ID survives app restarts, IP changes, and OS updates.
 * Stored in both localStorage and Tauri's on-disk settings for redundancy.
 */
function getNodeId() {
  if (_nodeId) return _nodeId;

  // Try localStorage first (fast)
  try {
    _nodeId = localStorage.getItem('si_node_id');
  } catch {}

  // If not found, try Tauri settings file (survives localStorage clears)
  if (!_nodeId) {
    try {
      // Synchronously check if we already loaded settings with a node_id
      const stored = window.__si_settings_node_id;
      if (stored) _nodeId = stored;
    } catch {}
  }

  // Generate new ID if none found
  if (!_nodeId) {
    const arr = new Uint8Array(16);
    crypto.getRandomValues(arr);
    _nodeId = 'si-' + Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  // Persist to all storage backends
  try { localStorage.setItem('si_node_id', _nodeId); } catch {}
  try { window.__si_settings_node_id = _nodeId; } catch {}

  // Also persist via Tauri invoke (async, fire-and-forget)
  _persistNodeIdToTauri(_nodeId);

  return _nodeId;
}

/**
 * Save node ID to Tauri's filesystem-backed settings for maximum persistence.
 */
async function _persistNodeIdToTauri(nodeId) {
  try {
    const tauri = await import('@tauri-apps/api/core').catch(() => null);
    if (!tauri) return;
    const existing = await tauri.invoke('load_settings').catch(() => '{}');
    const settings = JSON.parse(existing || '{}');
    if (settings.node_id !== nodeId) {
      settings.node_id = nodeId;
      await tauri.invoke('save_settings', { data: JSON.stringify(settings) });
    }
  } catch {}
}

/**
 * Load node ID from Tauri settings on app startup.
 * Call this once during init before the first heartbeat.
 */
export async function loadNodeIdFromDisk() {
  try {
    const tauri = await import('@tauri-apps/api/core').catch(() => null);
    if (!tauri) return;
    const data = await tauri.invoke('load_settings').catch(() => '{}');
    const settings = JSON.parse(data || '{}');
    if (settings.node_id) {
      window.__si_settings_node_id = settings.node_id;
      // If localStorage is empty but disk has it, restore
      if (!_nodeId) {
        _nodeId = settings.node_id;
        try { localStorage.setItem('si_node_id', _nodeId); } catch {}
      }
    }
  } catch {}
}

// Cached geo data
let _geoData = null;

/**
 * Look up this node's approximate location using free IP geolocation APIs.
 */
async function getGeoLocation() {
  if (_geoData) return _geoData;

  // Provider 1: ipapi.co (HTTPS, free tier 1000/day)
  try {
    const res = await fetch('https://ipapi.co/json/', { signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      const data = await res.json();
      if (data.city && data.country_code) {
        _geoData = { city: data.city, region: data.region_code || data.region || '', country: data.country_code, lat: data.latitude || 0, lon: data.longitude || 0 };
        console.log('[Heartbeat] Geo (ipapi.co):', _geoData.city, _geoData.country);
        return _geoData;
      }
    }
  } catch (e) {
    console.warn('[Heartbeat] ipapi.co failed:', e.message);
  }

  // Provider 2: ipwho.is (HTTPS, no rate limit)
  try {
    const res = await fetch('https://ipwho.is/', { signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      const data = await res.json();
      if (data.success !== false && data.city) {
        _geoData = { city: data.city, region: data.region_code || data.region || '', country: data.country_code || 'XX', lat: data.latitude || 0, lon: data.longitude || 0 };
        console.log('[Heartbeat] Geo (ipwho.is):', _geoData.city, _geoData.country);
        return _geoData;
      }
    }
  } catch (e) {
    console.warn('[Heartbeat] ipwho.is failed:', e.message);
  }

  // (Dropped the ip-api.com HTTP provider — mixed content is blocked in the
  //  packaged HTTPS/WKWebView context, so it never worked. HTTPS providers above
  //  plus the server-side lookup below cover it.)

  // Provider 3: Server-side geo lookup (our own edge script does the IP lookup)
  try {
    const res = await fetch(`${API_BASE}/api/geo`, { signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      const data = await res.json();
      if (data.lat && data.lon && data.lat !== 0) {
        _geoData = { city: data.city || 'Unknown', region: data.region || '', country: data.country || 'XX', lat: data.lat, lon: data.lon };
        console.log('[Heartbeat] Geo (server-side):', _geoData.city, _geoData.country);
        return _geoData;
      }
    }
  } catch (e) {
    console.warn('[Heartbeat] Server geo lookup failed:', e.message);
  }

  console.warn('[Heartbeat] All geo providers failed');
  return { city: 'Unknown', region: '', country: 'XX', lat: 0, lon: 0 };
}

/**
 * Send a single heartbeat and process the server response.
 */
async function sendHeartbeat() {
  try {
    const stats = _getStatsFn ? _getStatsFn() : {};
    const geo = await getGeoLocation();

    // Collect torrent node status (seeded torrents + session diagnostics)
    let torrents = [];
    let livePeers = 0;
    let p2pStatus = { running: false };
    try {
      const torrentModule = await import('./torrent.js').catch(() => null);
      if (torrentModule) {
        const status = await torrentModule.getStatus().catch(() => null);
        if (status?.running) {
          torrents = await torrentModule.listTorrents().catch(() => []);
          let sessionStats = null;
          try { sessionStats = await torrentModule.getSessionStats(); } catch {}
          livePeers = torrents.reduce((n, t) => n + (t.stats?.live?.snapshot?.peer_stats?.live || 0), 0);
          p2pStatus = {
            running: true,
            node_id: getNodeId(),
            tcp_listen_port: status.tcp_listen_port || null,
            torrent_count: status.torrent_count ?? torrents.length,
            seeded_count: torrents.filter(t => t.stats?.finished).length,
            peer_count: livePeers,
            uptime: status.uptime_secs || 0,
            uploaded_bytes: torrents.reduce((n, t) => n + (t.stats?.uploaded_bytes || 0), 0),
            downloaded_bytes: torrents.reduce((n, t) => n + (t.stats?.progress_bytes || 0), 0),
            session: sessionStats || null,
          };
        }
        // Attach last 20 log entries for admin visibility
        if (torrentModule.getLogs) {
          p2pStatus.recent_logs = torrentModule.getLogs(20).map(l => ({
            t: l.t, level: l.level, msg: l.msg.slice(0, 200),
          }));
        }
      }
    } catch {}

    // Seeded torrents keyed by sermon ID — the torrent name is the downloaded
    // filename (`<sermonId>.<ext>`), enriched with sermon metadata if available
    const seededTorrents = {};
    for (const t of torrents) {
      if (!t.stats?.finished || !t.info_hash) continue;
      const sermonId = (t.name || '').replace(/\.[^.]+$/, '');
      const info = sermonId && _getSermonInfoFn ? _getSermonInfoFn(sermonId) : null;
      seededTorrents[sermonId || t.info_hash] = {
        info_hash: t.info_hash,
        title: info?.title || '',
        speaker: info?.speaker || '',
        type: info?.type || 'audio',
      };
    }

    // Lifetime uploaded bytes — this node's contribution to network data transfer.
    const uploadedLifetime = accumulateUploaded((p2pStatus && p2pStatus.uploaded_bytes) || 0);

    // Seed telemetry — scope-relative progress, so the admin dashboard can answer
    // "is this a FULL seed node?". This is deliberately NOT library_coverage: that
    // is bytes-downloaded over the ENTIRE catalog (audio + video), so a complete
    // audio-scope seed would report ~30% forever. getSeedProgress() measures against
    // the node's own chosen scope, which is the number that actually means something.
    //
    // On ANY failure we omit the three keys entirely rather than sending zeros. The
    // server treats an absent key as "preserve existing value" (COALESCE), so a
    // transient error can't blank out good data on the dashboard.
    let seedTelemetry = {};
    try {
      const { getSeedProgress } = await import('./catalog');
      const scope = localStorage.getItem('si-seed-scope') || 'audio';
      const sp = getSeedProgress(scope);
      if (sp && Number.isFinite(sp.pct)) {
        seedTelemetry = {
          seed_scope: scope === 'full' ? 'full' : 'audio',
          seed_progress: Math.max(0, Math.min(100, sp.pct)),
          seed_verified: !!sp.verified,
        };
      }
    } catch { /* omit — server preserves the last known values */ }

    const payload = {
      ...seedTelemetry,
      node_id: getNodeId(),
      protocol: 'bittorrent',
      files_stored: stats.filesShared || 0,
      storage_used_bytes: stats.storageUsedBytes || 0,
      uploaded_bytes: uploadedLifetime,
      peers_connected: livePeers || stats.peersConnected || 0,
      uptime_seconds: Math.floor((Date.now() - _startTime) / 1000),
      library_coverage: stats.libraryCoverage || 0,
      content_mode: stats.contentMode || 'cdn',
      app_version: _appVersion || '0.0.0',
      node_type: stats.nodeType || 'user',
      // Reachability lets the dashboard classify: seed / reachable "node" (port
      // open) / "peer" (running but port closed). From the last probe result.
      reachable: (() => {
        try {
          const r = JSON.parse(localStorage.getItem('si-reach') || 'null');
          return r && typeof r.open === 'boolean' ? r.open : null;
        } catch { return null; }
      })(),
      lat: geo.lat,
      lon: geo.lon,
      city: geo.city,
      region: geo.region || '',
      country: geo.country,
      seeded_torrents: seededTorrents, // info_hashes replace the old per-sermon CID map
      p2p_status: p2pStatus, // Full session diagnostics for admin
    };

    const res = await fetch(`${API_BASE}/api/node/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (res.ok) {
      const data = await res.json();
      console.log('[Heartbeat] Sent successfully');

      // Process remote config
      if (data.config && _onConfigUpdate) {
        const configChanged = JSON.stringify(data.config) !== JSON.stringify(_lastConfig);
        if (configChanged) {
          console.log('[Heartbeat] Config updated from server:', data.config);
          _lastConfig = data.config;
          _onConfigUpdate(data.config);
        }
      }

      // Master list refresh: the admin can bump config.master_list_version to force
      // every node to re-pull the canonical master-list.json. Handled in catalog.js
      // via a dynamic import (avoids a hard module cycle). No-op when empty/unchanged.
      if (data.config && typeof data.config.master_list_version === 'string') {
        import('./catalog.js')
          .then(m => m.reconcileMasterListVersion(data.config.master_list_version))
          .catch(() => {});
      }

      // Process content packs
      if (data.content_packs && data.content_packs.length > 0 && _onContentPacks) {
        _onContentPacks(data.content_packs);
      }

      // Process remote commands from admin
      if (data.commands && Array.isArray(data.commands) && data.commands.length > 0) {
        console.log('[Heartbeat] Remote commands received:', data.commands.length);
        for (const cmd of data.commands) {
          executeRemoteCommand(cmd);
        }
      }
    } else {
      console.warn('[Heartbeat] Server returned', res.status);
      scheduleHeartbeatRetry();
    }
  } catch (e) {
    console.warn('[Heartbeat] Failed to send:', e.message);
    scheduleHeartbeatRetry();
  }
}

// Retry a failed heartbeat once after a short delay, so a transient network blip
// or brief server hiccup doesn't drop the node out of the dashboard's online window.
function scheduleHeartbeatRetry() {
  if (_retrying || !intervalId) return;
  _retrying = true;
  setTimeout(() => { _retrying = false; sendHeartbeat(); }, HEARTBEAT_RETRY_MS);
}

// Lifetime uploaded bytes. librqbit's session upload counter resets on restart,
// so keep a running total in localStorage and report that as this node's
// contribution to total network data transferred.
function accumulateUploaded(sessionUploaded) {
  try {
    const raw = localStorage.getItem('si-uploaded-lifetime');
    const st = raw ? JSON.parse(raw) : { lifetime: 0, lastSession: 0 };
    let lifetime = Number(st.lifetime) || 0;
    const last = Number(st.lastSession) || 0;
    const s = Number(sessionUploaded) || 0;
    lifetime += s < last ? s : (s - last); // s < last ⇒ counter reset on restart
    localStorage.setItem('si-uploaded-lifetime', JSON.stringify({ lifetime, lastSession: s }));
    return lifetime;
  } catch { return Number(sessionUploaded) || 0; }
}

/**
 * Execute a remote command received from the admin panel.
 * Commands are safe, scoped actions — not arbitrary code execution.
 */
async function executeRemoteCommand(cmd) {
  const { action, command_id } = cmd;
  console.log(`[Heartbeat] Executing remote command: ${action} (id: ${command_id})`);

  let result = { success: false, message: 'Unknown command' };

  try {
    const torrentModule = await import('./torrent.js').catch(() => null);

    if (/^(reconnect|restart)/.test(action || '')) {
      // Restart the P2P session (also covers the legacy reconnect command name)
      if (torrentModule) {
        try { await torrentModule.stopSession(); } catch {}
        await new Promise(r => setTimeout(r, 1000));
        const status = await torrentModule.startSession();
        result = { success: true, message: `P2P session restarted (port ${status?.tcp_listen_port ?? '?'}, ${status?.torrent_count ?? 0} torrents)` };
      } else {
        result = { success: false, message: 'Torrent module not available' };
      }
    } else if (action === 'get_diagnostics') {
      if (torrentModule) {
        const status = await torrentModule.getStatus().catch(() => ({ running: false }));
        const sessionStats = await torrentModule.getSessionStats().catch(() => null);
        const torrents = await torrentModule.listTorrents().catch(() => []);
        result = { success: true, message: JSON.stringify({ protocol: 'bittorrent', status, sessionStats, torrents }) };
      } else {
        result = { success: false, message: 'Torrent module not available' };
      }
    } else if (action === 'get_logs') {
      if (torrentModule && torrentModule.getLogs) {
        result = { success: true, message: JSON.stringify(torrentModule.getLogs(100)) };
      } else {
        result = { success: false, message: 'Logs not available' };
      }
    } else if (action === 'reannounce_content' || action === 'run_self_test') {
      // Legacy commands from the previous P2P stack — torrents announce
      // themselves continuously via DHT/trackers, so report status instead
      const status = torrentModule ? await torrentModule.getStatus().catch(() => null) : null;
      result = status?.running
        ? { success: true, message: `P2P node running with ${status.torrent_count} torrents (no-op on BitTorrent — DHT/trackers announce automatically)` }
        : { success: false, message: 'P2P node not running' };
    } else {
      result = { success: false, message: `Unknown action: ${action}` };
    }
  } catch (err) {
    result = { success: false, message: err.message };
  }

  console.log(`[Heartbeat] Command result: ${result.message}`);

  // Report result back to server
  try {
    await fetch(`${API_BASE}/api/node/command-result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        node_id: getNodeId(),
        command_id,
        result,
      }),
    });
  } catch (err) {
    console.warn('[Heartbeat] Failed to report command result:', err.message);
  }
}

/**
 * Start the heartbeat interval.
 * @param {Function} getStats - Returns { filesShared, storageUsedBytes, peersConnected, libraryCoverage, contentMode, nodeType }
 * @param {Object} options
 * @param {Function} options.onConfigUpdate - Called with remote config object when it changes
 * @param {Function} options.onContentPacks - Called with array of available content packs
 */
export function startHeartbeat(getStats, options = {}) {
  if (intervalId) return;
  _getStatsFn = getStats;
  _onConfigUpdate = options.onConfigUpdate || null;
  _onContentPacks = options.onContentPacks || null;
  _getSermonInfoFn = options.getSermonInfo || null;
  _onRemoteCommand = options.onRemoteCommand || null;
  _startTime = Date.now();

  // Set the interval id first so retry-on-failure is armed even for the first beat.
  intervalId = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL);

  // Redundancy: also beat immediately whenever the network comes back or the app
  // is brought to the foreground — covers laptop sleep/wake and connectivity blips.
  if (typeof window !== 'undefined' && !_listenersAttached) {
    _listenersAttached = true;
    try {
      window.addEventListener('online', () => { if (intervalId) sendHeartbeat(); });
      document.addEventListener('visibilitychange', () => {
        if (intervalId && document.visibilityState === 'visible') sendHeartbeat();
      });
    } catch { /* non-browser env */ }
  }

  // Send first heartbeat immediately
  sendHeartbeat();
  console.log('[Heartbeat] Started — reporting every 5 minutes (with retry + wake)');
}

/**
 * Stop heartbeats and notify server this node is going offline.
 */
export async function stopHeartbeat() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }

  try {
    await fetch(`${API_BASE}/api/node/shutdown`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ node_id: getNodeId() }),
    });
    console.log('[Heartbeat] Shutdown notification sent');
  } catch {
    // Best effort
  }
}

/**
 * Fetch the live node map from the API.
 */
export async function fetchNodeMap() {
  try {
    const res = await fetch(`${API_BASE}/api/node/map`);
    if (res.ok) {
      const data = await res.json();
      return data.nodes || [];
    }
  } catch {}
  return [];
}

/**
 * Fetch aggregate network statistics.
 */
export async function fetchNetworkStats() {
  try {
    const res = await fetch(`${API_BASE}/api/node/stats`);
    if (res.ok) return await res.json();
  } catch {}
  return null;
}

/**
 * Fetch remote config directly (outside heartbeat cycle).
 */
export async function fetchConfig() {
  try {
    // Cache-bust to always get the latest config from server
    const res = await fetch(`${API_BASE}/api/config?_t=${Date.now()}`);
    if (res.ok) {
      const data = await res.json();
      console.log('[Heartbeat] fetchConfig got:', data.config);
      return data.config || {};
    }
  } catch {}
  return {};
}

/**
 * Fetch available content packs.
 */
export async function fetchContentPacks() {
  try {
    const res = await fetch(`${API_BASE}/api/content-packs`);
    if (res.ok) {
      const data = await res.json();
      return data.packs || [];
    }
  } catch {}
  return [];
}

/**
 * Get the cached geo location data (or null if not yet looked up).
 */
export function getCachedGeo() {
  return _geoData;
}

export { getNodeId };
