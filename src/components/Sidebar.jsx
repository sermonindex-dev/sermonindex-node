import React from 'react';
import siLogo from '../assets/si-logo.png';

// Clean SVG icons (Lucide-inspired, MIT license, single-color flat)
const icons = {
  library: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" /><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
    </svg>
  ),
  bulkDownload: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  ),
  downloads: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
    </svg>
  ),
  globe: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" /><line x1="2" y1="12" x2="22" y2="12" /><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
    </svg>
  ),
  seed: (
    <svg width="18" height="18" viewBox="0 0 256 256" fill="currentColor">
      <path d="M208,32H48A16,16,0,0,0,32,48V208a16,16,0,0,0,16,16H208a16,16,0,0,0,16-16V48A16,16,0,0,0,208,32ZM88,160a8,8,0,1,1-8,8A8,8,0,0,1,88,160ZM48,48H80v97.38a24,24,0,1,0,16,0V115.31l48,48V208H48ZM208,208H160V160a8,8,0,0,0-2.34-5.66L96,92.69V48h32V72a8,8,0,0,0,2.34,5.66l16,16A23.74,23.74,0,0,0,144,104a24,24,0,1,0,24-24,23.74,23.74,0,0,0-10.34,2.35L144,68.69V48h64V208ZM168,96a8,8,0,1,1-8,8A8,8,0,0,1,168,96Z" />
    </svg>
  ),
  seedLocked: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  ),
  connections: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="2" /><path d="M16.24 7.76a6 6 0 0 1 0 8.49m-8.48-.01a6 6 0 0 1 0-8.49m11.31-2.82a10 10 0 0 1 0 14.14m-14.14 0a10 10 0 0 1 0-14.14" />
    </svg>
  ),
  settings: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  ),
};

export default function Sidebar({ page, onNavigate, nodeOnline, nodeStats, seedUnlocked, libraryStats, announcement }) {
  const coverage = libraryStats ? libraryStats.coverage : 0;

  return (
    <div className="sidebar">
      <div className="sidebar-header">
        <div className="sidebar-logo">
          <img src={siLogo} alt="SermonIndex" className="logo-img-wide" />
        </div>
        <div className="subtitle">Node Software</div>
      </div>

      <div className="sidebar-nav">
        <div className="nav-section">
          <div className="nav-section-label">Library</div>
          <div className={`nav-item ${page === 'library' ? 'active' : ''}`} onClick={() => onNavigate('library')}>
            <span className="icon">{icons.library}</span> Browse Sermons
          </div>
          <div className={`nav-item ${page === 'bulk-download' ? 'active' : ''}`} onClick={() => onNavigate('bulk-download')}>
            <span className="icon">{icons.bulkDownload}</span> Bulk Download
          </div>
          <div className={`nav-item ${page === 'downloads' ? 'active' : ''}`} onClick={() => onNavigate('downloads')}>
            <span className="icon">{icons.downloads}</span> My Downloads
          </div>
        </div>

        <div className="nav-section">
          <div className="nav-section-label">Network</div>
          <div className={`nav-item ${page === 'network' ? 'active' : ''}`} onClick={() => onNavigate('network')}>
            <span className="icon">{icons.globe}</span> Node Map
          </div>
          <div className={`nav-item ${page === 'seed' ? 'active' : ''}`} onClick={() => onNavigate('seed')}>
            <span className="icon">{icons.seed}</span> Seed Node
          </div>
        </div>

        <div className="nav-section">
          <div className="nav-section-label">App</div>
          <div className={`nav-item ${page === 'connections' ? 'active' : ''}`} onClick={() => onNavigate('connections')}>
            <span className="icon">{icons.connections}</span> Connections
          </div>
          <div className={`nav-item ${page === 'settings' ? 'active' : ''}`} onClick={() => onNavigate('settings')}>
            <span className="icon">{icons.settings}</span> Settings
          </div>
        </div>
      </div>

      {/* Announcement box — above node status */}
      {announcement ? (
        <div className="sidebar-announcement">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, opacity: 0.7 }}>
            <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
            <path d="M13.73 21a2 2 0 0 1-3.46 0" />
          </svg>
          <span>{announcement}</span>
        </div>
      ) : null}

      <div className="sidebar-footer">
        <div className="node-status">
          <div className={`node-dot ${nodeOnline ? '' : 'offline'}`}></div>
          <span>{nodeOnline ? 'Local Node Online' : 'Local Node Offline'}</span>
        </div>
        {nodeOnline && (
          <>
            <div className="node-stats">
              {nodeStats.filesShared} files · {nodeStats.storageUsed}
            </div>
            <div className="coverage-bar-container">
              <div className="coverage-bar">
                <div className="coverage-bar-fill" style={{ width: `${coverage}%` }}></div>
              </div>
              <span className="coverage-label">{coverage}% library coverage</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
