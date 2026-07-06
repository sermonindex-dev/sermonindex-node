import React, { useState, useCallback } from 'react';

const moonIcon = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
  </svg>
);

const sunIcon = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="5" />
    <line x1="12" y1="1" x2="12" y2="3" />
    <line x1="12" y1="21" x2="12" y2="23" />
    <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
    <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
    <line x1="1" y1="12" x2="3" y2="12" />
    <line x1="21" y1="12" x2="23" y2="12" />
    <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
    <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
  </svg>
);

export default function TopBar({ contentMode, announcement, onNavigate, networkHealth }) {
  const [theme, setTheme] = useState(() =>
    document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'
  );

  const toggleTheme = useCallback(() => {
    setTheme((prev) => {
      const next = prev === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = next;
      try { localStorage.setItem('si-theme', next); } catch {}
      return next;
    });
  }, []);

  const modeLabels = {
    cdn: 'Archive.org + CDN',
    'p2p-primary': 'P2P Primary',
    'p2p-only': 'P2P Only',
  };
  const modeLabel = modeLabels[contentMode] || 'Archive.org + CDN';

  // Network health display
  const healthLabel = networkHealth?.label || 'Offline';
  const healthColor = networkHealth?.color || 'var(--text-muted)';

  return (
    <div className="topbar">
      <div style={{ flex: 1 }} />
      <div className="topbar-right">
        {/* Network Health — clickable, links to connections tab */}
        <div
          className="topbar-health-badge"
          onClick={() => onNavigate && onNavigate('connections')}
          title="View connections"
        >
          <div style={{
            width: 8, height: 8, borderRadius: '50%',
            background: healthColor,
            boxShadow: healthLabel !== 'Offline' ? `0 0 6px ${healthColor}` : 'none',
            flexShrink: 0,
          }} />
          <span style={{ color: healthColor }}>{healthLabel}</span>
        </div>

        {/* Content mode — clickable, links to settings */}
        <span
          className={`mode-badge ${contentMode}`}
          onClick={() => onNavigate && onNavigate('settings')}
          style={{ cursor: 'pointer' }}
          title="Open settings"
        >
          {modeLabel}
        </span>

        {/* Theme toggle — moon in light mode, sun in dark mode */}
        <button
          className="theme-toggle"
          onClick={toggleTheme}
          aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
        >
          {theme === 'dark' ? sunIcon : moonIcon}
        </button>
      </div>
    </div>
  );
}
