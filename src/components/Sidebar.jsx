import React from 'react';
import logo from '../assets/sermon-index-white.png';
import UpdatePrompt from './UpdatePrompt';

// Clean SVG icons (Lucide-inspired, MIT license, single-color flat)
const icons = {
  dashboard: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="9" rx="1" /><rect x="14" y="3" width="7" height="5" rx="1" /><rect x="14" y="12" width="7" height="9" rx="1" /><rect x="3" y="16" width="7" height="5" rx="1" />
    </svg>
  ),
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
  // Every other icon in this column is a 24-unit outline at 1.8px. This one was
  // a SOLID fill on a 256 viewBox, so at 18px it rendered as a pale block among
  // delicate line drawings — the one heavy mark in the whole sidebar, and the
  // first thing your eye landed on for no reason. Redrawn in the column's own
  // language: a board, a chip, its pins, and a signal leaving it.
  seed: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="5" width="14" height="14" rx="2.5" />
      <rect x="8" y="10" width="4" height="4" rx="1" />
      <path d="M10 5V3.5M7 19v1.5M13 19v1.5" />
      <path d="M3 9H1.5M3 15H1.5" />
      <path d="M19.5 9.5a4.5 4.5 0 0 1 0 5M21.8 7.5a8 8 0 0 1 0 9" />
    </svg>
  ),
  seedLocked: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  ),
  stats: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="20" x2="18" y2="10" /><line x1="12" y1="20" x2="12" y2="4" /><line x1="6" y1="20" x2="6" y2="14" />
    </svg>
  ),
  chat: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
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
  about: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" /><line x1="12" y1="16" x2="12" y2="12" /><line x1="12" y1="8" x2="12.01" y2="8" />
    </svg>
  ),
};

// The whole navigation, in one place. Keys match the accelerators registered
// by the native View menu (src-tauri/src/appmenu.rs) — if you add a
// destination, add it in both or the shortcut silently does nothing.
const NAV = [
  { items: [
    { id: 'dashboard', label: 'Dashboard', icon: 'dashboard', key: '1' },
  ] },
  { label: 'Library', items: [
    { id: 'library', label: 'Browse Sermons', icon: 'library', key: '2' },
    { id: 'bulk-download', label: 'Bulk Download', icon: 'bulkDownload' },
    { id: 'downloads', label: 'My Downloads', icon: 'downloads', key: '3' },
  ] },
  { label: 'Network', items: [
    { id: 'network', label: 'Node Map', icon: 'globe', key: '4' },
    { id: 'seed', label: 'Seed Node', icon: 'seed', key: '5' },
    { id: 'stats', label: 'Your Stats', icon: 'stats', key: '6' },
    { id: 'community', label: 'Community', icon: 'chat' },
  ] },
  { label: 'App', items: [
    { id: 'connections', label: 'Connections', icon: 'connections', key: '7' },
    { id: 'settings', label: 'Settings', icon: 'settings' },
    { id: 'about', label: 'About', icon: 'about' },
  ] },
];

// Show the symbol the person's own keyboard has. A Windows user shown ⌘ learns
// nothing; a Mac user shown "Ctrl" is told something untrue.
const MOD = (() => {
  try {
    return /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent) ? '\u2318' : 'Ctrl+';
  } catch { return 'Ctrl+'; }
})();

export default function Sidebar({ page, onNavigate, nodeOnline, nodeStats, seedUnlocked, libraryStats, announcement, unreadChat = 0, chatShow = true, nodesOnline = null, seedsOnline = null, version = '' }) {
  const coverage = libraryStats ? libraryStats.coverage : 0;

  return (
    <div className="sidebar">
      <div className="sidebar-header">
        <div className="sidebar-logo" aria-label="SermonIndex">
          {/* Official site wordmark — white PNG on the olive sidebar matches the site header */}
          <img src={logo} alt="SermonIndex" style={{ height: 34 }} />
        </div>
        <div className="subtitle">
          Node Software
          {version && <span className="app-version">v{version}</span>}
        </div>
      </div>

      {/* ── Navigation ──────────────────────────────────────────────────────
          Data-driven rather than twenty hand-written blocks. The old version
          repeated the same nine lines per destination, which is why the count
          pills and the badge had drifted into three different treatments.

          Two upgrades beyond tidiness:

          BUTTONS, not divs. Every row was a <div onClick>, so none of them
          could be reached with a Tab key, none announced itself to a screen
          reader as clickable, and none could show a focus ring. A sidebar is
          the primary navigation of the app; it should not require a mouse.

          SHORTCUT HINTS. The menu bar added Cmd/Ctrl+1–7 in this release, and
          a shortcut nobody can discover may as well not exist. They appear on
          hover and on focus only, so the resting state stays quiet. */}
      <nav className="sidebar-nav" aria-label="Main">
        {NAV.map((section) => (
          <div className="nav-section" key={section.label || 'top'}>
            {section.label && <div className="nav-section-label">{section.label}</div>}
            {section.items.map((it) => {
              if (it.id === 'community' && !chatShow) return null;
              const count =
                it.id === 'network' ? nodesOnline :
                it.id === 'seed' ? seedsOnline : null;
              const badge = it.id === 'community' && unreadChat > 0
                ? (unreadChat > 99 ? '99+' : String(unreadChat))
                : null;
              return (
                <button
                  type="button"
                  key={it.id}
                  className={`nav-item ${page === it.id ? 'active' : ''}`}
                  aria-current={page === it.id ? 'page' : undefined}
                  onClick={() => onNavigate(it.id)}
                >
                  <span className="icon">{icons[it.icon]}</span>
                  <span className="nav-label">{it.label}</span>
                  {count !== null && count !== undefined && (
                    <span className="nav-count" title={`${count} online`}>{count}</span>
                  )}
                  {badge && <span className="nav-badge">{badge}</span>}
                  {it.key && <kbd className="nav-kbd">{MOD}{it.key}</kbd>}
                </button>
              );
            })}
          </div>
        ))}
      </nav>

      {/* In-app update alert — inline, directly above the scripture/announcement
          + "Local Node Online" status box. Self-gating: renders nothing unless
          updater.js has fired 'si-update-available' (and it isn't snoozed). */}
      <UpdatePrompt inline />

      {/* The announcement/verse moved to the header in 0.0.334 — see
          TopBar.jsx. It was the last element in the column, below the node
          stats, which is the lowest-priority position in the window for the
          one line in the app that is not about software. `announcement` is
          still accepted as a prop so App.jsx needs no change and so a future
          sidebar notice has somewhere to go. */}

      {/* Footer — what this node is actually holding. The online/offline status
          line that used to sit above these figures has been removed on purpose:
          the badge at the top right already states the node's state (Offline /
          Peer / Node / Seed node) in the map's colours and is the single source
          of truth. The whole footer drops out when the node is offline, so
          nothing is left behind but an empty bordered strip. */}
      {nodeOnline && (
        <div className="sidebar-footer">
          <div className="node-stats">
            {nodeStats.filesShared} files · {nodeStats.storageUsed}
          </div>
          <div className="coverage-bar-container">
            <div className="coverage-bar">
              <div className="coverage-bar-fill" style={{ width: `${coverage}%` }}></div>
            </div>
            <span className="coverage-label">{coverage}% library coverage</span>
          </div>
        </div>
      )}
    </div>
  );
}
