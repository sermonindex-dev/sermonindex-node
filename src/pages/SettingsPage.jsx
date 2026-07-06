import React, { useState, useEffect } from 'react';
import { getNodeId } from '../services/heartbeat.js';

export default function SettingsPage({
  contentMode,
  onModeChange,
  nodeOnline,
  onNodeToggle,
  p2pEnabled,
  p2pRunning,
  onP2pToggle,
  bandwidthLimit,
  onBandwidthChange,
  storageLimit,
  onStorageLimitChange,
  backgroundMode,
  onBackgroundModeChange,
  nodeStats,
}) {
  const [nodeId, setNodeId] = useState('');
  const [modeStatus, setModeStatus] = useState(''); // 'saved', ''

  // Show the persistent node ID (generated locally, survives restarts)
  useEffect(() => {
    try { setNodeId(getNodeId()); } catch {}
  }, []);

  const selectStyle = {
    background: 'var(--bg-tertiary)',
    border: '1px solid var(--border)',
    color: 'var(--text-primary)',
    padding: '6px 10px',
    borderRadius: '6px',
    fontSize: '0.82rem',
    fontFamily: 'var(--font)',
  };

  const modes = [
    {
      key: 'cdn',
      label: 'Archive.org + CDN',
      desc: 'Download from Archive.org (free), Bunny CDN as fallback — files are seeded to the peer swarm after download',
    },
    {
      key: 'p2p-primary',
      label: 'P2P Primary',
      desc: 'Download from the peer swarm first, Archive.org and CDN as fallback',
    },
    {
      key: 'p2p-only',
      label: 'P2P Only',
      desc: 'Fully decentralized — peer network only, no CDN dependency',
    },
  ];

  return (
    <div className="settings-page-root">
      <div className="seed-section" style={{ marginBottom: 0 }}>
        <div className="page-header">
          <h2>Settings</h2>
          <p>Configure your node and app preferences</p>
        </div>
      </div>

      {/* Two-column layout: Settings left, Stats + About right */}
      <div className="connections-layout">
        {/* ── LEFT: Settings ── */}
        <div className="connections-left">
          <div className="seed-card">
            <h3>Peer-to-Peer Network</h3>
            <p style={{ marginBottom: '16px' }}>
              SermonIndex is a peer-to-peer sermon library. When you download sermons, your computer
              helps share them with other believers around the world. The more people who run this app,
              the faster and more resilient the network becomes.
            </p>

            <div className="settings-row">
              <div>
                <div style={{ fontWeight: 500 }}>P2P Node (BitTorrent)</div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                  {p2pRunning
                    ? <span style={{ color: '#4caf50' }}>Running — sharing sermons with the peer network</span>
                    : p2pEnabled
                      ? 'Starting up...'
                      : 'Disabled — sermons will only download from CDN'}
                </div>
              </div>
              <div
                className={`toggle ${p2pEnabled ? 'on' : ''}`}
                onClick={() => onP2pToggle(!p2pEnabled)}
              ></div>
            </div>

            <div className="settings-row">
              <div>
                <div style={{ fontWeight: 500 }}>Background Seeding</div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                  Keep sharing sermons when the window is closed
                </div>
              </div>
              <div
                className={`toggle ${backgroundMode ? 'on' : ''}`}
                onClick={() => onBackgroundModeChange(!backgroundMode)}
              ></div>
            </div>

            <div className="settings-row">
              <div>
                <div style={{ fontWeight: 500 }}>Storage Limit</div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                  Maximum disk space for cached sermons:{' '}
                  <strong style={{ color: 'var(--gold)' }}>
                    {storageLimit === 0 ? 'Unlimited' : `${storageLimit} GB`}
                  </strong>
                </div>
              </div>
              <select
                value={storageLimit}
                onChange={e => onStorageLimitChange(parseInt(e.target.value))}
                style={selectStyle}
              >
                <option value={0}>Unlimited</option>
                <option value={5}>5 GB</option>
                <option value={10}>10 GB</option>
                <option value={20}>20 GB</option>
                <option value={50}>50 GB</option>
                <option value={100}>100 GB</option>
                <option value={500}>500 GB</option>
              </select>
            </div>

            <div className="settings-row" style={{ border: 'none' }}>
              <div>
                <div style={{ fontWeight: 500 }}>Upload Bandwidth Limit</div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                  Limit how much bandwidth is used for sharing:{' '}
                  <strong style={{ color: 'var(--gold)' }}>
                    {bandwidthLimit === 0 ? 'Unlimited' : bandwidthLimit < 1 ? `${bandwidthLimit * 1000} Kbps` : `${bandwidthLimit} Mbps`}
                  </strong>
                </div>
              </div>
              <select
                value={bandwidthLimit}
                onChange={e => onBandwidthChange(parseFloat(e.target.value))}
                style={selectStyle}
              >
                <option value={0.1}>100 Kbps</option>
                <option value={0.25}>250 Kbps</option>
                <option value={0.5}>500 Kbps</option>
                <option value={1}>1 Mbps</option>
                <option value={5}>5 Mbps</option>
                <option value={10}>10 Mbps</option>
                <option value={25}>25 Mbps</option>
                <option value={50}>50 Mbps</option>
                <option value={0}>Unlimited</option>
              </select>
            </div>
          </div>

          <div className="seed-card">
            <h3>Content Source</h3>
            <p style={{ marginBottom: '8px' }}>
              Controls where the app fetches sermon content from. Click to switch modes.
            </p>
            <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginBottom: '16px' }}>
              The network will suggest optimal settings via heartbeat, but you can override manually.
            </p>

            <div className="content-source-visual">
              {modes.map((mode, i) => {
                const isActive = contentMode === mode.key;
                return (
                  <div
                    key={mode.key}
                    className={`settings-row ${isActive ? 'active-mode' : ''}`}
                    style={{
                      ...(i === modes.length - 1 ? { border: 'none' } : {}),
                      cursor: 'pointer',
                      transition: 'background 0.15s',
                    }}
                    onClick={() => {
                      if (!isActive) {
                        onModeChange(mode.key);
                        setModeStatus('saved');
                        setTimeout(() => setModeStatus(''), 2500);
                      }
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                      <div style={{
                        width: 14, height: 14, borderRadius: '50%',
                        border: `2px solid ${isActive ? 'var(--gold)' : 'var(--border-light)'}`,
                        background: isActive ? 'var(--gold)' : 'transparent',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        flexShrink: 0,
                        transition: 'all 0.15s',
                      }}>
                        {isActive && (
                          <div style={{ width: 6, height: 6, borderRadius: '50%', background: '#fff' }} />
                        )}
                      </div>
                      <div>
                        <div style={{ fontWeight: 500 }}>{mode.label}</div>
                        <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{mode.desc}</div>
                      </div>
                    </div>
                    {isActive && <span className="mode-badge cdn">Active</span>}
                  </div>
                );
              })}
            </div>
            {modeStatus === 'saved' && (
              <div style={{ fontSize: '0.75rem', color: '#4caf50', marginTop: '8px', transition: 'opacity 0.3s' }}>
                Mode updated successfully
              </div>
            )}
          </div>
        </div>

        {/* ── RIGHT: Node Statistics + About ── */}
        <div className="connections-right">
          <div className="seed-card">
            <h3>Node Statistics</h3>
            <div className="settings-row">
              <span style={{ color: 'var(--text-muted)' }}>Peers Connected</span>
              <span style={{ color: 'var(--gold)', fontWeight: 600 }}>{nodeStats.peersConnected}</span>
            </div>
            <div className="settings-row">
              <span style={{ color: 'var(--text-muted)' }}>Files Shared</span>
              <span>{nodeStats.filesShared}</span>
            </div>
            <div className="settings-row" style={{ border: 'none' }}>
              <span style={{ color: 'var(--text-muted)' }}>Storage Used</span>
              <span>{nodeStats.storageUsed}</span>
            </div>
          </div>

          <div className="seed-card">
            <h3>About</h3>
            <div className="settings-row">
              <span style={{ color: 'var(--text-muted)' }}>Version</span>
              <span>1.0.0</span>
            </div>
            <div className="settings-row">
              <span style={{ color: 'var(--text-muted)' }}>Content Source Mode</span>
              <span>{contentMode === 'cdn' ? 'Archive.org + CDN' : contentMode === 'p2p-primary' ? 'P2P Primary' : 'P2P Only'}</span>
            </div>
            <div className="settings-row">
              <span style={{ color: 'var(--text-muted)' }}>P2P Status</span>
              <span style={{ color: p2pRunning ? '#4caf50' : 'var(--text-muted)' }}>
                {p2pRunning ? 'Running' : p2pEnabled ? 'Starting...' : 'Disabled'}
              </span>
            </div>
            {nodeId && (
              <div className="settings-row" style={{ border: 'none', flexDirection: 'column', alignItems: 'flex-start', gap: '6px' }}>
                <span style={{ color: 'var(--text-muted)', fontSize: '0.82rem' }}>Node ID</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', width: '100%' }}>
                  <code style={{
                    fontSize: '0.72rem', fontFamily: 'monospace', color: 'var(--text-secondary)',
                    background: 'var(--bg-primary)', padding: '6px 10px', borderRadius: '6px',
                    border: '1px solid var(--border)', flex: 1, wordBreak: 'break-all',
                    overflowWrap: 'anywhere', userSelect: 'all',
                  }}>
                    {nodeId}
                  </code>
                  <button
                    onClick={() => navigator.clipboard.writeText(nodeId).catch(() => {})}
                    style={{
                      fontSize: '0.7rem', color: 'var(--text-muted)', background: 'none',
                      border: '1px solid var(--border)', borderRadius: '4px', padding: '4px 10px',
                      cursor: 'pointer', flexShrink: 0,
                    }}
                    title="Copy Node ID"
                  >
                    Copy
                  </button>
                </div>
              </div>
            )}
          </div>

          <div className="seed-card" style={{ background: 'rgba(212,175,55,0.04)', border: '1px solid rgba(212,175,55,0.15)' }}>
            <h3 style={{ color: 'var(--gold)' }}>Network Layers</h3>
            <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginBottom: '12px' }}>
              Your node uses standard BitTorrent connectivity for maximum reachability:
            </p>
            <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', lineHeight: 1.8 }}>
              <div>1. TCP — direct peer connections</div>
              <div>2. Mainline DHT — trackerless peer discovery (millions of nodes)</div>
              <div>3. Public Trackers — secondary peer discovery</div>
              <div>4. UPnP — automatic router port forwarding</div>
            </div>
            <p style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: '12px' }}>
              See the Connections page for live status of each layer. Seeded sermons can also
              be shared with any standard torrent client.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
