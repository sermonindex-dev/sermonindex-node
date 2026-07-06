import React, { useState, useEffect, useRef, useCallback } from 'react';

// Tiny "Copied!" tooltip state hook
function useCopiedTooltip(timeout = 1500) {
  const [show, setShow] = useState(false);
  const fire = useCallback(() => { setShow(true); setTimeout(() => setShow(false), timeout); }, [timeout]);
  return [show, fire];
}

/**
 * ConnectionsPanel — Real-time P2P (BitTorrent) connectivity dashboard
 *
 * Two-column layout on wide screens:
 * LEFT:  Network Health, Connection Layers, Active Torrents
 * RIGHT: Live Logs (newest at bottom, auto-scroll), Actions
 *
 * Bottom of left column aligns with bottom of right column.
 */

// Connection layers — what the native BitTorrent node provides
const LAYERS = [
  {
    id: 'tcp',
    label: 'TCP Listener',
    desc: 'Incoming peer connections — other clients connect to you over TCP',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M5 12h14" /><path d="M12 5l7 7-7 7" />
      </svg>
    ),
  },
  {
    id: 'dht',
    label: 'Mainline DHT',
    desc: 'Trackerless peer discovery — millions of nodes, no central servers',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10" /><line x1="2" y1="12" x2="22" y2="12" /><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
      </svg>
    ),
  },
  {
    id: 'trackers',
    label: 'Public Trackers',
    desc: 'Second peer-discovery mechanism — announces your torrents to trackers',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M5 12.55a11 11 0 0 1 14.08 0" /><path d="M1.42 9a16 16 0 0 1 21.16 0" /><path d="M8.53 16.11a6 6 0 0 1 6.95 0" /><line x1="12" y1="20" x2="12.01" y2="20" />
      </svg>
    ),
  },
  {
    id: 'upnp',
    label: 'UPnP Port Forwarding',
    desc: 'Automatic router port mapping — makes you reachable from the internet',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="2" y="6" width="20" height="12" rx="2" /><path d="M12 12h.01" /><path d="M17 12h.01" /><path d="M7 12h.01" />
      </svg>
    ),
  },
  {
    id: 'swarm',
    label: 'Peer Swarm',
    desc: 'Live peer connections across all your torrents',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" />
      </svg>
    ),
  },
  {
    id: 'seeding',
    label: 'Seeding',
    desc: 'Fully-downloaded sermons being shared back to the network',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" />
      </svg>
    ),
  },
];

const STATUS_COLORS = {
  connected: 'var(--green)',
  connecting: 'var(--gold-text)',
  disconnected: 'var(--text-muted)',
  error: 'var(--red)',
  listening: 'var(--green)',
  active: 'var(--green)',
  enabled: 'var(--green)',
  inactive: 'var(--text-muted)',
  idle: 'var(--text-muted)',
};

const STATUS_LABELS = {
  connected: 'Connected',
  connecting: 'Connecting...',
  disconnected: 'Disconnected',
  error: 'Error',
  listening: 'Listening',
  active: 'Active',
  enabled: 'Enabled',
  inactive: 'Inactive',
  idle: 'Idle',
};

// Max log entries to keep in memory
const MAX_LOG_ENTRIES = 150;

const OFFLINE_LAYERS = {
  tcp: 'disconnected', dht: 'disconnected', trackers: 'inactive',
  upnp: 'inactive', swarm: 'disconnected', seeding: 'inactive',
};

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

export default function ConnectionsPanel({ p2pRunning, onP2pToggle, p2pEnabled }) {
  const [status, setStatus] = useState(null);        // { running, tcp_listen_port, uptime_secs, torrent_count }
  const [torrents, setTorrents] = useState([]);      // [{ id, info_hash, name, stats }]
  const [layerStatus, setLayerStatus] = useState(OFFLINE_LAYERS);
  const [connectionLog, setConnectionLog] = useState([]);
  const [isReconnecting, setIsReconnecting] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [copiedShow, fireCopied] = useCopiedTooltip();
  const pollRef = useRef(null);
  const torrentModRef = useRef(null);
  const logEndRef = useRef(null);
  const logContainerRef = useRef(null);
  const lastLogTimeRef = useRef(0);

  // Log helper — newest entries appended at END (bottom), capped
  const addLog = useCallback((msg, type = 'info') => {
    const entry = { time: new Date().toLocaleTimeString(), msg, type };
    setConnectionLog(prev => [...prev, entry].slice(-MAX_LOG_ENTRIES));
  }, []);

  // Auto-scroll to bottom when new logs arrive — scroll the LOG CONTAINER only, not the page
  useEffect(() => {
    if (autoScroll && logContainerRef.current) {
      const el = logContainerRef.current;
      el.scrollTop = el.scrollHeight;
    }
  }, [connectionLog, autoScroll]);

  // Detect if user scrolled away from bottom → pause auto-scroll
  const handleLogScroll = useCallback(() => {
    const el = logContainerRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    setAutoScroll(atBottom);
  }, []);

  // Copy all logs to clipboard
  const handleCopyLogs = useCallback(() => {
    const text = connectionLog.map(e => `${e.time} ${e.msg}`).join('\n');
    navigator.clipboard.writeText(text).then(() => fireCopied()).catch(() => {});
  }, [connectionLog, fireCopied]);

  // Load torrent module
  const getTorrent = useCallback(async () => {
    if (!torrentModRef.current) {
      torrentModRef.current = await import('../services/torrent.js').catch(() => null);
    }
    return torrentModRef.current;
  }, []);

  // Aggregate live peers across all torrents
  const livePeers = torrents.reduce((n, t) => n + (t.stats?.live?.snapshot?.peer_stats?.live || 0), 0);
  const seededCount = torrents.filter(t => t.stats?.finished).length;
  const uploadedTotal = torrents.reduce((n, t) => n + (t.stats?.uploaded_bytes || 0), 0);

  // Determine layer statuses from session status + torrent stats
  const analyzeConnections = useCallback((st, list) => {
    if (!st || !st.running) {
      setLayerStatus(OFFLINE_LAYERS);
      return;
    }
    const peers = list.reduce((n, t) => n + (t.stats?.live?.snapshot?.peer_stats?.live || 0), 0);
    const hasTorrents = list.length > 0;
    const hasSeeds = list.some(t => t.stats?.finished);
    setLayerStatus({
      tcp: st.tcp_listen_port ? 'listening' : 'connecting',
      dht: peers > 0 ? 'connected' : 'connecting',
      trackers: hasTorrents ? 'active' : 'idle',
      upnp: 'enabled', // librqbit requests UPnP mappings automatically while running
      swarm: peers > 0 ? 'connected' : (hasTorrents ? 'connecting' : 'idle'),
      seeding: hasSeeds ? 'active' : 'idle',
    });
  }, []);

  // Poll torrent session status + per-torrent stats
  useEffect(() => {
    if (!p2pRunning) {
      setStatus(null);
      setTorrents([]);
      setLayerStatus(OFFLINE_LAYERS);
      return;
    }

    let prevPeerCount = 0;
    const poll = async () => {
      try {
        const torrent = await getTorrent();
        if (!torrent) return;
        const st = await torrent.getStatus().catch(() => null);
        const list = st?.running ? await torrent.listTorrents().catch(() => []) : [];
        setStatus(st);
        setTorrents(list);
        analyzeConnections(st, list);

        // Ingest new torrent-service log entries into the Live Log
        if (torrent.getLogs) {
          const entries = torrent.getLogs(50).filter(l => l.t > lastLogTimeRef.current);
          for (const l of entries) {
            addLog(l.msg, l.level === 'error' ? 'error' : l.level === 'warn' ? 'warn' : 'info');
            lastLogTimeRef.current = l.t;
          }
        }

        // Auto-log peer count changes
        const peers = list.reduce((n, t) => n + (t.stats?.live?.snapshot?.peer_stats?.live || 0), 0);
        if (peers !== prevPeerCount) {
          addLog(`Live peers: ${prevPeerCount} → ${peers}`, peers > prevPeerCount && peers > 0 ? 'success' : 'warn');
          prevPeerCount = peers;
        }
      } catch (err) {
        console.warn('[Connections] Poll error:', err.message);
      }
    };

    addLog('Polling P2P node status...', 'info');
    poll();
    pollRef.current = setInterval(poll, 4000);
    return () => clearInterval(pollRef.current);
  }, [p2pRunning, getTorrent, analyzeConnections, addLog]);

  // Overall health score — mirrors the TopBar score in App.jsx
  const healthScore = (() => {
    if (!p2pRunning || !status?.running) return 0;
    let score = 20; // session up
    if (status.tcp_listen_port) score += 15;
    if ((status.torrent_count || 0) > 0) score += 15;
    if (seededCount > 0) score += 10;
    if (livePeers >= 1) score += 20;
    if (livePeers >= 5) score += 10;
    if (livePeers >= 10) score += 10;
    return Math.min(100, score);
  })();

  const healthLabel = healthScore >= 80 ? 'Excellent' : healthScore >= 50 ? 'Good' : healthScore >= 20 ? 'Fair' : 'Offline';
  const healthColor = healthScore >= 80 ? 'var(--green)' : healthScore >= 50 ? 'var(--gold-text)' : healthScore >= 20 ? 'var(--orange)' : 'var(--text-muted)';

  // Restart handler
  const handleReconnect = useCallback(async () => {
    setIsReconnecting(true);
    addLog('Restarting P2P session...', 'warn');
    try {
      const torrent = await getTorrent();
      if (torrent) {
        addLog('Stopping session...');
        await torrent.stopSession();
        addLog('Session stopped — waiting for port release...');
        await new Promise(r => setTimeout(r, 2000));
        addLog('Restarting session...');
        const st = await torrent.startSession();
        addLog(`Session restarted (port ${st?.tcp_listen_port ?? '?'}, ${st?.torrent_count ?? 0} torrents)`, 'success');
      }
    } catch (err) {
      addLog(`Restart failed: ${err.message}`, 'error');
      // Try to recover — startSession is idempotent
      try {
        const torrent = await getTorrent();
        if (torrent) {
          await torrent.startSession();
          addLog('Recovered — session is running', 'success');
        }
      } catch (recoveryErr) {
        addLog(`Recovery also failed: ${recoveryErr.message}`, 'error');
      }
    }
    setIsReconnecting(false);
  }, [getTorrent, addLog]);

  // Copy a magnet link for a seeded torrent (from the torrent list)
  const handleCopyMagnets = useCallback(async () => {
    try {
      const lines = torrents
        .filter(t => t.stats?.finished)
        .map(t => `${t.name}\nmagnet:?xt=urn:btih:${t.info_hash}`);
      if (lines.length === 0) {
        addLog('No seeded torrents to copy yet', 'warn');
        return;
      }
      await navigator.clipboard.writeText(lines.join('\n\n'));
      addLog(`Copied ${lines.length} magnet links to clipboard`, 'success');
    } catch (err) {
      addLog(`Copy failed: ${err.message}`, 'error');
    }
  }, [torrents, addLog]);

  // Render — two-column layout with aligned bottoms
  return (
    <div className="connections-layout">
      {/* ── LEFT COLUMN: Health + Layers + Active Torrents ── */}
      <div className="connections-left">
        {/* Health overview */}
        <div className="seed-card">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
            <h3 style={{ margin: 0 }}>Network Health</h3>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <div style={{
                width: 10, height: 10, borderRadius: '50%',
                background: healthColor,
                boxShadow: healthScore > 0 ? `0 0 8px ${healthColor}` : 'none',
              }} />
              <span style={{ color: healthColor, fontWeight: 600, fontSize: '0.85rem' }}>{healthLabel}</span>
            </div>
          </div>

          {/* Health bar */}
          <div style={{
            height: 6, borderRadius: 3,
            background: 'var(--border)',
            overflow: 'hidden',
            marginBottom: '12px',
          }}>
            <div style={{
              height: '100%', borderRadius: 3,
              width: `${healthScore}%`,
              background: `linear-gradient(90deg, ${healthColor}, ${healthColor}dd)`,
              transition: 'width 0.5s ease',
            }} />
          </div>

          {/* Quick stats */}
          <div style={{ display: 'flex', gap: '24px', flexWrap: 'wrap' }}>
            <div>
              <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Live Peers</div>
              <div style={{ fontSize: '1.1rem', fontWeight: 700, color: 'var(--gold-text)' }}>{livePeers}</div>
            </div>
            <div>
              <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Torrents</div>
              <div style={{ fontSize: '1.1rem', fontWeight: 700, color: 'var(--text-primary)' }}>{status?.torrent_count ?? torrents.length}</div>
            </div>
            <div>
              <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Seeding</div>
              <div style={{ fontSize: '1.1rem', fontWeight: 700, color: seededCount > 0 ? 'var(--green)' : 'var(--text-primary)' }}>{seededCount}</div>
            </div>
            <div>
              <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Uptime</div>
              <div style={{ fontSize: '1.1rem', fontWeight: 700, color: 'var(--text-primary)' }}>
                {status?.uptime_secs ? formatUptime(status.uptime_secs) : '—'}
              </div>
            </div>
          </div>

          {/* Native node extras */}
          {status?.running && (
            <div style={{ marginTop: '12px', padding: '10px 12px', background: 'rgba(78, 203, 113, 0.06)', borderRadius: '8px', border: '1px solid rgba(78, 203, 113, 0.15)', overflow: 'hidden' }}>
              <div style={{ fontSize: '0.7rem', color: 'var(--green)', fontWeight: 600, marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                Native BitTorrent Node — DHT + Trackers + UPnP
              </div>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', display: 'flex', flexWrap: 'wrap', gap: '12px' }}>
                <span>Listen port: <strong style={{ color: 'var(--text-primary)' }}>{status.tcp_listen_port || 'binding...'}</strong></span>
                <span>Uploaded: <strong style={{ color: 'var(--text-primary)' }}>{formatBytes(uploadedTotal)}</strong></span>
              </div>
              <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)', marginTop: '6px' }}>
                Seeded sermons are also downloadable with any standard client (qBittorrent, Transmission).
              </div>
            </div>
          )}
        </div>

        {/* Connection layers */}
        <div className="seed-card">
          <h3>Connection Layers</h3>
          <p style={{ marginBottom: '8px', fontSize: '0.78rem', color: 'var(--text-muted)' }}>
            Peer discovery and reachability mechanisms. Each layer works automatically.
          </p>

          {LAYERS.map((layer, i) => {
            const status_ = layerStatus[layer.id];
            const color = STATUS_COLORS[status_] || 'var(--text-muted)';
            const label = STATUS_LABELS[status_] || status_;
            // "Active" = actually carrying traffic or providing a service right now
            const isActive = ['connected', 'listening', 'active', 'enabled'].includes(status_);
            return (
              <div key={layer.id}
                className="settings-row"
                style={{
                  ...(i === LAYERS.length - 1 ? { border: 'none' } : {}),
                  // Highlight active layers with a subtle background
                  ...(isActive ? {
                    background: 'rgba(78, 203, 113, 0.04)',
                    borderRadius: '6px',
                    marginLeft: '-8px',
                    marginRight: '-8px',
                    paddingLeft: '8px',
                    paddingRight: '8px',
                  } : {
                    opacity: 0.55,
                  }),
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flex: 1, minWidth: 0 }}>
                  <div style={{
                    width: 32, height: 32, borderRadius: '8px',
                    background: 'var(--bg-hover)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    flexShrink: 0,
                    color: isActive ? 'var(--text-secondary)' : 'var(--text-muted)',
                  }}>
                    {layer.icon}
                  </div>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 500, fontSize: '0.85rem' }}>{layer.label}</div>
                    <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>{layer.desc}</div>
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
                  <div style={{
                    width: 8, height: 8, borderRadius: '50%',
                    background: color,
                    boxShadow: isActive ? `0 0 6px ${color}` : 'none',
                  }} />
                  <span style={{
                    fontSize: '0.76rem', fontWeight: 500,
                    color: color,
                    minWidth: '90px',
                  }}>
                    {label}
                  </span>
                </div>
              </div>
            );
          })}
        </div>

        {/* Active Torrents */}
        <div className="seed-card">
          <h3>Active Torrents ({torrents.length})</h3>
          {torrents.length > 0 ? (
            <div style={{
              maxHeight: '260px',
              overflowY: 'auto',
              background: 'var(--bg-primary)',
              borderRadius: '8px',
              padding: '8px 12px',
            }}>
              {torrents.map((t, i) => {
                const s = t.stats || {};
                const live = s.live || {};
                const peers = live.snapshot?.peer_stats?.live || 0;
                const pct = s.total_bytes ? Math.min(100, (100 * (s.progress_bytes || 0)) / s.total_bytes) : 0;
                const stateColor = s.state === 'error' ? 'var(--red)' : s.finished ? 'var(--green)' : s.state === 'live' ? 'var(--gold-text)' : 'var(--text-muted)';
                const stateLabel = s.state === 'error' ? 'Error' : s.finished ? 'Seeding' : s.state === 'live' ? 'Downloading' : (s.state || 'initializing');
                return (
                  <div key={t.id ?? i} style={{
                    fontSize: '0.72rem',
                    fontFamily: 'monospace',
                    color: 'var(--text-muted)',
                    lineHeight: 1.8,
                    borderBottom: i < torrents.length - 1 ? '1px solid var(--border)' : 'none',
                    paddingBottom: '6px',
                    marginBottom: '6px',
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 }}>
                      <div style={{
                        width: 6, height: 6, borderRadius: '50%',
                        background: stateColor,
                        flexShrink: 0,
                      }} />
                      <span style={{ color: 'var(--text-secondary)', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                        {t.name || t.info_hash?.slice(0, 16) || `#${t.id}`}
                      </span>
                      <span style={{
                        fontSize: '0.65rem',
                        padding: '1px 6px',
                        borderRadius: '4px',
                        background: s.finished ? 'rgba(78,203,113,0.15)' : 'rgba(212,175,55,0.15)',
                        color: stateColor,
                        flexShrink: 0,
                      }}>
                        {stateLabel}
                      </span>
                    </div>
                    <div style={{ paddingLeft: '12px', color: 'var(--text-muted)', fontSize: '0.68rem' }}>
                      {pct.toFixed(1)}% · ↓ {live.download_speed?.human_readable ?? '-'} · ↑ {live.upload_speed?.human_readable ?? '-'} · {peers} peer{peers === 1 ? '' : 's'}
                      {s.error ? ` · ${String(s.error).slice(0, 60)}` : ''}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', fontStyle: 'italic' }}>
              No torrents yet — download a sermon and it will be seeded here
            </div>
          )}
        </div>
      </div>

      {/* ── RIGHT COLUMN: Logs + Actions ── */}
      <div className="connections-right">
        {/* Live Log — newest at bottom, auto-scrolls */}
        <div className="seed-card" style={{ display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
            <h3 style={{ margin: 0 }}>Live Log</h3>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>
                {connectionLog.length}/{MAX_LOG_ENTRIES}
              </span>
              {connectionLog.length > 0 && (
                <>
                  <span style={{ position: 'relative', display: 'inline-block' }}>
                    <button
                      onClick={handleCopyLogs}
                      style={{
                        fontSize: '0.68rem', color: 'var(--text-muted)', background: 'none',
                        border: '1px solid var(--border)', borderRadius: '4px', padding: '2px 8px',
                        cursor: 'pointer',
                      }}
                      title="Copy all logs to clipboard"
                    >
                      Copy
                    </button>
                    {copiedShow && (
                      <span style={{
                        position: 'absolute', bottom: '110%', left: '50%', transform: 'translateX(-50%)',
                        background: '#2d7ff9', color: '#fff', fontSize: '0.65rem', fontWeight: 600,
                        padding: '3px 10px', borderRadius: '4px', whiteSpace: 'nowrap',
                        pointerEvents: 'none', zIndex: 10,
                        boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
                      }}>
                        Copied!
                      </span>
                    )}
                  </span>
                  <button
                    onClick={() => { setConnectionLog([]); }}
                    style={{
                      fontSize: '0.68rem', color: 'var(--text-muted)', background: 'none',
                      border: '1px solid var(--border)', borderRadius: '4px', padding: '2px 8px',
                      cursor: 'pointer',
                    }}
                  >
                    Clear
                  </button>
                </>
              )}
            </div>
          </div>
          <div
            className="connections-log-container"
            ref={logContainerRef}
            onScroll={handleLogScroll}
          >
            {connectionLog.length === 0 ? (
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', fontStyle: 'italic', padding: '12px' }}>
                Waiting for events...
              </div>
            ) : connectionLog.map((entry, i) => (
              <div key={i} style={{
                fontSize: '0.72rem',
                fontFamily: 'monospace',
                lineHeight: 1.7,
                padding: '1px 0',
                color: entry.type === 'error' ? 'var(--red)' : entry.type === 'success' ? 'var(--green)' : entry.type === 'warn' ? 'var(--orange)' : 'var(--text-muted)',
              }}>
                <span style={{ color: 'var(--border-light)', marginRight: '8px' }}>{entry.time}</span>
                {entry.msg}
              </div>
            ))}
            <div ref={logEndRef} />
          </div>
          {!autoScroll && connectionLog.length > 0 && (
            <button
              onClick={() => {
                setAutoScroll(true);
                if (logContainerRef.current) {
                  logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
                }
              }}
              style={{
                marginTop: '6px', fontSize: '0.7rem', color: 'var(--gold-text)', background: 'rgba(212,175,55,0.08)',
                border: '1px solid rgba(212,175,55,0.2)', borderRadius: '4px', padding: '3px 10px',
                cursor: 'pointer', alignSelf: 'center',
              }}
            >
              Jump to latest
            </button>
          )}
        </div>

        {/* Actions */}
        <div className="seed-card">
          <h3>Actions</h3>

          {/* Restart */}
          <div className="settings-row">
            <div>
              <div style={{ fontWeight: 500, fontSize: '0.85rem' }}>Restart Session</div>
              <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                Restart the BitTorrent session and re-announce all torrents
              </div>
            </div>
            <button
              className="btn btn-outline"
              style={{ fontSize: '0.78rem', padding: '5px 14px', whiteSpace: 'nowrap' }}
              onClick={handleReconnect}
              disabled={isReconnecting || !p2pRunning}
            >
              {isReconnecting ? (
                <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <span className="conn-spinner" />
                  Restarting...
                </span>
              ) : 'Restart'}
            </button>
          </div>

          {/* Copy magnets */}
          <div className="settings-row" style={{ border: 'none' }}>
            <div>
              <div style={{ fontWeight: 500, fontSize: '0.85rem' }}>Copy Magnet Links</div>
              <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                Copy magnets for all seeded sermons — shareable with any torrent client
              </div>
            </div>
            <button
              className="btn btn-outline"
              style={{ fontSize: '0.78rem', padding: '5px 14px', whiteSpace: 'nowrap' }}
              onClick={handleCopyMagnets}
              disabled={!p2pRunning || seededCount === 0}
            >
              Copy Magnets
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function formatUptime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${seconds}s`;
}
