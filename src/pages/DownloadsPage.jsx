import React, { useState, useCallback, useEffect } from 'react';
import SpeakerAvatar from '../components/SpeakerAvatar.jsx';

const PAGE_SIZE = 50;
const VIEW_KEY = 'si-downloads-view'; // 'cards' (default) | 'speaker'

// Flat SVG icons
const iconPlay = <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3" /></svg>;
const iconPause = <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" /><rect x="14" y="4" width="4" height="16" /></svg>;
const iconPin = <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 17v5" /><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16h14v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1h1V3H7v3h1a1 1 0 0 1 1 1z" /></svg>;
const iconFilm = <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="2" width="20" height="20" rx="2.18" /><line x1="7" y1="2" x2="7" y2="22" /><line x1="17" y1="2" x2="17" y2="22" /><line x1="2" y1="12" x2="22" y2="12" /><line x1="2" y1="7" x2="7" y2="7" /><line x1="2" y1="17" x2="7" y2="17" /><line x1="17" y1="7" x2="22" y2="7" /><line x1="17" y1="17" x2="22" y2="17" /></svg>;
const iconHeadphones = <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 18v-6a9 9 0 0 1 18 0v6" /><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z" /></svg>;
const iconExport = <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" /></svg>;
const iconExternalPlay = <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /><polyline points="15 3 21 3 21 9" /><line x1="10" y1="14" x2="21" y2="3" /></svg>;
const iconTrash = <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></svg>;
const iconRefresh = <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" /></svg>;
const iconWarning = <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" /></svg>;
const iconChevron = <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6" /></svg>;

// SpeakerAvatar now shared — tries multiple site image conventions before initials

function formatStorage(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

const iconFolder = <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" /></svg>;

// Tauri APIs — lazy-loaded to avoid top-level await (mirrors SeedNodePage).
let tauriInvoke = null;
let tauriDialog = null;
let tauriLoaded = false;

async function ensureTauri() {
  if (tauriLoaded) return;
  tauriLoaded = true;
  try {
    const tauriApi = await import('@tauri-apps/api/core');
    tauriInvoke = tauriApi.invoke;
  } catch {}
  try {
    const dialogApi = await import('@tauri-apps/plugin-dialog');
    tauriDialog = dialogApi;
  } catch {}
}

export default function DownloadsPage({ sermons, currentSermon, isPlaying, onPlay, onRemove, onExport, onOpenExternal, onRedownload, onOpenFolder, downloadStates }) {
  const [search, setSearch] = useState('');
  const [filterType, setFilterType] = useState('');
  const [sortBy, setSortBy] = useState('recent'); // 'recent' (default) | 'speaker' | 'title'
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [expandedId, setExpandedId] = useState(null);

  // View mode — Cards (default grid) vs By Speaker. Persisted to localStorage.
  const [view, setView] = useState(() => {
    try {
      const saved = localStorage.getItem(VIEW_KEY);
      if (saved === 'cards' || saved === 'speaker') return saved;
    } catch {}
    return 'cards';
  });
  const setViewPersisted = useCallback((next) => {
    setView(next);
    try { localStorage.setItem(VIEW_KEY, next); } catch {}
  }, []);

  // Which speaker is expanded in the By Speaker view.
  const [openSpeaker, setOpenSpeaker] = useState(null);

  // ── Download location (Task 1) ─────────────────────────────────────────────
  const [storageDir, setStorageDir] = useState('');
  const [tauriReady, setTauriReady] = useState(false); // true once we confirm invoke exists

  useEffect(() => {
    let cancelled = false;
    (async () => {
      await ensureTauri();
      if (cancelled) return;
      if (!tauriInvoke) { setTauriReady(false); return; }
      setTauriReady(true);
      try {
        const current = await tauriInvoke('get_storage_dir');
        if (!cancelled && current) setStorageDir(current);
      } catch {}
    })();
    return () => { cancelled = true; };
  }, []);

  const changeStorageDir = useCallback(async () => {
    await ensureTauri();
    if (!tauriDialog || !tauriInvoke) return;
    try {
      const selected = await tauriDialog.open({ directory: true, title: 'Choose download folder' });
      if (!selected) return;
      const saved = await tauriInvoke('set_storage_dir', { path: selected });
      setStorageDir(saved || selected);
    } catch (e) {
      console.warn('[Downloads] Change folder failed:', e);
    }
  }, []);

  const openStorageDir = useCallback(async () => {
    await ensureTauri();
    if (!tauriInvoke || !storageDir) return;
    try {
      await tauriInvoke('open_folder', { path: storageDir });
    } catch (e) {
      console.warn('[Downloads] Open folder failed:', e);
    }
  }, [storageDir]);

  // ── Export a whole speaker → Desktop/<Speaker>/<Title>.<ext> ────────────────
  // Copies every complete download by this speaker into one Desktop folder with
  // proper filenames. Status is tracked per speaker for inline feedback.
  const [exportStatus, setExportStatus] = useState({}); // name -> {state, exported, failed}
  const exportSpeaker = useCallback(async (speaker) => {
    await ensureTauri();
    if (!tauriInvoke) return;
    setExportStatus(prev => ({ ...prev, [speaker.name]: { state: 'working' } }));
    try {
      const items = speaker.sermons
        .filter(s => !s.incomplete) // don't export half-downloaded files
        .map(s => ({
          filename: `${s.id}.${s.type === 'video' ? 'mp4' : 'mp3'}`,
          title: s.title || s.id,
        }));
      const res = await tauriInvoke('export_speaker', { speaker: speaker.name, items });
      setExportStatus(prev => ({
        ...prev,
        [speaker.name]: { state: 'done', exported: res?.exported ?? 0, failed: res?.failed ?? 0, folder: res?.folder },
      }));
    } catch (e) {
      console.warn('[Downloads] Export speaker failed:', e);
      setExportStatus(prev => ({ ...prev, [speaker.name]: { state: 'error' } }));
    }
  }, []);

  // Download-location bar (Tauri only). Defined here — before the empty-state
  // early return — so it renders whether or not any sermons are downloaded yet.
  const locationBar = tauriReady ? (
    <div className="seed-card" style={{ marginBottom: '12px', padding: '10px 14px', display: 'flex', alignItems: 'center', gap: '12px' }}>
      <span style={{ display: 'inline-flex', color: 'var(--text-muted)', flexShrink: 0 }}>{iconFolder}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', fontWeight: 600, marginBottom: '1px' }}>Download location</div>
        <div style={{ fontSize: '0.75rem', fontFamily: 'monospace', color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={storageDir || undefined}>
          {storageDir || 'Not set'}
        </div>
        <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)', marginTop: '2px' }}>
          New downloads go here, auto-sorted into folders. Existing files stay where they are.
        </div>
      </div>
      <button
        className="btn"
        onClick={changeStorageDir}
        style={{ whiteSpace: 'nowrap', padding: '6px 12px', background: 'var(--bg-tertiary)', border: '1px solid var(--border)', color: 'var(--text-secondary)', borderRadius: '6px', cursor: 'pointer', fontSize: '0.75rem', flexShrink: 0 }}
      >
        Change…
      </button>
      <button
        className="btn"
        onClick={openStorageDir}
        disabled={!storageDir}
        style={{ whiteSpace: 'nowrap', padding: '6px 12px', background: 'var(--bg-tertiary)', border: '1px solid var(--border)', color: 'var(--text-secondary)', borderRadius: '6px', cursor: storageDir ? 'pointer' : 'default', fontSize: '0.75rem', flexShrink: 0, opacity: storageDir ? 1 : 0.4 }}
      >
        Open
      </button>
    </div>
  ) : null;

  if (sermons.length === 0) {
    return (
      <>
        <div className="page-header">
          <h2>My Downloads</h2>
          <p>Sermons you've downloaded are stored locally and shared with the peer network</p>
        </div>
        {locationBar}
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

  // ── Shared per-sermon card (used by BOTH Cards and By Speaker views) ────────
  // Extracted as a render function so play / remove / export / redownload keep
  // working identically in either view.
  const renderSermonCard = (sermon) => {
    const isCurrentPlaying = currentSermon?.id === sermon.id && isPlaying;
    const isActive = currentSermon?.id === sermon.id;
    const isExpanded = expandedId === sermon.id;
    const dlState = downloadStates?.[sermon.id];
    const isActivelyDownloading = dlState && ['downloading', 'seeding', 'queued'].includes(dlState.state);

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
                  className={`dl-progress-mini-fill ${dlState.state === 'seeding' ? 'seeding' : ''} ${dlState.progress < 0 ? 'indeterminate' : ''}`}
                  style={{ width: dlState.state === 'seeding' ? '100%' : dlState.progress < 0 ? '40%' : `${Math.min(Math.round(dlState.progress), 99)}%` }}
                ></div>
              </div>
              <span className="dl-progress-mini-text" style={dlState.state === 'seeding' ? { color: 'var(--seed-blue)' } : {}}>
                {dlState.state === 'seeding' ? 'Seeding to P2P network' : dlState.state === 'queued' ? 'Queued' : dlState.progress < 0 ? (dlState.bytesDownloaded > 0 ? formatStorage(dlState.bytesDownloaded) : 'Downloading...') : `${Math.min(Math.round(dlState.progress), 99)}%`}
              </span>
            </div>
          ) : sermon.incomplete ? (
            <span className="seed-badge incomplete" style={{ color: 'var(--orange)', borderColor: 'rgba(230,126,34,0.3)', background: 'rgba(230,126,34,0.1)' }}>
              {iconWarning} <span style={{ marginLeft: '3px' }}>Incomplete — {sermon.diskSize ? formatStorage(sermon.diskSize) : '?'} / {sermon.sizeFormatted}</span>
            </span>
          ) : (() => {
            // Best shareable link, in order:
            // 1. canonical .torrent URL — contains metadata + CDN webseed,
            //    works in ANY client even with zero peers (magnets need a
            //    live peer to fetch metadata first)
            // 2. canonical magnet (works once reachable peers exist)
            // 3. legacy local magnet
            const link = (sermon.torrentUrl && sermon.torrentUrl.startsWith('http')) ? sermon.torrentUrl
              : (sermon.magnet && sermon.magnet.startsWith('magnet:')) ? sermon.magnet
              : (sermon.localMagnet && sermon.localMagnet.startsWith('magnet:')) ? sermon.localMagnet
              : null;
            return (
            <span
              className="seed-badge local"
              style={{ cursor: link ? 'pointer' : 'default' }}
              data-tooltip={link ? (link.startsWith('http') ? 'Copy Torrent Link' : 'Copy Magnet Link') : 'Seeded locally'}
              onClick={(e) => {
                e.stopPropagation();
                if (link) {
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
            );
          })()}
        </div>
        <div className="sermon-actions">
          {sermon.type === 'video' && onOpenExternal ? (
            <button
              onClick={() => onOpenExternal(sermon)}
              data-tooltip="Open in your device's video player"
              disabled={sermon.incomplete}
              style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', padding: '6px 10px', background: 'var(--bg-tertiary)', border: '1px solid var(--border)', color: 'var(--text-secondary)', borderRadius: '6px', cursor: 'pointer', fontSize: '0.72rem', fontWeight: 600, opacity: sermon.incomplete ? 0.3 : 1 }}
            >
              {iconExternalPlay} Player
            </button>
          ) : (
            <button
              className={`btn-icon ${isActive ? 'active' : ''}`}
              onClick={() => onPlay(sermon)}
              data-tooltip={isCurrentPlaying ? 'Pause' : 'Play'}
              disabled={sermon.incomplete}
              style={sermon.incomplete ? { opacity: 0.3 } : {}}
            >
              {isCurrentPlaying ? iconPause : iconPlay}
            </button>
          )}
          {sermon.incomplete && onRedownload ? (
            <button
              className="btn-icon"
              onClick={() => onRedownload(sermon.id)}
              data-tooltip="Re-download"
              style={{ color: 'var(--orange)' }}
            >
              {iconRefresh}
            </button>
          ) : onExport ? (
            <button
              onClick={() => onExport(sermon.id)}
              data-tooltip="Export to Desktop"
              style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', padding: '6px 10px', background: 'var(--bg-tertiary)', border: '1px solid var(--border)', color: 'var(--text-secondary)', borderRadius: '6px', cursor: 'pointer', fontSize: '0.72rem', fontWeight: 600 }}
            >
              {iconExport} Export
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
  };

  // ── CARDS view data (search + type filter + sort + paging) ──────────────────
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
  if (sortBy === 'speaker') {
    filtered = [...filtered].sort((a, b) =>
      a.speaker.localeCompare(b.speaker) || a.title.localeCompare(b.title));
  } else if (sortBy === 'title') {
    filtered = [...filtered].sort((a, b) => a.title.localeCompare(b.title));
  }
  // 'recent' keeps the natural order (as downloaded)

  const displayed = filtered.slice(0, visibleCount);
  const hasMore = visibleCount < filtered.length;

  // ── BY SPEAKER view data — group the downloaded sermons by speaker ──────────
  // (mirrors BulkDownloadPage.speakerGroups, but over the already-downloaded
  // `sermons` array). Sorted A–Z. Search filters by speaker name.
  // Computed inline (not useMemo) because it sits after the early return above —
  // a hook here would break the Rules of Hooks. Grouping the downloaded set is
  // cheap, matching how `filtered` above is computed each render.
  const speakerGroups = (() => {
    const groups = {};
    for (const s of sermons) {
      if (!groups[s.speaker]) {
        groups[s.speaker] = {
          name: s.speaker,
          image: s.speakerImage,
          sermons: [],
          audioCount: 0,
          videoCount: 0,
        };
      }
      const g = groups[s.speaker];
      g.sermons.push(s);
      if (s.type === 'video') g.videoCount++;
      else g.audioCount++;
    }
    return Object.values(groups).sort((a, b) => a.name.localeCompare(b.name));
  })();

  const filteredSpeakers = search
    ? speakerGroups.filter(g => g.name.toLowerCase().includes(search.toLowerCase()))
    : speakerGroups;

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

      {locationBar}

      <div className="seed-card" style={{ marginBottom: '16px', padding: '12px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '16px' }}>
        <p style={{ fontSize: '0.78rem', margin: 0, color: 'var(--text-muted)', lineHeight: 1.5, flex: 1 }}>
          Downloaded files are stored locally and seeded to the P2P network (and should not be renamed). Use <strong style={{ color: 'var(--text-primary)' }}>Export</strong> on any sermon — or <strong style={{ color: 'var(--text-primary)' }}>By Speaker → Export</strong> — to save readable copies into a Desktop folder named for the speaker.
        </p>
        {onOpenFolder && (
          <button
            className="btn"
            onClick={onOpenFolder}
            style={{ whiteSpace: 'nowrap', padding: '6px 12px', background: 'var(--bg-tertiary)', border: '1px solid var(--border)', color: 'var(--text-secondary)', borderRadius: '6px', cursor: 'pointer', fontSize: '0.75rem', display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0 }}
          >
            {iconFolder} Open Downloads Folder
          </button>
        )}
      </div>

      <div className="library-filters">
        <div className="search-box" style={{ maxWidth: '300px' }}>
          <input
            type="text"
            placeholder={view === 'speaker' ? 'Search speakers...' : 'Search downloads...'}
            value={search}
            onChange={e => { setSearch(e.target.value); setVisibleCount(PAGE_SIZE); }}
          />
          <svg className="search-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
        </div>

        {/* Cards-only filters (type + sort) — hidden in By Speaker view to keep it clean */}
        {view === 'cards' && (
          <>
            <select
              value={filterType}
              onChange={e => { setFilterType(e.target.value); setVisibleCount(PAGE_SIZE); }}
              className="filter-select"
            >
              <option value="">All Types</option>
              <option value="audio">Audio Only</option>
              <option value="video">Video Only</option>
            </select>

            <select
              value={sortBy}
              onChange={e => { setSortBy(e.target.value); setVisibleCount(PAGE_SIZE); }}
              className="filter-select"
            >
              <option value="recent">Sort: Recent</option>
              <option value="speaker">Sort: Speaker A–Z</option>
              <option value="title">Sort: Title A–Z</option>
            </select>
          </>
        )}

        {/* View toggle — Cards (default) vs By Speaker */}
        <div className="view-toggle" style={{ display: 'inline-flex', border: '1px solid var(--border)', borderRadius: 'var(--radius)', overflow: 'hidden' }}>
          {[['cards', 'Cards'], ['speaker', 'By Speaker']].map(([key, label]) => {
            const active = view === key;
            return (
              <button
                key={key}
                type="button"
                onClick={() => { setViewPersisted(key); setOpenSpeaker(null); }}
                style={{
                  padding: '6px 12px',
                  fontSize: '0.75rem',
                  fontFamily: 'var(--font)',
                  border: 'none',
                  cursor: 'pointer',
                  background: active ? 'var(--gold)' : 'var(--bg-tertiary)',
                  color: active ? '#1a1a1a' : 'var(--text-secondary)',
                  fontWeight: active ? 600 : 500,
                }}
              >
                {label}
              </button>
            );
          })}
        </div>

        <span className="filter-count">
          {view === 'speaker'
            ? `${filteredSpeakers.length} speakers`
            : `${filtered.length} results · showing ${displayed.length}`}
        </span>
      </div>

      {view === 'cards' ? (
        <>
          <div className="sermon-grid">
            {displayed.map(sermon => renderSermonCard(sermon))}
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
      ) : (
        // BY SPEAKER view
        <div className="bulk-speaker-list">
          {filteredSpeakers.map(speaker => {
            const isOpen = openSpeaker === speaker.name;
            const exp = exportStatus[speaker.name];
            const metaText = speaker.videoCount > 0
              ? `${speaker.sermons.length} downloaded · ${speaker.audioCount} audio, ${speaker.videoCount} video`
              : `${speaker.sermons.length} downloaded`;
            return (
              <div key={speaker.name}>
                <div
                  className={`bulk-speaker-row ${isOpen ? 'active' : ''}`}
                  onClick={() => setOpenSpeaker(isOpen ? null : speaker.name)}
                  style={{ cursor: 'pointer' }}
                >
                  <span style={{ display: 'inline-flex', color: 'var(--text-muted)', transform: isOpen ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s ease', flexShrink: 0 }}>
                    {iconChevron}
                  </span>
                  <SpeakerAvatar speaker={speaker.name} image={speaker.image} className="bulk-speaker-avatar" />
                  <div className="bulk-speaker-info">
                    <div className="bulk-speaker-name">{speaker.name}</div>
                    <div className="bulk-speaker-meta">{metaText}</div>
                  </div>
                  <div className="bulk-speaker-action" style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    {exp?.state === 'done' && (
                      <span style={{ fontSize: '0.72rem', color: '#3ca35b', whiteSpace: 'nowrap' }}>
                        Exported {exp.exported}{exp.failed ? ` · ${exp.failed} skipped` : ''}
                      </span>
                    )}
                    {exp?.state === 'error' && (
                      <span style={{ fontSize: '0.72rem', color: 'var(--orange)' }}>Export failed</span>
                    )}
                    {tauriReady && (
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); exportSpeaker(speaker); }}
                        disabled={exp?.state === 'working'}
                        data-tooltip="Copy all this speaker's downloads to Desktop, named properly"
                        style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', padding: '5px 10px', background: 'var(--bg-tertiary)', border: '1px solid var(--border)', color: 'var(--text-secondary)', borderRadius: '6px', cursor: exp?.state === 'working' ? 'default' : 'pointer', fontSize: '0.72rem', opacity: exp?.state === 'working' ? 0.6 : 1, whiteSpace: 'nowrap' }}
                      >
                        {exp?.state === 'working' ? 'Exporting…' : <>{iconExport} Export</>}
                      </button>
                    )}
                    <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                      {isOpen ? 'Hide' : 'View'}
                    </span>
                  </div>
                </div>

                {isOpen && (
                  <div style={{ padding: '12px 0 4px' }}>
                    <button
                      type="button"
                      className="btn"
                      onClick={() => setOpenSpeaker(null)}
                      style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '0.75rem', padding: '0 0 10px', display: 'inline-flex', alignItems: 'center', gap: '4px' }}
                    >
                      ← All speakers
                    </button>
                    <div className="sermon-grid">
                      {speaker.sermons.map(sermon => renderSermonCard(sermon))}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
