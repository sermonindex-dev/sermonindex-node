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
  if (primary && !primary.includes('default-si-speaker')) {
    add(primary.startsWith('http') ? primary : `${SI_SITE_BASE}${primary}`);
  }
  const lower = (name || '').toLowerCase();
  const compact = lower.replace(/[^a-z0-9]/g, '');
  const hyphen = lower.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (compact) add(`${SI_SITE_BASE}/images/speakers/${compact[0]}/${compact}.png`);
  if (hyphen && hyphen !== compact) add(`${SI_SITE_BASE}/images/speakers/${hyphen[0]}/${hyphen}.png`);
  add(`${CDN_AUDIO_BASE}/default-si-speaker.png`);
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
            if (!fileSet.has(filename)) {
              delete downloadState[id];
              removed++;
            } else {
              // Store actual disk size for accurate display
              // Note: catalog sizeKB is often wrong — we trust the actual file on disk
              try {
                const diskSize = await tauriMod.invoke('get_file_size', { filename });
                downloadState[id].diskSize = diskSize;
                // A file with 0 bytes is definitely broken
                if (diskSize === 0) {
                  delete downloadState[id];
                  removed++;
                } else {
                  if (downloadState[id].incomplete) delete downloadState[id].incomplete;
                }
              } catch {
                // get_file_size failed — keep the entry, file might still be valid
              }
            }
          }
        }
        if (removed > 0 || incomplete > 0) {
          console.log(`[Catalog] Cleaned ${removed} stale entries, found ${incomplete} incomplete downloads`);
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

  return catalog;
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
    let changed = 0;
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
          // Refresh actual disk size for accurate stats
          try {
            const diskSize = await tauriMod.invoke('get_file_size', { filename });
            if (diskSize === 0) {
              delete downloadState[id];
              changed++;
            } else if (downloadState[id].diskSize !== diskSize) {
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

export { catalog };
