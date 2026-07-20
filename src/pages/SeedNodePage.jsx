import React, { useState, useCallback, useEffect } from 'react';
import { probeReachability, registerSeed, checkSeedAccess, requestSeedAccess, saveReachability, readReachability, readIpv6Observation } from '../services/network.js';
import { timeAgo } from '../utils/time.js';
import { isReachable, writeSeedGranted } from '../utils/nodeStatus.js';
import CgnatNotice from '../components/CgnatNotice.jsx';
import { TORRENT_PORT_RANGE } from '../services/constants.js';
import { getNodeId } from '../services/heartbeat.js';

const SEED_CONTACT_EMAIL = 'sermonindex@gmail.com';

// ── Library sizing, split by scope ─────────────────────────────────────────
// Audio-only is the practical common choice: ~412 GB fits on a cheap external
// drive. Everything (audio + video) is ~2.4 TB and needs a large drive.
const SCOPE_INFO = {
  audio: {
    label: 'Audio library',
    sizeLabel: '~412 GB',
    fileCount: 25587,
    tagline: '~412 GB · 25,587 sermons · fits on a small external drive',
    // Require a comfortable margin above the ~412 GB payload.
    requiredBytes: 500 * 1000 * 1000 * 1000, // 500 GB
    requiredLabel: '500 GB',
  },
  full: {
    label: 'Full library (audio + video)',
    sizeLabel: '~2.4 TB',
    fileCount: 33528, // 25,587 audio + 7,941 video
    tagline: '~2.4 TB · adds 7,941 videos · needs a large drive',
    requiredBytes: 2600 * 1000 * 1000 * 1000, // 2.6 TB
    requiredLabel: '2.6 TB',
  },
};

const SEED_SCOPE_KEY = 'si-seed-scope';

// Solid yellow lock SVG icon
const iconLock = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="#d4af37" stroke="none">
    <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
    <path d="M7 11V7a5 5 0 0 1 10 0v4" fill="none" stroke="#d4af37" strokeWidth="2" />
  </svg>
);

// Phosphor circuitry icon for seed node branding
const iconCircuitry = (
  <svg width="20" height="20" viewBox="0 0 256 256" fill="currentColor">
    <path d="M208,32H48A16,16,0,0,0,32,48V208a16,16,0,0,0,16,16H208a16,16,0,0,0,16-16V48A16,16,0,0,0,208,32ZM88,160a8,8,0,1,1-8,8A8,8,0,0,1,88,160ZM48,48H80v97.38a24,24,0,1,0,16,0V115.31l48,48V208H48ZM208,208H160V160a8,8,0,0,0-2.34-5.66L96,92.69V48h32V72a8,8,0,0,0,2.34,5.66l16,16A23.74,23.74,0,0,0,144,104a24,24,0,1,0,24-24,23.74,23.74,0,0,0-10.34,2.35L144,68.69V48h64V208ZM168,96a8,8,0,1,1-8,8A8,8,0,0,1,168,96Z" />
  </svg>
);

// ── Seed-node hero band ───────────────────────────────────────────────────
// Ported from the website's node-software landing page (the `.nlp-seed`
// section). Full-width band that sits above the two-column layout in BOTH the
// locked and unlocked states, since it is the page's introduction either way.
//
// The SVG bleeds in from the left and is masked out toward the copy on the
// right. Its colours are the site's literal gold/cream, so the band carries its
// own dark olive surface in both app themes (see `.si-seedhero` in styles.css)
// — cream dots would be invisible on the light theme's #F8F8F2.
//
// The gradient/pattern ids are document-global, so they are namespaced
// (`siSeedHero*`) to avoid the kind of id collision already fixed on StatsPage.
function SeedNodeHero() {
  return (
    <div className="si-seedhero">
      <div className="si-seedhero-viz" aria-hidden="true">
        <svg viewBox="0 0 620 560" preserveAspectRatio="xMidYMid slice">
          <defs>
            <pattern id="siSeedHeroDots" width="42" height="42" patternUnits="userSpaceOnUse">
              <circle cx="3" cy="3" r="1.5" fill="#f3efe0" opacity="0.09" />
            </pattern>
            <linearGradient id="siSeedHeroArea" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#d4af37" stopOpacity="0.32" />
              <stop offset="1" stopColor="#d4af37" stopOpacity="0.02" />
            </linearGradient>
            <radialGradient id="siSeedHeroGlow" cx="0.5" cy="0.5" r="0.5">
              <stop offset="0" stopColor="#f3efe0" stopOpacity="0.45" />
              <stop offset="1" stopColor="#f3efe0" stopOpacity="0" />
            </radialGradient>
          </defs>
          <rect x="0" y="0" width="620" height="560" fill="url(#siSeedHeroDots)" />
          {/* rising library-growth area chart */}
          <path
            d="M0,474 C70,464 120,452 180,432 C240,412 300,372 360,344 C420,316 470,268 520,232 C560,203 590,190 620,176 L620,560 L0,560 Z"
            fill="url(#siSeedHeroArea)"
          />
          <path
            d="M0,474 C70,464 120,452 180,432 C240,412 300,372 360,344 C420,316 470,268 520,232 C560,203 590,190 620,176"
            fill="none"
            stroke="#d4af37"
            strokeWidth="2.6"
            strokeOpacity="0.6"
            strokeLinecap="round"
          />
          {/* peer links */}
          <g stroke="#d4af37" strokeOpacity="0.32" strokeWidth="1.4">
            <line x1="80" y1="130" x2="150" y2="210" />
            <line x1="80" y1="130" x2="175" y2="80" />
            <line x1="150" y1="210" x2="270" y2="140" />
            <line x1="150" y1="210" x2="240" y2="255" />
            <line x1="270" y1="140" x2="360" y2="95" />
            <line x1="240" y1="255" x2="390" y2="205" />
            <line x1="270" y1="140" x2="390" y2="205" />
            <line x1="175" y1="80" x2="360" y2="95" />
            <line x1="390" y1="205" x2="460" y2="150" />
            <line x1="120" y1="320" x2="150" y2="210" />
            <line x1="120" y1="320" x2="240" y2="255" />
            <line x1="240" y1="255" x2="270" y2="140" />
          </g>
          {/* signal pulses on two hub nodes */}
          <circle className="si-seedhero-pulse" cx="80" cy="130" r="9" fill="none" stroke="#d4af37" strokeWidth="2" opacity="0.5">
            <animate attributeName="r" values="9;30" dur="3.2s" repeatCount="indefinite" />
            <animate attributeName="opacity" values="0.5;0" dur="3.2s" repeatCount="indefinite" />
          </circle>
          <circle className="si-seedhero-pulse" cx="240" cy="255" r="9" fill="none" stroke="#f3efe0" strokeWidth="2" opacity="0.4">
            <animate attributeName="r" values="9;28" dur="3.6s" begin="1.1s" repeatCount="indefinite" />
            <animate attributeName="opacity" values="0.45;0" dur="3.6s" begin="1.1s" repeatCount="indefinite" />
          </circle>
          {/* node glows */}
          <circle cx="80" cy="130" r="26" fill="url(#siSeedHeroGlow)" />
          <circle cx="240" cy="255" r="24" fill="url(#siSeedHeroGlow)" />
          {/* peer nodes */}
          <g>
            <circle cx="175" cy="80" r="5" fill="#f3efe0" opacity="0.85" />
            <circle cx="270" cy="140" r="6" fill="#f3efe0" opacity="0.9" />
            <circle cx="360" cy="95" r="5" fill="#f3efe0" opacity="0.8" />
            <circle cx="390" cy="205" r="6.5" fill="#d4af37" />
            <circle cx="460" cy="150" r="4.5" fill="#f3efe0" opacity="0.7" />
            <circle cx="120" cy="320" r="6" fill="#f3efe0" opacity="0.85" />
            <circle cx="150" cy="210" r="8" fill="#d4af37" />
            <circle cx="80" cy="130" r="8" fill="#d4af37" />
            <circle cx="240" cy="255" r="8" fill="#d4af37" />
          </g>
        </svg>
      </div>
      <div className="si-seedhero-wrap">
        <div className="si-seedhero-copy">
          <div className="si-seedhero-kick">◈ Seed Nodes</div>
          <h2>Hold a complete backup of over{"\u00a0"}25,000 sermons.</h2>
          <p>
            SermonIndex is built on a peer-to-peer network where every user helps share sermon
            content. Regular users share the sermons they’ve listened to. Seed nodes go further —
            they download and serve a large portion of the whole library so it can never be lost.
          </p>
          <p>
            With seed nodes distributed across the world, the sermon library becomes essentially
            indestructible. No single point of failure. No government can censor it. The content
            lives on across the body of Christ.
          </p>
          <div className="si-seedhero-stats">
            <div className="s"><b>25,000+</b><small>Sermons preserved</small></div>
            <div className="s"><b>Always-on</b><small>A Raspberry Pi or old laptop is perfect</small></div>
          </div>
        </div>
      </div>
    </div>
  );
}

// Tauri APIs — lazy-loaded to avoid top-level await
let tauriInvoke = null;
let tauriDialog = null;
let tauriLoaded = false;

async function ensureTauri() {
  if (tauriLoaded) return;
  tauriLoaded = true;
  try {
    const tauriApi = await import('@tauri-apps/api/core');
    tauriInvoke = tauriApi.invoke;
  } catch {}
  try {
    const dialogApi = await import('@tauri-apps/plugin-dialog');
    tauriDialog = dialogApi;
  } catch {}
}

// Torrent service — lazy-loaded (used to read the node's listening port for
// the reachability test).
let torrentModule = null;
let torrentLoadAttempted = false;
async function ensureTorrent() {
  if (torrentLoadAttempted) return torrentModule;
  torrentLoadAttempted = true;
  try {
    torrentModule = await import('../services/torrent.js');
  } catch {
    torrentModule = null;
  }
  return torrentModule;
}

export default function SeedNodePage({
  seedUnlocked,
  onUnlock,
  catalog,
  libraryStats,
  downloadManager,
  downloadStates,
  nodeStats,
}) {
  const [error, setError] = useState('');
  // Seed access is granted per-device via the backend allowlist (no password).
  const [nodeId] = useState(() => { try { return getNodeId(); } catch { return ''; } });
  const [checkingAccess, setCheckingAccess] = useState(false);
  const [accessMsg, setAccessMsg] = useState('');
  const [reqEmail, setReqEmail] = useState('');
  const [requested, setRequested] = useState(false);
  // Inline hardware-recommendations panel shown in the locked "What is a Seed
  // Node?" card — expands in-app in place of the old external forums link.
  const [showHardware, setShowHardware] = useState(false);

  // STEP 1 — what to host. Persisted to localStorage; default 'audio'.
  const [scope, setScope] = useState(() => {
    try {
      const saved = localStorage.getItem(SEED_SCOPE_KEY);
      if (saved === 'audio' || saved === 'full') return saved;
    } catch {}
    return 'audio';
  });
  const setScopePersisted = useCallback((next) => {
    setScope(next);
    try { localStorage.setItem(SEED_SCOPE_KEY, next); } catch {}
    // Changing scope invalidates a prior space check (thresholds differ).
    setStorageVerified(false);
    setStorageError('');
  }, []);

  // STEP 2 — storage location
  const [storagePath, setStoragePath] = useState('');
  const [confirmedPath, setConfirmedPath] = useState(''); // what the backend reports
  const [storageVerified, setStorageVerified] = useState(false);
  const [storageError, setStorageError] = useState('');
  const [savingPath, setSavingPath] = useState(false);
  const [diskInfo, setDiskInfo] = useState(null); // { available_bytes, available_formatted, available_tb }

  // STEP 3 — reachability. Seeded from the SAVED probe result so leaving this
  // page and coming back (or reopening the app) still shows the answer you
  // already got — and so the "Verified Seed Node" badge below, which depends on
  // it, doesn't claim you're unreachable simply because you haven't re-tested
  // this session. The saved result never expires and is only replaced by an
  // explicit Re-test. Shape: null | { open, open_v6, …, ts, port? }
  const [reach, setReach] = useState(() => readReachability());
  // PASSIVE inbound-IPv6 observation, read once on mount. Separate from `reach`
  // on purpose: it is sticky and survives a node that has never been probed. A
  // seed node reachable ONLY over IPv6 (the normal outcome on Starlink) is
  // genuinely reachable, and the badge below must not call it unreachable.
  const [v6obs] = useState(() => readIpv6Observation());
  // In flight, kept out of `reach` so a running (or failed) test never blanks
  // the result already on screen.
  const [testing, setTesting] = useState(false);
  const [reachPort, setReachPort] = useState(null);

  // STEP 4 — download
  const [downloading, setDownloading] = useState(false);
  const [batchProgress, setBatchProgress] = useState(null);
  // Files still failing after the download manager's automatic retry passes.
  const [failedItems, setFailedItems] = useState([]);
  const [isPaused, setIsPaused] = useState(false);

  // On unlock, show whatever storage dir the backend already has configured.
  useEffect(() => {
    if (!seedUnlocked) return;
    let cancelled = false;
    (async () => {
      await ensureTauri();
      if (!tauriInvoke) return;
      try {
        const current = await tauriInvoke('get_storage_dir');
        if (!cancelled && current) {
          setConfirmedPath(current);
          setStoragePath(prev => prev || current);
        }
      } catch {}
    })();
    return () => { cancelled = true; };
  }, [seedUnlocked]);

  // Auto-check access on mount: if the admin has enabled this node id in the
  // backend allowlist, unlock the page automatically.
  useEffect(() => {
    if (seedUnlocked || !nodeId) return;
    let cancelled = false;
    (async () => {
      const ok = await checkSeedAccess(nodeId);
      if (cancelled) return;
      // Mirror the server's answer locally — see utils/nodeStatus.js. This is
      // what lets the Connections panel tell a Seed node from a Node.
      writeSeedGranted(ok);
      if (ok) onUnlock(true);
    })();
    return () => { cancelled = true; };
  }, [seedUnlocked, nodeId, onUnlock]);

  const checkAccess = async () => {
    if (!nodeId) return;
    setCheckingAccess(true);
    setAccessMsg('');
    const ok = await checkSeedAccess(nodeId);
    writeSeedGranted(ok);
    if (ok) onUnlock(true);
    else setAccessMsg('Not approved yet. Once the admin enables your node, press "Check access" again.');
    setCheckingAccess(false);
  };

  const submitRequest = async () => {
    if (!nodeId) return;
    setCheckingAccess(true);
    setAccessMsg('');
    const res = await requestSeedAccess(nodeId, reqEmail.trim());
    if (res?.enabled) { writeSeedGranted(true); onUnlock(true); }
    else if (res?.requested) {
      setRequested(true);
      setAccessMsg("Request sent. You'll get access once the admin approves your node — then press \"Check access\".");
    } else {
      setAccessMsg('Could not send the request — check your connection and try again.');
    }
    setCheckingAccess(false);
  };

  // ── STEP 2: browse for + save a REAL storage directory ────────────────────
  const browsePath = useCallback(async () => {
    await ensureTauri();
    if (tauriDialog) {
      try {
        const selected = await tauriDialog.open({ directory: true, title: 'Select Seed Node Storage Location' });
        if (selected) {
          // Immediately apply the chosen folder so downloads actually use it.
          await applyStoragePath(selected);
        }
      } catch (e) {
        console.warn('[SeedNode] Dialog failed:', e);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope]);

  // Apply + verify a storage path: tell the backend to use it (so real
  // downloads land there), read it back for display, then check free space
  // against the current scope's requirement.
  const applyStoragePath = useCallback(async (rawPath) => {
    const path = (rawPath ?? storagePath ?? '').trim();
    if (!path) {
      setStorageError('Please choose a storage folder.');
      return;
    }
    setStoragePath(path);
    setSavingPath(true);
    setStorageError('');
    setStorageVerified(false);
    setDiskInfo(null);

    await ensureTauri();
    if (!tauriInvoke) {
      // Browser mode — no backend; accept the path so the UI can proceed.
      setConfirmedPath(path);
      setStorageVerified(true);
      setSavingPath(false);
      return;
    }

    // 1. Make downloads ACTUALLY use this folder (persisted in settings.json).
    try {
      const saved = await tauriInvoke('set_storage_dir', { path });
      setConfirmedPath(saved || path);
    } catch (e) {
      setStorageError(`Could not set storage folder: ${e}`);
      setSavingPath(false);
      return;
    }

    // 2. Read back the confirmed path from the backend for display.
    try {
      const current = await tauriInvoke('get_storage_dir');
      if (current) setConfirmedPath(current);
    } catch {}

    // 3. Verify free space against the scope requirement.
    const req = SCOPE_INFO[scope];
    try {
      const info = await tauriInvoke('check_disk_space', { path });
      setDiskInfo(info);
      const availableBytes = Number(info?.available_bytes || 0);
      if (availableBytes < req.requiredBytes) {
        setStorageVerified(false);
        setStorageError(
          `Only ${info.available_formatted} free (${info.available_tb} TB) on this drive. ` +
          `The ${req.label.toLowerCase()} needs at least ${req.requiredLabel} of free space.`
        );
      } else {
        setStorageVerified(true);
        setStorageError('');
      }
    } catch (e) {
      // Path saved but space check failed (e.g. df couldn't read it).
      setStorageError(`Storage folder saved, but could not verify free space: ${e}`);
    }
    setSavingPath(false);
  }, [scope, storagePath]);

  // ── STEP 3: reachability test (mirrors ConnectionsPanel) ──────────────────
  const testReachability = useCallback(async () => {
    setTesting(true);
    // Get the node's listening port from the torrent session.
    let port = reachPort;
    try {
      const mod = await ensureTorrent();
      if (mod) {
        const st = await mod.getStatus().catch(() => null);
        port = st?.tcp_listen_port || port;
      }
    } catch {}
    if (!port) {
      setTesting(false);
      setReach({ open: false, port: null, noPort: true, ts: Date.now() });
      return;
    }
    setReachPort(port);

    const result = await probeReachability(port);
    setTesting(false);
    if (result) {
      setReach({ ...result, port, ts: Date.now() });
      saveReachability(result);
      // Register in the backbone directory so new users can find reachable seeds.
      try {
        const scope = (() => { try { return localStorage.getItem('si-seed-scope') || 'audio'; } catch { return 'audio'; } })();
        registerSeed(getNodeId(), port, scope).catch(() => {});
      } catch {}
      return;
    }
    // Probe service unavailable — fall back to canyouseeme.org so the seed
    // node can still confirm the port manually.
    setReach({ open: false, port, manual: true, ts: Date.now() });
    await ensureTauri();
    if (tauriInvoke) {
      try { await tauriInvoke('open_url', { url: 'https://canyouseeme.org/' }); } catch {}
    }
  }, [reachPort]);

  // ── STEP 4: scope-filtered bulk download ──────────────────────────────────
  const runSeedBatch = useCallback(async (toDownload) => {
    if (!downloadManager || toDownload.length === 0) return;
    setDownloading(true);
    setFailedItems([]);

    let result = { failures: [] };
    try {
      // downloadBatch retries each file (backoff + Archive↔CDN fallback) and
      // then automatically re-runs the whole failed set a couple of times
      // before it reports anything as failed.
      result = await downloadManager.downloadBatch(toDownload, (progress) => {
        setBatchProgress({ ...progress });
      });
    } catch (err) {
      console.error('[SeedNode] Batch download error:', err);
    }
    setFailedItems(result.failures || []);
    setDownloading(false);
  }, [downloadManager]);

  const startFullDownload = useCallback(() => {
    const toDownload = scope === 'audio'
      ? catalog.filter(s => s.type === 'audio' && !s.downloaded)
      : catalog.filter(s => !s.downloaded);
    runSeedBatch(toDownload);
  }, [catalog, scope, runSeedBatch]);

  const retryFailed = useCallback(() => {
    const sermons = failedItems.map(f => f.sermon).filter(Boolean);
    runSeedBatch(sermons);
  }, [failedItems, runSeedBatch]);

  const togglePause = useCallback(() => {
    if (!downloadManager) return;
    if (isPaused) {
      downloadManager.resume();
      setIsPaused(false);
    } else {
      downloadManager.pause();
      setIsPaused(true);
    }
  }, [downloadManager, isPaused]);

  // ── Scope-aware counts ────────────────────────────────────────────────────
  const scopeInfo = SCOPE_INFO[scope];
  const inScope = scope === 'audio'
    ? catalog.filter(s => s.type === 'audio')
    : catalog;
  const scopeTotal = inScope.length;
  const scopeDownloaded = inScope.filter(s => s.downloaded).length;
  const scopeRemaining = scopeTotal - scopeDownloaded;
  const scopePercent = scopeTotal > 0 ? (scopeDownloaded / scopeTotal) * 100 : 0;

  const displayProgress = batchProgress
    ? { completed: batchProgress.completed, total: batchProgress.total, failed: batchProgress.failed, percent: batchProgress.progress, retrying: !!batchProgress.retrying }
    : { completed: scopeDownloaded, total: scopeTotal, failed: 0, percent: scopePercent, retrying: false };

  // ─── LOCKED STATE ─────────────────────────────────────────────────

  if (!seedUnlocked) {
    return (
      <div className="settings-page-root">
        <div className="page-header-wide">
          <div className="page-header">
            <h2 style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <span style={{ display: 'inline-flex', color: 'var(--gold-text)' }}>{iconCircuitry}</span> Become a Seed Node
            </h2>
            <p>Seed nodes carry the sermon library and serve it to the global peer network</p>
          </div>
        </div>

        {/* Full-width intro band, spanning both columns below. */}
        <div className="page-header-wide">
          <SeedNodeHero />
        </div>

        {/* Two columns (the shared Settings/Connections layout).
            LEFT  — the one thing to DO on this page: request access.
            RIGHT — the long explanation of what a seed node is, including the
                    expandable hardware guide. Keeping the action and the
                    explanation side by side means neither buries the other. */}
        <div className="connections-layout">
        <div className="connections-left">

        <div className="seed-card">
          <h3 style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>{iconLock} Request Seed Node Access</h3>
          <p>
            Seed node access is granted per device by the SermonIndex admin — the seed nodes are the
            trusted backbone of the peer-to-peer network. Your node's unique ID is:
          </p>

          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', margin: '10px 0' }}>
            <code style={{ fontSize: '1rem', fontWeight: 700, color: 'var(--gold-text)', background: 'var(--bg-tertiary)', padding: '6px 12px', borderRadius: '6px', letterSpacing: '0.5px' }}>
              #{(nodeId || '').slice(0, 8)}
            </code>
            <button
              className="btn"
              onClick={() => { try { navigator.clipboard.writeText(nodeId); setAccessMsg('Full node ID copied to clipboard.'); } catch {} }}
              style={{ padding: '6px 12px', background: 'var(--bg-tertiary)', border: '1px solid var(--border)', color: 'var(--text-secondary)', borderRadius: '6px', cursor: 'pointer', fontSize: '0.78rem' }}
            >
              Copy full ID
            </button>
          </div>

          <p>
            Enter your email and request access below — or email{' '}
            <a href={`mailto:${SEED_CONTACT_EMAIL}`} style={{ color: 'var(--gold-text)' }}>{SEED_CONTACT_EMAIL}</a>{' '}
            with the node ID above. Once the admin enables your node, press <strong>Check access</strong>.
          </p>

          <div style={{ display: 'flex', gap: '10px', marginTop: '8px', flexWrap: 'wrap' }}>
            <input
              type="email"
              placeholder="you@example.com"
              value={reqEmail}
              onChange={e => setReqEmail(e.target.value)}
              style={{ flex: 1, minWidth: '180px' }}
            />
            <button className="btn btn-gold" onClick={submitRequest} disabled={checkingAccess || requested}>
              {requested ? 'Requested ✓' : 'Request access'}
            </button>
            <button
              className="btn"
              onClick={checkAccess}
              disabled={checkingAccess}
              style={{ padding: '8px 14px', background: 'var(--bg-tertiary)', border: '1px solid var(--border)', color: 'var(--text-secondary)', borderRadius: '6px', cursor: checkingAccess ? 'default' : 'pointer' }}
            >
              {checkingAccess ? 'Checking…' : 'Check access'}
            </button>
          </div>
          {accessMsg && <p style={{ color: 'var(--text-secondary)', fontSize: '0.82rem', marginTop: '8px' }}>{accessMsg}</p>}
        </div>

        </div>

        {/* ── RIGHT: what a seed node is ── */}
        <div className="connections-right">

        <div className="seed-card">
          <h3 style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ display: 'inline-flex', color: 'var(--gold-text)' }}>{iconCircuitry}</span> What is a Seed Node?
          </h3>
          <p>
            SermonIndex is built on a peer-to-peer network where every user helps share sermon content.
            Regular users share the sermons they've listened to. <strong>Seed nodes</strong> go further — they
            download and serve a large portion of the <strong>whole library</strong> so it can never be lost.
          </p>
          <p>
            You choose how much to host. <strong>Audio-only</strong> is the practical, common choice:
            <strong style={{ color: 'var(--gold-text)' }}> ~412 GB</strong> (25,587 sermons) that fits on a
            cheap external drive. Hosting <strong>everything, including video</strong>, is
            <strong style={{ color: 'var(--gold-text)' }}> ~2.4 TB</strong> and needs a large drive.
          </p>
          <p style={{ marginBottom: showHardware ? '10px' : undefined }}>
            We recommend a dedicated NVMe or USB external drive. See our{' '}
            <span
              role="button"
              tabIndex={0}
              aria-expanded={showHardware}
              onClick={() => setShowHardware(v => !v)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setShowHardware(v => !v); } }}
              style={{
                color: 'var(--gold-text)', fontWeight: 600, cursor: 'pointer',
                display: 'inline-flex', alignItems: 'center', gap: '3px',
              }}
            >
              hardware setup guide
              <span style={{
                display: 'inline-block', fontSize: '0.85em', lineHeight: 1,
                transform: showHardware ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s ease',
              }}>
                ▾
              </span>
            </span>{' '}
            for a couple of simple, practical recommendations.
          </p>
          {showHardware && (
            <div style={{
              margin: '0 0 4px',
              padding: '14px 16px',
              background: 'var(--bg-tertiary)',
              border: '1px solid var(--border)',
              borderLeft: '3px solid var(--gold-text)',
              borderRadius: '8px',
              fontSize: '0.85rem',
              color: 'var(--text-secondary)',
              lineHeight: 1.6,
            }}>
              <div style={{ marginBottom: '12px' }}>
                <div style={{ fontWeight: 600, color: 'var(--gold-text)', marginBottom: '3px' }}>
                  Option A — External NVMe drive (simplest)
                </div>
                <div>
                  A <strong style={{ color: 'var(--text-primary)' }}>TerraMaster D4 SSD</strong> (NVMe)
                  enclosure fitted with NVMe SSD sticks, plugged into your Mac or PC. Size it to your
                  scope: <strong style={{ color: 'var(--gold-text)' }}>~500 GB</strong> is plenty for the
                  audio library (~412 GB), or{' '}
                  <strong style={{ color: 'var(--gold-text)' }}>~2.6 TB+</strong> if you also seed video
                  (~2.4 TB). SSD/NVMe runs quieter and more reliably than spinning drives for an
                  always-on node.
                </div>
              </div>
              <div style={{ marginBottom: '12px' }}>
                <div style={{ fontWeight: 600, color: 'var(--gold-text)', marginBottom: '3px' }}>
                  Option B — Dedicated low-power node (Raspberry Pi)
                </div>
                <div>
                  A <strong style={{ color: 'var(--text-primary)' }}>Raspberry Pi 5 (8 GB)</strong> in a{' '}
                  <strong style={{ color: 'var(--text-primary)' }}>Pironman 5</strong> (Pro/Max) case with
                  an NVMe SSD — a small, quiet box that sips power and stays out of the way. Leave it on
                  24/7 to keep serving the library without tying up your main computer.
                </div>
              </div>
              <div style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>
                Either way: pick a drive sized for your chosen scope (audio vs everything), keep the node
                powered on and online as much as possible — a reachable, port-forwarded node helps the
                network the most.
              </div>
            </div>
          )}
          <p>
            With seed nodes distributed across the world, the sermon library becomes essentially
            indestructible. No single point of failure. No government can censor it. The content lives
            on across the body of Christ.
          </p>
          <p style={{ color: 'var(--gold-text)', fontStyle: 'italic', marginBottom: 0 }}>
            "How beautiful on the mountains are the feet of those who bring good news" — Isaiah 52:7
          </p>
        </div>

        </div>
        </div>
      </div>
    );
  }

  // ─── UNLOCKED STATE ───────────────────────────────────────────────

  return (
    <div className="settings-page-root">
      <div className="page-header-wide">
        <div className="page-header">
          <h2 style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <span style={{ display: 'inline-flex', color: 'var(--gold-text)' }}>{iconCircuitry}</span> Seed Node Active
          </h2>
          <p>You are helping carry the sermon library for the global network</p>
        </div>
      </div>

      {/* Full-width intro band, spanning both columns below. */}
      <div className="page-header-wide">
        <SeedNodeHero />
      </div>

      {/* Two columns (the shared Settings/Connections layout).
          This page is a numbered setup flow, so Steps 1–4 stay together in ONE
          column, in order, top to bottom — splitting a "step 1, 2, 3, 4"
          sequence across two columns would make the order ambiguous. Only the
          genuinely independent cards (updates, live status readout, contact)
          move to the right, where the status figures now sit alongside the
          steps that produce them instead of far below them. */}
      <div className="connections-layout">
      <div className="connections-left">

      {/* Step 1: Choose what to host */}
      <div className="seed-card">
        <h3>Step 1: Choose What to Host</h3>
        <p>
          Pick how much of the library your node will hold. Audio-only is the common choice and fits
          a small drive; the full set adds every video and needs a large drive. You can start with
          audio and expand later.
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '12px', marginTop: '12px' }}>
          {['audio', 'full'].map((key) => {
            const info = SCOPE_INFO[key];
            const active = scope === key;
            return (
              <button
                key={key}
                type="button"
                onClick={() => setScopePersisted(key)}
                style={{
                  textAlign: 'left',
                  padding: '14px 16px',
                  borderRadius: '10px',
                  cursor: 'pointer',
                  background: active ? 'rgba(212,175,55,0.10)' : 'var(--bg-tertiary)',
                  border: `2px solid ${active ? 'var(--gold-text)' : 'var(--border)'}`,
                  transition: 'border-color 0.15s ease, background 0.15s ease',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '6px' }}>
                  <span style={{
                    width: 18, height: 18, borderRadius: '50%', flexShrink: 0,
                    border: `2px solid ${active ? 'var(--gold-text)' : 'var(--border-light)'}`,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}>
                    {active && <span style={{ width: 9, height: 9, borderRadius: '50%', background: 'var(--gold-text)' }} />}
                  </span>
                  <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{info.label}</span>
                  {key === 'audio' && (
                    <span style={{
                      fontSize: '0.62rem', fontWeight: 700, letterSpacing: '0.5px', textTransform: 'uppercase',
                      color: 'var(--gold-text)', background: 'rgba(212,175,55,0.15)',
                      padding: '2px 7px', borderRadius: '10px',
                    }}>
                      Recommended
                    </span>
                  )}
                </div>
                <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', lineHeight: 1.5, paddingLeft: '28px' }}>
                  {info.tagline}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Step 2: Storage location (real) */}
      <div className="seed-card">
        <h3>Step 2: Choose Your Storage Location</h3>
        <p>
          Pick a folder on a drive with at least{' '}
          <strong style={{ color: 'var(--gold-text)' }}>{scopeInfo.requiredLabel}</strong> of free space
          — the {scopeInfo.label.toLowerCase()} is {scopeInfo.sizeLabel}. We recommend a dedicated external
          NVMe drive — for example a <strong style={{ color: 'var(--gold-text)' }}>TerraMaster D4</strong> NVMe
          enclosure with NVMe sticks, or a <strong style={{ color: 'var(--gold-text)' }}>Raspberry Pi 5</strong> in
          a Pironman 5 case with an NVMe SSD for a quiet, always-on node.
        </p>
        <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
          Downloads and seeding will use this exact folder. Changing it only affects future downloads —
          files already on disk stay where they are.
        </p>

        <div style={{ display: 'flex', gap: '8px', marginTop: '8px', alignItems: 'center' }}>
          <input
            type="text"
            placeholder="/Volumes/SermonIndex-Drive/sermons"
            value={storagePath}
            onChange={e => { setStoragePath(e.target.value); setStorageVerified(false); setStorageError(''); }}
            onKeyDown={e => e.key === 'Enter' && applyStoragePath()}
            style={{ flex: 1 }}
          />
          <button
            className="btn"
            onClick={browsePath}
            style={{ whiteSpace: 'nowrap', padding: '6px 14px', background: 'var(--bg-tertiary)', border: '1px solid var(--border)', color: 'var(--text-secondary)', borderRadius: '6px', cursor: 'pointer', fontSize: '0.82rem' }}
          >
            Browse...
          </button>
          <button
            className="btn btn-gold"
            onClick={() => applyStoragePath()}
            disabled={savingPath}
          >
            {savingPath ? 'Checking...' : 'Use & Verify'}
          </button>
        </div>

        {confirmedPath && (
          <p style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', marginTop: '10px' }}>
            Downloads will be saved to:{' '}
            <span style={{ fontFamily: 'monospace', color: 'var(--text-primary)' }}>{confirmedPath}</span>
          </p>
        )}

        {storageError && (
          <p style={{ color: 'var(--red)', fontSize: '0.82rem', marginTop: '8px' }}>✕ {storageError}</p>
        )}
        {storageVerified && !storageError && (
          <p style={{ color: 'var(--green)', fontSize: '0.82rem', marginTop: '8px' }}>
            ✓ Storage set and space verified
            {diskInfo ? ` — ${diskInfo.available_formatted} free (${diskInfo.available_tb} TB), enough for the ${scopeInfo.label.toLowerCase()} at ${scopeInfo.sizeLabel}.` : '.'}
          </p>
        )}
      </div>

      {/* Step 3: Reachability */}
      <div className="seed-card">
        <h3>Step 3: Verify You're Reachable</h3>
        <p>
          Seed nodes are most valuable when other peers can connect <em>directly</em> to your node.
          This test checks whether your node's port is reachable from the internet.
        </p>

        <div style={{ display: 'flex', gap: '10px', alignItems: 'center', marginTop: '8px' }}>
          <button className="btn btn-gold" onClick={testReachability} disabled={testing}>
            {testing ? 'Testing…' : reach ? 'Re-test' : 'Test Reachability'}
          </button>
          {reachPort && (
            <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
              Node port: <strong style={{ color: 'var(--text-primary)' }}>{reachPort}</strong>
            </span>
          )}
          {/* The result is kept indefinitely and never re-probed on its own, so
              its age is shown alongside the button that refreshes it. */}
          {!testing && reach?.ts && (
            <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
              Last tested {timeAgo(reach.ts)}
            </span>
          )}
        </div>

        {reach && !testing && (
          reach.open ? (
            <p style={{ color: 'var(--green)', fontSize: '0.85rem', marginTop: '12px', fontWeight: 600 }}>
              ✓ Reachable — you're strengthening the backbone.
            </p>
          ) : reach.open_v6 ? (
            /* IPv4 closed, IPv6 open. A full, reachable seed node — just over the
               newer kind of address. No port-forward steps: there is nothing to
               forward, and on Starlink or mobile broadband there never will be. */
            <div style={{ marginTop: '12px' }}>
              <p style={{ color: 'var(--green)', fontSize: '0.85rem', fontWeight: 600, marginBottom: '6px' }}>
                ✓ Reachable over IPv6 — you're strengthening the backbone.
              </p>
              <p style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', lineHeight: 1.6, margin: 0 }}>
                We connected to your node from outside, so other people can too. They reach you on the newer
                kind of internet address (IPv6). The older kind (IPv4) is closed, which is completely normal on
                Starlink, T-Mobile Home Internet and mobile broadband — those providers share one old-style
                address between many homes but give each home a real modern one. There&rsquo;s nothing here for
                you to change or forward.
              </p>
            </div>
          ) : (
            <div style={{ marginTop: '12px' }}>
              {/* Peer colour — the same one the node map uses for a port-closed
                  node (NODE_COLORS.peer → var(--gold-text) in NetworkPage.jsx). */}
              <p style={{ color: reach.noPort ? 'var(--orange)' : 'var(--gold-text)', fontSize: '0.85rem', fontWeight: 600, marginBottom: '8px' }}>
                {reach.noPort
                  ? 'Not reachable yet — the P2P session isn\'t running, so there\'s no port to test. Start the node, then test again.'
                  /* A result restored from a previous session has no port recorded,
                     so fall back to neutral wording rather than "Port undefined". */
                  : `${reach.port || reachPort ? `Port ${reach.port || reachPort}` : "Your node's port"} isn't reachable from outside — your node still uploads to every peer it reaches, but others can't connect to you.`}
              </p>
              {!reach.noPort && (
                <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                  {/* Explain the cause nobody can fix BEFORE the router steps —
                      a seed node on Starlink or mobile broadband will never be
                      able to follow them, and shouldn't be sent chasing. */}
                  <CgnatNotice
                    detected={!!reach.cgnat}
                    v6Firewalled={!!reach.has_ipv6 && reach.v6_probe === 'ok' && reach.open_v6 === false}
                    style={{ marginTop: 0, marginBottom: '10px' }}
                  />
                  <p style={{ margin: '0 0 6px' }}>If your connection does allow it, the quickest fixes are:</p>
                  <p style={{ margin: '0 0 4px' }}>
                    1. In your router settings, turn on <strong>UPnP</strong>, then restart this app.
                  </p>
                  <p style={{ margin: '0 0 6px' }}>
                    2. Or add a port forward: <strong>TCP {reach.port || reachPort || "your node's port"}</strong> (or the range
                    {' '}<strong>{TORRENT_PORT_RANGE}</strong>) pointing to this computer.
                  </p>
                  {reach.manual && (
                    <p style={{ margin: 0, color: 'var(--text-muted)' }}>
                      Opened canyouseeme.org — enter port <strong>{reach.port}</strong> there to double-check.
                    </p>
                  )}
                </div>
              )}
            </div>
          )
        )}
      </div>

      {/* Step 4: Download the library (scope-filtered) */}
      <div className="seed-card" style={{ opacity: storageVerified ? 1 : 0.4, pointerEvents: storageVerified ? 'auto' : 'none' }}>
        <h3>Step 4: Download the {scope === 'audio' ? 'Audio Library' : 'Full Library'}</h3>
        <p>
          Download the {scopeInfo.label.toLowerCase()} to your drive. The total size is approximately{' '}
          <strong style={{ color: 'var(--gold-text)' }}>{scopeInfo.sizeLabel}</strong>
          {' '}({scopeTotal.toLocaleString()} {scope === 'audio' ? 'sermons' : 'files'}).
        </p>
        <p style={{ fontSize: '0.82rem', color: 'var(--text-muted)' }}>
          This can take <strong>several days or weeks</strong> depending on your connection speed. The download will
          automatically resume if you shut down the computer and turn it back on. You can pause and resume anytime.
        </p>

        {!downloading ? (
          <div style={{ marginTop: '12px' }}>
            <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '16px' }}>
              Already downloaded: <strong style={{ color: 'var(--gold-text)' }}>{scopeDownloaded.toLocaleString()}</strong>
              {' '}· Remaining: <strong>{scopeRemaining.toLocaleString()}</strong>
            </p>
            {failedItems.length > 0 && (
              <div style={{
                padding: '12px 14px', marginBottom: '14px', borderRadius: 'var(--radius)',
                background: 'var(--bg-tertiary)', border: '1px solid var(--red)',
              }}>
                <div style={{ fontWeight: 600, color: 'var(--red)', marginBottom: '4px' }}>
                  {failedItems.length} file{failedItems.length === 1 ? '' : 's'} failed after retries
                </div>
                <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginBottom: '10px' }}>
                  Every other file finished. These are usually temporary source hiccups (rate limiting or a
                  dropped connection) — retrying later almost always clears them.
                </div>
                <button className="btn btn-gold" onClick={retryFailed}>Retry failed ({failedItems.length})</button>
              </div>
            )}
            {scopeRemaining > 0 ? (
              <button className="btn btn-gold" onClick={startFullDownload}>
                {scopeDownloaded > 0 ? `Resume ${scope === 'audio' ? 'Audio' : 'Full'} Library Download` : `Start ${scope === 'audio' ? 'Audio' : 'Full'} Library Download`}
              </button>
            ) : (
              <p style={{ color: 'var(--green)', fontWeight: 600 }}>
                ✓ {scope === 'audio' ? 'Audio library' : 'Full library'} downloaded! You are a complete seed node.
              </p>
            )}
          </div>
        ) : (
          <div className="seed-progress">
            <div className="seed-progress-bar">
              <div
                className="seed-progress-fill"
                style={{ width: `${displayProgress.percent}%` }}
              ></div>
            </div>
            <div className="seed-progress-text">
              <span>{displayProgress.completed.toLocaleString()} of {displayProgress.total.toLocaleString()} files</span>
              <span>{displayProgress.percent.toFixed(1)}% complete</span>
            </div>
            {displayProgress.failed > 0 && (
              <p style={{ fontSize: '0.75rem', color: 'var(--red)', marginTop: '6px' }}>
                {displayProgress.failed} file{displayProgress.failed === 1 ? '' : 's'} failed so far
                {displayProgress.retrying ? ' — retrying them now…' : ' — they are retried automatically at the end of the run'}
              </p>
            )}
            <div style={{ marginTop: '12px', display: 'flex', gap: '10px' }}>
              <button className="btn btn-gold" onClick={togglePause}>
                {isPaused ? '▶ Resume' : '⏸ Pause'}
              </button>
            </div>
            <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '12px' }}>
              Downloading from Archive.org (free) with Bunny CDN fallback · Each file is seeded to the P2P network
              {displayProgress.percent >= 100 && ' · Download complete!'}
            </p>
          </div>
        )}
      </div>

      </div>

      {/* ── RIGHT: independent of the step sequence ── */}
      <div className="connections-right">

      {/* Updates section */}
      <div className="seed-card">
        <h3>Library Updates</h3>
        <p>
          When new sermons are added to SermonIndex, they'll appear here. You can choose to download
          the new batch to keep your seed node fully up to date.
        </p>
        <p style={{ fontSize: '0.82rem', color: 'var(--text-muted)' }}>
          No updates available at this time. We'll notify you when new content is ready.
        </p>
      </div>

      {/* Status */}
      <div className="seed-card">
        <h3>Your Seed Node Status</h3>

        {/* Verified badge — a real seed node holds ~all of its scope on disk AND
            is reachable so peers can actually pull from it. Both are measured,
            not claimed: coverage from files on disk, reachability from the probe
            OR from a real peer that connected in over IPv6. (It used to test
            `reach.open` alone, which wrongly told every IPv6-only-reachable seed
            node — Starlink, mobile broadband — that it was unreachable.) */}
        {(() => {
          const reachableSeed = isReachable({ reach, ipv6: v6obs });
          const verified = scopeTotal > 0 && (scopePercent >= 95) && reachableSeed;
          const nearly = scopeTotal > 0 && scopePercent >= 95 && !reachableSeed;
          return (
            <div style={{
              display: 'flex', alignItems: 'center', gap: '10px',
              padding: '12px 14px', marginBottom: '14px', borderRadius: 'var(--radius)',
              background: verified ? 'rgba(61,138,65,0.10)' : 'var(--bg-tertiary)',
              border: `1px solid ${verified ? 'rgba(61,138,65,0.35)' : 'var(--border)'}`,
            }}>
              <span style={{ fontSize: '1.4rem' }}>{verified ? '✓' : '◐'}</span>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 700, color: verified ? 'var(--green)' : 'var(--text-primary)' }}>
                  {verified ? 'Verified Seed Node' : nearly ? 'Library complete — not yet reachable' : 'Not yet a full seed node'}
                </div>
                <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                  {verified
                    ? `Hosting ${scopePercent.toFixed(1)}% of the ${scopeInfo.label.toLowerCase()} and reachable from the internet — you are backbone.`
                    : nearly
                      ? `You hold ${scopePercent.toFixed(1)}% of the ${scopeInfo.label.toLowerCase()}, but your port isn't reachable. Forward the port (Step 3) to become verified.`
                      : `${scopePercent.toFixed(1)}% of the ${scopeInfo.label.toLowerCase()} downloaded. A verified seed node holds ~95%+ and is reachable.`}
                </div>
              </div>
            </div>
          );
        })()}

        <div className="settings-row">
          <div>
            <div style={{ fontWeight: 500 }}>Hosting</div>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>What this node is set to carry</div>
          </div>
          <span style={{ color: 'var(--gold-text)', fontWeight: 600 }}>{scopeInfo.label} · {scopeInfo.sizeLabel}</span>
        </div>
        <div className="settings-row">
          <div>
            <div style={{ fontWeight: 500 }}>Library Coverage</div>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Percentage of the chosen library held locally</div>
          </div>
          <span style={{ color: 'var(--gold-text)', fontWeight: 600 }}>{scopeTotal > 0 ? Math.round(scopePercent) : 0}%</span>
        </div>
        <div className="settings-row">
          <div>
            <div style={{ fontWeight: 500 }}>Files Seeded</div>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Sermons stored and shared on the P2P network</div>
          </div>
          <span style={{ color: 'var(--text-secondary)' }}>{scopeDownloaded.toLocaleString()} / {scopeTotal.toLocaleString()}</span>
        </div>
        <div className="settings-row">
          <div>
            <div style={{ fontWeight: 500 }}>Storage Used</div>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Disk space used by downloaded sermons</div>
          </div>
          <span style={{ color: 'var(--text-secondary)' }}>{libraryStats?.downloadedSize || '0 B'}</span>
        </div>
        <div className="settings-row">
          <div>
            <div style={{ fontWeight: 500 }}>Storage Path</div>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Where sermons are stored on disk</div>
          </div>
          <span style={{ fontSize: '0.75rem', fontFamily: 'monospace', color: 'var(--text-secondary)' }}>
            {confirmedPath || storagePath || 'Not set'}
          </span>
        </div>
        <div className="settings-row" style={{ border: 'none' }}>
          <div>
            <div style={{ fontWeight: 500 }}>Download Status</div>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Current download queue</div>
          </div>
          <span style={{ color: isPaused ? 'var(--gold)' : downloading ? '#4caf50' : 'var(--text-muted)' }}>
            {isPaused ? 'Paused' : downloading ? 'Active' : 'Idle'}
          </span>
        </div>
      </div>

      {/* Contact */}
      <div className="seed-card">
        <p style={{ fontSize: '0.82rem', color: 'var(--text-muted)', marginBottom: 0 }}>
          Questions about seed nodes? Email{' '}
          <a href={`mailto:${SEED_CONTACT_EMAIL}`} style={{ color: 'var(--gold-text)' }}>{SEED_CONTACT_EMAIL}</a>
        </p>
      </div>

      </div>
      </div>
    </div>
  );
}
