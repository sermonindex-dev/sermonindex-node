/**
 * SermonIndex Catalog Service
 *
 * Loads the compact catalog manifest and provides a clean API.
 *
 * Compact format:
 *   s: [[name, image], ...]  — speakers indexed by position
 *   t: [topic1, topic2, ...]  — topics indexed by position
 *   c: [[id, title, spkIdx, topIdx, scripture, dur, sizeKB, archiveCode, cdnCode, type(0/1), views], ...]
 *
 * URL reconstruction:
 *   Audio CDN:  https://sermonindex1.b-cdn.net/{cdnCode}
 *   Archive:    https://archive.org/download/SERMONINDEX_{archiveCode}/{archiveCode}.mp3
 *   Video CDN:  https://sermonindex2.b-cdn.net/{cdnCode} (when type=1 and code is youtubeId)
 *   Speaker img: speakerImage from the speakers array
 */

import { saveCatalog as persistCatalog, loadCatalog as loadPersistedCatalog,
         saveDownloadState as persistDlState, loadDownloadState as loadPersistedDlState
       } from './tauriStore.js';

// Import the compact catalog data
import compactData from '../data/catalog.json';

const CATALOG_URL = 'https://analytics.sermonindex.net/api/catalog';
const LOCAL_STATE_KEY = 'si_download_state';

// ── URL Builders ──────────────────────────────────────────────────────────

const CDN_AUDIO_BASE = 'https://sermonindex1.b-cdn.net';
const CDN_VIDEO_BASE = 'https://sermonindex2.b-cdn.net';
const ARCHIVE_BASE = 'https://archive.org/download';
const SI_SITE_BASE = 'https://www.sermonindex.net';

function resolveSpeakerImage(img) {
  if (!img) return '';
  if (img.startsWith('http')) return img;
  // Relative path — prepend sermonindex.net
  return `${SI_SITE_BASE}${img}`;
}

/**
 * Candidate portrait URLs for a speaker, most-likely first.
 * The site has two slug conventions (compact "mikebullmore" and hyphenated
 * "mike-bullmore") and not every referenced file actually exists — the UI
 * tries each candidate in order, then falls back to initials.
 */
export function speakerImageCandidates(name, primary) {
  const out = [];
  const add = (u) => { if (u && !out.includes(u)) out.push(u); };
  // Try a LOCAL bundled copy FIRST (served from public/, zero network → instant,
  // offline, never broken), then the remote CDN as a fallback for portraits not
  // yet fetched into the app. scripts/fetch-speaker-images.mjs mirrors portraits
  // into public/images/speakers/<letter>/<slug>.png, so the bare site path (e.g.
  // /images/speakers/a/x.png) resolves against the app's own origin.
  const addLocalFirst = (path) => {
    if (!path) return;
    add(path);                      // local (bundled in public/)
    add(`${SI_SITE_BASE}${path}`);  // remote fallback
  };
  if (primary && !primary.includes('default-si-speaker')) {
    if (primary.startsWith('http')) {
      // Full URL — prefer a local mirror of its path, then the URL itself.
      try { add(new URL(primary).pathname); } catch { /* not a parseable URL */ }
      add(primary);
    } else {
      addLocalFirst(primary);
    }
  }
  const lower = (name || '').toLowerCase();
  const compact = lower.replace(/[^a-z0-9]/g, '');
  const hyphen = lower.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (compact) addLocalFirst(`/images/speakers/${compact[0]}/${compact}.png`);
  if (hyphen && hyphen !== compact) addLocalFirst(`/images/speakers/${hyphen[0]}/${hyphen}.png`);
  // NOTE: no remote placeholder here on purpose. For the ~440 speakers with no
  // portrait, hitting a remote CDN default caused visible lag/flicker on every
  // render. SpeakerAvatar's <img> onError chain lands on a bundled local asset
  // (then initials) instead — zero network requests for the placeholder.
  return out;
}

function buildArchiveUrl(code, isVideo) {
  if (!code) return '';
  if (isVideo) return `${ARCHIVE_BASE}/SERMONINDEX_${code}/${code}.mp4`;
  return `${ARCHIVE_BASE}/SERMONINDEX_${code}/${code}.mp3`;
}

function buildCdnUrl(code, isVideo) {
  if (!code) return '';
  if (isVideo) {
    // If it's a YouTube ID (11 chars, no slash), use video CDN with .mp4
    if (code.length === 11 && !code.includes('/')) {
      return `${CDN_VIDEO_BASE}/${code}.mp4`;
    }
    return `${CDN_AUDIO_BASE}/${code}`; // Fallback for non-YouTube video CDN paths
  }
  return `${CDN_AUDIO_BASE}/${code}`;
}

function formatDuration(secs) {
  if (secs <= 0) return '0:00';
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

// ── Expand compact entry to full sermon object ────────────────────────────

function expandSermon(entry, speakers, topics) {
  const [id, title, spkIdx, topIdx, scripture, dur, sizeKB, archiveCode, cdnCode, type, views] = entry;
  const isVideo = type === 1;
  const speaker = speakers[spkIdx] || ['Unknown', ''];
  const sizeBytes = sizeKB * 1024;

  return {
    id,
    title,
    speaker: speaker[0],
    speakerSlug: '', // Not stored in compact format, not needed for display
    speakerImage: resolveSpeakerImage(speaker[1]),
    topic: topics[topIdx] || 'General',
    scripture: scripture || '',
    duration: dur,
    durationFormatted: dur > 0 ? formatDuration(dur) : '',
    sizeBytes,
    sizeFormatted: sizeBytes > 0 ? formatBytes(sizeBytes) : '',
    archiveUrl: buildArchiveUrl(archiveCode, isVideo),
    cdnUrl: buildCdnUrl(cdnCode, isVideo),
    // The "url" field is what the player/downloader uses — Archive.org first, CDN fallback
    url: buildArchiveUrl(archiveCode, isVideo) || buildCdnUrl(cdnCode, isVideo),
    magnet: null, // Filled in when the catalog carries torrent magnet links

    type: isVideo ? 'video' : 'audio',
    format: isVideo ? 'mp4' : 'mp3',
    views: views || 0,
  };
}

// ── State ─────────────────────────────────────────────────────────────────

let catalog = [];
let downloadState = {}; // sermonId → { downloaded: boolean, magnet: string }

/**
 * Initialize the catalog — expand compact data, load download state
 */
export async function initCatalog() {
  // Expand the compact catalog
  const { s: speakers, t: topics, c: compact } = compactData;
  catalog = compact.map(entry => expandSermon(entry, speakers, topics));
  console.log(`[Catalog] Loaded ${catalog.length} sermons from ${speakers.length} speakers`);

  // Load download state from persistent storage
  try {
    const persisted = await loadPersistedDlState();
    if (persisted && Object.keys(persisted).length > 0) {
      downloadState = persisted;
    } else {
      const state = localStorage.getItem(LOCAL_STATE_KEY);
      if (state) downloadState = JSON.parse(state);
    }
  } catch (e) {
    console.warn('[Catalog] Failed to load download state:', e);
  }

  // Validate download state against actual files on disk (check existence + file size)
  // IMPORTANT: Only clean up if we actually got a valid file listing.
  // If list_downloaded_files fails (e.g., "Too many open files"), we must NOT wipe state.
  try {
    const tauriMod = await import('@tauri-apps/api/core').catch(() => null);
    if (tauriMod) {
      let files = null;
      try {
        files = await tauriMod.invoke('list_downloaded_files');
      } catch (listErr) {
        console.warn('[Catalog] list_downloaded_files failed, skipping validation:', listErr.message);
      }
      // Only validate if we got a real file list AND it's not suspiciously empty
      // when we have many download entries (likely fd exhaustion or fs error)
      const dlCount = Object.keys(downloadState).length;
      if (files !== null && !(files.length === 0 && dlCount > 2)) {
        const fileSet = new Set(files);
        const validIds = new Set(catalog.map(s => s.id));
        let removed = 0;
        let incomplete = 0;
        for (const id of Object.keys(downloadState)) {
          if (!validIds.has(id)) {
            delete downloadState[id];
            removed++;
            continue;
          }
          const sermon = catalog.find(s => s.id === id);
          if (sermon) {
            const ext = sermon.type === 'video' ? 'mp4' : 'mp3';
            const filename = `${id}.${ext}`;
            // CONSERVATIVE: only delete when the file is definitively absent from
            // a SUCCESSFUL, NON-EMPTY listing. Both are already guaranteed here
            // (files !== null and the empty-with-entries case was excluded above).
            if (!fileSet.has(filename)) {
              delete downloadState[id];
              removed++;
            } else {
              // File is present on disk — keep the entry. Refresh the disk size
              // for accurate display, but NEVER delete based on get_file_size:
              // a 0-byte read or a thrown error is a transient/read failure, not
              // proof the download is bad (the file is in the listing).
              try {
                const diskSize = await tauriMod.invoke('get_file_size', { filename });
                if (diskSize > 0) {
                  downloadState[id].diskSize = diskSize;
                  if (downloadState[id].incomplete) delete downloadState[id].incomplete;
                }
                // diskSize === 0 → leave the existing entry untouched (keep it).
              } catch {
                // get_file_size failed — keep the entry, file is still listed.
              }
            }
          }
        }
        // ── ADOPT ORPHANS: the folder is the source of truth ──
        // Any <id>.<ext> file on disk that maps to a catalog sermon but isn't
        // in downloadState gets added (this recovers downloads whose state was
        // lost, so My Downloads always matches the actual folder contents).
        let adopted = 0;
        for (const filename of files) {
          const base = filename.replace(/\.(mp3|mp4)$/i, '');
          if (base === filename) continue; // not a sermon media file
          if (!validIds.has(base)) continue; // unknown id — leave foreign files alone
          if (!downloadState[base]?.downloaded) {
            let diskSize = 0;
            try { diskSize = await tauriMod.invoke('get_file_size', { filename }); } catch {}
            downloadState[base] = {
              downloaded: true,
              magnet: downloadState[base]?.magnet || `local-${base}`,
              diskSize: diskSize || downloadState[base]?.diskSize || 0,
            };
            adopted++;
          }
        }
        if (removed > 0 || incomplete > 0 || adopted > 0) {
          console.log(`[Catalog] Reconciled downloads: ${removed} stale removed, ${adopted} orphan files adopted`);
          _persistDownloadState();
        }
      } else if (files !== null && files.length === 0 && dlCount > 2) {
        console.warn(`[Catalog] list_downloaded_files returned 0 files but we have ${dlCount} download entries — skipping cleanup (possible fd exhaustion)`);
      }
    }
  } catch (e) {
    console.warn('[Catalog] Could not validate download state:', e);
  }

  // Try API update in background (for new sermons added after app was built)
  fetchCatalogUpdate().catch(() => {});

  // Canonical torrent MASTER LIST — the trust anchor: sermons gain
  // magnet/infoHash/torrentUrl fields and the app only ever joins those official
  // swarms. Prefer the persistent cache so the node downloads master-list.json ONCE
  // and re-applies it instantly (and offline) on every later launch. Only hit the
  // network when there is NO cache; after that, refreshes are driven by the admin
  // bumping master_list_version (see reconcileMasterListVersion, called from the
  // heartbeat) instead of re-downloading the whole file on every start.
  try {
    const cached = _loadMasterListCache();
    if (cached && cached.entries) {
      const merged = applyMasterListEntries(cached.entries);
      console.log(`[Catalog] Master list applied from cache — ${merged} sermons have canonical torrents (version: ${cached.version || 'local'})`);
    } else {
      fetchMasterList().catch(() => {});
    }
  } catch (e) {
    console.warn('[Catalog] Master list cache load failed, fetching fresh:', e?.message || e);
    fetchMasterList().catch(() => {});
  }

  return catalog;
}

// Published by scripts/generate-canonical-torrents.mjs (see that file's header)
const MASTER_LIST_URL = 'https://sermonindex1.b-cdn.net/torrents/master-list.json';
let _masterListLoaded = false;

export function hasMasterList() {
  return _masterListLoaded;
}

// ── Master-list persistent cache ───────────────────────────────────────────
// A node downloads master-list.json ONCE, then re-applies the cached copy
// instantly (and offline) on every subsequent launch. It only re-pulls when the
// admin bumps `master_list_version` (delivered inside the heartbeat config →
// reconcileMasterListVersion). This kills the "re-download the whole file on every
// start" behaviour while keeping the trust anchor perfectly up to date on command.
const MASTER_LIST_CACHE_KEY = 'si_master_list';                       // JSON { version, entries }
const MASTER_LIST_APPLIED_VERSION_KEY = 'si_master_list_applied_version'; // string

function _loadMasterListCache() {
  try {
    const raw = localStorage.getItem(MASTER_LIST_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && parsed.entries && typeof parsed.entries === 'object') return parsed;
  } catch { /* corrupt/unavailable — treat as no cache */ }
  return null;
}

function _saveMasterListCache(version, entries) {
  // Quota-safe: master-list.json can be large. If the write throws (quota,
  // private mode, etc.) just skip caching — the app still works, it just
  // re-fetches on the next launch instead of serving from cache.
  try {
    localStorage.setItem(MASTER_LIST_CACHE_KEY, JSON.stringify({ version: version || '', entries }));
  } catch (e) {
    console.warn('[Catalog] Master list cache write skipped (storage quota?):', e?.message || e);
  }
}

function _getAppliedMasterListVersion() {
  try { return localStorage.getItem(MASTER_LIST_APPLIED_VERSION_KEY) || ''; } catch { return ''; }
}

function _setAppliedMasterListVersion(version) {
  try { localStorage.setItem(MASTER_LIST_APPLIED_VERSION_KEY, String(version || '')); } catch { /* non-fatal */ }
}

/**
 * Merge canonical torrent metadata from a master-list `entries` map into the
 * in-memory catalog — sermons gain magnet/infoHash/torrentUrl/verifiedSize and the
 * app only ever joins those official swarms. Reusable across the cache-apply and
 * network-apply paths. Returns the number of catalog sermons matched.
 */
export function applyMasterListEntries(entries) {
  if (!entries || typeof entries !== 'object') return 0;
  let merged = 0;
  for (const s of catalog) {
    const m = entries[s.id];
    if (m && m.info_hash) {
      s.magnet = m.magnet;
      s.infoHash = m.info_hash;
      s.torrentUrl = m.torrent_url;
      s.verifiedSize = m.size; // actual byte size, hashed — catalog sizes are unreliable
      merged++;
    }
  }
  if (merged > 0) {
    _masterListLoaded = true;
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('si-master-list', { detail: { merged } }));
    }
  }
  return merged;
}

// Retry schedule when the master list can't be fetched/parsed (transient CDN
// or network trouble is common right after wake-from-sleep / app launch).
const MASTER_LIST_RETRY_DELAYS_MS = [30_000, 60_000, 120_000];

// Fetch (with retries) → apply → re-cache. `cacheVersion` tags the persisted copy
// (server-pushed version when known, else the applied version, else a local marker).
// Resolves to true only on a successful fetch+apply, false after all retries fail.
async function fetchMasterList(cacheVersion) {
  for (let attempt = 0; attempt <= MASTER_LIST_RETRY_DELAYS_MS.length; attempt++) {
    try {
      await _fetchMasterListOnce(cacheVersion);
      return true; // success
    } catch (err) {
      if (attempt < MASTER_LIST_RETRY_DELAYS_MS.length) {
        const delay = MASTER_LIST_RETRY_DELAYS_MS[attempt];
        console.warn(`[Catalog] Master list fetch failed (attempt ${attempt + 1}/${MASTER_LIST_RETRY_DELAYS_MS.length + 1}) — retrying in ${delay / 1000}s:`, err?.message || err);
        await new Promise((r) => setTimeout(r, delay));
      } else {
        // Final failure — master list not reachable. HTTP downloads still work
        // fine; surface it so the UI can tell the user (non-blocking banner).
        console.warn('[Catalog] Master list unreachable after all retries:', err?.message || err);
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('si-master-list-failed'));
        }
        return false;
      }
    }
  }
  return false;
}

// ── Master-list signature verification ─────────────────────────────────────
// The master list is the trust anchor (sermon → infohash/magnet); the app only
// joins swarms it lists. HTTPS alone doesn't protect it — whoever can write to
// the CDN path could swap in false infohashes. So it's signed offline with an
// ed25519 key and published with a detached signature at <url>.sig. The public
// key is compiled into the Rust binary and verification happens there
// (WKWebView's WebCrypto Ed25519 support is unreliable).
//
// FAIL CLOSED: missing, malformed, or invalid signature → the list is NOT
// applied. The app keeps working (HTTP downloads are unaffected); it just falls
// back to the previously-cached/bundled catalog rather than trusting unverified
// canonical data.
const MASTER_LIST_SIG_URL = `${MASTER_LIST_URL}.sig`;

async function _fetchMasterListSignature() {
  try {
    const tauri = await import('@tauri-apps/api/core');
    return await tauri.invoke('fetch_text', { url: MASTER_LIST_SIG_URL });
  } catch {
    const res = await fetch(MASTER_LIST_SIG_URL, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching master list signature`);
    return await res.text();
  }
}

/**
 * Verify `text` against `signatureB64` via the Rust `verify_master_list` command.
 * Returns true ONLY on a cryptographically valid signature. Never throws —
 * every failure path (no signature, no Tauri/invoke, bad signature, unconfigured
 * public key) returns false so the caller can simply refuse to apply the list.
 */
async function _verifyMasterList(text, signatureB64) {
  if (!signatureB64 || typeof signatureB64 !== 'string' || !signatureB64.trim()) {
    console.warn('[Catalog] Master list signature missing — refusing to apply (fail closed).');
    return false;
  }
  let invoke;
  try {
    ({ invoke } = await import('@tauri-apps/api/core'));
  } catch {
    // Dev-in-browser / non-Tauri context: we cannot verify, so we must not trust.
    console.warn('[Catalog] Master list signature cannot be verified outside Tauri — not applying (fail closed).');
    return false;
  }
  try {
    const ok = await invoke('verify_master_list', { data: text, signatureB64: signatureB64.trim() });
    if (ok !== true) {
      console.warn('[Catalog] Master list signature verification returned false — not applying.');
      return false;
    }
    return true;
  } catch (e) {
    console.warn('[Catalog] Master list signature INVALID — not applying:', e?.message || e);
    return false;
  }
}

async function _fetchMasterListOnce(cacheVersion) {
  // Native fetch first (Rust reqwest — immune to CDN CORS policy, which
  // blocks the webview from reading .json cross-origin). Browser fetch as
  // fallback for dev-in-browser mode. We keep the RAW TEXT around: the
  // signature covers those exact bytes, not a re-serialization of them.
  let text = null;
  let data = null;
  try {
    const tauri = await import('@tauri-apps/api/core');
    text = await tauri.invoke('fetch_text', { url: MASTER_LIST_URL });
    data = JSON.parse(text);
  } catch (nativeErr) {
    console.warn('[Catalog] Native master-list fetch unavailable, trying browser fetch:', nativeErr?.message || nativeErr);
    const res = await fetch(MASTER_LIST_URL, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching master list`);
    text = await res.text();
    data = JSON.parse(text);
  }
  if (!data || !data.entries) throw new Error('Master list malformed (missing entries)');

  // Verify BEFORE applying or caching anything. A signature-fetch failure is
  // treated exactly like a bad signature: don't trust the list.
  let signatureB64 = null;
  try {
    signatureB64 = await _fetchMasterListSignature();
  } catch (sigErr) {
    console.warn('[Catalog] Master list signature unavailable:', sigErr?.message || sigErr);
  }
  if (!(await _verifyMasterList(text, signatureB64))) {
    // Do NOT apply and do NOT cache — keep the previously-known/bundled catalog.
    // Downloads over HTTP still work; only canonical torrent data is withheld.
    // Thrown (not returned) so the normal retry schedule applies: that gives a
    // self-healing window if the .json and .sig were briefly out of sync on the
    // CDN, and it stops reconcileMasterListVersion from marking this version as
    // successfully applied.
    console.warn('[Catalog] Master list REJECTED (signature not verified) — keeping existing catalog; canonical torrent data not applied.');
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('si-master-list-unverified'));
    }
    throw new Error('Master list signature verification failed');
  }

  const merged = applyMasterListEntries(data.entries);
  // Persist across launches so the node doesn't re-download on every start. Tag it
  // with the server-pushed version when known, else the version we already applied,
  // else a local timestamp marker (so a later server version always differs → pull).
  const version = cacheVersion || _getAppliedMasterListVersion() || `local-${Date.now()}`;
  _saveMasterListCache(version, data.entries);
  console.log(`[Catalog] Master list loaded from network — ${merged} sermons have canonical torrents (cached version: ${version})`);
  return merged;
}

// Guards reconcile/force from stacking concurrent network pulls of the master list.
let _masterListRefreshing = false;

/**
 * React to the server-pushed `master_list_version` (delivered inside the heartbeat
 * config). This is how the admin "Force all nodes to refresh" button reaches every
 * node: when the version differs from the one we last applied, force a fresh network
 * pull (bypassing the cache), apply it, re-cache, and record the applied version.
 * No-op when the version is empty or already applied. Guards concurrent runs.
 */
export async function reconcileMasterListVersion(serverVersion) {
  const v = typeof serverVersion === 'string' ? serverVersion.trim() : '';
  if (!v) return;                                   // empty = no forced version
  if (v === _getAppliedMasterListVersion()) return; // already on this version
  if (_masterListRefreshing) return;                // don't stack concurrent pulls
  _masterListRefreshing = true;
  try {
    console.log(`[Catalog] master_list_version changed → forcing refresh (server: ${v})`);
    const ok = await fetchMasterList(v); // fresh network pull, re-caches with version=v
    if (ok) _setAppliedMasterListVersion(v); // only mark applied on real success
  } catch (e) {
    console.warn('[Catalog] Master list reconcile failed (will retry next heartbeat):', e?.message || e);
  } finally {
    _masterListRefreshing = false;
  }
}

/**
 * Unconditionally re-pull the master list from the network and re-cache it
 * (optional manual trigger). Resolves to true if a fresh copy was fetched + applied.
 */
export async function forceRefreshMasterList() {
  if (_masterListRefreshing) return false;
  _masterListRefreshing = true;
  try {
    return await fetchMasterList();
  } finally {
    _masterListRefreshing = false;
  }
}

/**
 * Fetch catalog update from the API (new sermons only)
 */
async function fetchCatalogUpdate() {
  try {
    const res = await fetch(CATALOG_URL);
    if (res.ok) {
      const data = await res.json();
      if (data.sermons && data.sermons.length > 0) {
        // Merge new sermons into catalog (don't replace — the built-in is authoritative)
        const existingIds = new Set(catalog.map(s => s.id));
        let added = 0;
        for (const s of data.sermons) {
          if (!existingIds.has(s.id)) {
            catalog.push(s);
            added++;
          }
        }
        if (added > 0) console.log(`[Catalog] Added ${added} new sermons from API`);
      }
    }
  } catch {
    // Silently fail — use built-in catalog
  }
}

/**
 * Get the full catalog with download state merged in
 */
export function getCatalog() {
  return catalog.map(s => ({
    ...s,
    downloaded: !!downloadState[s.id]?.downloaded,
    incomplete: !!downloadState[s.id]?.incomplete,
    diskSize: downloadState[s.id]?.diskSize || 0,
    localMagnet: downloadState[s.id]?.magnet || null,
  }));
}

/**
 * Get unique speakers
 */
export function getSpeakers() {
  const speakers = new Set(catalog.map(s => s.speaker));
  return [...speakers].sort();
}

/**
 * Get unique topics
 */
export function getTopics() {
  const topics = new Set(catalog.map(s => s.topic));
  return [...topics].sort();
}

/**
 * Search the catalog
 */
export function searchCatalog(query) {
  if (!query) return getCatalog();
  const q = query.toLowerCase();
  return getCatalog().filter(s =>
    s.title.toLowerCase().includes(q) ||
    s.speaker.toLowerCase().includes(q) ||
    s.topic.toLowerCase().includes(q) ||
    (s.scripture && s.scripture.toLowerCase().includes(q))
  );
}

/**
 * Mark a sermon as downloaded with its magnet link (or `local-<id>` placeholder)
 */
export function markDownloaded(sermonId, magnet, diskSize) {
  downloadState[sermonId] = { downloaded: true, magnet, diskSize: diskSize || 0 };
  _persistDownloadState();
}

/**
 * Mark a sermon as removed
 */
export function markRemoved(sermonId) {
  delete downloadState[sermonId];
  _persistDownloadState();
}

function _persistDownloadState() {
  try {
    localStorage.setItem(LOCAL_STATE_KEY, JSON.stringify(downloadState));
    persistDlState(downloadState).catch(() => {});
  } catch (e) {
    console.warn('[Catalog] Failed to save download state:', e);
  }
}

/**
 * Re-validate download state against actual files on disk.
 * Call this when navigating to the Downloads page to detect manually deleted files.
 * Returns true if any entries were cleaned up.
 */
export async function revalidateDownloads() {
  try {
    const tauriMod = await import('@tauri-apps/api/core').catch(() => null);
    if (!tauriMod) return false;
    let files = null;
    try {
      files = await tauriMod.invoke('list_downloaded_files');
    } catch (listErr) {
      console.warn('[Catalog] Revalidation: list_downloaded_files failed:', listErr.message);
      return false;
    }
    // Guard: don't wipe state if file list is empty but we have entries (fd exhaustion)
    const dlCount = Object.keys(downloadState).length;
    if (files.length === 0 && dlCount > 2) {
      console.warn(`[Catalog] Revalidation: 0 files on disk but ${dlCount} entries — skipping (possible fd exhaustion)`);
      return false;
    }
    const fileSet = new Set(files);
    const validIds = new Set(catalog.map(s => s.id));
    let changed = 0;
    // Adopt orphan files on disk (folder = source of truth) so My Downloads
    // always matches the actual folder — recovers downloads whose state was lost.
    for (const filename of files) {
      const base = filename.replace(/\.(mp3|mp4)$/i, '');
      if (base === filename || !validIds.has(base)) continue;
      if (!downloadState[base]?.downloaded) {
        let diskSize = 0;
        try { diskSize = await tauriMod.invoke('get_file_size', { filename }); } catch {}
        downloadState[base] = { downloaded: true, magnet: downloadState[base]?.magnet || `local-${base}`, diskSize: diskSize || 0 };
        changed++;
      }
    }
    for (const id of Object.keys(downloadState)) {
      if (!downloadState[id].downloaded) continue;
      const sermon = catalog.find(s => s.id === id);
      if (sermon) {
        const ext = sermon.type === 'video' ? 'mp4' : 'mp3';
        const filename = `${id}.${ext}`;
        if (!fileSet.has(filename)) {
          delete downloadState[id];
          changed++;
        } else {
          // File is present in a successful, non-empty listing — keep the entry.
          // Refresh disk size for accurate stats, but NEVER delete on a 0-byte
          // read or a get_file_size error (transient read failure, not proof
          // the file is bad — it is still in the listing).
          try {
            const diskSize = await tauriMod.invoke('get_file_size', { filename });
            if (diskSize > 0 && downloadState[id].diskSize !== diskSize) {
              downloadState[id].diskSize = diskSize;
              changed++;
            }
          } catch {}
        }
      }
    }
    if (changed > 0) {
      console.log(`[Catalog] Revalidation: updated ${changed} entries`);
      _persistDownloadState();
      return true;
    }
  } catch (e) {
    console.warn('[Catalog] Revalidation failed:', e);
  }
  return false;
}

/**
 * Get downloaded sermons only
 */
export function getDownloaded() {
  return getCatalog().filter(s => s.downloaded);
}

/**
 * Get total library size
 */
export function getLibraryStats() {
  const totalBytes = catalog.reduce((acc, s) => acc + (s.sizeBytes || 0), 0);

  // ONLY use actual disk sizes — catalog sizes are unreliable
  let downloadedBytes = 0;
  let completeFiles = 0;
  let incompleteFiles = 0;
  for (const id of Object.keys(downloadState)) {
    if (!downloadState[id].downloaded) continue;
    if (downloadState[id].incomplete) {
      incompleteFiles++;
      downloadedBytes += downloadState[id].diskSize || 0;
    } else {
      completeFiles++;
      // Only count diskSize — never fall back to catalog sizeBytes (it's often wrong)
      downloadedBytes += downloadState[id].diskSize || 0;
    }
  }

  return {
    totalFiles: catalog.length,
    downloadedFiles: completeFiles,
    incompleteFiles,
    totalSize: formatBytes(totalBytes),
    totalSizeBytes: totalBytes,
    downloadedSize: formatBytes(downloadedBytes),
    downloadedSizeBytes: downloadedBytes,
    coverage: totalBytes > 0 ? Math.round((downloadedBytes / totalBytes) * 100) : 0,
  };
}

/**
 * Seed-node validation, measured from what's actually complete on disk
 * (the downloads folder is the source of truth). `scope` is 'audio' | 'full'.
 * Returns how much of the chosen library this node genuinely hosts, and a
 * boolean `verified` (a real seed node hosts ~all of its scope).
 */
export const SEED_VERIFY_THRESHOLD = 0.95; // ≥95% of the scope = verified seed

export function getSeedProgress(scope = 'audio') {
  const inScope = (s) => (scope === 'full' ? true : s.type === 'audio');
  let total = 0, downloaded = 0, bytes = 0;
  for (const s of catalog) {
    if (!inScope(s)) continue;
    total++;
    const st = downloadState[s.id];
    if (st?.downloaded && !st.incomplete) {
      downloaded++;
      bytes += st.diskSize || 0;
    }
  }
  const pct = total > 0 ? downloaded / total : 0;
  return {
    scope,
    total,
    downloaded,
    remaining: total - downloaded,
    pct: Math.round(pct * 1000) / 10, // one decimal, e.g. 97.4
    bytes,
    sizeFormatted: formatBytes(bytes),
    verified: total > 0 && pct >= SEED_VERIFY_THRESHOLD,
  };
}

export { catalog };
