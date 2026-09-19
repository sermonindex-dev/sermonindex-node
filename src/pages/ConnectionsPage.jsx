import React from 'react';
import ConnectionsPanel from '../components/ConnectionsPanel';
import PageHead from '../components/PageHead.jsx';

// The masthead's artwork: a signal fanning out from a node. Drawn rather than
// iconified because it bleeds off the right edge behind a mask, and an icon
// scaled to 400px is just a blurry icon.
const connectionsArt = (
  <svg viewBox="0 0 400 220" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
    <defs>
      <radialGradient id="siConnGlow" cx="0.5" cy="0.5" r="0.5">
        <stop offset="0" stopColor="#d4af37" stopOpacity="0.40" />
        <stop offset="1" stopColor="#d4af37" stopOpacity="0" />
      </radialGradient>
    </defs>
    <g stroke="#d4af37" strokeOpacity="0.26" strokeWidth="1.3" fill="none">
      <line x1="120" y1="110" x2="210" y2="52" /><line x1="120" y1="110" x2="232" y2="128" />
      <line x1="120" y1="110" x2="196" y2="178" /><line x1="210" y1="52" x2="310" y2="74" />
      <line x1="232" y1="128" x2="322" y2="160" /><line x1="232" y1="128" x2="310" y2="74" />
      <line x1="196" y1="178" x2="292" y2="196" />
    </g>
    {/* Concentric rings: the node announcing itself outward. */}
    <g fill="none" stroke="#f3efe0" strokeOpacity="0.14">
      <circle cx="120" cy="110" r="42" /><circle cx="120" cy="110" r="70" /><circle cx="120" cy="110" r="98" />
    </g>
    <circle cx="120" cy="110" r="34" fill="url(#siConnGlow)" />
    <g fill="#f3efe0" fillOpacity="0.72">
      <circle cx="210" cy="52" r="4" /><circle cx="322" cy="160" r="3.5" />
      <circle cx="196" cy="178" r="4" /><circle cx="292" cy="196" r="3" />
    </g>
    <g fill="#d4af37">
      <circle cx="120" cy="110" r="7" /><circle cx="232" cy="128" r="5" /><circle cx="310" cy="74" r="5" />
    </g>
  </svg>
);

export default function ConnectionsPage({ p2pRunning, p2pEnabled, onP2pToggle }) {
  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      overflow: 'hidden',
    }}>
      {/* Fixed header — never scrolls */}
      <div style={{ padding: '24px 24px 0 24px', flexShrink: 0 }}>
        {/* page-header-wide matches .connections-layout's 1100px max-width and
            centring, so the masthead lines up with the columns below it. */}
        <div className="page-header-wide">
          <PageHead
            kicker="Network"
            title="Connections"
            sub="Your node's BitTorrent connectivity and the swarms it is part of, live."
            art={connectionsArt}
            aside={
              <span className={`brand-chip ${p2pRunning ? 'ok' : ''}`}>
                <i className="dot" />{p2pRunning ? 'Running' : 'Stopped'}
              </span>
            }
          />
        </div>
      </div>
      {/* Scrollable body — only this region scrolls if content overflows */}
      <div style={{ flex: 1, overflow: 'auto', padding: '0 24px 24px 24px', minHeight: 0 }}>
        <ConnectionsPanel
          p2pRunning={p2pRunning}
          p2pEnabled={p2pEnabled}
          onP2pToggle={onP2pToggle}
        />
      </div>
    </div>
  );
}
