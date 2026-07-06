import React, { useState } from 'react';

const PAGE_SIZE = 50;

function formatStorage(bytes) {
  if (!bytes || bytes === 0) return '';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

// Flat SVG icons
const iconPlay = <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3" /></svg>;
const iconPause = <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" /><rect x="14" y="4" width="4" height="16" /></svg>;
const iconDownload = <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></svg>;
const iconCheck = <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>;
const iconPin = <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 17v5" /><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16h14v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1h1V3H7v3h1a1 1 0 0 1 1 1z" /></svg>;
const iconFilm = <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="2" width="20" height="20" rx="2.18" /><line x1="7" y1="2" x2="7" y2="22" /><line x1="17" y1="2" x2="17" y2="22" /><line x1="2" y1="12" x2="22" y2="12" /><line x1="2" y1="7" x2="7" y2="7" /><line x1="2" y1="17" x2="7" y2="17" /><line x1="17" y1="7" x2="22" y2="7" /><line x1="17" y1="17" x2="22" y2="17" /></svg>;
const iconHeadphones = <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 18v-6a9 9 0 0 1 18 0v6" /><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z" /></svg>;

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

function DownloadProgress({ dlState }) {
  if (!dlState) return null;
  const { state, progress } = dlState;

  if (state === 'seeding') {
    return (
      <div className="dl-progress-mini">
        <div className="dl-progress-mini-bar">
          <div className="dl-progress-mini-fill seeding" style={{ width: '100%' }}></div>
        </div>
        <span className="dl-progress-mini-text" style={{ color: '#6ea8fe' }}>Seeding to P2P network</span>
      </div>
    );
  }
  if (state === 'downloading') {
    const isIndeterminate = progress < 0;
    const pct = isIndeterminate ? 0 : Math.min(Math.round(progress), 99);
    const bytesText = dlState.bytesDownloaded > 0
      ? formatStorage(dlState.bytesDownloaded)
      : '';
    return (
      <div className="dl-progress-mini">
        <div className="dl-progress-mini-bar">
          <div
            className={`dl-progress-mini-fill ${isIndeterminate ? 'indeterminate' : ''}`}
            style={{ width: isIndeterminate ? '40%' : `${pct}%` }}
          ></div>
        </div>
        <span className="dl-progress-mini-text">
          {isIndeterminate ? (bytesText || 'Downloading...') : `${pct}%`}
        </span>
      </div>
    );
  }
  if (state === 'queued') {
    return <span className="dl-status queued">Queued</span>;
  }
  if (state === 'error') {
    return <span className="dl-status error">Failed</span>;
  }
  return null;
}

export default function LibraryPage({ sermons, currentSermon, isPlaying, onPlay, onDownload, search, onSearch }) {
  const [filterSpeaker, setFilterSpeaker] = useState('');
  const [filterTopic, setFilterTopic] = useState('');
  const [filterType, setFilterType] = useState(''); // '', 'audio', 'video'
  const [sortBy, setSortBy] = useState('random');
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [expandedId, setExpandedId] = useState(null);
  const [randomSeed, setRandomSeed] = useState(() => Math.random());

  // Get unique speakers and topics — filtered by type selection so dropdowns only show relevant options
  const typeFiltered = filterType ? sermons.filter(s => s.type === filterType) : sermons;
  const speakers = [...new Set(typeFiltered.map(s => s.speaker))].sort();
  const topics = [...new Set(typeFiltered.map(s => s.topic))].sort();

  // Apply filters
  let filtered = sermons;
  if (search) {
    const q = search.toLowerCase();
    filtered = filtered.filter(s =>
      s.title.toLowerCase().includes(q) ||
      s.speaker.toLowerCase().includes(q) ||
      (s.topic && s.topic.toLowerCase().includes(q)) ||
      (s.scripture && s.scripture.toLowerCase().includes(q))
    );
  }
  if (filterSpeaker) {
    filtered = filtered.filter(s => s.speaker === filterSpeaker);
  }
  if (filterTopic) {
    filtered = filtered.filter(s => s.topic === filterTopic);
  }
  if (filterType) {
    filtered = filtered.filter(s => s.type === filterType);
  }

  // Apply sort
  if (sortBy === 'random') {
    // Deterministic shuffle based on seed (stable until filter/type changes)
    filtered = [...filtered];
    for (let i = filtered.length - 1; i > 0; i--) {
      // Simple seeded hash: combine seed with index
      const h = Math.abs(Math.sin(randomSeed * 10000 + i * 9973)) * 10000;
      const j = Math.floor(h % (i + 1));
      [filtered[i], filtered[j]] = [filtered[j], filtered[i]];
    }
  } else {
    filtered = [...filtered].sort((a, b) => {
      switch (sortBy) {
        case 'speaker': return a.speaker.localeCompare(b.speaker);
        case 'duration': return (a.duration || 0) - (b.duration || 0);
        case 'size': return (a.sizeBytes || 0) - (b.sizeBytes || 0);
        case 'year': return (b.year || 0) - (a.year || 0);
        default: return a.title.localeCompare(b.title);
      }
    });
  }

  // Paginate
  const displayed = filtered.slice(0, visibleCount);
  const hasMore = visibleCount < filtered.length;

  const audioCount = sermons.filter(s => s.type === 'audio').length;
  const videoCount = sermons.filter(s => s.type === 'video').length;

  return (
    <>
      <div className="page-header">
        <h2>Sermon Library</h2>
        <p>{sermons.length} sermons available ({audioCount} audio, {videoCount} video) · Download to listen and share</p>
      </div>

      <div className="library-filters">
        <select
          value={filterSpeaker}
          onChange={e => { setFilterSpeaker(e.target.value); setVisibleCount(PAGE_SIZE); }}
          className="filter-select"
        >
          <option value="">All Speakers</option>
          {speakers.map(s => <option key={s} value={s}>{s}</option>)}
        </select>

        <select
          value={filterTopic}
          onChange={e => { setFilterTopic(e.target.value); setVisibleCount(PAGE_SIZE); }}
          className="filter-select"
        >
          <option value="">All Topics</option>
          {topics.map(t => <option key={t} value={t}>{t}</option>)}
        </select>

        <select
          value={filterType}
          onChange={e => {
            const newType = e.target.value;
            setFilterType(newType);
            setVisibleCount(PAGE_SIZE);
            if (sortBy === 'random') setRandomSeed(Math.random()); // reshuffle
            const newTypeFiltered = newType ? sermons.filter(s => s.type === newType) : sermons;
            const newSpeakers = new Set(newTypeFiltered.map(s => s.speaker));
            const newTopics = new Set(newTypeFiltered.map(s => s.topic));
            if (filterSpeaker && !newSpeakers.has(filterSpeaker)) setFilterSpeaker('');
            if (filterTopic && !newTopics.has(filterTopic)) setFilterTopic('');
          }}
          className="filter-select"
        >
          <option value="">All Types</option>
          <option value="audio">Audio Only</option>
          <option value="video">Video Only</option>
        </select>

        <select
          value={sortBy}
          onChange={e => { setSortBy(e.target.value); if (e.target.value === 'random') setRandomSeed(Math.random()); }}
          className="filter-select"
        >
          <option value="random">Sort: Random</option>
          <option value="title">Sort: Title</option>
          <option value="speaker">Sort: Speaker</option>
          <option value="duration">Sort: Duration</option>
          <option value="size">Sort: Size</option>
          <option value="year">Sort: Year</option>
        </select>

        <span className="filter-count">{filtered.length} results · showing {displayed.length}</span>
      </div>

      <div className="library-search-row">
        <div className="search-box">
          <input
            type="text"
            placeholder="Search sermons by title, speaker, topic, or scripture..."
            value={search || ''}
            onChange={e => { if (onSearch) onSearch(e.target.value); setVisibleCount(PAGE_SIZE); }}
          />
          <svg className="search-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
        </div>
      </div>

      <div className="sermon-grid">
        {displayed.map(sermon => {
          const isCurrentPlaying = currentSermon?.id === sermon.id && isPlaying;
          const isActive = currentSermon?.id === sermon.id;
          const dlState = sermon.dlState;
          const isDownloading = dlState && ['downloading', 'seeding', 'queued'].includes(dlState.state);
          const isExpanded = expandedId === sermon.id;

          return (
            <div
              key={sermon.id}
              className={`sermon-card ${isActive ? 'playing' : ''} ${isExpanded ? 'expanded' : ''}`}
              onClick={(e) => {
                if (e.target.closest('button') || e.target.closest('select')) return;
                setExpandedId(isExpanded ? null : sermon.id);
              }}
              style={isExpanded ? { gridColumn: 'span 2', cursor: 'pointer' } : { cursor: 'pointer' }}
            >
              <div className="sermon-card-header">
                <SpeakerAvatar speaker={sermon.speaker} image={sermon.speakerImage} />
                <div className="sermon-card-info">
                  <div className="sermon-title" title={sermon.title} style={isExpanded ? { whiteSpace: 'normal', overflow: 'visible', textOverflow: 'unset' } : {}}>
                    {sermon.title}
                  </div>
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
                {sermon.scripture && (
                  <span className="scripture-ref" title={sermon.scripture}>{sermon.scripture}</span>
                )}
              </div>

              <div className="sermon-meta-row2">
                {sermon.downloaded && (
                  <span className="seed-badge local">{iconPin} <span style={{ marginLeft: '3px' }}>Seeded</span></span>
                )}
                {sermon.year && (
                  <span className="year-badge">{sermon.year}</span>
                )}
              </div>

              {isDownloading && <DownloadProgress dlState={dlState} />}

              <div className="sermon-actions">
                {/* Play button only visible after download */}
                {sermon.downloaded && (
                  <button
                    className={`btn-icon ${isActive ? 'active' : ''}`}
                    onClick={() => onPlay(sermon)}
                    data-tooltip={isCurrentPlaying ? 'Pause' : 'Play'}
                  >
                    {isCurrentPlaying ? iconPause : iconPlay}
                  </button>
                )}
                {!sermon.downloaded && (
                  <button
                    className={`btn-icon ${isDownloading ? 'downloading' : ''}`}
                    onClick={() => !isDownloading && onDownload(sermon.id)}
                    data-tooltip={isDownloading ? 'Downloading...' : 'Download'}
                    disabled={isDownloading}
                  >
                    {iconDownload}
                  </button>
                )}
                {sermon.downloaded && (
                  <span className="btn-icon downloaded" data-tooltip="Downloaded" style={{ cursor: 'default' }}>
                    {iconCheck}
                  </span>
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
