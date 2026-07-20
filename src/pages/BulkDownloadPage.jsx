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
  // A saved queue from a previous session, resolved against today's catalog.
  // Held, never auto-started — a volunteer who quit deliberately must not come
  // back to 437 GB already downloading.
  const [savedBatch, setSavedBatch] = useState(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  // A speaker the user asked for while a saved list is still waiting.
  const [pendingSpeaker, setPendingSpeaker] = useState(null);
  // User pressed Stop — the batch finishes the current file and saves its place.
  const stopRef = useRef(false);
  const [stopping, setStopping] = useState(false);
  // Track mount state so the pause-wait interval below can't outlive the page
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // Look once for an interrupted run, as soon as the catalog is available.
  // Anything already on this computer is skipped and anything no longer in the
  // catalog is dropped — see downloadManager.getResumableBatch.
  const resumeCheckedRef = useRef(false);
  useEffect(() => {
    if (resumeCheckedRef.current) return;
    if (!downloadManager || !catalog || catalog.length === 0) return;
    resumeCheckedRef.current = true;
    downloadManager.getResumableBatch(catalog)
      .then((info) => {
        if (!mountedRef.current || !info || info.remaining === 0) return;
        // Only failures left over? Show the familiar "failed" card instead of
        // asking someone to "resume" a run that already finished.
        if (info.pendingCount > 0) setSavedBatch(info);
        else setFailedItems(info.failures);
      })
      .catch(() => { /* no saved queue is a perfectly normal state */ });
  }, [downloadManager, catalog]);

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
    setSavedBatch(null);
    setConfirmDiscard(false);
    setPendingSpeaker(null);
    stopRef.current = false;
    setStopping(false);
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
        // Stop queuing if the user presses Stop or navigates away mid-run.
        // `label` names the run in the saved queue so a resume can say what it is.
        { shouldStop: () => stopRef.current || !mountedRef.current, label: speakerName }
      );
    } catch (err) {
      console.error('[BulkDownload] Batch error:', err);
    }

    const wasStopped = stopRef.current;
    stopRef.current = false;
    if (!mountedRef.current) return;
    onCatalogUpdate();
    setStopping(false);
    setActiveSpeaker(null);
    setBatchProgress(null);
    setFailedItems(result.failures || []);
    // Stopped part-way: the manager has saved the place, so offer it straight
    // back rather than making the user restart the app to see it.
    if (wasStopped) {
      downloadManager.getResumableBatch()
        .then((info) => {
          if (!mountedRef.current || !info || info.pendingCount === 0) return;
          setSavedBatch(info);
          // The resume card already accounts for the failures — don't show the
          // same files twice in two different cards.
          setFailedItems([]);
        })
        .catch(() => {});
    }
  }, [downloadManager, onCatalogUpdate]);

  const startBulkDownload = useCallback((speaker) => {
    if (!downloadManager || activeSpeaker) return;
    const toDownload = speaker.sermons.filter(s => !s.downloaded);
    if (toDownload.length === 0) return;
    // Only one saved list is kept, so starting a different one replaces it.
    // Say so first — quietly discarding a half-finished 437 GB queue is exactly
    // the loss this whole feature exists to prevent.
    if (savedBatch) {
      setPendingSpeaker({ name: speaker.name, sermons: toDownload });
      return;
    }
    runBatch(speaker.name, toDownload);
  }, [downloadManager, activeSpeaker, runBatch, savedBatch]);

  const confirmPendingSpeaker = useCallback(() => {
    if (!pendingSpeaker) return;
    const { name, sermons } = pendingSpeaker;
    setPendingSpeaker(null);
    runBatch(name, sermons);
  }, [pendingSpeaker, runBatch]);

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
      // Pausing is the moment people close the lid — make sure the place is saved.
      downloadManager.saveBatchProgressNow?.();
    }
  }, [downloadManager, isPaused]);

  // Stop for now. The current file finishes, the place is saved, and the list is
  // offered back on the next launch (or straight away, above).
  const stopForNow = useCallback(() => {
    if (!downloadManager) return;
    stopRef.current = true;
    setStopping(true);
    if (isPausedRef.current) {
      // Un-pause so the waiting loop can notice the stop and exit.
      downloadManager.resume();
      isPausedRef.current = false;
      setIsPaused(false);
    }
    downloadManager.saveBatchProgressNow?.();
  }, [downloadManager]);

  const resumeSavedBatch = useCallback(() => {
    if (!savedBatch || activeSpeaker) return;
    runBatch(savedBatch.label || 'your saved list', savedBatch.sermons);
  }, [savedBatch, activeSpeaker, runBatch]);

  const discardSavedBatch = useCallback(() => {
    setSavedBatch(null);
    setConfirmDiscard(false);
    downloadManager?.clearSavedBatch?.();
  }, [downloadManager]);

  // Dismissing the failures also forgets the saved copy, so they don't come
  // back on the next launch after the user has said they're done with them.
  const dismissFailed = useCallback(() => {
    setFailedItems([]);
    downloadManager?.clearSavedBatch?.();
  }, [downloadManager]);

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
          <div style={{ marginTop: '12px', display: 'flex', gap: '10px', alignItems: 'center' }}>
            <button className="btn btn-gold" onClick={togglePause}>
              {isPaused ? '▶ Resume' : '⏸ Pause'}
            </button>
            <button
              className="btn"
              onClick={stopForNow}
              disabled={stopping}
              style={{ padding: '6px 14px', background: 'var(--bg-tertiary)', border: '1px solid var(--border)', color: 'var(--text-secondary)', borderRadius: '6px', cursor: stopping ? 'default' : 'pointer', fontSize: '0.82rem', opacity: stopping ? 0.6 : 1 }}
            >
              {stopping ? 'Finishing this file…' : '■ Stop for now'}
            </button>
            <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
              Your place is saved as you go, so you can stop any time — or just close the app — and carry on later.
            </span>
          </div>
        </div>
      )}

      {/* An interrupted run from a previous session. Offered, never auto-started. */}
      {!activeSpeaker && savedBatch && (
        <div className="seed-card" style={{ marginBottom: '16px', borderColor: 'var(--gold)' }}>
          <h3 style={{ marginBottom: '6px' }}>Pick up where you left off</h3>
          <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '8px' }}>
            Your last bulk download{savedBatch.label ? ` — ${savedBatch.label} — ` : ' '}didn't get to finish.
            There {savedBatch.remaining === 1 ? 'is' : 'are'} <strong>{savedBatch.remaining.toLocaleString()}</strong>{' '}
            sermon{savedBatch.remaining === 1 ? '' : 's'} still to go
            {savedBatch.bytes > 0 ? ` (about ${formatBytes(savedBatch.bytes)})` : ''}.
            Nothing has been lost.
          </p>
          <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginBottom: '12px' }}>
            {savedBatch.alreadyHave > 0 && (
              <div>· {savedBatch.alreadyHave.toLocaleString()} of them are already on this computer, so they'll be skipped.</div>
            )}
            {savedBatch.failures.length > 0 && (
              <div>· {savedBatch.failures.length.toLocaleString()} didn't come through last time and will be tried again.</div>
            )}
            {savedBatch.gone > 0 && (
              <div>· {savedBatch.gone.toLocaleString()} {savedBatch.gone === 1 ? 'is' : 'are'} no longer in the sermon list, so {savedBatch.gone === 1 ? 'it has' : 'they have'} been left out.</div>
            )}
            {savedBatch.savedAt > 0 && (
              <div>· Saved {new Date(savedBatch.savedAt).toLocaleString()}.</div>
            )}
          </div>
          {pendingSpeaker ? (
            <div>
              <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '10px' }}>
                Only one list is kept at a time. Starting {pendingSpeaker.name} now will replace the saved one above.
                Your downloaded sermons are all kept either way.
              </p>
              <div style={{ display: 'flex', gap: '10px' }}>
                <button className="btn btn-gold" onClick={() => setPendingSpeaker(null)}>Keep my saved list</button>
                <button
                  className="btn"
                  onClick={confirmPendingSpeaker}
                  style={{ padding: '6px 14px', background: 'var(--bg-tertiary)', border: '1px solid var(--border)', color: 'var(--text-secondary)', borderRadius: '6px', cursor: 'pointer', fontSize: '0.82rem' }}
                >
                  Start {pendingSpeaker.name} instead
                </button>
              </div>
            </div>
          ) : confirmDiscard ? (
            <div>
              <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '10px' }}>
                Forget this list? Your downloaded sermons are all kept — you'd just be starting the list again from the speakers below.
              </p>
              <div style={{ display: 'flex', gap: '10px' }}>
                <button className="btn btn-gold" onClick={() => setConfirmDiscard(false)}>Keep it</button>
                <button
                  className="btn"
                  onClick={discardSavedBatch}
                  style={{ padding: '6px 14px', background: 'var(--bg-tertiary)', border: '1px solid var(--border)', color: 'var(--text-secondary)', borderRadius: '6px', cursor: 'pointer', fontSize: '0.82rem' }}
                >
                  Yes, forget it
                </button>
              </div>
            </div>
          ) : (
            <div style={{ display: 'flex', gap: '10px' }}>
              <button className="btn btn-gold" onClick={resumeSavedBatch}>
                Resume where you left off ({savedBatch.remaining.toLocaleString()})
              </button>
              <button
                className="btn"
                onClick={() => setConfirmDiscard(true)}
                style={{ padding: '6px 14px', background: 'var(--bg-tertiary)', border: '1px solid var(--border)', color: 'var(--text-secondary)', borderRadius: '6px', cursor: 'pointer', fontSize: '0.82rem' }}
              >
                Start fresh instead
              </button>
            </div>
          )}
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
            This list is kept safe if you close the app, so you can come back to it another day.
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
              onClick={dismissFailed}
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
