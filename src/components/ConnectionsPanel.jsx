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

import {
  probeReachability, saveReachability, readReachability,
  recordIpv6Observation, readIpv6Observation,
} from '../services/network.js';
import { TORRENT_PORT_MIN, TORRENT_PORT_RANGE } from '../services/constants.js';
import { timeAgo } from '../utils/time.js';
import { deriveNodeState, isReachable, readSeedGranted } from '../utils/nodeStatus.js';
import CgnatNotice from './CgnatNotice.jsx';

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
  // Reachability: the SAVED result is the source of truth and is loaded
  // synchronously on mount, so leaving this page and coming back shows the same
  // answer instead of a blank "unknown" or a fresh probe. It never expires and
  // is never re-probed on its own — the age line + Re-test button are how it
  // gets refreshed. Shape: null | { open, open_v6, …, ts }
  const [reach, setReach] = useState(() => readReachability());
  // PASSIVE IPv6 observation — deliberately SEPARATE state from `reach`.
  // `reach` is null until the user has run a probe at least once; the IPv6
  // observation is independent of that and must survive a null probe result,
  // so a node that has never been tested can still know it is IPv6-reachable.
  // Loaded synchronously on mount from the same si-reach blob (sticky keys).
  const [v6obs, setV6obs] = useState(() => readIpv6Observation());
  // In-flight flag kept OUT of `reach` on purpose: a test in progress (or a
  // failed one) must not blank the result already on screen.
  const [testing, setTesting] = useState(false);
  const pollRef = useRef(null);
  const torrentModRef = useRef(null);
  const logEndRef = useRef(null);
  const logContainerRef = useRef(null);
  const lastLogTimeRef = useRef(0);
  // Mirror of the sticky IPv6 observation, used ONLY to detect the false→true
  // transition so the "you are reachable over IPv6" line is logged exactly once.
  const v6SeenRef = useRef(readIpv6Observation());
  // Has the admin granted this node seed access? Mirrored into localStorage by
  // App.jsx / SeedNodePage from the backend allowlist — see utils/nodeStatus.js.
  // Re-read on the status poll so an approval that lands while this page is open
  // shows up without a restart.
  const [seedGranted, setSeedGranted] = useState(() => readSeedGranted());

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
        // Cheap localStorage read; React bails out when the value is unchanged.
        setSeedGranted(readSeedGranted());

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

        // PASSIVE IPv6 reachability. Cheap to call — the native side throttles
        // the real peer-table scan to once every 30s and the verdict is sticky,
        // so polling it alongside the 4s status poll costs almost nothing.
        // A missing/older native build returns null, which is treated as "no
        // information", never as "not reachable".
        if (st?.running && torrent.getIpv6Observation) {
          const obs = await torrent.getIpv6Observation().catch(() => null);
          if (obs) {
            const before = v6SeenRef.current;
            const merged = recordIpv6Observation(obs);
            v6SeenRef.current = merged;
            setV6obs(merged);
            // Announce only on the transition, and compare against a REF rather
            // than doing it inside the setState updater — updaters must stay
            // pure (StrictMode invokes them twice, which would double-log).
            // This is once-in-a-node-lifetime good news, not a recurring line.
            if (merged.v6_inbound_seen && !before.v6_inbound_seen) {
              addLog('A peer connected to you over IPv6 — you ARE reachable from the internet ✓', 'success');
            } else if (merged.v6_egress_seen && !before.v6_egress_seen) {
              addLog('Your node reached a peer over IPv6 (outgoing only — this does not prove anyone can reach you)', 'info');
            }
          }
        }
      } catch (err) {
        console.warn('[Connections] Poll error:', err.message);
      }
    };

    poll();
    pollRef.current = setInterval(poll, 4000);
    return () => clearInterval(pollRef.current);
  }, [p2pRunning, getTorrent, addLog]);

  // Auto-check reachability ONLY when we have never tested — i.e. there is no
  // saved result at all. Once a result exists it stays until the user presses
  // Re-test; we never silently re-probe behind their back, so what they see is
  // always the reading they last asked for (with its age shown next to it).
  useEffect(() => {
    if (!p2pRunning || !status?.tcp_listen_port || reach || testing) return;
    let cancelled = false;
    (async () => {
      const r = await probeReachability(status.tcp_listen_port);
      if (cancelled || !r) return;
      setReach({ ...r, ts: Date.now() });
      saveReachability(r);
    })();
    return () => { cancelled = true; };
  }, [p2pRunning, status?.tcp_listen_port, reach, testing]);

  // ─── Honest status derivation ───────────────────────────────────────────

  const natpmp = status?.natpmp || 'inactive';

  // PROVEN inbound IPv6 — either the probe got through (which in practice never
  // happens, since our probe server has no IPv6 route) or, far more usefully, we
  // passively observed a real peer connecting IN to us over a public IPv6
  // address. Both are evidence of the same fact, so everything below treats them
  // identically. `v6_egress_seen` is deliberately NOT included: dialling out
  // over IPv6 proves nothing about anyone being able to reach us.
  const ipv6Reachable = reach?.open_v6 === true || v6obs?.v6_inbound_seen === true;

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
    if (testing) return { key: 'checking', label: 'Testing…', color: 'var(--gold-text)', on: true };
    if (reach?.open === true) return { key: 'ok', label: 'Reachable from the internet ✓', color: 'var(--green)', on: true };
    // IPv4 closed but IPv6 open is a REACHABLE node, not a closed one. This is
    // the standard outcome on Starlink and mobile broadband, and calling it
    // "closed" was the single most misleading thing this panel said.
    if (ipv6Reachable) return { key: 'ok', label: 'Reachable over IPv6 ✓', color: 'var(--green)', on: true };
    // Port closed is a DIFFERENT shape of node, not a broken one — say so
    // plainly and in a neutral colour, rather than an orange "not reachable"
    // that reads like a fault the user has failed to fix.
    if (reach?.open === false) return { key: 'closed', label: 'Closed — you connect out to peers instead', color: 'var(--gold-text)', on: true };
    if (natpmp.startsWith('mapped')) return { key: 'ok', label: 'Port opened automatically (NAT-PMP)', color: 'var(--green)', on: true };
    if (natpmp === 'trying') return { key: 'unknown', label: 'Trying automatic setup (UPnP / NAT-PMP)…', color: 'var(--gold-text)', on: true };
    return { key: 'unknown', label: 'Unknown — automatic setup not confirmed', color: 'var(--gold-text)', on: true };
  })();

  const seeding = !status?.running
    ? { label: 'Offline', color: 'var(--text-muted)', on: false }
    : seededCount > 0
      ? { label: `Sharing ${seededCount} sermon${seededCount === 1 ? '' : 's'}`, color: 'var(--green)', on: true }
      : { label: 'Nothing to share yet', color: 'var(--text-muted)', on: true };

  // ── What kind of node am I? ───────────────────────────────────────────────
  // FOUR plain states — Offline / Peer / Node / Seed node — derived in ONE
  // place (utils/nodeStatus.js) and shared with the TopBar mirror in App.jsx,
  // which used to duplicate this logic and had already drifted out of step.
  // The old numeric "health score" (Excellent / Good / Fair) is gone: it told a
  // volunteer nothing they could act on, and it used words the node map has
  // never used. These four words and colours are the map's own.
  //
  // Note the two things that deliberately do NOT feed into this any more:
  //   • upload/peer activity — busy-ness is not a category, and a quiet
  //     reachable node is still a Node.
  //   • being on the seed allowlist ALONE — an approved volunteer whose port is
  //     shut is a Peer. Approval does not make anyone reachable.
  const nodeState = deriveNodeState({
    running: !!(p2pRunning && status?.running),
    reachable: isReachable({ reach, ipv6: v6obs }),
    seedGranted,
  });

  // Truly unreachable: neither address family let anyone in. Everything that
  // used to key off `reach?.open === false` alone must use this instead, or an
  // IPv6-reachable node gets shown peer copy and port-forward instructions it
  // does not need.
  const unreachableBoth = reach?.open === false && !ipv6Reachable;

  // ─── Reachability test ──────────────────────────────────────────────────
  // Tries the SermonIndex probe endpoint; if it isn't deployed yet, falls
  // back to opening canyouseeme.org in the browser with the port logged.
  const handleTestReachability = useCallback(async () => {
    const port = status?.tcp_listen_port;
    if (!port) return;
    setTesting(true);
    addLog(`Testing whether port ${port} is reachable from the internet...`);
    const result = await probeReachability(port);
    setTesting(false);
    if (result) {
      setReach({ ...result, ts: Date.now() });
      saveReachability(result);
      if (result.open) {
        addLog(`Port ${port} is OPEN — you are reachable ✓`, 'success');
      } else if (result.open_v6) {
        // Reachable over IPv6 only. A real, good outcome — log it as success so
        // the activity log doesn't contradict the green banner.
        addLog(`IPv4 port ${port} is closed, but peers CAN reach you over IPv6 (${result.ipv6}) ✓`, 'success');
      } else if (v6SeenRef.current?.v6_inbound_seen) {
        // The IPv4 test failed, but we have already WATCHED a peer connect to us
        // over IPv6. That outranks a failed IPv4 dial, and the banner is showing
        // green — the log must not contradict it.
        addLog(`IPv4 port ${port} is closed, but a peer has already reached you over IPv6 — you are reachable ✓`, 'success');
      } else {
        addLog(`Port ${port} is CLOSED — your node still uploads to every peer it reaches`, 'warn');
        if (result.has_ipv6 && result.v6_probe === 'ok') {
          addLog('Your IPv6 address was dialled too and did not answer — your router is likely blocking incoming IPv6', 'warn');
        } else if (result.v6_probe === 'unsupported') {
          addLog('IPv6 could not be tested (the test server has no IPv6 route) — this says nothing about your connection. Your node watches for real IPv6 peers instead and will say so here if one connects to you', 'warn');
        }
      }
      return;
    }
    // Probe service not configured/reachable — fall back to canyouseeme.org.
    // Deliberately do NOT clear `reach`: a failed re-test tells us nothing new,
    // so the last real answer (and its age) stays on screen rather than the
    // display collapsing back to "unknown".
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
        // The saved reachability result deliberately SURVIVES a restart — it is
        // only ever replaced by an explicit Re-test. Nudge instead of re-probing.
        addLog('Reachability result kept — press Re-test if you want a fresh reading', 'info');
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
        reachOpen6={!!reach?.open_v6}
        v6Probe={reach?.v6_probe || 'none'}
        hasIpv6={!!reach?.has_ipv6}
        cgnat={!!reach?.cgnat}
        testing={testing}
        testedAt={reach?.ts || null}
        onTest={handleTestReachability}
        // Passive, sticky observations. These are what actually answer the IPv6
        // question — the probe server has no IPv6 route, so `reachOpen6` above
        // is effectively always false for everyone.
        v6InboundSeen={!!v6obs?.v6_inbound_seen}
        v6InboundAt={v6obs?.v6_inbound_ts || null}
        v6EgressSeen={!!v6obs?.v6_egress_seen}
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
                background: nodeState.color,
                boxShadow: nodeState.key !== 'offline' ? `0 0 8px ${nodeState.color}` : 'none',
              }} />
              <span style={{ color: nodeState.color, fontWeight: 600, fontSize: '0.85rem' }}>{nodeState.label}</span>
            </div>
          </div>

          {/* Status band. Deliberately NOT a progress bar any more — there is no
              score to fill it with, and showing a Peer as a half-empty bar told
              them they were half a node, which is exactly the discouragement
              this change is meant to remove. It is now a plain colour band in
              the state's own colour: full when running, empty when offline. */}
          <div style={{ height: 6, borderRadius: 3, background: 'var(--border)', overflow: 'hidden', marginBottom: '10px' }}>
            <div style={{
              height: '100%', borderRadius: 3,
              width: nodeState.key === 'offline' ? '0%' : '100%',
              background: `linear-gradient(90deg, ${nodeState.color}, ${nodeState.color}dd)`,
              transition: 'width 0.5s ease',
            }} />
          </div>

          {/* One plain sentence saying what that word means for them. */}
          <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: '12px' }}>
            {nodeState.blurb}
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
                    disabled={testing}
                  >
                    {testing ? 'Testing…' : reach ? 'Re-test' : 'Test'}
                  </button>
                )}
              </div>
            </div>
          ))}

          {/* The honest reassurance for unreachable nodes, in the MAIN status
              area — it used to be the last line inside a collapsed <details>,
              where the people who most needed to read it never saw it. */}
          {unreachableBoth && (
            <div style={{
              marginTop: '12px',
              padding: '10px 12px',
              borderRadius: '8px',
              background: 'var(--bg-tertiary)',
              border: '1px solid var(--border)',
              borderLeft: '3px solid var(--gold-text)',
              fontSize: '0.8rem',
              color: 'var(--text-secondary)',
              lineHeight: 1.6,
            }}>
              <strong style={{ color: 'var(--text-primary)' }}>You are still helping.</strong>{' '}
              Your node finds other nodes on its own and uploads to every peer it can reach — including
              sermons you finished downloading long ago. Nobody can knock on your door, so you go and
              knock on theirs.
            </div>
          )}

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

              {/* For an unreachable node, explain the one cause nobody can fix
                  BEFORE handing out router instructions that may be impossible
                  to follow. Everyone else still gets the guide unchanged. */}
              {unreachableBoth && (
                <CgnatNotice
                  detected={!!reach?.cgnat}
                  v6Firewalled={!!reach?.has_ipv6 && reach?.v6_probe === 'ok' && reach?.open_v6 === false && !ipv6Reachable}
                  style={{ marginTop: 0, marginBottom: '10px' }}
                />
              )}

              <p style={{ marginBottom: '8px' }}>
                Otherwise, the app tries to open its port automatically (UPnP and NAT-PMP). If the test
                above says you're not reachable, the usual fix is one of:
              </p>
              <p style={{ marginBottom: 0 }}>
                1. In your router's settings, turn on <strong>UPnP</strong>, then restart this app.<br />
                2. Or add a port forward: <strong>TCP {status?.tcp_listen_port || TORRENT_PORT_MIN}</strong> (or the
                range {TORRENT_PORT_RANGE}) to this computer.
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
                {/* The result is kept indefinitely and never refreshed on its
                    own, so its age is shown wherever the Re-test button is. */}
                {reach?.ts ? ` · Last tested ${timeAgo(reach.ts)}` : ''}
              </div>
            </div>
            <button
              className="btn btn-outline"
              style={{ fontSize: '0.78rem', padding: '5px 14px', whiteSpace: 'nowrap' }}
              onClick={handleTestReachability}
              disabled={!p2pRunning || testing}
            >
              {testing ? 'Testing…' : reach ? 'Re-test' : 'Test'}
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
