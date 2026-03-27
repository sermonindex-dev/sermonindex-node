/**
 * SermonIndex Download Manager
 *
 * Download priority:
 *   1. Archive.org (free, unlimited) — primary source
 *   2. Bunny CDN (paid, fast) — fallback
 *   3. IPFS peers — when network is strong enough
 *
 * Features:
 * - Download queue with concurrency control
 * - Progress tracking per file and overall
 * - Automatic IPFS pinning after download
 * - Resume capability
 * - Bandwidth throttling
 * - Archive.org → CDN → IPFS mode switching
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

// IPFS is optional — lazy-loaded on first use to avoid top-level await
let ipfsModule = null;
let ipfsLoadAttempted = false;

async function loadIPFS() {
  if (ipfsLoadAttempted) return ipfsModule;
  ipfsLoadAttempted = true;
  try {
    ipfsModule = await import('./ipfs.js');
  } catch (e) {
    console.warn('[DL] IPFS module not available, downloads will work without pinning');
    ipfsModule = null;
  }
  return ipfsModule;
}

async function tryPinToIPFS(bytes, sermonId, sourceUrl = null) {
  const mod = await loadIPFS();
  if (!mod) return null;
  try {
    if (!mod.isNodeRunning()) return null;
    return await mod.addFile(bytes, sermonId, sourceUrl);
  } catch (e) {
    console.warn('[DL] IPFS pinning skipped:', e.message);
    return null;
  }
}

export const DL_STATE = {
  QUEUED: 'queued',
  DOWNLOADING: 'downloading',
  PINNING: 'pinning',
  COMPLETE: 'complete',
  ERROR: 'error',
  PAUSED: 'paused',
};

// Content source modes — controlled by admin, not user
export const SOURCE_MODE = {
  CDN_PRIMARY: 'cdn',           // Archive.org first, CDN fallback, IPFS last
  IPFS_PRIMARY: 'ipfs-primary', // IPFS first, Archive.org fallback, CDN last
  IPFS_ONLY: 'ipfs-only',       // IPFS only — full decentralization
};

class DownloadManager {
  constructor() {
    this.queue = new Map();
    this.listeners = new Set();
    this.maxConcurrent = 3;
    this.activeDownloads = 0;
    this.mode = SOURCE_MODE.CDN_PRIMARY;
    this.bandwidthLimit = 0; // bytes/sec, 0 = unlimited
    this.paused = false;
    this.totalDownloaded = 0;
    this.totalFiles = 0;
  }

  setMode(mode) {
    this.mode = mode;
  }

  setBandwidthLimit(mbps) {
    this.bandwidthLimit = mbps > 0 ? mbps * 125000 : 0;
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
      return this.queue.get(sermon.id).cid;
    }

    const entry = {
      sermon,
      state: DL_STATE.QUEUED,
      progress: 0,
      bytesDownloaded: 0,
      totalBytes: sermon.sizeBytes || 0,
      cid: null,
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
      if (this.mode === SOURCE_MODE.IPFS_ONLY) {
        bytes = await this._fetchFromIPFS(sermon, entry);
        entry.source = 'ipfs';
      } else if (this.mode === SOURCE_MODE.IPFS_PRIMARY) {
        try {
          bytes = await this._fetchFromIPFS(sermon, entry);
          entry.source = 'ipfs';
        } catch {
          bytes = await this._fetchWithArchiveFallback(sermon, entry);
        }
      } else {
        // Default: Archive.org → CDN → IPFS
        bytes = await this._fetchWithArchiveFallback(sermon, entry);
      }

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
      throw err;
    }

    // ── Release download slot — other queued downloads can proceed now ──
    this.activeDownloads--;

    // ── PHASE 2: Post-processing (IPFS pin, no slot needed) ──
    try {
      // Try to pin to IPFS with a 30-second timeout (non-critical)
      entry.state = DL_STATE.PINNING;
      this._notify(sermon.id, entry);

      let cid = null;
      try {
        const pinPromise = tryPinToIPFS(bytes, sermon.id, entry.sourceUrl);
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('IPFS pin timeout')), 30000)
        );
        cid = await Promise.race([pinPromise, timeoutPromise]);
      } catch (pinErr) {
        console.warn(`[DL] IPFS pin skipped for "${sermon.title}":`, pinErr.message);
      }

      entry.state = DL_STATE.COMPLETE;
      entry.cid = cid || `local-${sermon.id}`;
      entry.progress = 100;
      entry.bytesDownloaded = bytes.byteLength;
      this.totalDownloaded += bytes.byteLength;
      this.totalFiles++;
      this._notify(sermon.id, entry);

      const fileSizeMB = (bytes.byteLength / (1024 * 1024)).toFixed(1);
      console.log(`[DL] Complete: "${sermon.title}" via ${entry.source} (${fileSizeMB} MB) → CID: ${cid || 'local'}`);
      return cid;

    } catch (err) {
      // Post-processing failed but file is already on disk
      entry.state = DL_STATE.COMPLETE;
      entry.cid = `local-${sermon.id}`;
      entry.progress = 100;
      entry.bytesDownloaded = bytes.byteLength;
      this.totalDownloaded += bytes.byteLength;
      this.totalFiles++;
      this._notify(sermon.id, entry);
      console.warn(`[DL] Post-processing failed for "${sermon.title}" but file is saved:`, err.message);
      return entry.cid;
    }
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
        console.warn(`[DL] CDN failed for "${sermon.title}": ${e.message}, trying IPFS...`);
      }
    }

    // Last resort: IPFS
    if (sermon.cid || sermon.localCid) {
      const bytes = await this._fetchFromIPFS(sermon, entry);
      entry.source = 'ipfs';
      return bytes;
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
   * Fetch from IPFS peers
   */
  async _fetchFromIPFS(sermon, entry) {
    const cid = sermon.cid || sermon.localCid;
    if (!cid) throw new Error('No CID available for IPFS fetch');
    const mod = await loadIPFS();
    if (!mod || !mod.isNodeRunning()) throw new Error('IPFS node not running');
    entry.source = 'ipfs';
    const bytes = await mod.getFile(cid);
    return bytes.buffer;
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
