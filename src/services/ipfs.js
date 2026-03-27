/**
 * SermonIndex IPFS Service
 *
 * Thin frontend wrapper around the native Rust IPFS node running in Tauri.
 *
 * The Rust backend runs a real libp2p node with:
 *  - TCP + QUIC transports (dialable by public IPFS gateways)
 *  - UPnP automatic port forwarding (like BitTorrent)
 *  - Kademlia DHT in SERVER mode (full network participant)
 *  - AutoNAT (detects if publicly reachable)
 *  - DCUtR hole punching (NAT traversal)
 *  - Circuit Relay (fallback when hole punching fails)
 *
 * This is what makes the network truly decentralized — each app is a real,
 * publicly-dialable IPFS node. Content pinned here IS directly fetchable
 * by ipfs.io and other TCP-based gateways.
 *
 * The frontend JS just calls Tauri invoke() commands — all the heavy lifting
 * happens in Rust with zero browser sandbox limitations.
 */

let _running = false;
let _peerId = null;
let _uptimeStart = null;

// CID catalog — maps sermon IDs to their IPFS CIDs (synced with Rust side)
const cidCatalog = new Map();

// Stats cache (updated from diagnostics)
let nodeStats = {
  peersConnected: 0,
  filesStored: 0,
  storageUsedBytes: 0,
  bytesServed: 0,
  uptimeStart: null,
  nodeId: null,
};

// ─── Log capture ring buffer (last 200 entries) ─────────────────────────
const LOG_BUFFER_SIZE = 200;
const logBuffer = [];

function captureLog(level, ...args) {
  const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
  const entry = { t: Date.now(), level, msg };
  logBuffer.push(entry);
  if (logBuffer.length > LOG_BUFFER_SIZE) logBuffer.shift();
  if (level === 'error') console.error(...args);
  else if (level === 'warn') console.warn(...args);
  else console.log(...args);
}

const ipfsLog = {
  info: (...args) => captureLog('info', ...args),
  warn: (...args) => captureLog('warn', ...args),
  error: (...args) => captureLog('error', ...args),
};

/**
 * Get captured log entries (for remote admin or Connections panel)
 */
export function getLogs(count = 50) {
  return logBuffer.slice(-count);
}

// ─── Tauri invoke helper ────────────────────────────────────────────────
let _tauriInvoke = null;

async function invoke(cmd, args = {}) {
  if (!_tauriInvoke) {
    try {
      const tauri = await import('@tauri-apps/api/core');
      _tauriInvoke = tauri.invoke;
    } catch (e) {
      throw new Error('Tauri API not available — IPFS requires the native app');
    }
  }
  return _tauriInvoke(cmd, args);
}

/**
 * Initialize the native IPFS node
 *
 * Starts the Rust libp2p node with TCP, QUIC, UPnP, DHT server mode,
 * hole punching, and relay support. The node is publicly dialable —
 * content pinned here can be fetched by ipfs.io directly.
 */
export async function initNode(storagePath = 'sermonindex') {
  if (_running) return;

  try {
    ipfsLog.info('[IPFS] Starting native Rust IPFS node...');

    const peerId = await invoke('ipfs_start');

    if (peerId === 'already_running') {
      ipfsLog.info('[IPFS] Node was already running');
    } else {
      ipfsLog.info('[IPFS] Native node started:', peerId);
    }

    _running = true;
    _uptimeStart = Date.now();
    _peerId = peerId;
    nodeStats.uptimeStart = Date.now();
    nodeStats.nodeId = peerId;

    // Start peer count monitoring
    startPeerMonitoring();

    return peerId;
  } catch (err) {
    ipfsLog.error('[IPFS] Failed to start native node:', err);
    throw err;
  }
}

/**
 * Shutdown the IPFS node gracefully
 */
export async function stopNode() {
  if (!_running) return;
  ipfsLog.info('[IPFS] Shutting down native node...');
  try {
    await invoke('ipfs_stop');
  } catch (e) {
    ipfsLog.warn('[IPFS] Stop error:', e);
  }
  _running = false;
  _peerId = null;
  _uptimeStart = null;
  nodeStats.uptimeStart = null;
}

/**
 * Check if the IPFS node is running
 */
export function isNodeRunning() {
  return _running;
}

/**
 * Get the node's peer ID
 */
export function getNodeId() {
  return nodeStats.nodeId;
}

/**
 * Add a file to IPFS from raw bytes
 * Returns the CID (content identifier)
 *
 * The native Rust node pins the file, stores it on disk, and announces
 * it on the DHT. Because we run TCP+QUIC with UPnP port forwarding,
 * public gateways CAN directly fetch this content from us.
 *
 * @param {ArrayBuffer|Uint8Array} bytes - Raw file content
 * @param {string|null} sermonId - Optional sermon ID for catalog tracking
 * @param {string|null} sourceUrl - Original download URL (kept for bridge fallback)
 */
export async function addFile(bytes, sermonId = null, sourceUrl = null) {
  if (!_running) throw new Error('IPFS node not initialized');

  // Convert to base64 for IPC transfer to Rust
  const uint8 = new Uint8Array(bytes);
  const b64 = uint8ArrayToBase64(uint8);

  const cidStr = await invoke('ipfs_add_file', {
    dataB64: b64,
    sermonId: sermonId || null,
  });

  // Update local catalog
  if (sermonId) {
    cidCatalog.set(sermonId, cidStr);
  }
  nodeStats.filesStored++;
  nodeStats.storageUsedBytes += bytes.byteLength;

  ipfsLog.info(`[IPFS] Pinned: ${cidStr} (${(bytes.byteLength / 1024 / 1024).toFixed(1)} MB) — TCP-dialable by gateways`);

  return cidStr;
}

/**
 * Retrieve a file from IPFS by CID
 */
export async function getFile(cidString) {
  if (!_running) throw new Error('IPFS node not initialized');

  const b64 = await invoke('ipfs_get_file', { cid: cidString });
  return base64ToUint8Array(b64);
}

/**
 * Check if we have a file locally (pinned)
 */
export async function hasFile(cidString) {
  if (!_running) return false;
  try {
    const pinned = await invoke('ipfs_list_pinned');
    return pinned.includes(cidString);
  } catch {
    return false;
  }
}

/**
 * Get all pinned CIDs
 */
export async function listPinned() {
  if (!_running) return [];
  try {
    return await invoke('ipfs_list_pinned');
  } catch {
    return [];
  }
}

/**
 * Remove a pinned file
 */
export async function removeFile(cidString) {
  if (!_running) return;
  await invoke('ipfs_remove_pin', { cid: cidString });
  nodeStats.filesStored = Math.max(0, nodeStats.filesStored - 1);
}

/**
 * Get current node statistics
 */
export function getStats() {
  const uptime = nodeStats.uptimeStart
    ? Math.floor((Date.now() - nodeStats.uptimeStart) / 1000)
    : 0;

  return {
    ...nodeStats,
    uptime,
    uptimeFormatted: formatUptime(uptime),
    storageUsed: formatBytes(nodeStats.storageUsedBytes),
    isRunning: isNodeRunning(),
  };
}

/**
 * Get the CID catalog (sermon ID → CID mapping)
 */
export function getCatalog() {
  return Object.fromEntries(cidCatalog);
}

/**
 * Load a saved CID catalog (from disk on startup)
 */
export function loadCatalog(data) {
  for (const [key, val] of Object.entries(data)) {
    cidCatalog.set(key, val);
  }
}

/**
 * Diagnostic function — check IPFS node health and connectivity
 */
export async function getDiagnostics() {
  if (!_running) return { running: false };

  try {
    const diag = await invoke('ipfs_diagnostics');
    return {
      running: diag.running,
      peerId: diag.peer_id,
      peerCount: diag.peer_count,
      multiaddrs: diag.listen_addresses,
      externalAddresses: diag.external_addresses,
      natStatus: diag.nat_status,
      upnpStatus: diag.upnp_status,
      natpmpStatus: diag.natpmp_status || 'inactive',
      relayStatus: diag.relay_status || 'inactive',
      mdnsPeers: diag.mdns_peers || 0,
      rendezvousStatus: diag.rendezvous_status || 'inactive',
      dhtMode: diag.dht_mode,
      pinnedCount: diag.pinned_count || 0,
      pinnedCids: [], // Full list available via listPinned()
      uptime: diag.uptime_secs,
      connections: diag.connections.map(c => ({
        remotePeer: c.peer_id,
        remoteAddr: c.address,
        direction: c.direction,
      })),
      protocol: diag.protocol, // "native-libp2p" — distinguishes from browser Helia
      recentEvents: diag.recent_events || [], // Rust-side event log
    };
  } catch (err) {
    ipfsLog.error('[IPFS] Diagnostics failed:', err);
    return { running: false };
  }
}

/**
 * Manually trigger a DHT provide call for a specific CID (debugging)
 */
export async function debugProvide(cidString) {
  if (!_running) return { success: false, error: 'Node not running' };

  try {
    await invoke('ipfs_provide', { cid: cidString });
    return { success: true, messages: [`Provided ${cidString} on DHT (TCP+QUIC dialable)`] };
  } catch (err) {
    return { success: false, messages: [`Error: ${err}`], error: String(err) };
  }
}

// ─── Internal helpers ─────────────────────────────────────────────────────

let peerMonitorInterval = null;

function startPeerMonitoring() {
  if (peerMonitorInterval) clearInterval(peerMonitorInterval);
  peerMonitorInterval = setInterval(async () => {
    if (_running) {
      try {
        const diag = await invoke('ipfs_diagnostics');
        nodeStats.peersConnected = diag.peer_count || 0;
      } catch {}
    }
  }, 5000);
}

function formatUptime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

/**
 * Convert Uint8Array to base64 string (for Tauri IPC)
 */
function uint8ArrayToBase64(uint8) {
  let binary = '';
  const chunkSize = 8192;
  for (let i = 0; i < uint8.length; i += chunkSize) {
    const chunk = uint8.subarray(i, i + chunkSize);
    binary += String.fromCharCode.apply(null, chunk);
  }
  return btoa(binary);
}

/**
 * Convert base64 string to Uint8Array (from Tauri IPC)
 */
function base64ToUint8Array(b64) {
  const binary = atob(b64);
  const uint8 = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    uint8[i] = binary.charCodeAt(i);
  }
  return uint8;
}

// Export stats for direct access if needed
export { nodeStats };
