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

// Tauri event listener — used for native streaming download progress.
let tauriListen = null;
let tauriListenLoaded = false;
async function loadTauriListen() {
  if (tauriListenLoaded) return tauriListen;
  tauriListenLoaded = true;
  try {
    const mod = await import('@tauri-apps/api/event');
    tauriListen = mod.listen;
  } catch {
    tauriListen = null;
  }
  return tauriListen;
}

/**
 * Whether the native streaming download command is usable.
 *
 * Flipped to false the first time `stream_sermon_file` comes back "not found",
 * i.e. a frontend running against an older native binary. Everything then falls
 * back to the buffered fetch + chunked-save path below, which is left fully
 * intact for exactly that reason.
 */
let streamingSupported = true;
const STREAM_PROGRESS_EVENT = 'sermon-download-progress';

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

/**
 * Write the downloaded bytes to disk.
 *
 * Returns `{ path, size }` where `size` is the REAL on-disk byte length reported
 * by the Rust side — NOT the number of bytes we counted off the network. Those
 * two never disagreeing is precisely why a failed write used to be invisible.
 *
 * THROWS on any failure. A file we could not write is not a download: the caller
 * must fail the whole thing rather than report a "complete" sermon that isn't
 * there. Returns null ONLY when there is no native backend at all (dev in a
 * plain browser), where there is no disk to write to in the first place.
 *
 * Both paths stage into `<final>.part` on the Rust side and the real filename
 * only appears when the write is finalized, so an interrupted download can never
 * be mistaken for a complete sermon or seeded to the swarm.
 */
async function saveFileToDisk(filename, bytes) {
  const invoke = await loadTauri();
  if (!invoke) return null; // no native side — nothing to write to

  const totalSize = bytes.byteLength;

  if (totalSize <= CHUNK_THRESHOLD) {
    // Small file — single base64 transfer (fast path). save_sermon_file stages
    // and renames atomically inside Rust, so there is nothing here to finalize
    // or abort: it either produced the whole file or it threw.
    const dataB64 = arrayBufferToBase64(bytes);
    const saved = await invoke('save_sermon_file', { filename, dataB64 });
    return { path: saved?.path || '', size: Number(saved?.size ?? 0) };
  }

  // Large file — chunked write to avoid memory explosion. The bytes accumulate
  // in <file>.part and the sermon DOES NOT EXIST under its real name until
  // finalize_sermon_file renames it. Every exit path below therefore either
  // finalizes or aborts — there is no third way out.
  console.log(`[DL] Large file (${(totalSize / 1024 / 1024).toFixed(1)} MB), using chunked save...`);
  await invoke('create_sermon_file', { filename });
  try {
    const uint8 = new Uint8Array(bytes);
    let offset = 0;
    let chunkNum = 0;
    const totalChunks = Math.ceil(totalSize / CHUNK_SIZE);

    while (offset < totalSize) {
      const end = Math.min(offset + CHUNK_SIZE, totalSize);
      const chunk = uint8.subarray(offset, end);
      const chunkB64 = chunkToBase64(chunk);
      const staged = await invoke('append_sermon_chunk', { filename, chunkB64 });
      offset = end;
      chunkNum++;
      // append_sermon_chunk reports the total bytes staged so far — cross-check
      // it instead of assuming the write landed where we think it did.
      if (Number(staged) !== offset) {
        throw new Error(`Staged size mismatch after chunk ${chunkNum}/${totalChunks}: disk has ${staged} bytes, expected ${offset}`);
      }
      if (chunkNum % 10 === 0 || chunkNum === totalChunks) {
        console.log(`[DL] Chunk ${chunkNum}/${totalChunks} written`);
      }
    }

    // REQUIRED. Without this the .part is never renamed and the sermon never
    // appears under its real name — i.e. every large download silently vanishes.
    const saved = await invoke('finalize_sermon_file', { filename });
    const size = Number(saved?.size ?? 0);
    console.log(`[DL] Chunked save complete: ${saved?.path} (${size} bytes)`);
    return { path: saved?.path || '', size };
  } catch (e) {
    // Never leave a .part behind: it wastes the space and would confuse a later
    // finalize. Best-effort — the original error is what the caller needs.
    try { await invoke('abort_sermon_file', { filename }); } catch { /* best effort */ }
    throw e;
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

// ── Resilience tuning ──────────────────────────────────────────────────────
// Archive.org rate-limits aggressively during bulk pulls (429s, mid-stream
// resets, occasional 5xx). These knobs turn a transient blip into a retry
// instead of a permanent gap in a seed node's library.
const MAX_ATTEMPTS_PER_SOURCE = 3;   // tries per source within one pass
const SOURCE_PASSES = 2;             // full Archive→CDN rounds before failing the file
const BATCH_RETRY_PASSES = 2;        // extra passes over the failed set at end of a batch
const BASE_BACKOFF_MS = 1000;        // 1s → 2s → 4s → 8s …
const MAX_BACKOFF_MS = 30000;        // hard ceiling per wait
const MAX_RETRY_AFTER_MS = 120000;   // never obey an absurd Retry-After
// A source that answers with one of these simply doesn't have the file —
// retrying it is pointless (and looks like abuse). Fall back to the other source.
const NON_RETRYABLE_STATUS = new Set([400, 401, 403, 404, 410, 451]);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// A cancellation is not a transient failure — it must never be retried or
// backed off, only propagated straight out of the download.
function cancelledError() {
  const err = new Error('Cancelled');
  err.cancelled = true;
  err.fatalSource = true; // stops the per-source retry/fallback machinery dead
  return err;
}

function hostOf(url) {
  try { return new URL(url).hostname; } catch { return 'source'; }
}

// Exponential backoff with jitter (jitter avoids a bulk run re-hitting the
// host in lockstep after a rate-limit burst).
function backoffDelay(attempt) {
  const base = Math.min(BASE_BACKOFF_MS * Math.pow(2, attempt), MAX_BACKOFF_MS);
  return Math.round(base + Math.random() * Math.min(base, 2000));
}

// Honor Retry-After on 429/503 — seconds or HTTP-date form.
// Takes the RAW header value so it can be used both for a fetch Response and
// for the raw string the native streaming command hands back.
function parseRetryAfterValue(raw) {
  if (!raw) return 0;
  const secs = Number(raw);
  if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, MAX_RETRY_AFTER_MS);
  const when = Date.parse(raw);
  if (!Number.isNaN(when)) return Math.max(0, Math.min(when - Date.now(), MAX_RETRY_AFTER_MS));
  return 0;
}

function parseRetryAfter(response) {
  try { return parseRetryAfterValue(response.headers.get('retry-after')); } catch { return 0; }
}

// ── Batch persistence ──────────────────────────────────────────────────────
//
// A volunteer pulling the whole archive queues ~33,500 files / ~437 GB. That run
// WILL be interrupted — a lid closes, the app quits, the machine reboots. Until
// now the pending queue and the accumulated failure list lived only in memory,
// so a restart meant working out by hand where you had got to. This keeps both.
//
// WHERE IT LIVES — settings.json (Rust save_settings/load_settings), NOT
// localStorage. Measured: the full 33,528-id queue serialises to 637,033 bytes
// as a JSON array of ids. WebView2/WebKitGTK enforce roughly a 5 MB per-origin
// quota for the WHOLE origin, and localStorage here already carries
// `si_download_state` (one record per downloaded sermon — megabytes on a seed
// node). Adding another ~0.6 MB on top is exactly the kind of near-the-line
// write that failed silently for the 22.7 MB master list (see catalog.js). The
// Rust settings file is atomic, quota-free, and already the pattern the app uses
// for anything that must not be lost — so it is what we use here. Reads and
// writes go through a read-modify-write on the whole settings object (the same
// shape heartbeat.js uses for node_id) and are serialised through a promise
// chain so two checkpoints can never interleave and drop each other's keys.
//
// WHAT IT STORES — sermon IDS ONLY, never sermon objects. Sermon objects are
// large and go stale (the master list merges torrent fields into them minutes
// after launch). Everything is re-resolved against the live catalog on load.
const BATCH_STATE_KEY = 'bulk_batch';
const BATCH_STATE_VERSION = 1;
// CADENCE — a write after every file would mean 33,500 rewrites of a 637 KB
// file, and a write only at the end would lose everything to the crash we are
// trying to survive. So: whichever of these comes first, plus a forced write on
// start, on pause, on stop and at the end. Worst case a crash costs the user
// 25 files (~20 minutes of re-checking, and re-checking is cheap because
// already-downloaded files are skipped on resume, not re-fetched).
const CHECKPOINT_EVERY_FILES = 25;
const CHECKPOINT_EVERY_MS = 60_000;
// Failure records are id + a trimmed message. Capped so a catastrophic run
// (every source down) can't grow the settings file without bound.
const MAX_PERSISTED_FAILURES = 2000;
const MAX_PERSISTED_ERROR_CHARS = 200;

let storeModule = null;
let storeLoadAttempted = false;
async function loadStore() {
  if (storeLoadAttempted) return storeModule;
  storeLoadAttempted = true;
  try {
    storeModule = await import('./tauriStore.js');
  } catch (e) {
    console.warn('[DL] Persistent store unavailable — the bulk queue will not survive a restart:', e?.message || e);
    storeModule = null;
  }
  return storeModule;
}

// Serialises every read-modify-write of settings.json. Without this, two
// checkpoints in flight at once would both read the old object and the second
// save would erase whatever the first added (including node_id).
let _settingsChain = Promise.resolve();
let _settingsWriteWarned = false;

/**
 * Read settings.json, hand the parsed object to `mutate`, and write it back.
 * Return `false` from `mutate` to read without writing.
 * Never throws — a storage failure must not take a download run down with it,
 * but it IS logged loudly once (silent write failures are how the master-list
 * cache appeared to work for months).
 */
function _withSettings(mutate) {
  const run = async () => {
    const store = await loadStore();
    if (!store) return null;
    let settings = null;
    try { settings = await store.loadSettings(); } catch { settings = null; }
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) settings = {};
    const wants = mutate(settings);
    if (wants === false) return settings;
    try {
      await store.saveSettings(settings);
    } catch (e) {
      if (!_settingsWriteWarned) {
        _settingsWriteWarned = true;
        console.warn(`[DL] Saving the bulk-download queue FAILED — it will not survive a restart: ${e?.message || e}`);
      }
    }
    return settings;
  };
  const result = _settingsChain.then(run, run);
  _settingsChain = result.then(() => {}, () => {});
  return result;
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
    // Conservative on purpose: Archive.org throttles per-client aggressively,
    // and a 429 storm is what turns a bulk run into dozens of "failed" files.
    // Bulk/seed runs are sequential anyway; this only caps ad-hoc parallelism.
    this.maxConcurrent = 2;
    this.activeDownloads = 0;
    this.lastBatchFailures = []; // [{ sermon, error }] from the last downloadBatch()
    this.mode = SOURCE_MODE.CDN_PRIMARY;
    this.bandwidthLimit = 0; // bytes/sec, 0 = unlimited (throttles HTTP downloads)
    this.storageLimitBytes = 0; // bytes, 0 = unlimited (caps total cached sermons)
    this.paused = false;
    this.totalDownloaded = 0;
    this.totalFiles = 0;
    // Waiters parked on a concurrency slot (event-driven — no busy-polling).
    this._slotWaiters = [];
    // Storage-cap admission control: a serialising chain plus the bytes already
    // admitted but not yet on disk. See _reserveStorage().
    this._capChain = Promise.resolve();
    this._reservedBytes = 0;
    // Native streaming downloads: filename → queue entry, so the single
    // `sermon-download-progress` listener can route each event to its bar.
    this._streamEntries = new Map();
    this._streamListenerPromise = null;
    // Set while a batch is running: forces an immediate checkpoint of the saved
    // queue (used when the user pauses or stops). Null when no batch is running.
    this._checkpointNow = null;
  }

  setMode(mode) {
    this.mode = mode;
  }

  // ── Concurrency slots ──────────────────────────────────────────────────
  // Event-driven rather than a 500 ms busy-poll: every release/resume/cancel
  // wakes the parked waiters, which re-check the condition and either take a
  // slot or park again.

  _wakeSlotWaiters() {
    const waiters = this._slotWaiters;
    this._slotWaiters = [];
    for (const wake of waiters) wake();
  }

  async _acquireSlot(entry) {
    while (this.activeDownloads >= this.maxConcurrent || this.paused) {
      if (entry?.cancelled) throw cancelledError();
      await new Promise((resolve) => this._slotWaiters.push(resolve));
    }
    if (entry?.cancelled) throw cancelledError();
    this.activeDownloads++;
  }

  _releaseSlot() {
    if (this.activeDownloads > 0) this.activeDownloads--;
    this._wakeSlotWaiters();
  }

  /**
   * Storage-cap admission control (opt-in; 0 = unlimited).
   *
   * Serialised through a promise chain AND holding a reservation for bytes that
   * are in flight. Plain read-then-act let two concurrent downloads observe the
   * same `used` figure and both pass the same check, so the cap could be blown
   * by up to maxConcurrent files. Reservations are released once the bytes are
   * on disk (where get_storage_usage can see them) or the download fails.
   *
   * Fails OPEN when usage can't be measured (e.g. running in a plain browser) —
   * same as before.
   */
  async _reserveStorage(incoming) {
    const admit = async () => {
      if (this.storageLimitBytes <= 0) return 0;
      let usedBytes = 0;
      try {
        const invoke = await loadTauri();
        if (invoke) {
          const usage = await invoke('get_storage_usage');
          usedBytes = usage?.bytes || 0;
        }
      } catch { usedBytes = 0; }
      const committed = usedBytes + this._reservedBytes;
      if (committed + incoming > this.storageLimitBytes) {
        const capGb = (this.storageLimitBytes / (1024 ** 3)).toFixed(0);
        const usedGb = (committed / (1024 ** 3)).toFixed(1);
        throw new Error(`Storage limit reached — ${usedGb} GB of ${capGb} GB used. Raise the limit in Settings or free up space, then try again.`);
      }
      this._reservedBytes += incoming;
      return incoming;
    };
    // Run after whatever is already queued, whether it succeeded or not, and
    // keep the chain alive either way.
    const result = this._capChain.then(admit, admit);
    this._capChain = result.then(() => {}, () => {});
    return result;
  }

  _releaseReservation(bytes) {
    if (bytes > 0) this._reservedBytes = Math.max(0, this._reservedBytes - bytes);
  }

  /**
   * Re-seed the sermons the user actually has on disk. Called once at startup
   * (the torrent session no longer persists its own list — see torrent_node.rs),
   * so this runs on EVERY launch. `sermons` should be getDownloaded().
   *
   * TRUST RULE — the same one trySeedTorrent uses for a fresh download: prefer
   * the CANONICAL torrent from the signed master list. seedDownloaded() hashes
   * the local bytes and derives an infohash FROM THEM, so one wrong byte gives a
   * different infohash: the node joins a swarm of one, silently stops
   * contributing to the real swarm, and reports that wrong infohash to the
   * dashboard. addTorrent(torrentUrl || magnet, filename) instead hands librqbit
   * the official fingerprint and points it at this file's own shard folder
   * (overwrite:true) so it hash-checks and resumes the existing bytes rather
   * than re-downloading them — and because the canonical magnets carry `&ws=`
   * CDN webseeds, a damaged file gets REPAIRED instead of merely rejected.
   * It also does the hashing once instead of twice (self-seeding hashes to build
   * the .torrent, then hashes again to verify on add).
   *
   * seedDownloaded() remains the fallback for sermons with no canonical entry.
   *
   * Non-blocking by design: callers fire and forget, and we yield between files
   * so a full seed node's library never stalls app launch.
   */
  async reseedExisting(sermons) {
    if (!Array.isArray(sermons) || sermons.length === 0) return;
    const mod = await loadTorrent();
    if (!mod) return;
    try { await mod.startSession(); } catch { return; }

    // The master list lands a few seconds after launch. Wait briefly for it —
    // self-seeding the entire library because we were three seconds early is
    // exactly the failure this is meant to prevent. Bounded at ~20s.
    let byId = null;
    try {
      const cat = await import('./catalog.js');
      for (let i = 0; i < 10 && !cat.hasMasterList(); i++) await sleep(2000);
      // Snapshot ONCE into a lookup map: getCatalog() rebuilds the whole 33k
      // array on every call, and calling it per sermon would be quadratic.
      byId = new Map(cat.getCatalog().map((c) => [c.id, c]));
    } catch { /* catalog unavailable — fall back to what we were handed */ }

    let canonical = 0, local = 0, failed = 0;
    for (const s of sermons) {
      // Re-resolve against the LIVE catalog: the objects we were handed were
      // snapshotted before the master list merged its torrent fields in.
      const fresh = (byId && byId.get(s?.id)) || s;
      const ext = fresh.type === 'video' ? 'mp4' : 'mp3';
      const filename = `${fresh.id}.${ext}`;
      const source = fresh.torrentUrl || (fresh.magnet?.startsWith('magnet:') ? fresh.magnet : null);
      try {
        if (source) {
          await mod.addTorrent(source, filename);
          canonical++;
        } else {
          await mod.seedDownloaded(filename);
          local++;
        }
      } catch (e) {
        if (source) {
          // Canonical .torrent unreachable (CDN hiccup, or never published for
          // this sermon) — fall back so the file is at least shareable.
          try {
            await mod.seedDownloaded(filename);
            local++;
          } catch (e2) {
            failed++;
            console.warn('[DL] reseed skipped', filename, e2?.message || e2);
          }
        } else {
          // File may have just been removed, or hashing failed — skip quietly.
          failed++;
          console.warn('[DL] reseed skipped', filename, e?.message || e);
        }
      }
      await sleep(0); // yield — this loop can be tens of thousands long
    }
    console.log(`[DL] Re-seeded ${canonical + local} existing download(s) — ${canonical} canonical, ${local} self-hashed, ${failed} failed`);
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

  // ── Native streaming download ──────────────────────────────────────────
  // The bytes go socket → `<file>.part` → fsync → rename entirely inside Rust
  // (see stream_sermon_file in lib.rs), so the webview never holds the file.
  // Everything the old JS path provided is preserved, just split differently:
  // progress arrives as events, throttling and Range/resume happen in Rust,
  // and retry/backoff/source-alternation stay HERE — that logic understands
  // Retry-After, jitter and dead sources and is not worth re-deriving in Rust,
  // so the command reports what happened and these loops decide what to do.

  /**
   * Register the one-and-only progress listener (idempotent).
   * Returns false when there is no native event API, which is the signal to
   * use the buffered path instead of showing a frozen progress bar.
   */
  async _ensureProgressListener() {
    if (this._streamListenerPromise) return this._streamListenerPromise;
    this._streamListenerPromise = (async () => {
      const listen = await loadTauriListen();
      if (!listen) return false;
      try {
        await listen(STREAM_PROGRESS_EVENT, (ev) => {
          const p = ev?.payload || {};
          const entry = this._streamEntries.get(p.filename);
          if (!entry) return;
          const received = Number(p.received || 0);
          const total = Number(p.total || 0);
          if (total > 0) entry.totalBytes = total;
          entry.bytesDownloaded = received;
          const estimatedTotal = total || entry.totalBytes || entry.sermon?.sizeBytes || 0;
          entry.progress = estimatedTotal > 0
            ? Math.min((received / estimatedTotal) * 100, 99)
            : -1; // unknown total — same "indeterminate" signal as before
          // Rust already emits ~10/sec; this is a second guard so a future
          // change there can't flood React state updates.
          const now = Date.now();
          if (now - (entry._lastStreamNotify || 0) >= 100) {
            entry._lastStreamNotify = now;
            this._notify(entry.sermon.id, entry);
          }
        });
        return true;
      } catch (e) {
        console.warn('[DL] Progress listener unavailable:', e?.message || e);
        return false;
      }
    })();
    return this._streamListenerPromise;
  }

  /**
   * One streaming attempt. Resolves with `{ path, size, received }` where
   * `size` is the REAL on-disk length from fs::metadata after the rename.
   * Rejects with the same error shape the fetch path produces
   * (`status` / `retryAfterMs` / `fatalSource` / `resumable`) so the retry and
   * source-fallback loops below are identical in behaviour.
   */
  async _streamOnce(url, entry, filename, resume) {
    const invoke = await loadTauri();
    if (!invoke) throw new Error('Native backend unavailable');
    if (entry.cancelled) throw cancelledError();

    this._streamEntries.set(filename, entry);
    let outcome;
    try {
      outcome = await invoke('stream_sermon_file', {
        url,
        filename,
        resume,
        limitBps: Math.max(0, Math.round(this.bandwidthLimit || 0)),
      });
    } catch (e) {
      const msg = e?.message || String(e);
      // A frontend running against an older native binary: the command simply
      // isn't there. Remember it and let download() use the buffered path.
      // Matches Tauri's "Command stream_sermon_file not found". Deliberately
      // narrow: "URL not allowed" (the host allowlist) must NOT disable
      // streaming — it is a security rejection, not a missing feature.
      if (/(not\s+found|unknown)/i.test(msg) && /command|stream_sermon_file/i.test(msg)) {
        streamingSupported = false;
        const unsupported = new Error(`Native streaming unavailable: ${msg}`);
        unsupported.streamUnsupported = true;
        unsupported.fatalSource = true;
        throw unsupported;
      }
      // The command only returns Err for caller error (disallowed URL,
      // registry failure) — retrying cannot help.
      const err = new Error(msg);
      err.fatalSource = true;
      throw err;
    } finally {
      this._streamEntries.delete(filename);
    }

    const received = Number(outcome?.received ?? 0);
    if (Number(outcome?.total) > 0) entry.totalBytes = Number(outcome.total);
    entry.bytesDownloaded = received;

    if (outcome?.ok) {
      entry.progress = 99; // hits 100 when COMPLETE is set, as before
      this._notify(entry.sermon.id, entry);
      return { path: outcome.path || '', size: Number(outcome.size ?? 0), received };
    }

    if (outcome?.cancelled || entry.cancelled) throw cancelledError();

    const err = new Error(`${outcome?.error || 'Download failed'} from ${hostOf(url)}`);
    err.status = Number(outcome?.status ?? 0);
    err.retryAfterMs = parseRetryAfterValue(outcome?.retryAfter);
    err.fatalSource = !!outcome?.fatalSource;
    // Only claim resumability when there are actually staged bytes to resume.
    err.resumable = !!outcome?.resumable && received > 0;
    err.received = received;
    err.retryable = !err.fatalSource;
    throw err;
  }

  /**
   * Streaming equivalent of _fetchWithRetry: same attempt count, same jittered
   * backoff, same Retry-After handling, same non-retryable statuses. Resume is
   * expressed as a flag to the native side — the partially received bytes live
   * in `<file>.part` on disk instead of in a JS array.
   */
  async _streamWithRetry(url, entry, filename, maxAttempts = MAX_ATTEMPTS_PER_SOURCE) {
    let lastError;
    let resume = false; // first attempt for this source always starts clean
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (entry.cancelled) throw cancelledError();
      try {
        return await this._streamOnce(url, entry, filename, resume);
      } catch (e) {
        lastError = e;
        if (entry.cancelled) throw cancelledError();
        if (e?.streamUnsupported) throw e;   // fall back to the buffered path
        if (e?.fatalSource) throw e;         // 404 etc — don't hammer it
        if (attempt >= maxAttempts - 1) throw e;

        const wait = e?.retryAfterMs > 0
          ? Math.min(e.retryAfterMs, MAX_BACKOFF_MS)
          : backoffDelay(attempt);
        resume = !!e?.resumable;
        console.warn(
          `[DL] ${hostOf(url)} attempt ${attempt + 1}/${maxAttempts} failed (${e.message})` +
          ` — retrying in ${Math.round(wait / 100) / 10}s${resume ? ` (resume @ ${e.received} bytes)` : ''}`
        );
        await sleep(wait);
        if (!resume) {
          entry.bytesDownloaded = 0;
          entry.progress = 0;
        }
      }
    }
    throw lastError;
  }

  /**
   * Streaming equivalent of _fetchWithArchiveFallback — same two passes over
   * Archive.org → CDN, same dropping of sources that answer 404/410.
   * Each source starts its own `.part` from scratch: bytes from one source are
   * never appended to bytes from another (the fetch path had the same property,
   * since `partial` was created per source per pass).
   */
  async _streamWithArchiveFallback(sermon, entry, filename) {
    const sources = [];
    if (sermon.archiveUrl) sources.push({ name: 'archive.org', url: sermon.archiveUrl });
    if (sermon.cdnUrl) sources.push({ name: 'cdn', url: sermon.cdnUrl });
    if (sources.length === 0) throw new Error('No available source for download');

    const dead = new Set();
    let lastError = null;

    for (let pass = 0; pass < SOURCE_PASSES; pass++) {
      const live = sources.filter(s => !dead.has(s.name));
      if (live.length === 0) break;

      if (pass > 0) {
        const wait = backoffDelay(pass);
        console.warn(`[DL] All sources failed for "${sermon.title}" — pass ${pass + 1}/${SOURCE_PASSES} in ${Math.round(wait / 100) / 10}s`);
        await sleep(wait);
        entry.bytesDownloaded = 0;
        entry.progress = 0;
      }

      for (const src of live) {
        if (entry.cancelled) throw cancelledError();
        try {
          const saved = await this._streamWithRetry(src.url, entry, filename);
          entry.source = src.name;
          entry.sourceUrl = src.url;
          if (pass > 0 || src !== live[0]) {
            console.log(`[DL] Recovered "${sermon.title}" via ${src.name} (pass ${pass + 1})`);
          }
          return saved;
        } catch (e) {
          lastError = e;
          if (e?.streamUnsupported) throw e;
          if (e?.cancelled || entry.cancelled) throw cancelledError();
          if (e?.fatalSource) {
            dead.add(src.name);
            console.warn(`[DL] ${src.name} has no file for "${sermon.title}" (${e.message}) — dropping source`);
          } else {
            console.warn(`[DL] ${src.name} failed for "${sermon.title}": ${e.message}`);
          }
        }
      }
    }

    throw new Error(lastError ? `All sources failed — ${lastError.message}` : 'No available source for download');
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
    // touched. The check is atomic (see _reserveStorage) so two concurrent
    // downloads can't both squeeze past the same reading.
    const incoming = sermon.sizeBytes || sermon.totalBytes || 0;
    let reserved = 0;
    if (this.storageLimitBytes > 0) {
      try {
        reserved = (await this._reserveStorage(incoming)) || 0;
      } catch (capErr) {
        const blocked = {
          sermon,
          state: DL_STATE.ERROR,
          progress: 0,
          bytesDownloaded: 0,
          totalBytes: incoming,
          magnet: null,
          infoHash: null,
          diskSize: 0,
          error: capErr.message,
          startTime: null,
          source: null,
          sourceUrl: null,
        };
        this.queue.set(sermon.id, blocked);
        this._notify(sermon.id, blocked);
        throw capErr;
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
      diskSize: 0, // real on-disk size, filled in once the file is written
      error: null,
      startTime: null,
      source: null,
      sourceUrl: null, // Track the actual URL used for bridge registration
      cancelled: false,
      // Aborting this aborts the in-flight fetch — see cancel().
      controller: typeof AbortController !== 'undefined' ? new AbortController() : null,
    };
    this.queue.set(sermon.id, entry);
    this._notify(sermon.id, entry);

    // Wait for a concurrency slot (event-driven; also the point at which a
    // still-queued download notices it has been cancelled).
    try {
      await this._acquireSlot(entry);
    } catch (slotErr) {
      entry.state = DL_STATE.ERROR;
      entry.error = slotErr.message;
      this._notify(sermon.id, entry);
      this._releaseReservation(reserved);
      throw slotErr;
    }

    entry.state = DL_STATE.DOWNLOADING;
    entry.startTime = Date.now();
    this._notify(sermon.id, entry);

    let receivedBytes = 0;
    let diskSize = 0;
    // Set only if we renamed something onto the real filename and THEN found it
    // untrustworthy — that file has to go, unlike an untouched earlier copy.
    let wroteBadFile = false;
    const ext = sermon.format || (sermon.type === 'video' ? 'mp4' : 'mp3');
    const filename = `${sermon.id}.${ext}`;
    entry.filename = filename; // cancel() needs it to stop the native stream

    try {
      // ── PHASE 1: Download (holds concurrency slot) ──────────────────
      // All modes currently download over HTTP (Archive.org → CDN). The peer
      // swarm is fed by seeding completed files; swarm-first fetching will
      // become possible once catalog entries carry magnet links.
      //
      // Preferred path: Rust streams the body straight into `<file>.part` and
      // renames it, so the webview never holds the file (a 2 GB video used to
      // mean ~4 GB of JS heap plus a base64 copy over IPC). The buffered path
      // below is kept as the fallback for a plain browser and for a frontend
      // running against a native binary without the streaming command.
      const invoke = await loadTauri();
      const canStream = !!invoke && streamingSupported && (await this._ensureProgressListener());

      let streamed = null;
      if (canStream) {
        try {
          streamed = await this._streamWithArchiveFallback(sermon, entry, filename);
        } catch (streamErr) {
          if (!streamErr?.streamUnsupported) throw streamErr;
          console.warn('[DL] Native streaming unavailable — falling back to buffered download');
          streamed = null;
        }
      }

      if (streamed) {
        receivedBytes = streamed.received;
        diskSize = streamed.size;
        console.log(`[DL] Streamed to disk: ${streamed.path} (${diskSize} bytes)`);
        // The only size worth recording is the one the filesystem reports. If it
        // disagrees with what we received, the write is not trustworthy — and
        // the file HAS been renamed into place, so it must be deleted.
        if (diskSize !== receivedBytes) {
          wroteBadFile = true;
          throw new Error(`Disk write incomplete for ${filename}: ${diskSize} of ${receivedBytes} bytes on disk`);
        }
      } else {
        const bytes = await this._fetchWithArchiveFallback(sermon, entry);
        receivedBytes = bytes.byteLength;

        // Save file to disk IMMEDIATELY (so it appears in My Downloads right away)
        const fileSizeMB = (receivedBytes / (1024 * 1024)).toFixed(1);
        console.log(`[DL] Saving ${filename} (${fileSizeMB} MB) to disk...`);

        // A FAILED WRITE IS A FAILED DOWNLOAD. This used to be caught and logged
        // while the flow carried on to COMPLETE, so a full disk, an unplugged
        // external drive or a permissions error produced a "successful" download
        // of nothing — and with it a false library, a false coverage %, false
        // Seed Node progress and a heartbeat reporting files that don't exist.
        const saved = await saveFileToDisk(filename, bytes);
        if (saved) {
          diskSize = saved.size;
          console.log(`[DL] Saved to disk: ${saved.path} (${diskSize} bytes)`);
          if (diskSize !== receivedBytes) {
            wroteBadFile = true;
            throw new Error(`Disk write incomplete for ${filename}: ${diskSize} of ${receivedBytes} bytes on disk`);
          }
        } else {
          // No native backend (dev in a browser) — nothing was written and nothing
          // claims to have been. Fall back to the received count for display only.
          diskSize = receivedBytes;
        }
      }
      entry.diskSize = diskSize;

    } catch (err) {
      entry.state = DL_STATE.ERROR;
      entry.error = entry.cancelled ? 'Cancelled' : err.message;
      this._notify(sermon.id, entry);
      this._releaseSlot();
      this._releaseReservation(reserved);
      if (entry.cancelled) {
        console.warn(`[DL] Cancelled: "${sermon.title}"`);
      } else {
        console.error(`[DL] Failed: "${sermon.title}":`, err);
      }
      // Best-effort cleanup. abort_sermon_file removes ONLY the `.part` staging
      // file, so a download that fails while an earlier, complete copy of the
      // same sermon sits on disk never destroys that copy (writes are atomic —
      // the real filename is only ever touched by a successful finalize).
      // The one case that does need a delete is a file we renamed into place and
      // then found untrustworthy.
      try {
        const invoke = await loadTauri();
        if (invoke) {
          await invoke('abort_sermon_file', { filename }).catch(() => {});
          if (wroteBadFile) await invoke('delete_sermon_file', { filename }).catch(() => {});
        }
      } catch { /* best effort — never mask the original error */ }
      throw err;
    }

    // ── Release download slot — other queued downloads can proceed now ──
    this._releaseSlot();
    // The bytes are on disk now, so they show up in get_storage_usage; the
    // in-flight reservation that stood in for them can go.
    this._releaseReservation(reserved);
    reserved = 0;

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
    entry.bytesDownloaded = receivedBytes;
    entry.diskSize = diskSize; // what's actually on disk — the number to record
    this.totalDownloaded += receivedBytes;
    this.totalFiles++;
    this._notify(sermon.id, entry);

    const doneSizeMB = (receivedBytes / (1024 * 1024)).toFixed(1);
    console.log(`[DL] Complete: "${sermon.title}" via ${entry.source} (${doneSizeMB} MB)`);
    return entry.magnet;
  }

  /**
   * Fetch one URL with retries: exponential backoff + jitter, Retry-After
   * awareness, and HTTP Range resume of a partially received body.
   *
   * `maxAttempts` counts total tries for THIS source in THIS pass.
   * A non-retryable status (404/403/401/410) aborts immediately and marks the
   * error `fatalSource` so the caller stops re-trying that URL.
   */
  async _fetchWithRetry(url, entry, maxAttempts = MAX_ATTEMPTS_PER_SOURCE) {
    // Partial-body state shared across attempts so a dropped connection can be
    // resumed with `Range: bytes=<received>-` instead of starting over.
    const partial = { chunks: [], received: 0, total: 0, acceptRanges: false };
    let lastError;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (entry.cancelled) throw cancelledError();
      try {
        return await this._fetchFromUrl(url, entry, partial);
      } catch (e) {
        lastError = e;
        if (entry.cancelled) throw cancelledError();     // user pulled the plug
        if (e && e.fatalSource) throw e;                 // 404 etc — don't hammer it
        if (attempt >= maxAttempts - 1) throw e;         // out of attempts here

        const wait = e?.retryAfterMs > 0
          ? Math.min(e.retryAfterMs, MAX_BACKOFF_MS)
          : backoffDelay(attempt);
        const resuming = partial.acceptRanges && partial.received > 0;
        console.warn(
          `[DL] ${hostOf(url)} attempt ${attempt + 1}/${maxAttempts} failed (${e.message})` +
          ` — retrying in ${Math.round(wait / 100) / 10}s${resuming ? ` (resume @ ${partial.received} bytes)` : ''}`
        );
        await sleep(wait);

        if (!resuming) {
          // Can't resume — start this file over cleanly.
          partial.chunks = [];
          partial.received = 0;
          entry.bytesDownloaded = 0;
          entry.progress = 0;
        }
      }
    }
    throw lastError;
  }

  /**
   * Try Archive.org, then CDN — and if BOTH fail, come back around for another
   * full pass (Archive → CDN) with backoff. Archive.org rate-limits hard during
   * bulk pulls, so a second pass a few seconds later usually succeeds.
   * Sources that return a definitive 404/410 are dropped from later passes.
   */
  async _fetchWithArchiveFallback(sermon, entry) {
    const sources = [];
    if (sermon.archiveUrl) sources.push({ name: 'archive.org', url: sermon.archiveUrl });
    if (sermon.cdnUrl) sources.push({ name: 'cdn', url: sermon.cdnUrl });
    if (sources.length === 0) throw new Error('No available source for download');

    const dead = new Set(); // sources that answered 404/410 — never retried
    let lastError = null;

    for (let pass = 0; pass < SOURCE_PASSES; pass++) {
      const live = sources.filter(s => !dead.has(s.name));
      if (live.length === 0) break;

      if (pass > 0) {
        const wait = backoffDelay(pass);
        console.warn(`[DL] All sources failed for "${sermon.title}" — pass ${pass + 1}/${SOURCE_PASSES} in ${Math.round(wait / 100) / 10}s`);
        await sleep(wait);
        entry.bytesDownloaded = 0;
        entry.progress = 0;
      }

      for (const src of live) {
        if (entry.cancelled) throw cancelledError();
        try {
          const bytes = await this._fetchWithRetry(src.url, entry);
          entry.source = src.name;
          entry.sourceUrl = src.url;
          if (pass > 0 || src !== live[0]) {
            console.log(`[DL] Recovered "${sermon.title}" via ${src.name} (pass ${pass + 1})`);
          }
          return bytes;
        } catch (e) {
          lastError = e;
          if (e?.cancelled || entry.cancelled) throw cancelledError();
          if (e?.fatalSource) {
            dead.add(src.name);
            console.warn(`[DL] ${src.name} has no file for "${sermon.title}" (${e.message}) — dropping source`);
          } else {
            console.warn(`[DL] ${src.name} failed for "${sermon.title}": ${e.message}`);
          }
        }
      }
    }

    throw new Error(lastError ? `All sources failed — ${lastError.message}` : 'No available source for download');
  }

  /**
   * Download from a URL with progress tracking and bandwidth throttling.
   * `partial` (optional) carries chunks already received on a previous attempt
   * so this call can resume with a Range request instead of restarting.
   */
  async _fetchFromUrl(url, entry, partial = null) {
    const host = hostOf(url);
    // 5 minute timeout for the initial connection (the streaming read has its own implicit timeout)
    const controller = new AbortController();
    const connectionTimeout = setTimeout(() => controller.abort(), 5 * 60 * 1000);
    // Link the entry-level cancel controller so cancel() actually tears down the
    // socket, instead of leaving the transfer running in the background.
    const onEntryAbort = () => controller.abort();
    entry.controller?.signal.addEventListener('abort', onEntryAbort);
    const unlinkAbort = () => entry.controller?.signal.removeEventListener('abort', onEntryAbort);
    try {
      return await this._fetchFromUrlInner(url, entry, partial, host, controller, connectionTimeout);
    } finally {
      clearTimeout(connectionTimeout);
      unlinkAbort();
    }
  }

  async _fetchFromUrlInner(url, entry, partial, host, controller, connectionTimeout) {
    const resumeFrom = partial && partial.acceptRanges && partial.received > 0 ? partial.received : 0;
    const headers = resumeFrom > 0 ? { Range: `bytes=${resumeFrom}-` } : undefined;

    let response;
    try {
      response = await fetch(url, { signal: controller.signal, headers });
    } catch (netErr) {
      if (entry.cancelled) throw cancelledError();
      // Connection reset / DNS / abort — always worth another try.
      const err = new Error(`Network error from ${host}: ${netErr?.message || netErr}`);
      err.retryable = true;
      throw err;
    } finally {
      clearTimeout(connectionTimeout);
    }

    if (!response.ok) {
      const err = new Error(`HTTP ${response.status} from ${host}`);
      err.status = response.status;
      err.retryAfterMs = parseRetryAfter(response);
      // 404/410/403/401 mean "this source doesn't have it" — try the OTHER
      // source instead of hammering this one.
      err.fatalSource = NON_RETRYABLE_STATUS.has(response.status);
      throw err;
    }

    // ── Size / resume bookkeeping ──────────────────────────────────────
    const contentLength = parseInt(response.headers.get('content-length') || '0');
    const acceptRanges = (response.headers.get('accept-ranges') || '').toLowerCase().includes('bytes');
    let baseReceived = 0;
    let expectedTotal = 0;

    if (response.status === 206) {
      // Server honoured our Range — keep what we already have.
      baseReceived = resumeFrom;
      const cr = response.headers.get('content-range') || '';
      const m = /\/(\d+)\s*$/.exec(cr);
      expectedTotal = m ? parseInt(m[1]) : (contentLength ? resumeFrom + contentLength : 0);
    } else {
      // 200 — full body (server ignored the Range header, or first attempt).
      if (partial) { partial.chunks = []; partial.received = 0; }
      expectedTotal = contentLength;
    }
    if (partial) {
      partial.acceptRanges = acceptRanges || response.status === 206;
      if (expectedTotal > 0) partial.total = expectedTotal;
    }
    if (expectedTotal > 0) entry.totalBytes = expectedTotal;

    // Use the best estimate of total size for progress calculation
    const estimatedTotal = expectedTotal || entry.totalBytes || entry.sermon?.sizeBytes || 0;

    const reader = response.body.getReader();
    const chunks = partial ? partial.chunks : [];
    let received = baseReceived;
    let lastNotify = 0;

    // Bandwidth-throttle baseline. It has to be per-ATTEMPT: measuring against
    // entry.startTime (set once when the download began, never reset across
    // retries) meant that after any backoff `elapsed` was already far larger
    // than the target time, so the limiter waved through an unthrottled burst.
    const throttleStart = Date.now();
    const throttleBase = received;

    try {
      while (true) {
        if (entry.cancelled) throw cancelledError();
        const { done, value } = await reader.read();
        if (done) break;

        chunks.push(value);
        received += value.length;
        if (partial) partial.received = received;
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

        // Bandwidth throttling (measured from this attempt's own baseline)
        if (this.bandwidthLimit > 0) {
          const elapsed = (Date.now() - throttleStart) / 1000;
          const targetTime = (received - throttleBase) / this.bandwidthLimit;
          if (elapsed < targetTime) {
            await new Promise(r => setTimeout(r, (targetTime - elapsed) * 1000));
          }
        }
      }
    } catch (streamErr) {
      if (streamErr?.cancelled || entry.cancelled) throw cancelledError();
      // Mid-stream drop. Whatever we already buffered stays in `partial`, so
      // the next attempt resumes from here if the server supports Range.
      const err = new Error(`Connection dropped at ${received} bytes from ${host}: ${streamErr?.message || streamErr}`);
      err.retryable = true;
      throw err;
    }

    // Final progress notification after loop completes
    entry.bytesDownloaded = received;
    entry.progress = 99; // Almost done — will hit 100 when COMPLETE state is set
    this._notify(entry.sermon.id, entry);

    const totalLength = chunks.reduce((acc, c) => acc + c.length, 0);

    // Integrity check: if the server told us a total, verify we got the full file
    if (expectedTotal > 0 && totalLength < expectedTotal) {
      const pct = Math.round((totalLength / expectedTotal) * 100);
      const err = new Error(`Incomplete download: got ${totalLength} of ${expectedTotal} bytes (${pct}%) from ${host}`);
      err.retryable = true;
      throw err; // partial retained → next attempt resumes
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
   * Batch download for seed nodes / bulk speaker pulls.
   *
   * Runs sequentially in the given order, then automatically re-queues anything
   * that failed for up to `retryPasses` additional passes (with backoff between
   * passes) before reporting. The surviving failures are kept on
   * `lastBatchFailures` so the UI can offer a "Retry failed" button.
   */
  async downloadBatch(sermons, onBatchProgress, options = {}) {
    const retryPasses = Number.isInteger(options.retryPasses) ? options.retryPasses : BATCH_RETRY_PASSES;
    const shouldStop = typeof options.shouldStop === 'function' ? options.shouldStop : () => false;
    const total = sermons.length;
    let completed = 0;
    const failures = new Map(); // sermonId → { sermon, error }
    let pending = [...sermons];

    // ── Crash-safe queue (see the BATCH_STATE_KEY notes above) ────────────
    // On by default: a queue that only persists when the caller remembers to
    // ask for it is a queue that is lost the first time someone adds a caller.
    const persist = options.persist !== false;
    const label = typeof options.label === 'string' ? options.label : '';
    // IDS ONLY — re-resolved against the live catalog on resume.
    const ids = sermons.map((s) => s?.id).filter((id) => typeof id === 'string' && id);
    // How far into `ids` the FIRST pass has got. Later passes only ever re-run
    // the failed set, which is persisted separately, so the cursor stays put.
    let cursor = 0;
    let lastCheckpoint = 0;
    let sinceCheckpoint = 0;

    const snapshot = () => ({
      v: BATCH_STATE_VERSION,
      label,
      savedAt: Date.now(),
      ids,
      cursor,
      failures: [...failures.values()]
        .slice(0, MAX_PERSISTED_FAILURES)
        .map((f) => ({ id: f.sermon?.id, error: String(f.error || '').slice(0, MAX_PERSISTED_ERROR_CHARS) }))
        .filter((f) => f.id),
    });

    // Fire-and-forget: _writeBatchState never throws and the writes are
    // serialised, so a slow disk delays the save, never the download.
    const checkpoint = (force = false) => {
      if (!persist) return Promise.resolve();
      const now = Date.now();
      if (!force && sinceCheckpoint < CHECKPOINT_EVERY_FILES && now - lastCheckpoint < CHECKPOINT_EVERY_MS) {
        return Promise.resolve();
      }
      sinceCheckpoint = 0;
      lastCheckpoint = now;
      return this._writeBatchState(snapshot());
    };
    this._checkpointNow = () => checkpoint(true);
    if (persist) await checkpoint(true);

    const emit = (pass, retrying) => {
      if (!onBatchProgress) return;
      onBatchProgress({
        total,
        completed,
        failed: failures.size,
        progress: total > 0 ? (completed / total) * 100 : 0,
        totalBytes: this.totalDownloaded,
        pass,            // 0 = first run, ≥1 = automatic retry pass
        retrying,        // true while re-running the failed set
        remaining: total - completed,
      });
    };

    for (let pass = 0; pass <= retryPasses; pass++) {
      if (pending.length === 0) break;
      if (shouldStop()) break;

      if (pass > 0) {
        const wait = backoffDelay(pass + 1); // ~4–8s+ before re-attacking a rate-limited host
        console.warn(`[DL] Batch: ${pending.length} file(s) failed — automatic retry pass ${pass}/${retryPasses} in ${Math.round(wait / 1000)}s`);
        emit(pass, true);
        await sleep(wait);
      }

      const roundFailures = [];
      for (const sermon of pending) {
        if (shouldStop()) break;
        if (this.paused) {
          // Pausing is the most likely moment for the app to be quit, so make
          // sure the saved queue is current before we sit here waiting.
          await checkpoint(true);
          await new Promise(r => {
            const check = setInterval(() => {
              if (!this.paused || shouldStop()) { clearInterval(check); r(); }
            }, 1000);
          });
        }

        try {
          await this.download(sermon);
          completed++;
          failures.delete(sermon.id);
        } catch (e) {
          roundFailures.push(sermon);
          failures.set(sermon.id, { sermon, error: e?.message || String(e) });
        }

        // Attempted, for better or worse — a failure is remembered in
        // `failures`, so the cursor may move past it either way.
        if (pass === 0) cursor++;
        sinceCheckpoint++;
        checkpoint();

        emit(pass, pass > 0);
      }
      pending = roundFailures;
    }

    this.lastBatchFailures = [...failures.values()];

    // ── Final save ────────────────────────────────────────────────────────
    // Clear the saved queue ONLY when there is genuinely nothing left: the run
    // wasn't stopped, every id was attempted, and nothing is still failing.
    // Anything else is kept so the user can resume or retry after a restart.
    this._checkpointNow = null;
    if (persist) {
      const stopped = shouldStop();
      if (!stopped && cursor >= ids.length && failures.size === 0) {
        await this.clearSavedBatch();
      } else {
        await this._writeBatchState(snapshot());
      }
    }

    if (failures.size > 0) {
      console.warn(`[DL] Batch finished: ${completed}/${total} complete, ${failures.size} failed after ${retryPasses + 1} pass(es)`);
    } else {
      console.log(`[DL] Batch finished: ${completed}/${total} complete, 0 failed`);
    }
    emit(retryPasses, false);

    return { total, completed, failed: failures.size, failures: this.lastBatchFailures };
  }

  /** Sermons that were still failing at the end of the last batch run. */
  getFailedDownloads() {
    return (this.lastBatchFailures || []).map(f => f.sermon);
  }

  /** Re-run just the failures from the last batch (for a "Retry failed" button). */
  async retryFailedDownloads(onBatchProgress, options = {}) {
    const sermons = this.getFailedDownloads();
    if (sermons.length === 0) return { total: 0, completed: 0, failed: 0, failures: [] };
    return this.downloadBatch(sermons, onBatchProgress, options);
  }

  // ── Saved batch queue ──────────────────────────────────────────────────

  /** Write the batch record to settings.json. Never throws. */
  async _writeBatchState(record) {
    try {
      await _withSettings((s) => { s[BATCH_STATE_KEY] = record; });
    } catch (e) {
      console.warn('[DL] Could not save the bulk-download queue:', e?.message || e);
    }
  }

  /** Read the raw batch record back, or null if there isn't a usable one. */
  async _readBatchState() {
    let rec = null;
    try {
      await _withSettings((s) => { rec = s[BATCH_STATE_KEY]; return false; });
    } catch (e) {
      console.warn('[DL] Could not read the saved bulk-download queue:', e?.message || e);
      return null;
    }
    if (!rec || typeof rec !== 'object' || !Array.isArray(rec.ids)) return null;
    return {
      label: typeof rec.label === 'string' ? rec.label : '',
      savedAt: Number(rec.savedAt) || 0,
      ids: rec.ids.filter((id) => typeof id === 'string' && id),
      cursor: Math.max(0, Number(rec.cursor) || 0),
      failures: Array.isArray(rec.failures)
        ? rec.failures.filter((f) => f && typeof f.id === 'string' && f.id)
        : [],
    };
  }

  /** Forget the saved queue entirely (the user chose to start fresh). */
  async clearSavedBatch() {
    try {
      await _withSettings((s) => {
        if (!(BATCH_STATE_KEY in s)) return false;
        delete s[BATCH_STATE_KEY];
      });
    } catch (e) {
      console.warn('[DL] Could not clear the saved bulk-download queue:', e?.message || e);
    }
  }

  /** Force the running batch to save its place right now (pause/stop buttons). */
  async saveBatchProgressNow() {
    const fn = this._checkpointNow;
    if (typeof fn !== 'function') return;
    try { await fn(); } catch { /* never blocks the UI */ }
  }

  /**
   * Resolve the saved queue against the CURRENT catalog and report what is
   * actually left to do. Nothing starts here — this only describes the work, so
   * the page can offer it rather than silently resuming 437 GB.
   *
   * Between quitting and resuming, the world moves: the catalog can gain or lose
   * sermons, and files can appear or disappear by other means. So:
   *   · ids that are no longer in the catalog are DROPPED (counted as `gone`)
   *   · sermons already complete on disk are SKIPPED, not re-fetched
   *     (counted as `alreadyHave`) — an incomplete file is NOT skipped, since
   *     that is precisely a download worth finishing
   *   · everything else is returned in its original queue order, with the files
   *     that failed last time appended at the end
   *
   * `catalogList` should be the merged catalog (getCatalog()); when omitted it
   * is loaded lazily. Returns null when there is nothing saved.
   */
  async getResumableBatch(catalogList = null) {
    const rec = await this._readBatchState();
    if (!rec) return null;

    let list = Array.isArray(catalogList) ? catalogList : null;
    if (!list || list.length === 0) {
      try {
        const cat = await import('./catalog.js');
        list = cat.getCatalog();
      } catch {
        list = [];
      }
    }
    if (!list.length) return null; // catalog not ready — ask again later

    const byId = new Map(list.map((s) => [s.id, s]));
    const errorById = new Map(rec.failures.map((f) => [f.id, f.error || '']));
    const cursor = Math.min(rec.cursor, rec.ids.length);
    const unattempted = rec.ids.slice(cursor);
    const failedIds = rec.failures.map((f) => f.id);

    const seen = new Set();
    const sermons = [];
    const failures = [];
    let pendingCount = 0;
    let alreadyHave = 0;
    let gone = 0;

    for (const id of [...unattempted, ...failedIds]) {
      if (seen.has(id)) continue;
      seen.add(id);
      const sermon = byId.get(id);
      if (!sermon) { gone++; continue; }
      if (sermon.downloaded && !sermon.incomplete) { alreadyHave++; continue; }
      sermons.push(sermon);
      if (errorById.has(id)) failures.push({ sermon, error: errorById.get(id) });
      else pendingCount++;
    }

    const bytes = sermons.reduce((acc, s) => acc + (s.sizeBytes || 0), 0);
    console.log(
      `[DL] Saved bulk queue found: ${sermons.length} to do ` +
      `(${pendingCount} not yet tried, ${failures.length} failed last time), ` +
      `${alreadyHave} already on disk, ${gone} no longer in the catalog`
    );

    return {
      label: rec.label,
      savedAt: rec.savedAt,
      sermons,
      remaining: sermons.length,
      pendingCount,
      failures,
      alreadyHave,
      gone,
      bytes,
    };
  }

  pause() { this.paused = true; }
  resume() {
    this.paused = false;
    this._wakeSlotWaiters(); // let anything parked on the pause flag proceed
  }

  /**
   * Cancel a queued or in-flight download. Returns true if something was cancelled.
   *
   * Wired up rather than left as a trap for the next caller: it aborts the
   * in-flight fetch through the entry's AbortController and wakes the download
   * if it is parked waiting for a concurrency slot. The download's own error
   * path then does the state transition and releases the slot and the storage
   * reservation — so a cancelled download can no longer keep running in the
   * background and later overwrite its state with COMPLETE.
   */
  cancel(sermonId) {
    const entry = this.queue.get(sermonId);
    if (!entry) return false;
    if (entry.state !== DL_STATE.QUEUED && entry.state !== DL_STATE.DOWNLOADING) return false;
    entry.cancelled = true;
    try { entry.controller?.abort(); } catch { /* already aborted */ }
    // The streaming path's bytes are moving inside Rust, where an
    // AbortController can't reach them — tell the native side to stop too, or a
    // cancelled download would keep writing to `<file>.part` in the background.
    if (entry.filename) {
      loadTauri()
        .then((invoke) => invoke && invoke('cancel_sermon_download', { filename: entry.filename }))
        .catch(() => { /* best effort — the entry is already marked cancelled */ });
    }
    this._wakeSlotWaiters();
    return true;
  }

  /**
   * Drop a finished/failed queue entry so the sermon can be downloaded again.
   * download() short-circuits on a COMPLETE entry, so a re-download needs this
   * first (see App's Re-download button).
   */
  forget(sermonId) {
    const entry = this.queue.get(sermonId);
    if (!entry) return false;
    if (entry.state === DL_STATE.QUEUED || entry.state === DL_STATE.DOWNLOADING) return false;
    this.queue.delete(sermonId);
    return true;
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
