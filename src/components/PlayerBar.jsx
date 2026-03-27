import React, { useCallback, useRef } from 'react';

function formatTime(seconds) {
  if (!seconds || isNaN(seconds)) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// Flat SVG icons for the player
const iconFilm = <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="2" width="20" height="20" rx="2.18" /><line x1="7" y1="2" x2="7" y2="22" /><line x1="17" y1="2" x2="17" y2="22" /><line x1="2" y1="12" x2="22" y2="12" /><line x1="2" y1="7" x2="7" y2="7" /><line x1="2" y1="17" x2="7" y2="17" /><line x1="17" y1="7" x2="22" y2="7" /><line x1="17" y1="17" x2="22" y2="17" /></svg>;
const iconHeadphones = <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 18v-6a9 9 0 0 1 18 0v6" /><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z" /></svg>;
const iconPlay = <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3" /></svg>;
const iconPause = <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" /><rect x="14" y="4" width="4" height="16" /></svg>;
const iconPrev = <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="19 20 9 12 19 4 19 20" /><line x1="5" y1="19" x2="5" y2="5" stroke="currentColor" strokeWidth="2" /></svg>;
const iconNext = <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 4 15 12 5 20 5 4" /><line x1="19" y1="5" x2="19" y2="19" stroke="currentColor" strokeWidth="2" /></svg>;
const iconVolume = <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor" /><path d="M15.54 8.46a5 5 0 0 1 0 7.07" /><path d="M19.07 4.93a10 10 0 0 1 0 14.14" /></svg>;
const iconMute = <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor" /><line x1="23" y1="9" x2="17" y2="15" /><line x1="17" y1="9" x2="23" y2="15" /></svg>;
const iconClose = <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>;

export default function PlayerBar({
  sermon,
  isPlaying,
  progress,
  currentTime,
  duration,
  volume,
  onTogglePlay,
  onSeek,
  onVolumeChange,
  onClose,
}) {
  const progressBarRef = useRef(null);

  const handleProgressClick = useCallback((e) => {
    if (!progressBarRef.current || !onSeek) return;
    const rect = progressBarRef.current.getBoundingClientRect();
    const percent = ((e.clientX - rect.left) / rect.width) * 100;
    onSeek(Math.max(0, Math.min(100, percent)));
  }, [onSeek]);

  const isVideo = sermon.type === 'video';

  return (
    <div className="player-bar">
      <div className="player-info">
        <div className="player-title">
          <span className={`player-type-icon ${isVideo ? 'video' : 'audio'}`}>
            {isVideo ? iconFilm : iconHeadphones}
          </span>
          {sermon.title}
        </div>
        <div className="player-speaker">{sermon.speaker}</div>
      </div>

      <div className="player-controls">
        <button title="Previous" style={{ opacity: 0.3, cursor: 'default' }} disabled>{iconPrev}</button>
        <button className="play-btn" onClick={onTogglePlay} title={isPlaying ? 'Pause' : 'Play'}>
          {isPlaying ? iconPause : iconPlay}
        </button>
        <button title="Next" style={{ opacity: 0.3, cursor: 'default' }} disabled>{iconNext}</button>
      </div>

      <div className="player-progress">
        <span className="player-time">{formatTime(currentTime)}</span>
        <div
          className="progress-bar"
          ref={progressBarRef}
          onClick={handleProgressClick}
          style={{ cursor: 'pointer' }}
        >
          <div className="progress-bar-fill" style={{ width: `${progress}%` }}></div>
        </div>
        <span className="player-time">{formatTime(duration)}</span>
      </div>

      <div className="player-volume">
        <span style={{ display: 'flex', alignItems: 'center' }}>{volume > 0 ? iconVolume : iconMute}</span>
        <input
          type="range"
          min="0"
          max="1"
          step="0.05"
          value={volume}
          onChange={e => onVolumeChange(parseFloat(e.target.value))}
          style={{ width: '80px', accentColor: 'var(--gold)' }}
        />
      </div>

      <button
        className="player-close"
        onClick={onClose}
        title="Close player"
      >
        {iconClose}
      </button>
    </div>
  );
}
