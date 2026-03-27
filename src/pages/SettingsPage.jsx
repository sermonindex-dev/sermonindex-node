import React, { useState, useEffect } from 'react';
import { saveSettings, loadSettings } from '../services/tauriStore.js';

export default function SettingsPage({
  contentMode,
  onModeChange,
  nodeOnline,
  onNodeToggle,
  ipfsEnabled,
  ipfsRunning,
  onIpfsToggle,
  bandwidthLimit,
  onBandwidthChange,
  storageLimit,
  onStorageLimitChange,
  backgroundMode,
  onBackgroundModeChange,
  nodeStats,
}) {
  const [peerId, setPeerId] = useState('');
  const [announceAddress, setAnnounceAddress] = useState('');
  const [announceStatus, setAnnounceStatus] = useState(''); // 'saved', 'error', ''
  const [showAdvanced, setShowAdvanced] = useState(false);

  // Load announce address from persisted settings
  useEffect(() => {
    loadSettings().then(settings => {
      if (settings?.announceAddress) {
        setAnnounceAddress(settings.announceAddress);
        setShowAdvanced(true);
      }
    }).catch(() => {});
  }, []);

  const handleSaveAnnounce = async () => {
    try {
      const existing = await loadSettings().catch(() => ({})) || {};
      await saveSettings({ ...existing, announceAddress: announceAddress.trim() });
      setAnnounceStatus('saved');
      setTimeout(() => setAnnounceStatus(''), 3000);
    } catch {
      setAnnounceStatus('error');
    }
  };

  // Fetch peer ID from IPFS diagnostics
  useEffect(() => {
    if (!ipfsRunning) { setPeerId(''); return; }
    let cancelled = false;
    const fetchPeerId = async () => {
      try {
        const ipfs = await import('../services/ipfs.js').catch(() => null);
        if (ipfs && ipfs.getDiagnostics && !cancelled) {
          const diag = await ipfs.getDiagnostics();
          if (!cancelled && diag?.peerId) setPeerId(diag.peerId);
        }
      } catch {}
    };
    fetchPeerId();
    return () => { cancelled = true; };
  }, [ipfsRunning]);

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
      desc: 'Download from Archive.org (free), Bunny CDN as fallback, IPFS peers as last resort',
    },
    {
      key: 'ipfs-primary',
      label: 'IPFS Primary',
      desc: 'Download from peers first, Archive.org and CDN as fallback',
    },
    {
      key: 'ipfs-only',
      label: 'IPFS Only',
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
                <div style={{ fontWeight: 500 }}>IPFS Node</div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                  {ipfsRunning
                    ? <span style={{ color: '#4caf50' }}>Running — sharing sermons with the peer network</span>
                    : ipfsEnabled
                      ? 'Starting up...'
                      : 'Disabled — sermons will only download from CDN'}
                </div>
              </div>
              <div
                className={`toggle ${ipfsEnabled ? 'on' : ''}`}
                onClick={() => onIpfsToggle(!ipfsEnabled)}
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
            <div
              onClick={() => setShowAdvanced(!showAdvanced)}
              style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
            >
              <h3 style={{ margin: 0 }}>Advanced Networking</h3>
              <span style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>
                {showAdvanced ? '▾' : '▸'}
              </span>
            </div>

            {showAdvanced && (
              <div style={{ marginTop: '14px' }}>
                <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginBottom: '12px' }}>
                  Your node listens on port <strong>4001</strong> (TCP &amp; QUIC). If UPnP doesn't work
                  on your router, you can manually port-forward 4001 and enter your public IP below.
                  This tells the network how to reach you directly — like opening a port for a game server.
                </p>

                <div className="settings-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: '8px', border: 'none' }}>
                  <div style={{ fontWeight: 500, fontSize: '0.82rem' }}>External Address Override</div>
                  <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginBottom: '4px' }}>
                    Format: <code style={{ background: 'var(--bg-primary)', padding: '2px 6px', borderRadius: '4px' }}>/ip4/YOUR_PUBLIC_IP/tcp/4001</code>
                  </div>
                  <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                    <input
                      type="text"
                      value={announceAddress}
                      onChange={e => setAnnounceAddress(e.target.value)}
                      placeholder="/ip4/203.0.113.5/tcp/4001"
                      style={{
                        flex: 1,
                        background: 'var(--bg-primary)',
                        border: '1px solid var(--border)',
                        color: 'var(--text-primary)',
                        padding: '8px 12px',
                        borderRadius: '6px',
                        fontSize: '0.82rem',
                        fontFamily: 'monospace',
                      }}
                    />
                    <button
                      onClick={handleSaveAnnounce}
                      style={{
                        background: 'var(--gold)',
                        color: '#1a1a2e',
                        border: 'none',
                        borderRadius: '6px',
                        padding: '8px 16px',
                        fontSize: '0.8rem',
                        fontWeight: 600,
                        cursor: 'pointer',
                        flexShrink: 0,
                      }}
                    >
                      Save
                    </button>
                  </div>
                  {announceStatus === 'saved' && (
                    <div style={{ fontSize: '0.75rem', color: '#4caf50' }}>
                      Saved — restart the IPFS node (toggle off/on above) to apply.
                    </div>
                  )}
                  {announceStatus === 'error' && (
                    <div style={{ fontSize: '0.75rem', color: '#ef5350' }}>
                      Failed to save settings.
                    </div>
                  )}
                  <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: '4px' }}>
                    To find your public IP, visit <a href="https://whatismyip.com" target="_blank" rel="noreferrer" style={{ color: 'var(--text-secondary)' }}>whatismyip.com</a>.
                    Leave empty to use automatic NAT traversal (UPnP, relay, hole punching).
                  </div>
                </div>
              </div>
            )}
          </div>

          <div className="seed-card">
            <h3>Content Source</h3>
            <p style={{ marginBottom: '8px' }}>
              Controls where the app fetches sermon content from. As the peer network grows stronger,
              this will automatically shift toward full decentralization.
            </p>
            <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginBottom: '16px' }}>
              This setting is managed by the SermonIndex network and will update automatically as more
              peers come online. You don't need to change this — the network optimizes itself over time.
            </p>

            <div className="content-source-visual">
              {modes.map((mode, i) => (
                <div
                  key={mode.key}
                  className={`settings-row ${contentMode === mode.key ? 'active-mode' : ''}`}
                  style={i === modes.length - 1 ? { border: 'none' } : {}}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <div style={{
                      width: 14, height: 14, borderRadius: '50%',
                      border: `2px solid ${contentMode === mode.key ? 'var(--gold)' : 'var(--border-light)'}`,
                      background: contentMode === mode.key ? 'var(--gold)' : 'transparent',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      flexShrink: 0,
                    }}>
                      {contentMode === mode.key && (
                        <div style={{ width: 6, height: 6, borderRadius: '50%', background: '#fff' }} />
                      )}
                    </div>
                    <div>
                      <div style={{ fontWeight: 500 }}>{mode.label}</div>
                      <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{mode.desc}</div>
                    </div>
                  </div>
                  {contentMode === mode.key && <span className="mode-badge cdn">Active</span>}
                </div>
              ))}
            </div>
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
              <span>{contentMode === 'cdn' ? 'Archive.org + CDN' : contentMode === 'ipfs-primary' ? 'IPFS Primary' : 'IPFS Only'}</span>
            </div>
            <div className="settings-row">
              <span style={{ color: 'var(--text-muted)' }}>IPFS Status</span>
              <span style={{ color: ipfsRunning ? '#4caf50' : 'var(--text-muted)' }}>
                {ipfsRunning ? 'Running' : ipfsEnabled ? 'Starting...' : 'Disabled'}
              </span>
            </div>
            {peerId && (
              <div className="settings-row" style={{ border: 'none', flexDirection: 'column', alignItems: 'flex-start', gap: '6px' }}>
                <span style={{ color: 'var(--text-muted)', fontSize: '0.82rem' }}>IPFS Peer ID</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', width: '100%' }}>
                  <code style={{
                    fontSize: '0.72rem', fontFamily: 'monospace', color: 'var(--text-secondary)',
                    background: 'var(--bg-primary)', padding: '6px 10px', borderRadius: '6px',
                    border: '1px solid var(--border)', flex: 1, wordBreak: 'break-all',
                    overflowWrap: 'anywhere', userSelect: 'all',
                  }}>
                    {peerId}
                  </code>
                  <button
                    onClick={() => navigator.clipboard.writeText(peerId).catch(() => {})}
                    style={{
                      fontSize: '0.7rem', color: 'var(--text-muted)', background: 'none',
                      border: '1px solid var(--border)', borderRadius: '4px', padding: '4px 10px',
                      cursor: 'pointer', flexShrink: 0,
                    }}
                    title="Copy Peer ID"
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
              Your node uses 9 connectivity layers for maximum reachability:
            </p>
            <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', lineHeight: 1.8 }}>
              <div>1. TCP — primary gateway-reachable transport</div>
              <div>2. QUIC — fast multiplexed UDP transport</div>
              <div>3. WebSocket — HTTP proxy traversal</div>
              <div>4. UPnP — automatic router port forwarding</div>
              <div>5. Circuit Relay — NAT fallback via relay nodes</div>
              <div>6. DCUtR Hole Punch — upgrade relay to direct</div>
              <div>7. Kademlia DHT — content routing (server mode)</div>
              <div>8. mDNS — zero-config LAN discovery</div>
              <div>9. Rendezvous — SermonIndex peer registry</div>
            </div>
            <p style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: '12px' }}>
              See the Connections page for live status of each layer.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
