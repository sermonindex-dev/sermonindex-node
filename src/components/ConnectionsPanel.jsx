import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Panel } from './PageHead.jsx';
import { getCatalog } from '../services/catalog.js';
import ReachabilityBanner from './ReachabilityBanner';
import ReachabilityHelp from './ReachabilityHelp.jsx';
import { v6ConfirmedRecently, localIpv6 } from '../services/network.js';
import { onAction } from '../services/pendingAction.js';

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
import { TORRENT_PORT_MIN, TORRENT_PORT_RANGE, PORT_MIN, PORT_MAX, PORT_PRIVILEGED_MAX } from '../services/constants.js';
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
  port: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="8" width="18" height="10" rx="2" /><path d="M7 8V6a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v2" /><line x1="8" y1="13" x2="8" y2="13" /><line x1="12" y1="13" x2="12" y2="13" /><line x1="16" y1="13" x2="16" y2="13" />
    </svg>
  ),
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
  log: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="4 17 10 11 4 5" /><line x1="12" y1="19" x2="20" y2="19" />
    </svg>
  ),
  actions: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
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
  // The native observation, UNMERGED. `v6obs` above is the sticky localStorage
  // blob and survives restarts; this one is sticky for the current session only.
  // Keeping them apart is the whole point: it is the only way to tell "an IPv6
  // peer has dialled in" from "an IPv6 peer dialled in once, some time before
  // you last quit the app", and the banner was reporting the second as the
  // first. Starts null — no information, never a negative answer.
  const [v6live, setV6live] = useState(null);
  // This machine's own global IPv6 address, for the self-help panel. The probe
  // result carries one too, but only after a test has been run — and the whole
  // point of the panel is to be useful BEFORE anyone has pressed anything.
  const [ownV6, setOwnV6] = useState(null);
  useEffect(() => {
    let alive = true;
    localIpv6()
      .then((list) => { if (alive && Array.isArray(list) && list.length) setOwnV6(list[0]); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);
  // ── Listening port ────────────────────────────────────────────────────────
  // `status.tcp_listen_port` is what we ACTUALLY bound; `status.configured_port`
  // is what the user asked for. Keeping both lets the panel say "your chosen
  // port was taken, you're on X" instead of silently drifting — which is the
  // failure that makes a hand-written router rule stop matching with nothing on
  // screen to explain it.
  const [portDraft, setPortDraft] = useState('');
  const [portSaving, setPortSaving] = useState(false);
  const [portErr, setPortErr] = useState('');
  const [portCopied, setPortCopied] = useState(null);
  const portTouched = useRef(false);

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
            setV6live(obs);
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

  // App menu → "Re-test Reachability". The request can arrive before the
  // torrent session has reported its listening port, and the test cannot run
  // without one, so it is held as `wantRetest` until the port is known.
  const [wantRetest, setWantRetest] = useState(false);
  useEffect(() => onAction('retest-reach', () => setWantRetest(true)), []);
  useEffect(() => {
    if (wantRetest && status?.tcp_listen_port && !testing) {
      setWantRetest(false);
      handleTestReachability();
    }
  }, [wantRetest, status?.tcp_listen_port, testing, handleTestReachability]);

  // Seed the input from whatever is stored, but ONLY until the user types.
  // Re-seeding on every status poll would wipe a half-typed port every 2s.
  useEffect(() => {
    if (portTouched.current) return;
    const v = status?.configured_port;
    setPortDraft(v ? String(v) : '');
  }, [status?.configured_port]);

  const effectivePort = status?.tcp_listen_port || status?.configured_port || TORRENT_PORT_MIN;
  // The chosen port did not stick. Worth saying out loud — see the state comment.
  const portDrifted = !!(status?.running && status?.configured_port
    && status?.tcp_listen_port && status.configured_port !== status.tcp_listen_port);

  const copyText = useCallback(async (text, which) => {
    try {
      await navigator.clipboard.writeText(text);
      setPortCopied(which);
      setTimeout(() => setPortCopied(null), 1800);
    } catch { /* clipboard blocked — the text is on screen to read anyway */ }
  }, []);

  /**
   * Save the port and restart the session so it takes effect now.
   *
   * `null` clears the pin and goes back to the automatic range. Validation is
   * deliberately permissive about privileged ports: we WARN that binding below
   * 1024 needs root on macOS and Linux, but we store it, because Windows has no
   * such rule and someone who knows their own machine should not be overruled
   * by a guess about their OS. If it does not bind, `portDrifted` says so
   * plainly rather than the app pretending it worked.
   */
  const handleSavePort = useCallback(async (clear = false) => {
    setPortErr('');
    let port = null;
    if (!clear) {
      const n = Number(portDraft.trim());
      if (!Number.isInteger(n) || n < PORT_MIN || n > PORT_MAX) {
        setPortErr(`Enter a port between ${PORT_MIN} and ${PORT_MAX}.`);
        return;
      }
      port = n;
    }
    setPortSaving(true);
    try {
      const torrent = await getTorrent();
      if (!torrent) throw new Error('P2P module unavailable');
      await torrent.setListenPort(port);
      portTouched.current = false;
      addLog(port ? `Listening port set to ${port}` : 'Listening port set to automatic', 'info');
      if (status?.running) {
        addLog('Restarting session to apply the port…', 'warn');
        await torrent.stopSession();
        await new Promise(r => setTimeout(r, 1500));
        const st = await torrent.startSession();
        addLog(`Session restarted on port ${st?.tcp_listen_port ?? '?'}`, 'success');
        // A new port invalidates the old reachability answer — it was measured
        // against a port nobody is listening on any more.
        setReach(null);
      }
    } catch (e) {
      setPortErr(String(e?.message || e));
      addLog(`Could not set the port: ${e?.message || e}`, 'error');
    } finally {
      setPortSaving(false);
    }
  }, [portDraft, status?.running, addLog]);

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
        // …and the same question asked of THIS session only.
        v6ThisSession={v6live?.inbound_ipv6 === true}
        inboundPeersPeak={
          typeof v6live?.inbound_peers_peak === 'number' ? v6live.inbound_peers_peak : null
        }
      />

      {/* The self-help half. The banner says WHERE you stand; this says what,
          if anything, you can do about it — including saying plainly when the
          answer is "nothing, and that is not your fault", which is the case for
          every household on a shared carrier address. */}
      <div style={{ maxWidth: '1100px', margin: '0 auto 16px' }}>
        <ReachabilityHelp
          port={status?.tcp_listen_port}
          publicIpv6={reach?.ipv6 || ownV6 || null}
          localIp={status?.local_ip || null}
          reachOpen={reach && typeof reach.open === 'boolean' ? reach.open : null}
          v6Confirmed={v6ConfirmedRecently(v6obs)}
          cgnat={!!reach?.cgnat}
        />
      </div>
    <div className="connections-layout">
      {/* ── LEFT COLUMN: Health + Status + Active Torrents ── */}
      <div className="connections-left">
        {/* Health overview */}
        <Panel
          mark={icons.discovery}
          title="Network Health"
          sub="What your node is doing right now"
          aside={
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '8px' }}>
              <span style={{
                width: 9, height: 9, borderRadius: '50%',
                background: nodeState.color,
                boxShadow: nodeState.key !== 'offline' ? `0 0 8px ${nodeState.color}` : 'none',
              }} />
              <span style={{ color: nodeState.color, fontWeight: 700, fontSize: 'var(--text-sm)' }}>{nodeState.label}</span>
            </span>
          }
        >

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
          <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: '12px' }}>
            {nodeState.blurb}
          </div>

          {/* Five figures as one instrument panel rather than five divs in a
              flex row, each styling its own label. Wells, hairline-separated,
              tabular numerals — so the values line up and read as one reading
              of one machine. */}
          <div className="statstrip">
            <div><b style={{ color: 'var(--gold-text)' }}>{livePeers}</b><small>Peers</small></div>
            <div><b>{status?.torrent_count ?? torrents.length}</b><small>Torrents</small></div>
            <div><b style={seededCount > 0 ? { color: 'var(--green)' } : undefined}>{seededCount}</b><small>Seeding</small></div>
            <div><b>{formatBytes(uploadedTotal)}</b><small>Uploaded</small></div>
            <div><b>{status?.uptime_secs ? formatUptime(status.uptime_secs) : '—'}</b><small>Uptime</small></div>
          </div>

          {status?.running && (
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginTop: '12px', marginBottom: 0 }}>
              Listening on port <strong style={{ color: 'var(--text-primary)' }}>{status.tcp_listen_port || '…'}</strong>.
              Seeded sermons are downloadable with any torrent client (qBittorrent, Transmission).
            </div>
          )}
        </Panel>

        {/* Status — three things that matter */}
        <Panel
          mark={icons.seeding}
          title="Node Status"
          sub="All automatic — nothing here needs configuring"
        >

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
                  <div style={{ fontWeight: 500, fontSize: 'var(--text-sm)' }}>{row.label}</div>
                  <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>{row.desc}</div>
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
                <div style={{
                  width: 8, height: 8, borderRadius: '50%',
                  background: row.st.color,
                  boxShadow: row.st.on ? `0 0 6px ${row.st.color}` : 'none',
                }} />
                <span style={{ fontSize: 'var(--text-xs)', fontWeight: 500, color: row.st.color, maxWidth: '220px', textAlign: 'right' }}>
                  {row.st.label}
                </span>
                {row.action === 'test' && status?.running && reachability.key !== 'ok' && (
                  <button
                    className="btn btn-outline"
                    style={{ fontSize: 'var(--text-xs)', padding: '3px 10px', whiteSpace: 'nowrap' }}
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
              fontSize: 'var(--text-sm)',
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
            <summary style={{ fontSize: 'var(--text-sm)', color: 'var(--gold-text)', cursor: 'pointer', fontWeight: 600 }}>
              Help the network more (optional)
            </summary>
            <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', lineHeight: 1.6, padding: '10px 2px 2px' }}>
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
                2. Or write the rule yourself — pin the port in <strong>Listening port</strong> below, then
                copy the forward (IPv4) or pinhole (IPv6) text it gives you into your router.
              </p>
            </div>
          </details>
        </Panel>

        {/* Active Torrents */}
        <Panel
          mark={icons.reach}
          title="Active Torrents"
          sub="Every swarm this node is currently in"
          aside={<span className="pill">{torrents.length}</span>}
        >
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
                    fontSize: 'var(--text-xs)',
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
                        fontSize: 'var(--text-xs)',
                        padding: '1px 6px',
                        borderRadius: '4px',
                        background: s.finished ? 'rgba(78,203,113,0.15)' : 'rgba(212,175,55,0.15)',
                        color: stateColor,
                        flexShrink: 0,
                      }}>
                        {stateLabel}
                      </span>
                    </div>
                    <div style={{ paddingLeft: '12px', color: 'var(--text-muted)', fontSize: 'var(--text-xs)' }}>
                      {pct.toFixed(1)}% · ↓ {live.download_speed?.human_readable ?? '-'} · ↑ {live.upload_speed?.human_readable ?? '-'} · {peers} peer{peers === 1 ? '' : 's'}
                      {s.error ? ` · ${String(s.error).slice(0, 60)}` : ''}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', fontStyle: 'italic' }}>
              No torrents yet — download a sermon and it will be seeded here
            </div>
          )}
        </Panel>
      </div>

      {/* ── RIGHT COLUMN: Logs + Actions ── */}
      <div className="connections-right">
        {/* Live Log — newest at bottom, auto-scrolls */}
        {/* The log is the one thing in the app you read INTO rather than act
            on, and it was cream monospace on a cream card — the typeface was
            the only thing telling you it was machine output. It is now the
            deepest well in the product, dark in BOTH themes, because a log that
            flips to cream is a log you have to re-learn to read each time you
            change theme. */}
        {/* ── Listening port ─────────────────────────────────────────────────
            Everything else on this page is automatic and says so. This panel is
            the opposite, and it exists for the people the automatic path never
            reaches: no UPnP, no NAT-PMP, and — the case that matters most now —
            IPv6, where there is no NAT to traverse and the router's inbound
            firewall is the only thing in the way. The fix there is a pinhole
            rule, and a pinhole rule needs two things this panel supplies: an
            address and a port that will still be the same tomorrow. */}
        <Panel
          mark={icons.port}
          title="Listening port"
          sub="Pin it if you're writing a router rule by hand"
          aside={
            <span className="pill" style={{ fontVariantNumeric: 'tabular-nums' }}>
              {status?.running ? effectivePort : '—'}
            </span>
          }
        >
          <p style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', lineHeight: 1.6, margin: 0 }}>
            By default the node takes the first free port in {TORRENT_PORT_RANGE}, which is fine when
            UPnP or NAT-PMP opens it for you. A router rule you write yourself names <em>one</em> port —
            so pin it first, or the rule stops matching the day something else takes that port.
          </p>

          <div className="port-set">
            <div className="port-field">
              <label htmlFor="si-port">Port</label>
              <input
                id="si-port"
                type="number"
                value={portDraft}
                min={PORT_MIN}
                max={PORT_MAX}
                placeholder="auto"
                onChange={(e) => { portTouched.current = true; setPortDraft(e.target.value); setPortErr(''); }}
              />
            </div>
            <button
              className="btn btn-gold"
              onClick={() => handleSavePort(false)}
              disabled={portSaving || !portDraft.trim()}
            >
              {portSaving ? 'Applying…' : 'Pin this port'}
            </button>
            {status?.configured_port && (
              <button
                className="btn btn-outline"
                onClick={() => { portTouched.current = false; handleSavePort(true); }}
                disabled={portSaving}
                style={{ height: 46 }}
              >
                Back to automatic
              </button>
            )}
          </div>

          {portErr && (
            <div style={{ color: 'var(--red)', fontSize: 'var(--text-sm)', marginBottom: '10px' }}>{portErr}</div>
          )}

          {/* Below 1024 is a real OS rule, not a preference of ours, so it is
              stated as such — and as a warning, not a refusal. */}
          {Number(portDraft) > 0 && Number(portDraft) <= PORT_PRIVILEGED_MAX && (
            <div className="verdict quiet" style={{ marginBottom: '10px' }}>
              <div className="verdict-copy">
                Ports below {PORT_PRIVILEGED_MAX + 1} are reserved by the operating system on macOS and
                Linux, and this app doesn't run as an administrator — so {portDraft} will almost
                certainly fall back to the automatic range. Anything from {PORT_PRIVILEGED_MAX + 1} to{' '}
                {PORT_MAX.toLocaleString()} is safe.
              </div>
            </div>
          )}

          {portDrifted && (
            <div className="verdict" style={{ marginBottom: '10px' }}>
              <div className="verdict-title">
                Port <span className="verdict-flag">{status.configured_port}</span> wasn't available
              </div>
              <div className="verdict-copy">
                Something else on this machine is using it, so the node is listening on{' '}
                <strong>{status.tcp_listen_port}</strong> instead — and a router rule naming{' '}
                {status.configured_port} won't match. Either free that port and restart, or pin{' '}
                {status.tcp_listen_port} and point the rule there.
              </div>
            </div>
          )}

          <div style={{ fontWeight: 600, color: 'var(--text-primary)', margin: '16px 0 10px' }}>
            What to put in your router
          </div>

          <div className="rule">
            <div className="rule-body">
              <div className="rule-kind">IPv4</div>
              <div className="rule-what">A port forward, pointed at this computer</div>
              <div className="rule-value">Forward TCP {effectivePort} to this computer</div>
            </div>
            <button
              className="btn btn-gold btn-sm"
              onClick={() => copyText(`Forward TCP ${effectivePort} to this computer`, 'v4')}
            >
              {portCopied === 'v4' ? 'Copied' : 'Copy'}
            </button>
          </div>

          {ownV6 ? (
            <div className="rule">
              <div className="rule-body">
                <div className="rule-kind">IPv6</div>
                <div className="rule-what">A firewall pinhole — nothing to forward, just "allow in"</div>
                <div className="rule-value">Allow inbound TCP to [{ownV6}]:{effectivePort}</div>
              </div>
              <button
                className="btn btn-gold btn-sm"
                onClick={() => copyText(`Allow inbound TCP to [${ownV6}]:${effectivePort}`, 'v6')}
              >
                {portCopied === 'v6' ? 'Copied' : 'Copy'}
              </button>
            </div>
          ) : (
            <p className="port-note" style={{ marginTop: 0 }}>
              This machine has no global IPv6 address, so there's no pinhole to add — the IPv4 forward
              above is the one that matters here.
            </p>
          )}

          <p className="port-note">
            IPv6 has no NAT, so there is nothing to "forward" — your router simply blocks unsolicited
            connections in, and a pinhole tells it not to for this one address and port. Routers call it{' '}
            <em>IPv6 Firewall</em>, <em>Pinhole</em>, <em>Allow Inbound IPv6</em>, or{' '}
            <em>IPv6 Simple Security</em>.
          </p>
        </Panel>

        <Panel
          mark={icons.log}
          title="Live Log"
          sub="Newest at the bottom"
          aside={
            <>
              <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums' }}>
                {connectionLog.length}/{MAX_LOG_ENTRIES}
              </span>
              {connectionLog.length > 0 && (
                <>
                  <span style={{ position: 'relative', display: 'inline-block' }}>
                    <button
                      className="btn btn-outline btn-sm"
                      onClick={handleCopyLogs}
                      title="Copy all logs to clipboard"
                    >
                      Copy
                    </button>
                    {copiedShow && (
                      <span style={{
                        position: 'absolute', bottom: '110%', left: '50%', transform: 'translateX(-50%)',
                        background: 'var(--olive)', color: '#fff', fontSize: 'var(--text-xs)', fontWeight: 600,
                        padding: '3px 10px', borderRadius: '4px', whiteSpace: 'nowrap',
                        pointerEvents: 'none', zIndex: 10,
                        boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
                      }}>
                        Copied!
                      </span>
                    )}
                  </span>
                  <button
                    className="btn btn-outline btn-sm"
                    onClick={() => { setConnectionLog([]); }}
                  >
                    Clear
                  </button>
                </>
              )}
            </>
          }
        >
          <div className="terminal">
            <div className="terminal-head">
              <span className="terminal-count">
                {status?.running ? 'session running' : 'session stopped'}
              </span>
              <span className="grow" />
              <span className="terminal-count">
                port {status?.tcp_listen_port || '—'}
              </span>
            </div>
            <div
              className="terminal-body"
              ref={logContainerRef}
              onScroll={handleLogScroll}
            >
              {connectionLog.length === 0 ? (
                <div className="terminal-empty">Waiting for events…</div>
              ) : connectionLog.map((entry, i) => (
                <div key={i} className={`terminal-line ${entry.type || ''}`}>
                  <span className="t-time">{entry.time}</span>
                  {entry.msg}
                </div>
              ))}
              <div ref={logEndRef} />
            </div>
          </div>
          {!autoScroll && connectionLog.length > 0 && (
            <button
              onClick={() => {
                setAutoScroll(true);
                if (logContainerRef.current) {
                  logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
                }
              }}
              className="btn btn-outline btn-sm"
              style={{ marginTop: '8px', alignSelf: 'center', color: 'var(--gold-text)', display: 'flex', marginLeft: 'auto', marginRight: 'auto' }}
            >
              Jump to latest
            </button>
          )}
        </Panel>

        {/* Actions */}
        <Panel mark={icons.actions} title="Actions" sub="Things you can do by hand">

          {/* Test reachability */}
          <div className="settings-row">
            <div>
              <div style={{ fontWeight: 500, fontSize: 'var(--text-sm)' }}>Test Reachability</div>
              <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
                Check whether other peers can connect directly to your node
                {/* The result is kept indefinitely and never refreshed on its
                    own, so its age is shown wherever the Re-test button is. */}
                {reach?.ts ? ` · Last tested ${timeAgo(reach.ts)}` : ''}
              </div>
            </div>
            <button
              className="btn btn-outline"
              style={{ fontSize: 'var(--text-sm)', padding: '5px 14px', whiteSpace: 'nowrap' }}
              onClick={handleTestReachability}
              disabled={!p2pRunning || testing}
            >
              {testing ? 'Testing…' : reach ? 'Re-test' : 'Test'}
            </button>
          </div>

          {/* Restart */}
          <div className="settings-row">
            <div>
              <div style={{ fontWeight: 500, fontSize: 'var(--text-sm)' }}>Restart Session</div>
              <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
                Restart the BitTorrent session and re-announce all torrents
              </div>
            </div>
            <button
              className="btn btn-outline"
              style={{ fontSize: 'var(--text-sm)', padding: '5px 14px', whiteSpace: 'nowrap' }}
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
              <div style={{ fontWeight: 500, fontSize: 'var(--text-sm)' }}>Copy Magnet Links</div>
              <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
                Copy magnets for all seeded sermons — shareable with any torrent client
              </div>
            </div>
            <button
              className="btn btn-outline"
              style={{ fontSize: 'var(--text-sm)', padding: '5px 14px', whiteSpace: 'nowrap' }}
              onClick={handleCopyMagnets}
              disabled={!p2pRunning || seededCount === 0}
            >
              Copy Magnets
            </button>
          </div>
        </Panel>
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
