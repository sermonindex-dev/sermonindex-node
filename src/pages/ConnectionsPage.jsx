import React from 'react';
import ConnectionsPanel from '../components/ConnectionsPanel';

export default function ConnectionsPage({ ipfsRunning, ipfsEnabled, onIpfsToggle }) {
  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      overflow: 'hidden',
    }}>
      {/* Fixed header — never scrolls */}
      <div style={{ padding: '24px 24px 0 24px', flexShrink: 0 }}>
        <div className="page-header">
          <h2>Connections</h2>
          <p>Monitor your node's connectivity and NAT traversal layers</p>
        </div>
      </div>
      {/* Scrollable body — only this region scrolls if content overflows */}
      <div style={{ flex: 1, overflow: 'auto', padding: '16px 24px 24px 24px', minHeight: 0 }}>
        <ConnectionsPanel
          ipfsRunning={ipfsRunning}
          ipfsEnabled={ipfsEnabled}
          onIpfsToggle={onIpfsToggle}
        />
      </div>
    </div>
  );
}
