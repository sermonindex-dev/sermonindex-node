import React, { useState, useEffect, useRef, useCallback } from 'react';
import { getCatalog } from '../services/catalog.js';
import ReachabilityBanner from './ReachabilityBanner';

// Tiny "Copied!" tooltip state hook
function useCopiedTooltip(timeout = 1500) {
  const [show, setShow] = useState(false);
  const fire = useCallback(() => { setShow(true); setTimeout(() => setShow(false), timeout); }, [timeout]);
  return [show, fire];
}

/**
 * ConnectionsPanel — Real-time P2P (BitTorrent) connectivity dashboard
 *
 * Design principle: tell the truth, simply.
 * Three statuses that matter: Peer discovery, Reachability, Seeding.
 * Regular users never need to configure anything — reachability is a
 * "help the network more" upgrade, not a requirement.
 */

// Same trackers the Rust node announces to (keep in sync with torrent_node.rs)
const TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.demonii.com:1337/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://exodus.desync.com:6969/announce',
];

function buildMagnet(infoHash, name) {
  let m = `magnet:?xt=urn:btih:${infoHash}`;
  if (name) m += `&dn=${encodeURIComponent(name)}`;
  for (const t of TRACKERS) m += `&tr=${encodeURIComponent(t)}`;
  return m;
}

import { probeReachability } from '../services/network.js';
import { TORRENT_PORT_MIN, TORRENT_PORT_RANGE } from '../services/constants.js';

// Max log entries to keep in memory
const MAX_LOG_ENTRIES = 150;

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

const icons = {
  discovery: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" /><line x1="2" y1="12" x2="22" y2="12" /><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
    </svg>
  ),
  reach: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 12h14" /><path d="M12 5l7 7-7 7" />
    </svg>
  ),
  seeding: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" />
    </svg>
  ),
};

export default function ConnectionsPanel({ p2pRunning, onP2pToggle, p2pEnabled }) {
  const [status, setStatus] = useState(null);        // { running, tcp_listen_port, uptime_secs, torrent_count, natpmp }
  const [torrents, setTorrents] = useState([]);      // [{ id, info_hash, name, stats }]
  const [connectionLog, setConnectionLog] = useState([]);
  const [isReconnecting, setIsReconnecting] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [copiedShow, fireCopied] = useCopiedTooltip();
  // Reachability test result: null | {checking:true} | {open:boolean}
  const [reach, setReach] = useState(null);
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

  // Poll torrent session status + per-torrent stats
  useEffect(() => {
    if (!p2pRunning) {
      setStatus(null);
      setTorrents([]);
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

    poll();
    pollRef.current = setInterval(poll, 4000);
    return () => clearInterval(pollRef.current);
  }, [p2pRunning, getTorrent, addLog]);

  // Auto-check reachability once when the panel opens (and after a restart, which
  // resets `reach` to null) so Network Health reflects real internet
  // reachability without needing a manual "Test" click.
  useEffect(() => {
    if (!p2pRunning || !status?.tcp_listen_port || reach) return;
    let cancelled = false;
    (async () => {
      const r = await probeReachability(status.tcp_listen_port);
      if (cancelled || !r) return;
      setReach({ open: r.open });
      try { localStorage.setItem('si-reach', JSON.stringify({ open: r.open, ts: Date.now() })); } catch {}
    })();
    return () => { cancelled = true; };
  }, [p2pRunning, status?.tcp_listen_port, reach]);

  // ─── Honest status derivation ───────────────────────────────────────────

  const natpmp = status?.natpmp || 'inactive';

  // Peer discovery: DHT + trackers are automatic once the session runs.
  const discovery = !status?.running
    ? { label: 'Offline', color: 'var(--text-muted)', on: false }
    : torrents.length === 0
      ? { label: 'Ready — nothing to announce yet', color: 'var(--text-muted)', on: true }
      : livePeers > 0
        ? { label: 'Working — peers found', color: 'var(--green)', on: true }
        : { label: 'Announcing to DHT + trackers', color: 'var(--gold-text)', on: true };

  // Reachability: only claim what we can actually verify.
  const reachability = (() => {
    if (!status?.running) return { key: 'off', label: 'Offline', color: 'var(--text-muted)', on: false };
    if (uploadedTotal > 0) return { key: 'ok', label: 'Working — peers have downloaded from you', color: 'var(--green)', on: true };
    if (reach?.checking) return { key: 'checking', label: 'Testing…', color: 'var(--gold-text)', on: true };
    if (reach?.open === true) return { key: 'ok', label: 'Reachable from the internet ✓', color: 'var(--green)', on: true };
    if (reach?.open === false) return { key: 'closed', label: 'Not reachable from outside', color: 'var(--orange)', on: true };
    if (natpmp.startsWith('mapped')) return { key: 'ok', label: 'Port opened automatically (NAT-PMP)', color: 'var(--green)', on: true };
    if (natpmp === 'trying') return { key: 'unknown', label: 'Trying automatic setup (UPnP / NAT-PMP)…', color: 'var(--gold-text)', on: true };
    return { key: 'unknown', label: 'Unknown — automatic setup not confirmed', color: 'var(--gold-text)', on: true };
  })();

  const seeding = !status?.running
    ? { label: 'Offline', color: 'var(--text-muted)', on: false }
    : seededCount > 0
      ? { label: `Sharing ${seededCount} sermon${seededCount === 1 ? '' : 's'}`, color: 'var(--green)', on: true }
      : { label: 'Nothing to share yet', color: 'var(--text-muted)', on: true };

  // Overall health score — mirrors the TopBar score in App.jsx
  const healthScore = (() => {
    if (!p2pRunning || !status?.running) return 0;
    // Health = how well your node participates on the internet. The key axis is
    // REACHABILITY (can other peers connect to you), not whether you've
    // downloaded anything or your upload speed:
    //   Offline    — session not running
    //   Fair       — running, but not reachable from outside (still works as a
    //                "leaf": you download and upload OUT to reachable peers)
    //   Good       — reachable from the internet (peers can connect to you)
    //   Excellent  — reachable AND actively serving (a peer connected / bytes uploaded)
    const reachable = reach?.open === true;
    const closed = reach?.open === false;
    const serving = livePeers >= 1 || uploadedTotal > 0;
    if (reachable && serving) return 100;   // Excellent
    if (reachable) return 75;               // Good — backbone-ready
    if (serving) return 60;                 // Good — serving out even if reachability unconfirmed
    if (closed) return 35;                  // Fair — works, but not reachable (leaf)
    return 45;                              // Fair — running, reachability not confirmed yet
  })();

  const healthLabel = healthScore >= 80 ? 'Excellent' : healthScore >= 50 ? 'Good' : healthScore > 0 ? 'Fair' : 'Offline';
  const healthColor = healthScore >= 80 ? 'var(--green)' : healthScore >= 50 ? 'var(--gold-text)' : healthScore > 0 ? 'var(--orange)' : 'var(--text-muted)';

  // ─── Reachability test ──────────────────────────────────────────────────
  // Tries the SermonIndex probe endpoint; if it isn't deployed yet, falls
  // back to opening canyouseeme.org in the browser with the port logged.
  const handleTestReachability = useCallback(async () => {
    const port = status?.tcp_listen_port;
    if (!port) return;
    setReach({ checking: true });
    addLog(`Testing whether port ${port} is reachable from the internet...`);
    const result = await probeReachability(port);
    if (result) {
      setReach({ open: result.open });
      try { localStorage.setItem('si-reach', JSON.stringify({ open: result.open, ts: Date.now() })); } catch {}
      addLog(result.open ? `Port ${port} is OPEN — you are reachable ✓` : `Port ${port} is CLOSED — see "Help the network more" below`, result.open ? 'success' : 'warn');
      return;
    }
    // Probe service not configured/reachable — fall back to canyouseeme.org.
    setReach(null);
    addLog(`Automatic test not available yet — opening canyouseeme.org (check port ${port})`, 'warn');
    try {
      const tauri = await import('@tauri-apps/api/core');
      await tauri.invoke('open_url', { url: 'https://canyouseeme.org/' });
    } catch {}
  }, [status, addLog]);

  // Restart handler
  const handleReconnect = useCallback(async () => {
    setIsReconnecting(true);
    addLog('Restarting P2P session...', 'warn');
    try {
      const torrent = await getTorrent();
      if (torrent) {
        await torrent.stopSession();
        await new Promise(r => setTimeout(r, 2000));
        const st = await torrent.startSession();
        addLog(`Session restarted (port ${st?.tcp_listen_port ?? '?'}, ${st?.torrent_count ?? 0} torrents)`, 'success');
        // Session no longer persists its list — re-seed exactly what's on disk.
        try {
          const [dm, cat] = await Promise.all([import('../services/downloadManager.js'), import('../services/catalog.js')]);
          await dm.default.reseedExisting(cat.getDownloaded());
          addLog('Re-seeded downloads present on disk', 'info');
        } catch (e) { addLog(`Re-seed skipped: ${e?.message || e}`, 'warn'); }
        setReach(null);
      }
    } catch (err) {
      addLog(`Restart failed: ${err.message}`, 'error');
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

  // Copy magnet links for all seeded torrents. Prefers the CANONICAL magnet
  // from the master list (includes the CDN webseed — works anywhere, even
  // with zero peers); falls back to a tracker-only magnet.
  const handleCopyMagnets = useCallback(async () => {
    try {
      const byId = new Map();
      try {
        for (const s of getCatalog()) {
          if (s.magnet && s.magnet.startsWith('magnet:')) byId.set(s.id, s.magnet);
        }
      } catch {}
      const lines = torrents
        .filter(t => t.stats?.finished)
        .map(t => {
          const id = (t.name || '').replace(/\.(mp3|mp4)$/i, '');
          const magnet = byId.get(id) || buildMagnet(t.info_hash, t.name);
          return `${t.name || t.info_hash}\n${magnet}`;
        });
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

  const rows = [
    { id: 'discovery', icon: icons.discovery, label: 'Finding peers', desc: 'DHT + public trackers announce your sermons automatically', st: discovery },
    { id: 'reach', icon: icons.reach, label: 'Incoming connections', desc: 'Whether other people can connect directly to your node', st: reachability, action: 'test' },
    { id: 'seeding', icon: icons.seeding, label: 'Sharing back', desc: 'Downloaded sermons being served to the network', st: seeding },
  ];

  // Render — the user's own reachability banner sits above the two-column layout.
  // `reachOpen` is the authoritative probe result only (true / false / null); we
  // never upgrade it from an outbound upload count, so the banner stays honest.
  return (
    <>
      <ReachabilityBanner
        running={!!status?.running}
        port={status?.tcp_listen_port}
        reachOpen={reach && typeof reach.open === 'boolean' ? reach.open : null}
        testing={!!reach?.checking}
        onTest={handleTestReachability}
      />
    <div className="connections-layout">
      {/* ── LEFT COLUMN: Health + Status + Active Torrents ── */}
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
          <div style={{ height: 6, borderRadius: 3, background: 'var(--border)', overflow: 'hidden', marginBottom: '12px' }}>
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
              <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Uploaded</div>
              <div style={{ fontSize: '1.1rem', fontWeight: 700, color: 'var(--text-primary)' }}>{formatBytes(uploadedTotal)}</div>
            </div>
            <div>
              <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Uptime</div>
              <div style={{ fontSize: '1.1rem', fontWeight: 700, color: 'var(--text-primary)' }}>
                {status?.uptime_secs ? formatUptime(status.uptime_secs) : '—'}
              </div>
            </div>
          </div>

          {status?.running && (
            <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: '12px' }}>
              Listening on port <strong style={{ color: 'var(--text-primary)' }}>{status.tcp_listen_port || '…'}</strong>.
              Seeded sermons are downloadable with any torrent client (qBittorrent, Transmission).
            </div>
          )}
        </div>

        {/* Status — three things that matter */}
        <div className="seed-card">
          <h3>Node Status</h3>
          <p style={{ marginBottom: '8px', fontSize: '0.78rem', color: 'var(--text-muted)' }}>
            Everything is automatic — nothing here needs configuring to use SermonIndex.
          </p>

          {rows.map((row, i) => (
            <div key={row.id} className="settings-row" style={i === rows.length - 1 ? { border: 'none' } : {}}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flex: 1, minWidth: 0 }}>
                <div style={{
                  width: 32, height: 32, borderRadius: '8px',
                  background: 'var(--bg-hover)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  flexShrink: 0,
                  color: row.st.on ? 'var(--text-secondary)' : 'var(--text-muted)',
                }}>
                  {row.icon}
                </div>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 500, fontSize: '0.85rem' }}>{row.label}</div>
                  <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>{row.desc}</div>
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
                <div style={{
                  width: 8, height: 8, borderRadius: '50%',
                  background: row.st.color,
                  boxShadow: row.st.on ? `0 0 6px ${row.st.color}` : 'none',
                }} />
                <span style={{ fontSize: '0.76rem', fontWeight: 500, color: row.st.color, maxWidth: '220px', textAlign: 'right' }}>
                  {row.st.label}
                </span>
                {row.action === 'test' && status?.running && reachability.key !== 'ok' && (
                  <button
                    className="btn btn-outline"
                    style={{ fontSize: '0.72rem', padding: '3px 10px', whiteSpace: 'nowrap' }}
                    onClick={handleTestReachability}
                    disabled={!!reach?.checking}
                  >
                    {reach?.checking ? 'Testing…' : 'Test'}
                  </button>
                )}
              </div>
            </div>
          ))}

          {/* Plain-language help — only relevant if not confirmed reachable */}
          <details style={{ marginTop: '10px' }}>
            <summary style={{ fontSize: '0.78rem', color: 'var(--gold-text)', cursor: 'pointer', fontWeight: 600 }}>
              Help the network more (optional)
            </summary>
            <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', lineHeight: 1.6, padding: '10px 2px 2px' }}>
              <p style={{ marginBottom: '8px' }}>
                You can download and share sermons without changing anything. But if other people can
                connect <em>directly</em> to your node, you become part of the network's backbone —
                especially valuable for seed nodes.
              </p>
              <p style={{ marginBottom: '8px' }}>
                The app tries to open its port automatically (UPnP and NAT-PMP). If the test above says
                you're not reachable, the usual fix is one of:
              </p>
              <p style={{ marginBottom: '8px' }}>
                1. In your router's settings, turn on <strong>UPnP</strong>, then restart this app.<br />
                2. Or add a port forward: <strong>TCP {status?.tcp_listen_port || TORRENT_PORT_MIN}</strong> (or the
                range {TORRENT_PORT_RANGE}) to this computer.
              </p>
              <p style={{ marginBottom: 0, color: 'var(--text-muted)' }}>
                Not reachable? You still help — your node uploads to every peer it can reach.
              </p>
            </div>
          </details>
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
                        background: 'var(--olive)', color: '#fff', fontSize: '0.65rem', fontWeight: 600,
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

          {/* Test reachability */}
          <div className="settings-row">
            <div>
              <div style={{ fontWeight: 500, fontSize: '0.85rem' }}>Test Reachability</div>
              <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                Check whether other peers can connect directly to your node
              </div>
            </div>
            <button
              className="btn btn-outline"
              style={{ fontSize: '0.78rem', padding: '5px 14px', whiteSpace: 'nowrap' }}
              onClick={handleTestReachability}
              disabled={!p2pRunning || !!reach?.checking}
            >
              {reach?.checking ? 'Testing…' : 'Test'}
            </button>
          </div>

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
    </>
  );
}

function formatUptime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${seconds}s`;
}
