import React from 'react';
import downloadManager, { DL_STATE } from '../services/downloadManager.js';

/**
 * Shared, presentation-only handling of failed sermon downloads.
 *
 * Everything here READS state that downloadManager already produces — nothing
 * here decides what a failure is, retries anything itself, or touches disk. The
 * one job is turning a technical error into something a volunteer can act on,
 * and doing it identically on every page that shows it.
 *
 * HOUSE RULE: a raw Rust/HTTP error string never reaches the screen. The full
 * message is already in the console for diagnostics; the user gets plain
 * English. (SeedNodePage:267 renders a raw error — that is the mistake this
 * module exists to avoid repeating.)
 */

const iconAlert = (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
    <line x1="12" y1="9" x2="12" y2="13" />
    <line x1="12" y1="17" x2="12.01" y2="17" />
  </svg>
);

export const iconRetry = (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="23 4 23 10 17 10" />
    <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
  </svg>
);

/** A cancellation is a choice the user made, not a failure to report. */
export function isCancellation(entry) {
  if (!entry) return false;
  if (entry.cancelled) return true;
  return /^\s*cancell?ed\s*$/i.test(String(entry.error || ''));
}

/**
 * Map a download error onto wording an ordinary person can act on.
 *
 * Order matters: the most specific and most actionable cause wins. A message
 * like "Failed to write file: No space left on device (os error 28)" matches
 * both the disk-full test and the generic write test — disk-full is the one
 * that tells the user what to DO, so it is checked first.
 *
 * Returns { key, title, detail }. `key` is used to group identical causes in
 * the summary banner, so one full disk reads as one problem rather than forty.
 */
export function describeDownloadError(rawError) {
  const raw = String(rawError || '');

  // 1. Storage cap — downloadManager already writes a genuinely good sentence
  //    here. Surface it as-is rather than paraphrasing it worse; it is authored
  //    copy, not a system error string.
  if (/storage limit reached/i.test(raw)) {
    const detail = raw.replace(/^\s*storage limit reached\s*[—–-]\s*/i, '').trim();
    return {
      key: 'storage-cap',
      title: 'Your storage limit has been reached',
      detail: detail || 'Raise the limit in Settings or free up space, then try again.',
    };
  }

  // 2. Disk full — the single most likely new failure now that a bad write
  //    correctly fails the download.
  if (/no space left|os error 28|enospc|disk full|not enough space|quota exceeded|disk is full/i.test(raw)) {
    return {
      key: 'disk-full',
      title: 'There is no room left on the drive',
      detail: 'The drive you download to has run out of space. Free some up — or pick another folder under Download location in My Downloads — and then try again.',
    };
  }

  // 3. Permission / read-only folder.
  if (/permission denied|os error 13|access is denied|read-only|readonly file system/i.test(raw)) {
    return {
      key: 'permission',
      title: 'The app was not allowed to save the file',
      detail: 'Your computer would not let the app write to the download folder. Check the folder still exists and is not read-only, or choose a different one under Download location in My Downloads, then try again.',
    };
  }

  // 4. Network — checked before the disk-write and HTTP buckets because a
  //    dropped connection often arrives wrapped in an "All sources failed"
  //    message, and the network is the part the user can actually check.
  if (/network error|failed to fetch|load failed|connection dropped|incomplete download: got|err_internet|dns|timed out|timeout|the operation was aborted/i.test(raw)) {
    return {
      key: 'network',
      title: 'The connection was interrupted',
      detail: 'The download could not reach the internet, or the connection dropped part-way through. Check that you are online, then try again — nothing already downloaded was affected.',
    };
  }

  // 5. Servers busy or having trouble (429 / 5xx).
  if (/http 429|http 5\d\d|too many requests/i.test(raw)) {
    return {
      key: 'busy',
      title: 'The sermon servers are busy',
      detail: 'Too many people are downloading at once. Please wait a few minutes and try again — this usually clears on its own.',
    };
  }

  // 6. The file genuinely is not there (404/410/403) or has no source at all.
  if (/http 4\d\d|no available source|all sources failed/i.test(raw)) {
    return {
      key: 'unavailable',
      title: 'This sermon is not available right now',
      detail: 'The library servers did not have this recording to hand. This is usually temporary — please try again later. If it keeps happening, this sermon may need re-uploading.',
    };
  }

  // 7. Anything else that went wrong writing to disk (unplugged external drive,
  //    short write, failed rename).
  if (/failed to (write|create|append|open|finalize|flush|stat)|disk write incomplete|staged size mismatch|no in-progress download|failed to decode/i.test(raw)) {
    return {
      key: 'disk-write',
      title: 'The file could not be saved to your drive',
      detail: 'The sermon downloaded, but saving it to disk did not finish. If you save to an external drive, check that it is still plugged in, then try again.',
    };
  }

  // 8. Fallback — calm, honest, and still actionable.
  return {
    key: 'unknown',
    title: 'This download did not finish',
    detail: 'Something got in the way and we could not tell what. Please try again — if it keeps happening, closing and reopening the app usually clears it.',
  };
}

/**
 * Every download currently sitting in the ERROR state, with plain-language
 * wording attached. Read straight off the manager's queue rather than from a
 * page's own (search-filtered) sermon list, so a failure is never hidden just
 * because the user happened to type something into the search box.
 *
 * Safe to call during render: it only reads.
 */
export function collectFailedDownloads() {
  let entries;
  try {
    entries = downloadManager.getAll() || {};
  } catch {
    return [];
  }
  const failures = [];
  for (const [id, entry] of Object.entries(entries)) {
    if (!entry || entry.state !== DL_STATE.ERROR) continue;
    if (isCancellation(entry)) continue;
    failures.push({
      id,
      sermon: entry.sermon || null,
      title: entry.sermon?.title || id,
      error: entry.error || '',
      reason: describeDownloadError(entry.error),
    });
  }
  return failures;
}

/**
 * Persistent summary of everything that failed, grouped by cause.
 *
 * Deliberately built from the same `seed-card` + `borderColor: var(--red)`
 * shape BulkDownloadPage already uses for its "files failed after retries"
 * card, so the two paths look and sound like the same application.
 */
export default function DownloadFailureBanner({ failures, onRetryAll, onDismiss, style }) {
  if (!failures || failures.length === 0) return null;

  // Group by cause so one full disk reads as one problem, not forty.
  const groups = [];
  const byKey = new Map();
  for (const f of failures) {
    let g = byKey.get(f.reason.key);
    if (!g) {
      g = { key: f.reason.key, title: f.reason.title, detail: f.reason.detail, items: [] };
      byKey.set(f.reason.key, g);
      groups.push(g);
    }
    g.items.push(f);
  }

  const n = failures.length;

  return (
    <div className="seed-card" style={{ marginBottom: '16px', borderColor: 'var(--red)', ...style }}>
      <h3 style={{ marginBottom: '6px', display: 'flex', alignItems: 'center', gap: '7px' }}>
        <span style={{ display: 'inline-flex', color: 'var(--red)' }}>{iconAlert}</span>
        {n === 1 ? '1 download did not finish' : `${n} downloads did not finish`}
      </h3>
      <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '12px' }}>
        Nothing you already have was lost — your other sermons are untouched. Here is what happened:
      </p>

      <div style={{ maxHeight: '260px', overflowY: 'auto', marginBottom: '12px' }}>
        {groups.map(g => (
          <div key={g.key} style={{ marginBottom: '12px' }}>
            <div style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-primary)' }}>
              {g.title}
              <span style={{ fontWeight: 500, color: 'var(--text-muted)', marginLeft: '6px' }}>
                ({g.items.length === 1 ? '1 sermon' : `${g.items.length} sermons`})
              </span>
            </div>
            <div style={{ fontSize: '0.76rem', color: 'var(--text-secondary)', lineHeight: 1.5, marginTop: '2px' }}>
              {g.detail}
            </div>
            <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: '5px', lineHeight: 1.6 }}>
              {g.items.slice(0, 5).map(f => (
                <div key={f.id}>· {f.title}</div>
              ))}
              {g.items.length > 5 && <div>· …and {g.items.length - 5} more</div>}
            </div>
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
        {onRetryAll && (
          <button className="btn btn-gold" onClick={() => onRetryAll(failures)}>
            {n === 1 ? 'Try again' : 'Try all again'}
          </button>
        )}
        {onDismiss && (
          <button
            className="btn"
            onClick={() => onDismiss(failures)}
            style={{ padding: '6px 14px', background: 'var(--bg-tertiary)', border: '1px solid var(--border)', color: 'var(--text-secondary)', borderRadius: '6px', cursor: 'pointer', fontSize: '0.82rem' }}
          >
            Hide this
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * The small red chip + one-line explanation that sits on an individual sermon
 * card. Same wording source as the banner, so the two can never drift apart.
 */
export function DownloadFailureNote({ reason, compact }) {
  if (!reason) return null;
  return (
    <div style={{ width: '100%', marginTop: compact ? '0' : '8px' }}>
      <span
        className="seed-badge"
        style={{ color: 'var(--red)', borderColor: 'rgba(231, 76, 60, 0.3)', background: 'rgba(231, 76, 60, 0.1)' }}
      >
        {iconAlert} <span style={{ marginLeft: '4px' }}>{reason.title}</span>
      </span>
      <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', lineHeight: 1.5, marginTop: '5px' }}>
        {reason.detail}
      </div>
    </div>
  );
}
