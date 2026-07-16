/**
 * SermonIndex Download Manager
 *
 * Download priority:
 *   1. Archive.org (free, unlimited) — primary source
 *   2. Bunny CDN (paid, fast) — fallback
 *
 * Features:
 * - Download queue with concurrency control
 * - Progress tracking per file and overall
 * - Automatic BitTorrent seeding after download (fire-and-forget)
 * - Resume capability
 * - Bandwidth throttling
 */

// Tauri invoke — lazy-loaded to work in browser too
let tauriInvoke = null;
let tauriLoaded = false;
async function loadTauri() {
  if (tauriLoaded) return tauriInvoke;
  tauriLoaded = true;
  try {
    const mod = await import('@tauri-apps/api/core');
    tauriInvoke = mod.invoke;
  } catch {
    tauriInvoke = null;
  }
  return tauriInvoke;
}

// Convert ArrayBuffer to base64 string in chunks to avoid stack overflow
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 32768; // 32KB chunks
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
    binary += String.fromCharCode.apply(null, chunk);
  }
  return btoa(binary);
}

// Convert a chunk (Uint8Array) to base64
function chunkToBase64(uint8arr) {
  const chunkSize = 32768;
  let binary = '';
  for (let i = 0; i < uint8arr.length; i += chunkSize) {
    const slice = uint8arr.subarray(i, Math.min(i + chunkSize, uint8arr.length));
    binary += String.fromCharCode.apply(null, slice);
  }
  return btoa(binary);
}

const CHUNK_THRESHOLD = 10 * 1024 * 1024; // 10 MB — use chunked write above this
const CHUNK_SIZE = 4 * 1024 * 1024; // 4 MB per IPC call

async function saveFileToDisk(filename, bytes) {
  const invoke = await loadTauri();
  if (!invoke) return null;

  const totalSize = bytes.byteLength;

  try {
    if (totalSize <= CHUNK_THRESHOLD) {
      // Small file — single base64 transfer (fast path)
      const dataB64 = arrayBufferToBase64(bytes);
      const path = await invoke('save_sermon_file', { filename, dataB64 });
      return path;
    }

    // Large file — chunked write to avoid memory explosion
    console.log(`[DL] Large file (${(totalSize / 1024 / 1024).toFixed(1)} MB), using chunked save...`);
    const filePath = await invoke('create_sermon_file', { filename });
    const uint8 = new Uint8Array(bytes);
    let offset = 0;
    let chunkNum = 0;
    const totalChunks = Math.ceil(totalSize / CHUNK_SIZE);

    while (offset < totalSize) {
      const end = Math.min(offset + CHUNK_SIZE, totalSize);
      const chunk = uint8.subarray(offset, end);
      const chunkB64 = chunkToBase64(chunk);
      await invoke('append_sermon_chunk', { filename, chunkB64 });
      offset = end;
      chunkNum++;
      if (chunkNum % 10 === 0 || chunkNum === totalChunks) {
        console.log(`[DL] Chunk ${chunkNum}/${totalChunks} written`);
      }
    }

    console.log(`[DL] Chunked save complete: ${filePath}`);
    return filePath;
  } catch (e) {
    console.warn('[DL] Failed to save file to disk:', e.message);
    return null;
  }
}

// Torrent seeding is optional — lazy-loaded on first use to avoid top-level await
let torrentModule = null;
let torrentLoadAttempted = false;

async function loadTorrent() {
  if (torrentLoadAttempted) return torrentModule;
  torrentLoadAttempted = true;
  try {
    torrentModule = await import('./torrent.js');
  } catch (e) {
    console.warn('[DL] Torrent module not available, downloads will work without seeding');
    torrentModule = null;
  }
  return torrentModule;
}

/**
 * Seed a downloaded file (by filename in the app downloads dir) to the swarm.
 * Returns { id, info_hash, magnet, torrent_file, name } or null on failure.
 * Fire-and-forget — a seeding failure must never break the download flow.
 */
async function trySeedTorrent(filename, sermon = null) {
  try {
    const mod = await loadTorrent();
    if (!mod) return null;
    await mod.startSession(); // idempotent

    // Re-resolve the sermon from the LIVE catalog: the master list loads a few
    // seconds after app start, and the sermon object captured when the download
    // began may predate the merge (no magnet/torrentUrl yet). If the master
    // list still hasn't arrived, wait up to 20s — canonical seeding is worth it.
    let fresh = sermon;
    try {
      const cat = await import('./catalog.js');
      const resolve = () => {
        if (sermon?.id) fresh = cat.getCatalog().find((s) => s.id === sermon.id) || fresh;
      };
      resolve();
      if (!(fresh?.torrentUrl || fresh?.magnet?.startsWith('magnet:'))) {
        for (let i = 0; i < 10 && !cat.hasMasterList(); i++) {
          await new Promise((r) => setTimeout(r, 2000));
        }
        resolve();
      }
    } catch { /* catalog unavailable — proceed with what we have */ }

    // TRUST RULE: if the master list gave this sermon a canonical torrent,
    // seed THAT (librqbit hash-checks the file we just downloaded against the
    // official fingerprint, then joins the one canonical swarm). The file is
    // already in the session's default output folder, so nothing re-downloads.
    // If the canonical .torrent is unreachable (CDN hiccup), fall through to
    // legacy self-seeding — deterministic hashing puts it in the SAME swarm.
    if (fresh?.torrentUrl || fresh?.magnet?.startsWith('magnet:')) {
      try {
        const source = fresh.torrentUrl || fresh.magnet;
        // Pass the filename so the native side points librqbit at this file's
        // shard folder — it then verifies the bytes we just downloaded and seeds,
        // rather than re-fetching them from the CDN webseed.
        const res = await mod.addTorrent(source, filename);
        return { magnet: fresh.magnet, info_hash: fresh.infoHash || res?.info_hash, id: res?.id };
      } catch (canonErr) {
        console.warn('[DL] Canonical seed failed, falling back to local torrent:', canonErr?.message || canonErr);
      }
    }

    // No canonical entry (master list not published / new file) — legacy
    // self-generated torrent so the file is at least shareable.
    return await mod.seedDownloaded(filename);
  } catch (e) {
    console.warn('[DL] Torrent seeding skipped:', e?.message || e);
    return null;
  }
}

export const DL_STATE = {
  QUEUED: 'queued',
  DOWNLOADING: 'downloading',
  SEEDING: 'seeding',
  COMPLETE: 'complete',
  ERROR: 'error',
  PAUSED: 'paused',
};

// Content source modes — controlled by admin, not user
export const SOURCE_MODE = {
  CDN_PRIMARY: 'cdn',          // Archive.org first, CDN fallback
  P2P_PRIMARY: 'p2p-primary',  // Peer swarm first, Archive.org/CDN fallback (needs catalog magnets)
  P2P_ONLY: 'p2p-only',        // Peer swarm only — full decentralization (needs catalog magnets)
};

class DownloadManager {
  constructor() {
    this.queue = new Map();
    this.listeners = new Set();
    this.maxConcurrent = 3;
    this.activeDownloads = 0;
    this.mode = SOURCE_MODE.CDN_PRIMARY;
    this.bandwidthLimit = 0; // bytes/sec, 0 = unlimited (throttles HTTP downloads)
    this.storageLimitBytes = 0; // bytes, 0 = unlimited (caps total cached sermons)
    this.paused = false;
    this.totalDownloaded = 0;
    this.totalFiles = 0;
  }

  setMode(mode) {
    this.mode = mode;
  }

  /**
   * Re-seed the sermons the user actually has on disk. Called once at startup
   * (the torrent session no longer persists its own list — see torrent_node.rs).
   * Uses seedDownloaded, which builds the torrent from the EXISTING file
   * (deterministic infohash = same canonical swarm) and never re-downloads.
   * `sermons` should be the downloaded sermons (getDownloaded()).
   */
  async reseedExisting(sermons) {
    if (!Array.isArray(sermons) || sermons.length === 0) return;
    const mod = await loadTorrent();
    if (!mod) return;
    try { await mod.startSession(); } catch { return; }
    for (const s of sermons) {
      const ext = s.type === 'video' ? 'mp4' : 'mp3';
      const filename = `${s.id}.${ext}`;
      try {
        await mod.seedDownloaded(filename);
      } catch (e) {
        // File may have just been removed, or hashing failed — skip quietly.
        console.warn('[DL] reseed skipped', filename, e?.message || e);
      }
    }
    console.log(`[DL] Re-seeded ${sermons.length} existing download(s)`);
  }

  setBandwidthLimit(mbps) {
    this.bandwidthLimit = mbps > 0 ? mbps * 125000 : 0;
  }

  // Storage cap in GB (0 = unlimited). Enforced at the start of download().
  setStorageLimit(gb) {
    this.storageLimitBytes = gb > 0 ? gb * 1024 * 1024 * 1024 : 0;
  }

  onProgress(callback) {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  _notify(sermonId, state) {
    for (const cb of this.listeners) {
      try { cb(sermonId, state); } catch (e) { console.error('[DL] Listener error:', e); }
    }
  }

  /**
   * Download a sermon using the priority chain
   */
  async download(sermon) {
    if (this.queue.has(sermon.id) && this.queue.get(sermon.id).state === DL_STATE.COMPLETE) {
      return this.queue.get(sermon.id).magnet;
    }

    // ── Storage cap enforcement (opt-in; 0 = unlimited) ──────────────────
    // Refuse a NEW download when the cache is already at/over the user's cap,
    // or when this file would push it over. Files already on disk are never
    // touched. `used` is the real on-disk size measured by the Rust side; if we
    // can't measure it (e.g. running in a plain browser) we fail open.
    if (this.storageLimitBytes > 0) {
      const incoming = sermon.sizeBytes || sermon.totalBytes || 0;
      let usedBytes = 0;
      try {
        const invoke = await loadTauri();
        if (invoke) {
          const usage = await invoke('get_storage_usage');
          usedBytes = usage?.bytes || 0;
        }
      } catch { usedBytes = 0; }
      if (usedBytes + incoming > this.storageLimitBytes) {
        const capGb = (this.storageLimitBytes / (1024 ** 3)).toFixed(0);
        const usedGb = (usedBytes / (1024 ** 3)).toFixed(1);
        const blocked = {
          sermon,
          state: DL_STATE.ERROR,
          progress: 0,
          bytesDownloaded: 0,
          totalBytes: incoming,
          magnet: null,
          infoHash: null,
          error: `Storage limit reached — ${usedGb} GB of ${capGb} GB used. Raise the limit in Settings or free up space, then try again.`,
          startTime: null,
          source: null,
          sourceUrl: null,
        };
        this.queue.set(sermon.id, blocked);
        this._notify(sermon.id, blocked);
        throw new Error(blocked.error);
      }
    }

    const entry = {
      sermon,
      state: DL_STATE.QUEUED,
      progress: 0,
      bytesDownloaded: 0,
      totalBytes: sermon.sizeBytes || 0,
      magnet: null,
      infoHash: null,
      error: null,
      startTime: null,
      source: null,
      sourceUrl: null, // Track the actual URL used for bridge registration
    };
    this.queue.set(sermon.id, entry);
    this._notify(sermon.id, entry);

    // Wait for slot
    while (this.activeDownloads >= this.maxConcurrent || this.paused) {
      await new Promise(r => setTimeout(r, 500));
      if (this.paused) continue;
    }

    this.activeDownloads++;
    entry.state = DL_STATE.DOWNLOADING;
    entry.startTime = Date.now();
    this._notify(sermon.id, entry);

    let bytes;
    const ext = sermon.format || (sermon.type === 'video' ? 'mp4' : 'mp3');
    const filename = `${sermon.id}.${ext}`;

    try {
      // ── PHASE 1: Download (holds concurrency slot) ──────────────────
      // All modes currently download over HTTP (Archive.org → CDN). The peer
      // swarm is fed by seeding completed files; swarm-first fetching will
      // become possible once catalog entries carry magnet links.
      bytes = await this._fetchWithArchiveFallback(sermon, entry);

      // Save file to disk IMMEDIATELY (so it appears in My Downloads right away)
      const fileSizeMB = (bytes.byteLength / (1024 * 1024)).toFixed(1);
      console.log(`[DL] Saving ${filename} (${fileSizeMB} MB) to disk...`);

      try {
        const savedPath = await saveFileToDisk(filename, bytes);
        if (savedPath) {
          console.log(`[DL] Saved to disk: ${savedPath}`);
        } else {
          console.warn(`[DL] saveFileToDisk returned null for ${filename}`);
        }
      } catch (saveErr) {
        console.error(`[DL] Failed to save ${filename} to disk:`, saveErr.message);
      }

    } catch (err) {
      entry.state = DL_STATE.ERROR;
      entry.error = err.message;
      this._notify(sermon.id, entry);
      this.activeDownloads--;
      console.error(`[DL] Failed: "${sermon.title}":`, err);
      // Best-effort: remove any partial file left on disk so a broken download
      // can't linger, be mistaken for complete, or get seeded to the swarm
      try {
        const invoke = await loadTauri();
        if (invoke) {
          await invoke('delete_sermon_file', { filename }).catch(() => {});
        }
      } catch { /* best effort — never mask the original error */ }
      throw err;
    }

    // ── Release download slot — other queued downloads can proceed now ──
    this.activeDownloads--;

    // NOTE: We intentionally do NOT auto-create a human-readable Library copy
    // here anymore. Hardlinks only stay "free" on the SAME filesystem; once the
    // download folder is an external drive (a common seed-node setup) the OS
    // can't hardlink across volumes and silently falls back to a full COPY,
    // doubling the space a volunteer needs (500 GB → 1 TB). Instead, readable
    // copies are produced on demand via the Export buttons in My Downloads,
    // which write into Desktop/<Speaker>/<Title>.<ext> only when the user asks.

    // ── PHASE 2: Seed the file to the torrent swarm (fire-and-forget) ──
    // Hashing large files can take a while, so we don't block completion on
    // it. When seeding finishes, the entry is updated with magnet/info_hash
    // and listeners are re-notified — a seeding failure never breaks the flow.
    entry.state = DL_STATE.SEEDING;
    this._notify(sermon.id, entry);

    trySeedTorrent(filename, sermon)
      .then((seedInfo) => {
        if (seedInfo && seedInfo.magnet) {
          entry.magnet = seedInfo.magnet;
          entry.infoHash = seedInfo.info_hash || null;
          console.log(`[DL] Seeding "${sermon.title}" → ${seedInfo.info_hash}`);
          this._notify(sermon.id, entry);
        }
      })
      .catch(() => { /* never breaks the download flow */ });

    entry.state = DL_STATE.COMPLETE;
    if (!entry.magnet) entry.magnet = `local-${sermon.id}`;
    entry.progress = 100;
    entry.bytesDownloaded = bytes.byteLength;
    this.totalDownloaded += bytes.byteLength;
    this.totalFiles++;
    this._notify(sermon.id, entry);

    const doneSizeMB = (bytes.byteLength / (1024 * 1024)).toFixed(1);
    console.log(`[DL] Complete: "${sermon.title}" via ${entry.source} (${doneSizeMB} MB)`);
    return entry.magnet;
  }

  /**
   * Retry a URL fetch up to maxRetries times with a small delay between attempts.
   */
  async _fetchWithRetry(url, entry, maxRetries = 2) {
    let lastError;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await this._fetchFromUrl(url, entry);
      } catch (e) {
        lastError = e;
        if (attempt < maxRetries && e.message.includes('Incomplete download')) {
          console.warn(`[DL] Attempt ${attempt + 1} failed (incomplete), retrying in 2s...`);
          await new Promise(r => setTimeout(r, 2000));
          // Reset progress for retry
          entry.bytesDownloaded = 0;
          entry.progress = 0;
        } else {
          throw e;
        }
      }
    }
    throw lastError;
  }

  /**
   * Try Archive.org first, then CDN — with retries for incomplete downloads
   */
  async _fetchWithArchiveFallback(sermon, entry) {
    // Try Archive.org first (free)
    if (sermon.archiveUrl) {
      try {
        const bytes = await this._fetchWithRetry(sermon.archiveUrl, entry);
        entry.source = 'archive.org';
        entry.sourceUrl = sermon.archiveUrl;
        return bytes;
      } catch (e) {
        console.warn(`[DL] Archive.org failed for "${sermon.title}": ${e.message}, trying CDN...`);
      }
    }

    // Fallback to Bunny CDN
    if (sermon.cdnUrl) {
      try {
        const bytes = await this._fetchWithRetry(sermon.cdnUrl, entry);
        entry.source = 'cdn';
        entry.sourceUrl = sermon.cdnUrl;
        return bytes;
      } catch (e) {
        console.warn(`[DL] CDN failed for "${sermon.title}": ${e.message}`);
      }
    }

    throw new Error('No available source for download');
  }

  /**
   * Download from a URL with progress tracking and bandwidth throttling
   */
  async _fetchFromUrl(url, entry) {
    // 5 minute timeout for the initial connection (the streaming read has its own implicit timeout)
    const controller = new AbortController();
    const connectionTimeout = setTimeout(() => controller.abort(), 5 * 60 * 1000);
    let response;
    try {
      response = await fetch(url, { signal: controller.signal });
    } finally {
      clearTimeout(connectionTimeout);
    }
    if (!response.ok) throw new Error(`HTTP ${response.status} from ${new URL(url).hostname}`);

    const contentLength = parseInt(response.headers.get('content-length') || '0');
    if (contentLength > 0) {
      entry.totalBytes = contentLength;
    }
    // Use the best estimate of total size for progress calculation
    const estimatedTotal = contentLength || entry.totalBytes || entry.sermon?.sizeBytes || 0;

    const reader = response.body.getReader();
    const chunks = [];
    let received = 0;
    let lastNotify = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      chunks.push(value);
      received += value.length;
      entry.bytesDownloaded = received;
      // Calculate progress using best available size estimate
      if (estimatedTotal > 0) {
        entry.progress = Math.min((received / estimatedTotal) * 100, 99);
      } else {
        // No size info at all — show indeterminate-style progress (received bytes only)
        entry.progress = -1; // signals "downloading but unknown total"
      }
      // Throttle notifications to max ~10 per second to avoid flooding React state updates
      const now = Date.now();
      if (now - lastNotify >= 100 || done) {
        lastNotify = now;
        this._notify(entry.sermon.id, entry);
      }

      // Bandwidth throttling
      if (this.bandwidthLimit > 0) {
        const elapsed = (Date.now() - entry.startTime) / 1000;
        const targetTime = received / this.bandwidthLimit;
        if (elapsed < targetTime) {
          await new Promise(r => setTimeout(r, (targetTime - elapsed) * 1000));
        }
      }
    }

    // Final progress notification after loop completes
    entry.bytesDownloaded = received;
    entry.progress = 99; // Almost done — will hit 100 when COMPLETE state is set
    this._notify(entry.sermon.id, entry);

    const totalLength = chunks.reduce((acc, c) => acc + c.length, 0);

    // Integrity check: if server sent Content-Length, verify we got the full file
    if (contentLength > 0 && totalLength < contentLength) {
      const pct = Math.round((totalLength / contentLength) * 100);
      throw new Error(`Incomplete download: got ${totalLength} of ${contentLength} bytes (${pct}%) from ${new URL(url).hostname}`);
    }

    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }

    return result.buffer;
  }

  /**
   * Batch download for seed nodes
   */
  async downloadBatch(sermons, onBatchProgress) {
    const total = sermons.length;
    let completed = 0;
    let failed = 0;

    for (const sermon of sermons) {
      if (this.paused) {
        await new Promise(r => {
          const check = setInterval(() => {
            if (!this.paused) { clearInterval(check); r(); }
          }, 1000);
        });
      }

      try {
        await this.download(sermon);
        completed++;
      } catch {
        failed++;
      }

      if (onBatchProgress) {
        onBatchProgress({
          total,
          completed,
          failed,
          progress: (completed / total) * 100,
          totalBytes: this.totalDownloaded,
        });
      }
    }

    return { total, completed, failed };
  }

  pause() { this.paused = true; }
  resume() { this.paused = false; }

  cancel(sermonId) {
    if (this.queue.has(sermonId)) {
      const entry = this.queue.get(sermonId);
      if (entry.state === DL_STATE.QUEUED || entry.state === DL_STATE.DOWNLOADING) {
        entry.state = DL_STATE.ERROR;
        entry.error = 'Cancelled';
        this._notify(sermonId, entry);
      }
    }
  }

  getState(sermonId) { return this.queue.get(sermonId) || null; }
  getAll() { return Object.fromEntries(this.queue); }

  getStats() {
    return {
      totalDownloaded: this.totalDownloaded,
      totalFiles: this.totalFiles,
      activeDownloads: this.activeDownloads,
      queueSize: [...this.queue.values()].filter(e => e.state === DL_STATE.QUEUED).length,
      mode: this.mode,
      paused: this.paused,
    };
  }
}

const downloadManager = new DownloadManager();
export default downloadManager;
