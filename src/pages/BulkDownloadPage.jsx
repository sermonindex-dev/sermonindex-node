import React, { useState, useCallback, useMemo, useRef } from 'react';
import { markDownloaded } from '../services/catalog.js';
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
  const [isPaused, setIsPaused] = useState(false);
  const isPausedRef = useRef(false);

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

  const startBulkDownload = useCallback(async (speaker) => {
    if (!downloadManager || activeSpeaker) return;

    setActiveSpeaker(speaker.name);
    setBatchProgress({ completed: 0, total: 0, failed: 0, percent: 0 });

    const toDownload = speaker.sermons.filter(s => !s.downloaded);
    const total = toDownload.length;

    if (total === 0) {
      setActiveSpeaker(null);
      setBatchProgress(null);
      return;
    }

    let completed = 0;
    let failed = 0;

    for (const sermon of toDownload) {
      // Check pause using ref (avoids stale closure)
      if (isPausedRef.current) {
        await new Promise(r => {
          const check = setInterval(() => {
            if (!isPausedRef.current) { clearInterval(check); r(); }
          }, 500);
        });
      }

      try {
        await downloadManager.download(sermon);
        completed++;
        markDownloaded(sermon.id, `local-${sermon.id}`);
      } catch {
        failed++;
      }

      setBatchProgress({
        completed,
        total,
        failed,
        percent: (completed / total) * 100,
      });
    }

    // Done
    onCatalogUpdate();
    setActiveSpeaker(null);
    setBatchProgress(null);
  }, [downloadManager, activeSpeaker, onCatalogUpdate]);

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
        <p>Download all sermons by a specific speaker. One speaker at a time to keep things smooth.</p>
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
                {batchProgress.failed} files failed — will be skipped
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
