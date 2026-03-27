import React, { useState, useCallback, useRef } from 'react';

const PAGE_SIZE = 50;

// Flat SVG icons
const iconPlay = <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3" /></svg>;
const iconPause = <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" /><rect x="14" y="4" width="4" height="16" /></svg>;
const iconPin = <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 17v5" /><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16h14v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1h1V3H7v3h1a1 1 0 0 1 1 1z" /></svg>;
const iconFilm = <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="2" width="20" height="20" rx="2.18" /><line x1="7" y1="2" x2="7" y2="22" /><line x1="17" y1="2" x2="17" y2="22" /><line x1="2" y1="12" x2="22" y2="12" /><line x1="2" y1="7" x2="7" y2="7" /><line x1="2" y1="17" x2="7" y2="17" /><line x1="17" y1="7" x2="22" y2="7" /><line x1="17" y1="17" x2="22" y2="17" /></svg>;
const iconHeadphones = <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 18v-6a9 9 0 0 1 18 0v6" /><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z" /></svg>;
const iconExport = <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" /></svg>;
const iconTrash = <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></svg>;
const iconRefresh = <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" /></svg>;
const iconWarning = <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" /></svg>;

function getInitials(name) {
  return name.split(' ').map(w => w[0]).join('').slice(0, 2);
}

function SpeakerAvatar({ speaker, image }) {
  if (image) {
    return (
      <div className="sermon-speaker-avatar">
        <img src={image} alt={speaker} loading="lazy" onError={e => { e.target.style.display = 'none'; e.target.parentNode.textContent = getInitials(speaker); }} />
      </div>
    );
  }
  return <div className="sermon-speaker-avatar">{getInitials(speaker)}</div>;
}

function formatStorage(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

const iconFolder = <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" /></svg>;

export default function DownloadsPage({ sermons, currentSermon, isPlaying, onPlay, onRemove, onExport, onRedownload, onOpenFolder, downloadStates }) {
  const [search, setSearch] = useState('');
  const [filterType, setFilterType] = useState('');
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [expandedId, setExpandedId] = useState(null);

  if (sermons.length === 0) {
    return (
      <>
        <div className="page-header">
          <h2>My Downloads</h2>
          <p>Sermons you've downloaded are stored locally and shared with the peer network</p>
        </div>
        <div className="seed-card" style={{ textAlign: 'center', padding: '48px 24px' }}>
          <div style={{ fontSize: '2.5rem', marginBottom: '16px', opacity: 0.4 }}>
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></svg>
          </div>
          <h3 style={{ marginBottom: '8px' }}>No downloads yet</h3>
          <p>Browse the library and download sermons to listen offline and help share with the network.</p>
        </div>
      </>
    );
  }

  let filtered = sermons;
  if (search) {
    const q = search.toLowerCase();
    filtered = filtered.filter(s =>
      s.title.toLowerCase().includes(q) ||
      s.speaker.toLowerCase().includes(q) ||
      (s.topic && s.topic.toLowerCase().includes(q))
    );
  }
  if (filterType) {
    filtered = filtered.filter(s => s.type === filterType);
  }

  const displayed = filtered.slice(0, visibleCount);
  const hasMore = visibleCount < filtered.length;

  // Use actual disk sizes — catalog sizeBytes is often wrong
  const totalBytes = sermons.reduce((acc, s) => acc + (s.diskSize || 0), 0);
  const audioCount = sermons.filter(s => s.type === 'audio').length;
  const videoCount = sermons.filter(s => s.type === 'video').length;

  return (
    <>
      <div className="page-header">
        <h2>My Downloads</h2>
        <p>{sermons.length} sermons ({audioCount} audio, {videoCount} video) · {formatStorage(totalBytes)} stored</p>
      </div>

      <div className="seed-card" style={{ marginBottom: '16px', padding: '12px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '16px' }}>
        <p style={{ fontSize: '0.78rem', margin: 0, color: 'var(--text-muted)', lineHeight: 1.5, flex: 1 }}>
          Downloaded files are stored in a hashed format for IPFS sharing. Use the <strong style={{ color: 'var(--text-primary)' }}>Export</strong> button on any sermon to save a readable copy to your Desktop.
        </p>
        {onOpenFolder && (
          <button
            className="btn"
            onClick={onOpenFolder}
            style={{ whiteSpace: 'nowrap', padding: '6px 12px', background: 'var(--bg-tertiary)', border: '1px solid var(--border)', color: 'var(--text-secondary)', borderRadius: '6px', cursor: 'pointer', fontSize: '0.75rem', display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0 }}
          >
            {iconFolder} Open IPFS Folder
          </button>
        )}
      </div>

      <div className="library-filters">
        <div className="search-box" style={{ maxWidth: '300px' }}>
          <input
            type="text"
            placeholder="Search downloads..."
            value={search}
            onChange={e => { setSearch(e.target.value); setVisibleCount(PAGE_SIZE); }}
          />
          <svg className="search-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
        </div>

        <select
          value={filterType}
          onChange={e => { setFilterType(e.target.value); setVisibleCount(PAGE_SIZE); }}
          className="filter-select"
        >
          <option value="">All Types</option>
          <option value="audio">Audio Only</option>
          <option value="video">Video Only</option>
        </select>

        <span className="filter-count">{filtered.length} results · showing {displayed.length}</span>
      </div>

      <div className="sermon-grid">
        {displayed.map(sermon => {
          const isCurrentPlaying = currentSermon?.id === sermon.id && isPlaying;
          const isActive = currentSermon?.id === sermon.id;
          const isExpanded = expandedId === sermon.id;
          const dlState = downloadStates?.[sermon.id];
          const isActivelyDownloading = dlState && ['downloading', 'pinning', 'queued'].includes(dlState.state);

          return (
            <div
              key={sermon.id}
              className={`sermon-card ${isActive ? 'playing' : ''} ${isExpanded ? 'expanded' : ''}`}
              onClick={(e) => {
                // Don't toggle if clicking buttons
                if (e.target.closest('button')) return;
                setExpandedId(isExpanded ? null : sermon.id);
              }}
              style={isExpanded ? { gridColumn: 'span 2', cursor: 'pointer' } : { cursor: 'pointer' }}
            >
              <div className="sermon-card-header">
                <SpeakerAvatar speaker={sermon.speaker} image={sermon.speakerImage} />
                <div className="sermon-card-info">
                  <div className="sermon-title" title={sermon.title} style={isExpanded ? { whiteSpace: 'normal', overflow: 'visible', textOverflow: 'unset' } : {}}>{sermon.title}</div>
                  <div className="sermon-speaker">{sermon.speaker}</div>
                </div>
                <span className={`type-badge ${sermon.type || 'audio'}`}>
                  {sermon.type === 'video' ? iconFilm : iconHeadphones}
                  <span style={{ marginLeft: '4px' }}>{sermon.type === 'video' ? 'Video' : 'Audio'}</span>
                </span>
              </div>
              <div className="sermon-meta">
                <span className="tag">{sermon.topic}</span>
                <span>{sermon.durationFormatted || sermon.duration}</span>
                <span>{sermon.diskSize ? formatStorage(sermon.diskSize) : (sermon.sizeFormatted || sermon.size)}</span>
              </div>
              <div className="sermon-meta-row2">
                {isActivelyDownloading ? (
                  <div className="dl-progress-mini" style={{ width: '100%' }}>
                    <div className="dl-progress-mini-bar">
                      <div
                        className={`dl-progress-mini-fill ${dlState.state === 'pinning' ? 'pinning' : ''} ${dlState.progress < 0 ? 'indeterminate' : ''}`}
                        style={{ width: dlState.state === 'pinning' ? '100%' : dlState.progress < 0 ? '40%' : `${Math.min(Math.round(dlState.progress), 99)}%` }}
                      ></div>
                    </div>
                    <span className="dl-progress-mini-text" style={dlState.state === 'pinning' ? { color: '#6ea8fe' } : {}}>
                      {dlState.state === 'pinning' ? 'Pinning to IPFS' : dlState.state === 'queued' ? 'Queued' : dlState.progress < 0 ? (dlState.bytesDownloaded > 0 ? formatStorage(dlState.bytesDownloaded) : 'Downloading...') : `${Math.min(Math.round(dlState.progress), 99)}%`}
                    </span>
                  </div>
                ) : sermon.incomplete ? (
                  <span className="ipfs-badge incomplete" style={{ color: '#e67e22', borderColor: 'rgba(230,126,34,0.3)', background: 'rgba(230,126,34,0.1)' }}>
                    {iconWarning} <span style={{ marginLeft: '3px' }}>Incomplete — {sermon.diskSize ? formatStorage(sermon.diskSize) : '?'} / {sermon.sizeFormatted}</span>
                  </span>
                ) : (
                  <span
                    className="ipfs-badge local"
                    style={{ cursor: sermon.localCid && !sermon.localCid.startsWith('local-') ? 'pointer' : 'default' }}
                    data-tooltip={sermon.localCid && !sermon.localCid.startsWith('local-') ? 'Copy IPFS Link' : 'Seeded locally'}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (sermon.localCid && !sermon.localCid.startsWith('local-')) {
                        const link = `https://ipfs.io/ipfs/${sermon.localCid}`;
                        const el = e.currentTarget;
                        const showCopied = () => {
                          const origTooltip = el.getAttribute('data-tooltip');
                          el.setAttribute('data-tooltip', 'Copied!');
                          el.style.borderColor = 'rgba(78, 203, 113, 0.6)';
                          setTimeout(() => {
                            el.setAttribute('data-tooltip', origTooltip);
                            el.style.borderColor = '';
                          }, 1500);
                        };
                        // Try modern clipboard API first, fall back to execCommand
                        if (navigator.clipboard && navigator.clipboard.writeText) {
                          navigator.clipboard.writeText(link).then(showCopied).catch(() => {
                            // Fallback for WKWebView where clipboard API may fail
                            try {
                              const ta = document.createElement('textarea');
                              ta.value = link;
                              ta.style.position = 'fixed';
                              ta.style.left = '-9999px';
                              document.body.appendChild(ta);
                              ta.select();
                              document.execCommand('copy');
                              document.body.removeChild(ta);
                              showCopied();
                            } catch (ex) { console.warn('[Copy] Failed:', ex); }
                          });
                        } else {
                          try {
                            const ta = document.createElement('textarea');
                            ta.value = link;
                            ta.style.position = 'fixed';
                            ta.style.left = '-9999px';
                            document.body.appendChild(ta);
                            ta.select();
                            document.execCommand('copy');
                            document.body.removeChild(ta);
                            showCopied();
                          } catch (ex) { console.warn('[Copy] Failed:', ex); }
                        }
                      }
                    }}
                  >{iconPin} <span style={{ marginLeft: '3px' }}>Seeded</span></span>
                )}
              </div>
              <div className="sermon-actions">
                <button
                  className={`btn-icon ${isActive ? 'active' : ''}`}
                  onClick={() => onPlay(sermon)}
                  data-tooltip={isCurrentPlaying ? 'Pause' : 'Play'}
                  disabled={sermon.incomplete}
                  style={sermon.incomplete ? { opacity: 0.3 } : {}}
                >
                  {isCurrentPlaying ? iconPause : iconPlay}
                </button>
                {sermon.incomplete && onRedownload ? (
                  <button
                    className="btn-icon"
                    onClick={() => onRedownload(sermon.id)}
                    data-tooltip="Re-download"
                    style={{ color: '#e67e22' }}
                  >
                    {iconRefresh}
                  </button>
                ) : onExport ? (
                  <button
                    className="btn-icon"
                    onClick={() => onExport(sermon.id)}
                    data-tooltip="Export to Desktop"
                    style={{ color: 'var(--text-muted)' }}
                  >
                    {iconExport}
                  </button>
                ) : null}
                {onRemove && (
                  <button
                    className="btn-icon"
                    onClick={() => {
                      if (confirm(`Remove "${sermon.title}" from downloads?`)) {
                        onRemove(sermon.id);
                      }
                    }}
                    data-tooltip="Delete"
                    style={{ color: 'var(--text-muted)' }}
                  >
                    {iconTrash}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {hasMore && (
        <div style={{ textAlign: 'center', padding: '24px 0' }}>
          <button
            className="btn btn-outline"
            onClick={() => setVisibleCount(prev => prev + PAGE_SIZE)}
            style={{ padding: '10px 32px', fontSize: '0.85rem' }}
          >
            Load More ({filtered.length - visibleCount} remaining)
          </button>
        </div>
      )}
    </>
  );
}
