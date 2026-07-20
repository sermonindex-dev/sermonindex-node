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

// Cached geo data.
//
// The cache EXPIRES rather than living for the whole process. Long-running seed
// nodes are a first-class use case, so a process can easily stay up for months —
// a laptop that moves city (or country) would otherwise sit on the public node
// map at its original coordinates forever.
//
// 6 hours is the balance point: a node that physically moves is corrected within
// one working day, while the third-party free tiers stay untouched. At the 5-min
// beat cadence that's 4 lookups/day/node against ipapi.co's 1000/day-per-IP
// budget (~0.4% of it), versus 288 beats/day if we looked up every beat.
//
// On failure we deliberately KEEP the previous value — a stale-but-plausible
// location is far better on the map than "Unknown / XX" — and only push the next
// attempt out by GEO_RETRY_MS so a provider outage doesn't get hammered every beat.
const GEO_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const GEO_RETRY_MS = 30 * 60 * 1000;   // back off 30 min after a failed refresh
const GEO_UNKNOWN = { city: 'Unknown', region: '', country: 'XX', lat: 0, lon: 0 };

let _geoData = null;
let _geoNextCheck = 0; // epoch ms; before this, serve the cached value untouched

/**
 * Look up this node's approximate location using free IP geolocation APIs.
 *
 * Refresh is LAZY — it happens on the first heartbeat after the cache expires,
 * so there is no extra timer to keep alive.
 */
async function getGeoLocation() {
  if (Date.now() < _geoNextCheck) return _geoData || GEO_UNKNOWN;

  // Provider 1: ipapi.co (HTTPS, free tier 1000/day)
  try {
    const res = await fetch('https://ipapi.co/json/', { signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      const data = await res.json();
      if (data.city && data.country_code) {
        _geoData = { city: data.city, region: data.region_code || data.region || '', country: data.country_code, lat: data.latitude || 0, lon: data.longitude || 0 };
        _geoNextCheck = Date.now() + GEO_TTL_MS;
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
        _geoNextCheck = Date.now() + GEO_TTL_MS;
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
        _geoNextCheck = Date.now() + GEO_TTL_MS;
        console.log('[Heartbeat] Geo (server-side):', _geoData.city, _geoData.country);
        return _geoData;
      }
    }
  } catch (e) {
    console.warn('[Heartbeat] Server geo lookup failed:', e.message);
  }

  // Every provider failed. Keep whatever we had — a stale-but-plausible location
  // beats blanking a node out to Unknown/XX on the public map — and just delay the
  // next attempt so we don't retry on every single beat.
  _geoNextCheck = Date.now() + GEO_RETRY_MS;
  console.warn(
    _geoData
      ? '[Heartbeat] All geo providers failed — keeping previous location'
      : '[Heartbeat] All geo providers failed'
  );
  return _geoData || GEO_UNKNOWN;
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
    // Pass null (not 0) when there is no reading to report: if getStatus() failed or
    // the session isn't running, `p2pStatus.uploaded_bytes` is absent and a 0 would
    // be indistinguishable from a genuinely idle session. See accumulateUploaded().
    const haveUploadReading = !!(p2pStatus && p2pStatus.running && p2pStatus.uploaded_bytes != null);
    const uploadedLifetime = accumulateUploaded(
      haveUploadReading ? p2pStatus.uploaded_bytes : null,
      haveUploadReading ? p2pStatus.uptime : 0
    );

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
      // "Reachable" means a peer can open a connection to us over EITHER address
      // family — matching App.jsx's health derivation. A node reachable ONLY
      // over IPv6 (the normal good outcome on Starlink and mobile broadband) is
      // a full node; reporting just `r.open` sent it to the dashboard as
      // unreachable, so the map miscategorised it as a peer while the app itself
      // showed a green "Reachable over IPv6" banner.
      reachable: (() => {
        try {
          const r = JSON.parse(localStorage.getItem('si-reach') || 'null');
          if (!r || typeof r.open !== 'boolean') return null;
          return r.open || r.open_v6 === true;
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
//
// `sessionUploaded` is the sum of uploaded_bytes over the CURRENTLY-LOADED
// torrents, which means it can fall for two very different reasons:
//
//   1. The session restarted and the counter genuinely reset to 0. The whole new
//      value is fresh upload and must be added.
//   2. A torrent was removed and its bytes left the sum. Nothing was uploaded;
//      the total simply covers fewer torrents than it did a moment ago.
//
// The old code inferred (1) from the byte total alone — any drop was treated as a
// restart and the ENTIRE running total was re-added. But pruneMissing() runs after
// every sermon deletion (App.jsx), so case (2) happened routinely and silently
// inflated this node's lifetime figure. The server stores uploaded_bytes as a
// monotonic high-water mark (MAX(existing, incoming)), so that inflation was
// permanent and fed straight into the network-wide "Data Transferred" stat.
//
// The fix is to stop inferring a restart from the bytes at all and read it from the
// session's OWN start marker instead: `uptime_secs`, derived in Rust from
// `started_at.elapsed()` (torrent_node.rs). It climbs monotonically for the life of
// a session and can only go backwards when a new session object is constructed.
// Removing a torrent does not touch it, so case (2) cannot be mistaken for case (1).
//
// When uptime says the session is the same one as last beat, any decrease is case
// (2) and the delta is clamped to 0. The cost is that the removed torrent's last
// (at most 5 minutes of) upload goes unrecorded — a bounded undercount, which is
// the right way to err against a value the server can never revise downwards.
//
// `sessionUploaded == null` means "no reading this beat" (getStatus() failed, or
// the session isn't running). Previously the caller passed 0 in that case, which
// wrote lastSession: 0 and made the next successful beat re-add the full session
// total — the same over-counting bug by a different route. Now we leave the stored
// state completely untouched and just report the last known lifetime.
function accumulateUploaded(sessionUploaded, sessionUptime) {
  try {
    const raw = localStorage.getItem('si-uploaded-lifetime');
    const st = raw ? JSON.parse(raw) : { lifetime: 0, lastSession: 0 };
    let lifetime = Number(st.lifetime) || 0;

    // No usable reading — preserve state and report what we already have.
    if (sessionUploaded == null) return lifetime;

    const last = Number(st.lastSession) || 0;
    const s = Number(sessionUploaded) || 0;
    const uptime = Number(sessionUptime) || 0;
    // `lastUptime` is absent on state written by older builds; treating it as 0
    // just means we take the monotonic branch, which is the safe direction.
    const lastUptime = Number(st.lastUptime) || 0;

    // Session restarted ⇒ `s` is a fresh counter starting from 0, so all of it is
    // new. Otherwise the counter is continuous with last beat's and only the
    // increase is new — a decrease means torrents left the set, not new upload.
    const restarted = uptime < lastUptime;
    lifetime += restarted ? s : Math.max(0, s - last);

    localStorage.setItem('si-uploaded-lifetime', JSON.stringify({ lifetime, lastSession: s, lastUptime: uptime }));
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
 *
 * This runs from a `beforeunload` handler (App.jsx), and browsers/WKWebViews do
 * not reliably keep an async fetch alive through unload — the document is torn
 * down first and the request is cancelled. When that happened the shutdown never
 * landed and the dashboard kept the node "online" until the 15-min staleness
 * window expired. navigator.sendBeacon exists precisely for this: the request is
 * handed to the browser, which sends it independently of the page's lifetime.
 */
export async function stopHeartbeat() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }

  const url = `${API_BASE}/api/node/shutdown`;
  const body = JSON.stringify({ node_id: getNodeId() });

  // sendBeacon always POSTs and only lets us pick the Content-Type via the Blob
  // type, so we send the JSON as text/plain. Two reasons that's the right choice:
  //  - The server's handleShutdown() does `await req.json()` and never inspects
  //    Content-Type, so the body parses exactly the same (verified in
  //    server/si-app-dashboard.ts).
  //  - text/plain is CORS-safelisted, so this is a simple cross-origin request.
  //    application/json would force a preflight, and an unloading page cannot be
  //    relied on to complete the OPTIONS round-trip — the very failure we're fixing.
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      const blob = new Blob([body], { type: 'text/plain;charset=UTF-8' });
      if (navigator.sendBeacon(url, blob)) {
        console.log('[Heartbeat] Shutdown notification queued (sendBeacon)');
        return;
      }
      // Returned false — queue full or blocked. Fall through to fetch.
    }
  } catch { /* no sendBeacon in this environment — fall through to fetch */ }

  // Fallback for environments without sendBeacon (or when it refused the payload).
  // `keepalive` asks the fetch to outlive the document where it's supported; it's
  // still weaker than a beacon, which is why it's the second choice, not the first.
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true,
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
