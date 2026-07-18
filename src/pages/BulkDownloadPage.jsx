import React, { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import SpeakerAvatar from '../components/SpeakerAvatar.jsx';

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

export default function BulkDownloadPage({ catalog, downloadManager, downloadStates, onCatalogUpdate }) {
  const [search, setSearch] = useState('');
  const [activeSpeaker, setActiveSpeaker] = useState(null); // currently downloading speaker
  const [batchProgress, setBatchProgress] = useState(null);
  // Files still failing after the manager's automatic retry passes — kept so
  // the user can hit "Retry failed" without re-running the whole speaker.
  const [failedItems, setFailedItems] = useState([]);
  const [isPaused, setIsPaused] = useState(false);
  const isPausedRef = useRef(false);
  // Track mount state so the pause-wait interval below can't outlive the page
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // Group sermons by speaker with stats
  const speakerGroups = useMemo(() => {
    const groups = {};
    for (const s of catalog) {
      if (!groups[s.speaker]) {
        groups[s.speaker] = {
          name: s.speaker,
          image: s.speakerImage,
          sermons: [],
          totalBytes: 0,
          downloadedCount: 0,
          audioCount: 0,
          videoCount: 0,
        };
      }
      const g = groups[s.speaker];
      g.sermons.push(s);
      g.totalBytes += s.sizeBytes || 0;
      if (s.downloaded) g.downloadedCount++;
      if (s.type === 'video') g.videoCount++;
      else g.audioCount++;
    }
    return Object.values(groups).sort((a, b) => a.name.localeCompare(b.name));
  }, [catalog]);

  // Filter speakers by search
  const filtered = search
    ? speakerGroups.filter(g => g.name.toLowerCase().includes(search.toLowerCase()))
    : speakerGroups;

  // Shared runner for both the initial bulk run and the "Retry failed" button.
  // downloadBatch() handles per-file retry/backoff/source-fallback AND
  // automatically re-queues the failed set a couple of times before reporting.
  // NOTE: do NOT markDownloaded() here — App's download progress handler
  // persists the real canonical magnet. Marking a 'local-<id>' placeholder
  // here would race and clobber it (audit M1).
  const runBatch = useCallback(async (speakerName, sermons) => {
    if (!downloadManager || sermons.length === 0) return;

    setActiveSpeaker(speakerName);
    setFailedItems([]);
    setBatchProgress({ completed: 0, total: sermons.length, failed: 0, percent: 0, retrying: false });

    let result = { failed: 0, failures: [] };
    try {
      result = await downloadManager.downloadBatch(
        sermons,
        (p) => {
          if (!mountedRef.current) return;
          setBatchProgress({
            completed: p.completed,
            total: p.total,
            failed: p.failed,
            percent: p.progress,
            retrying: !!p.retrying,
          });
        },
        // Stop queuing if the user navigates away mid-run.
        { shouldStop: () => !mountedRef.current }
      );
    } catch (err) {
      console.error('[BulkDownload] Batch error:', err);
    }

    if (!mountedRef.current) return;
    onCatalogUpdate();
    setActiveSpeaker(null);
    setBatchProgress(null);
    setFailedItems(result.failures || []);
  }, [downloadManager, onCatalogUpdate]);

  const startBulkDownload = useCallback((speaker) => {
    if (!downloadManager || activeSpeaker) return;
    const toDownload = speaker.sermons.filter(s => !s.downloaded);
    if (toDownload.length === 0) return;
    runBatch(speaker.name, toDownload);
  }, [downloadManager, activeSpeaker, runBatch]);

  const retryFailed = useCallback(() => {
    if (!downloadManager || activeSpeaker || failedItems.length === 0) return;
    const sermons = failedItems.map(f => f.sermon).filter(Boolean);
    const name = sermons[0]?.speaker || 'failed files';
    runBatch(name, sermons);
  }, [downloadManager, activeSpeaker, failedItems, runBatch]);

  const togglePause = useCallback(() => {
    if (!downloadManager) return;
    if (isPaused) {
      downloadManager.resume();
      isPausedRef.current = false;
      setIsPaused(false);
    } else {
      downloadManager.pause();
      isPausedRef.current = true;
      setIsPaused(true);
    }
  }, [downloadManager, isPaused]);

  return (
    <>
      <div className="page-header">
        <h2>Bulk Download</h2>
        <p>Bulk-download a speaker's entire catalog. Downloads are processed sequentially — one speaker at a time — to avoid saturating your connection and disk I/O.</p>
      </div>

      <div className="library-filters">
        <div className="search-box" style={{ maxWidth: '400px' }}>
          <input
            type="text"
            placeholder="Search speakers..."
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          <svg className="search-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
        </div>
        <span className="filter-count">{filtered.length} speakers</span>
      </div>

      {/* Active download banner */}
      {activeSpeaker && batchProgress && (
        <div className="seed-card" style={{ marginBottom: '16px', borderColor: 'var(--gold)' }}>
          <h3 style={{ marginBottom: '8px' }}>Downloading: {activeSpeaker}</h3>
          <div className="seed-progress">
            <div className="seed-progress-bar">
              <div className="seed-progress-fill" style={{ width: `${batchProgress.percent}%` }}></div>
            </div>
            <div className="seed-progress-text">
              <span>{batchProgress.completed} of {batchProgress.total} sermons</span>
              <span>{batchProgress.percent.toFixed(1)}%</span>
            </div>
            {batchProgress.failed > 0 && (
              <p style={{ fontSize: '0.75rem', color: 'var(--red)', marginTop: '6px' }}>
                {batchProgress.failed} file{batchProgress.failed === 1 ? '' : 's'} failed so far
                {batchProgress.retrying ? ' — retrying them now…' : ' — they will be retried automatically'}
              </p>
            )}
          </div>
          <div style={{ marginTop: '12px' }}>
            <button className="btn btn-gold" onClick={togglePause}>
              {isPaused ? '▶ Resume' : '⏸ Pause'}
            </button>
          </div>
        </div>
      )}

      {/* Leftovers after the automatic retry passes — offer a manual retry */}
      {!activeSpeaker && failedItems.length > 0 && (
        <div className="seed-card" style={{ marginBottom: '16px', borderColor: 'var(--red)' }}>
          <h3 style={{ marginBottom: '6px' }}>
            {failedItems.length} file{failedItems.length === 1 ? '' : 's'} failed after retries
          </h3>
          <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '10px' }}>
            Everything else finished. These are usually temporary source hiccups — try again in a moment.
          </p>
          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '10px', maxHeight: '120px', overflowY: 'auto' }}>
            {failedItems.slice(0, 10).map((f, i) => (
              <div key={f.sermon?.id || i}>· {f.sermon?.title || f.sermon?.id} — {f.error}</div>
            ))}
            {failedItems.length > 10 && <div>· …and {failedItems.length - 10} more</div>}
          </div>
          <div style={{ display: 'flex', gap: '10px' }}>
            <button className="btn btn-gold" onClick={retryFailed}>Retry failed</button>
            <button
              className="btn"
              onClick={() => setFailedItems([])}
              style={{ padding: '6px 14px', background: 'var(--bg-tertiary)', border: '1px solid var(--border)', color: 'var(--text-secondary)', borderRadius: '6px', cursor: 'pointer', fontSize: '0.82rem' }}
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      <div className="bulk-speaker-list">
        {filtered.map(speaker => {
          const remaining = speaker.sermons.length - speaker.downloadedCount;
          const remainingBytes = speaker.sermons
            .filter(s => !s.downloaded)
            .reduce((acc, s) => acc + (s.sizeBytes || 0), 0);
          const isComplete = remaining === 0;
          const isActive = activeSpeaker === speaker.name;
          const isDisabled = activeSpeaker && !isActive;

          return (
            <div
              key={speaker.name}
              className={`bulk-speaker-row ${isActive ? 'active' : ''} ${isComplete ? 'complete' : ''}`}
              style={{ opacity: isDisabled ? 0.5 : 1, pointerEvents: isDisabled ? 'none' : 'auto' }}
            >
              <SpeakerAvatar speaker={speaker.name} image={speaker.image} className="bulk-speaker-avatar" />

              <div className="bulk-speaker-info">
                <div className="bulk-speaker-name">{speaker.name}</div>
                <div className="bulk-speaker-meta">
                  {speaker.sermons.length} sermons
                  ({speaker.audioCount} audio{speaker.videoCount > 0 ? `, ${speaker.videoCount} video` : ''})
                  · {formatBytes(speaker.totalBytes)}
                </div>
                {speaker.downloadedCount > 0 && !isComplete && (
                  <div className="bulk-speaker-meta" style={{ color: 'var(--gold-text)' }}>
                    {speaker.downloadedCount} already downloaded · {remaining} remaining
                  </div>
                )}
              </div>

              <div className="bulk-speaker-action">
                {isComplete ? (
                  <span style={{ color: 'var(--green)', fontWeight: 600, fontSize: '0.82rem' }}>✓ Complete</span>
                ) : isActive ? (
                  <span style={{ color: 'var(--gold-text)', fontWeight: 600, fontSize: '0.82rem' }}>Downloading...</span>
                ) : (
                  <button
                    className="btn btn-gold"
                    onClick={() => startBulkDownload(speaker)}
                    style={{ fontSize: '0.78rem', padding: '6px 16px' }}
                  >
                    Download All ({remaining}) {remainingBytes > 0 ? formatBytes(remainingBytes) : ''}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}
