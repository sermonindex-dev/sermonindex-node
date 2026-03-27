import React from 'react';

export default function TopBar({ contentMode, announcement, onNavigate, networkHealth }) {
  const modeLabels = {
    cdn: 'Archive.org + CDN',
    'ipfs-primary': 'IPFS Primary',
    'ipfs-only': 'IPFS Only',
  };
  const modeLabel = modeLabels[contentMode] || 'Archive.org + CDN';

  // Network health display
  const healthLabel = networkHealth?.label || 'Offline';
  const healthColor = networkHealth?.color || '#6a8299';

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
      </div>
    </div>
  );
}
