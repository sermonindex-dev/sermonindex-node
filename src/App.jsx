import React, { useState, useRef, useEffect, useCallback, Component } from 'react';
import Sidebar from './components/Sidebar';
import TopBar from './components/TopBar';
import PlayerBar from './components/PlayerBar';
import DonateBanner from './components/DonateBanner';
import ImageContextMenu from './components/ImageContextMenu';
import DashboardPage from './pages/DashboardPage';
import LibraryPage from './pages/LibraryPage';
import DownloadsPage from './pages/DownloadsPage';
import BulkDownloadPage from './pages/BulkDownloadPage';
import SeedNodePage from './pages/SeedNodePage';
import StatsPage from './pages/StatsPage';
import SettingsPage from './pages/SettingsPage';
import ConnectionsPage from './pages/ConnectionsPage';
import NetworkPage from './pages/NetworkPage';
import CommunityPage from './pages/CommunityPage';
import AboutPage from './pages/AboutPage';
import ConditionsModal from './components/ConditionsModal';
import { CONDITIONS_VERSION } from './data/conditions.jsx';

// Error boundary to prevent full app crashes.
//
// RECOVERY: "Try Again" used to do nothing but flip `hasError` back to false,
// which re-rendered the EXACT component tree that had just thrown — so it either
// crashed again immediately or sat there looking fixed while the underlying
// state was still bad. Two changes make it mean something:
//   1. `resetKey` is bumped on retry and keyed onto the children, so React
//      unmounts and REMOUNTS the whole subtree instead of re-rendering it. Any
//      corrupt component state is discarded rather than replayed.
//   2. `onReset` lets the owner clear the app-level state that caused the crash
//      (stop playback, drop the current sermon, return to a safe page) before
//      the remount happens.
// "Reload app" is the honest last resort when a remount isn't enough.
class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null, resetKey: 0 };
  }
  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }
  componentDidCatch(error, errorInfo) {
    console.error('[App] Uncaught error:', error, errorInfo);
  }
  handleRetry = () => {
    // Clear the offending app state FIRST — the remount below must not walk
    // straight back into it. A throwing reset handler must not block recovery.
    try { this.props.onReset?.(); } catch (e) { console.warn('[App] Error-boundary reset handler failed:', e); }
    this.setState((s) => ({ hasError: false, error: null, resetKey: s.resetKey + 1 }));
  };
  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: '48px', textAlign: 'center', background: 'var(--bg-primary)', color: 'var(--text-primary)', minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
          <h2 style={{ color: 'var(--gold-text)', marginBottom: '16px' }}>Something went wrong</h2>
          <p style={{ color: 'var(--text-secondary)', marginBottom: '24px', maxWidth: '400px' }}>
            The app encountered an unexpected error. This has been logged.
          </p>
          <p style={{ fontFamily: 'monospace', fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '24px', maxWidth: '500px', wordBreak: 'break-all' }}>
            {this.state.error?.message || 'Unknown error'}
          </p>
          <div style={{ display: 'flex', gap: '12px' }}>
            <button
              onClick={this.handleRetry}
              style={{ background: '#D4AF37', color: '#2a2a14', border: 'none', padding: '10px 24px', borderRadius: '8px', fontWeight: 700, cursor: 'pointer', fontSize: '0.9rem' }}
            >
              Try Again
            </button>
            <button
              onClick={() => window.location.reload()}
              style={{ background: 'transparent', color: 'var(--text-secondary)', border: '1px solid var(--border)', padding: '10px 24px', borderRadius: '8px', fontWeight: 600, cursor: 'pointer', fontSize: '0.9rem' }}
            >
              Reload app
            </button>
          </div>
        </div>
      );
    }
    // Keyed so a retry REMOUNTS the subtree rather than re-rendering the state
    // that just threw. Downloads and seeding live in module-level singletons, not
    // in this tree, so a remount never interrupts them.
    return <React.Fragment key={this.state.resetKey}>{this.props.children}</React.Fragment>;
  }
}
import {
  initCatalog,
  getCatalog,
  searchCatalog,
  getDownloaded,
  getLibraryStats,
  markDownloaded,
  markRemoved,
  revalidateDownloads,
} from './services/catalog.js';
import downloadManager, { DL_STATE, SOURCE_MODE } from './services/downloadManager.js';
import { startHeartbeat, stopHeartbeat, fetchConfig, loadNodeIdFromDisk } from './services/heartbeat.js';
import { loadSettings, saveSettings } from './services/tauriStore.js';
import { startUpdateChecks } from './services/updater.js';
import { fetchUnreadCount, chatPrefs } from './services/chatNotify.js';
import { fetchSeeds, readReachability, readIpv6Observation } from './services/network.js';
import { subscribe as subscribeNodeMap } from './services/nodeMapStore.js';
import { to12h } from './utils/time.js';
import { deriveNodeState, isReachable, writeSeedGranted } from './utils/nodeStatus.js';

// ── Seeding-policy helpers (task 108) + low-disk floor (task 105) ────────────
// "Off" is represented as a tiny ~1 KB/s cap, NOT 0 — the native set_upload_limit
// command treats 0 as UNLIMITED, so passing 0 would REMOVE the throttle instead
// of applying it. 1 KB/s is effectively paused seeding while remaining a valid cap.
const UPLOAD_OFF_BYTES = 1024;                            // ~1 KB/s ≈ seeding off
const LOW_DISK_THRESHOLD_BYTES = 2 * 1024 * 1024 * 1024;  // 2 GB free-space floor

// ── Consent flag mirrored to disk, for the Rust side ────────────────────────
// The first-launch agreement lives in localStorage, which the Rust backend
// cannot read. The Rust liveness-ping task (a 3-minute tokio interval that
// POSTs to /api/node/ping so the dashboard doesn't mark us OFFLINE when macOS
// App Nap throttles the JS heartbeat) must never transmit anything before
// consent, so we mirror the flag into the same settings.json the heartbeat
// writes `node_id` into. Read-modify-write so we never clobber other keys.
async function persistConsentFlag(agreed) {
  try {
    const current = await loadSettings();
    const settings = { ...(current || {}) };
    if (settings.conditions_agreed === !!agreed) return; // already correct — don't rewrite
    settings.conditions_agreed = !!agreed;
    await saveSettings(settings);
  } catch (e) {
    console.warn('[App] Persist consent flag failed:', e?.message || e);
  }
}

// Parse "HH:MM" (24h) → minutes since midnight, or null when malformed.
function hhmmToMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (!Number.isFinite(h) || !Number.isFinite(min)) return null;
  return (h % 24) * 60 + min;
}

// True when the current LOCAL time falls inside [start, end) — correctly handling
// windows that cross midnight (e.g. 23:00 → 07:00). Malformed or zero-length
// inputs fail OPEN (treated as "always seed") so a bad time never silently
// kills seeding.
function isWithinSeedWindow(startStr, endStr, now = new Date()) {
  const start = hhmmToMinutes(startStr);
  const end = hhmmToMinutes(endStr);
  if (start === null || end === null || start === end) return true;
  const cur = now.getHours() * 60 + now.getMinutes();
  return start < end ? (cur >= start && cur < end) : (cur >= start || cur < end);
}

// User-facing view of the seeding window, derived from the SAME window math the
// policy effect enforces (isWithinSeedWindow above) — never re-derived elsewhere.
// Outside the window uploads are clamped to UPLOAD_OFF_BYTES, so BitTorrent peers
// drift away and the peer count falls; without this the drop looks like a bug.
// Returns all-null/false (i.e. "say nothing") when the schedule is off, the times
// are malformed, or start === end — the same cases isWithinSeedWindow fails OPEN on.
function computeSeedStatus(enabled, startStr, endStr, now = new Date()) {
  const start = hhmmToMinutes(startStr);
  const end = hhmmToMinutes(endStr);
  if (!enabled || start === null || end === null || start === end) {
    return { throttled: false, resumesAt: null, windowLabel: null };
  }
  const inWindow = isWithinSeedWindow(startStr, endStr, now);
  return {
    throttled: !inWindow,
    resumesAt: inWindow ? null : to12h(startStr), // when seeding picks back up
    windowLabel: `${to12h(startStr)} – ${to12h(endStr)}`,
  };
}

// This calendar month's key in the node's LOCAL time, e.g. "2026-07".
function currentMonthKey(now = new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

// Bytes uploaded so far THIS month, derived from the lifetime accumulator that
// heartbeat.js maintains (localStorage `si-uploaded-lifetime`). We stash a
// per-month baseline in `si-upload-month` = { month, baseLifetime }; usage =
// lifetime − baseLifetime. The baseline resets whenever the month string changes
// (or the lifetime counter goes backwards, e.g. localStorage was cleared). Pass
// persist=false for a read-only peek that never rewrites the baseline.
function monthlyUploadedBytes(persist = true) {
  try {
    let lifetime = 0;
    const raw = localStorage.getItem('si-uploaded-lifetime');
    if (raw) lifetime = Number(JSON.parse(raw).lifetime) || 0;
    const month = currentMonthKey();
    let rec = null;
    try { rec = JSON.parse(localStorage.getItem('si-upload-month') || 'null'); } catch {}
    if (!rec || rec.month !== month || Number(rec.baseLifetime) > lifetime) {
      rec = { month, baseLifetime: lifetime };
      if (persist) { try { localStorage.setItem('si-upload-month', JSON.stringify(rec)); } catch {} }
    }
    return Math.max(0, lifetime - (Number(rec.baseLifetime) || 0));
  } catch { return 0; }
}

export default function App() {
  const [page, setPage] = useState('dashboard');
  const [search, setSearch] = useState('');
  const [catalog, setCatalog] = useState([]);
  const [currentSermon, setCurrentSermon] = useState(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(0.8);
  const [contentMode, setContentMode] = useState('cdn');
  const [nodeOnline, setNodeOnline] = useState(true);
  const [nodeStats, setNodeStats] = useState({
    peersConnected: 0,
    filesShared: 0,
    storageUsed: '0 B',
  });
  const [seedUnlocked, setSeedUnlocked] = useState(false);
  // Live refs so the heartbeat's getStats callback (set up once) reads current
  // values instead of the ones captured at first render (audit M2).
  const contentModeRef = useRef('cdn');
  const seedUnlockedRef = useRef(false);
  useEffect(() => { contentModeRef.current = contentMode; }, [contentMode]);
  useEffect(() => { seedUnlockedRef.current = seedUnlocked; }, [seedUnlocked]);
  const [downloadStates, setDownloadStates] = useState({});
  const [libraryStats, setLibraryStats] = useState(null);
  const [bandwidthLimit, setBandwidthLimitState] = useState(0);
  const [storageLimit, setStorageLimitState] = useState(0);
  const [backgroundMode, setBackgroundMode] = useState(true);
  // Opt-in BitTorrent UPLOAD throttle (task 93). Default OFF = unlimited, so
  // nothing changes for existing users unless they turn it on.
  const [uploadLimitEnabled, setUploadLimitEnabled] = useState(false);
  const [uploadLimitKbps, setUploadLimitKbps] = useState(500); // KB/s, applied only when enabled
  // Seeding schedule + monthly upload cap (task 108) — opt-in, DEFAULT OFF so
  // existing users seed continuously exactly as before until they turn these on.
  const [seedScheduleEnabled, setSeedScheduleEnabled] = useState(false);
  const [seedStart, setSeedStart] = useState('23:00');
  const [seedEnd, setSeedEnd] = useState('07:00');
  // Read-only mirror of the seeding window for the UI (Dashboard + Settings).
  // Recomputed on the existing policy tick below — no extra timer.
  const [seedStatus, setSeedStatus] = useState(() => ({ throttled: false, resumesAt: null, windowLabel: null }));
  const [uploadCapEnabled, setUploadCapEnabled] = useState(false);
  const [uploadCapGb, setUploadCapGb] = useState(100);
  // Low-disk guard (task 105): warning surfaced in nodeStats/UI; blocks new downloads.
  const [lowDisk, setLowDisk] = useState(false);
  const [diskFreeFormatted, setDiskFreeFormatted] = useState(null);
  const [p2pEnabled, setP2pEnabled] = useState(true);
  const [p2pRunning, setP2pRunning] = useState(false);
  // Live copy of the P2P enable flag so the consent-gated startup can read the
  // latest value without being re-created (kept in sync just below).
  const p2pEnabledRef = useRef(true);
  useEffect(() => { p2pEnabledRef.current = p2pEnabled; }, [p2pEnabled]);
  const [videoMini, setVideoMini] = useState(false); // true = mini player, false = could be fullscreen
  const [videoFullscreen, setVideoFullscreen] = useState(false);
  const [videoError, setVideoError] = useState(null); // null or error message string
  const [localStreamUrl, setLocalStreamUrl] = useState(null); // local asset:// URL for downloaded files
  const [announcement, setAnnouncement] = useState('');       // server-pushed banner message
  const [availablePacks, setAvailablePacks] = useState([]);   // content packs from server
  const [settingsTab, setSettingsTab] = useState(null);       // which settings sub-tab to open
  const [appVersion, setAppVersion] = useState('');           // shown beside "Node Software"
  // { key, label, color, blurb } — Offline / Peer / Node / Seed node.
  const [networkHealth, setNetworkHealth] = useState(() => deriveNodeState({ running: false }));
  const [unreadChat, setUnreadChat] = useState(0);             // unread community messages (sidebar badge)
  const [nodesOnline, setNodesOnline] = useState(null);        // live nodes online (sidebar count beside Node Map)
  const [seedsOnline, setSeedsOnline] = useState(null);        // reachable seed nodes online (beside Seed Node)
  const [chatNotify, setChatNotify] = useState(() => chatPrefs().notify); // show unread badge
  const [chatShow, setChatShow] = useState(() => chatPrefs().show);       // show Community page at all
  const [conditionsAgreed, setConditionsAgreed] = useState(() => {        // first-launch agreement gate
    try { return localStorage.getItem('si-conditions-agreed') === CONDITIONS_VERSION; } catch { return false; }
  });
  const [conditionsOpen, setConditionsOpen] = useState(false);           // read-only conditions view (from About/Settings)
  const audioRef = useRef(null);
  const videoRef = useRef(null);
  const videoWatchdogRef = useRef(null);   // timer: detects "playing but black" (undecodable codec)
  const videoStartedRef = useRef(false);   // true once playback actually advances past ~0
  const networkStartedRef = useRef(false); // guards one-time start of P2P/heartbeat/geo/port-forward
  const startNetServicesRef = useRef(null);// lets the first-launch Agree handler start services without a restart
  // Live ref for the first-launch consent flag so the self-heal watchdog (created
  // once) always reads the latest value instead of the first-render capture.
  const conditionsAgreedRef = useRef(conditionsAgreed);
  useEffect(() => { conditionsAgreedRef.current = conditionsAgreed; }, [conditionsAgreed]);
  // Same trick for the low-disk flag: playSermon's background cache reads it
  // without having to take `lowDisk` as a dependency (which would rebuild the
  // callback, and with it the play effect, on every disk-guard tick).
  const lowDiskRef = useRef(lowDisk);
  useEffect(() => { lowDiskRef.current = lowDisk; }, [lowDisk]);
  // Mirror the consent flag into settings.json so the Rust liveness-ping task can
  // read it (Rust can't see localStorage). Runs on mount — which is what backfills
  // the flag for EXISTING users who agreed on a previous launch, otherwise their
  // ping would stay disabled forever — and again whenever consent changes, so a
  // withdrawal/reset writes `false`. persistConsentFlag no-ops when the on-disk
  // value already matches, so this never spams writes.
  useEffect(() => { persistConsentFlag(conditionsAgreed); }, [conditionsAgreed]);
  // Self-heal backoff bookkeeping (task 105): cap consecutive restart attempts,
  // no more than ~one attempt / 2 min, long cooldown before a fresh burst.
  const healAttemptsRef = useRef(0);
  const lastHealRef = useRef(0);

  // The active media type: 'audio' or 'video'
  const mediaType = currentSermon?.type === 'video' ? 'video' : 'audio';

  // Initialize catalog and the P2P (BitTorrent) node on mount
  useEffect(() => {
    async function init() {
      // Stage 1: catalog FIRST — the library must load even if anything else fails
      try {
        await initCatalog();
      } catch (e) {
        console.error('[App] initCatalog failed (showing what we have):', e);
      }
      try {
        setCatalog(getCatalog());
        setLibraryStats(getLibraryStats());
      } catch (e) {
        console.error('[App] Catalog state failed:', e);
      }

      // Stage 2: persistent node ID (needed by heartbeat)
      try {
        await loadNodeIdFromDisk();
      } catch (e) {
        console.warn('[App] Node ID load failed (non-critical):', e);
      }

      // Stage 2b: persisted user settings. Read the P2P enable flag BEFORE deciding
      // whether to auto-start the torrent session, so a user who turned P2P off
      // stays off across restarts (defaults ON when never set — Change 2).
      try {
        const saved = await loadSettings();
        const p2pAllowed = saved?.p2p_enabled !== false;
        setP2pEnabled(p2pAllowed);
        p2pEnabledRef.current = p2pAllowed;
        // Restore the remaining user preferences. Each key defaults when unset,
        // so existing installs are unchanged. Mirrors the p2p_enabled pattern so
        // storage limit, background seeding and the upload throttle now persist
        // across restarts (previously they reset every launch).
        if (typeof saved?.bandwidth_limit === 'number') setBandwidthLimitState(saved.bandwidth_limit);
        if (typeof saved?.storage_limit_gb === 'number') setStorageLimitState(saved.storage_limit_gb);
        if (typeof saved?.background_mode === 'boolean') setBackgroundMode(saved.background_mode);
        if (typeof saved?.upload_limit_enabled === 'boolean') setUploadLimitEnabled(saved.upload_limit_enabled);
        if (typeof saved?.upload_limit_kbps === 'number' && saved.upload_limit_kbps > 0) setUploadLimitKbps(saved.upload_limit_kbps);
        // Seeding schedule + monthly upload cap (task 108). Each defaults OFF, so
        // installs that never set them keep seeding exactly as before.
        if (typeof saved?.seed_schedule_enabled === 'boolean') setSeedScheduleEnabled(saved.seed_schedule_enabled);
        if (typeof saved?.seed_start === 'string' && /^\d{1,2}:\d{2}$/.test(saved.seed_start)) setSeedStart(saved.seed_start);
        if (typeof saved?.seed_end === 'string' && /^\d{1,2}:\d{2}$/.test(saved.seed_end)) setSeedEnd(saved.seed_end);
        if (typeof saved?.upload_cap_enabled === 'boolean') setUploadCapEnabled(saved.upload_cap_enabled);
        if (typeof saved?.upload_cap_gb === 'number' && saved.upload_cap_gb > 0) setUploadCapGb(saved.upload_cap_gb);
      } catch (e) {
        console.warn('[App] Settings load failed (non-critical):', e?.message || e);
      }

      // Normalize server mode keys to app keys. Legacy server values
      // (e.g. *_PRIMARY / *_ONLY from the pre-BitTorrent era) map onto the
      // new p2p modes so old admin configs keep working.
      const normalizeMode = (m) => {
        const s = String(m || '').toLowerCase();
        let result = 'cdn';
        if (s.startsWith('cdn')) result = 'cdn';
        else if (s.includes('only')) result = 'p2p-only';
        else if (s.includes('primary')) result = 'p2p-primary';
        console.log(`[App] normalizeMode: "${m}" → "${result}"`);
        return result;
      };

      // Fetch config immediately on startup (don't wait for heartbeat)
      try {
        const config = await fetchConfig();
        if (config.source_mode) setContentMode(normalizeMode(config.source_mode));
        if (config.announcement !== undefined) setAnnouncement(config.announcement || '');
      } catch (e) {
        console.warn('[App] Initial config fetch failed:', e.message);
      }

      // ── Consent-gated network participation ──────────────────────────────────
      // Everything above this point is local or an anonymous GET, safe to run
      // before consent. The heartbeat (which also performs IP geolocation and
      // reports node telemetry), the BitTorrent/P2P session, and the router
      // UPnP/NAT-PMP port-forwarding that startSession triggers must NOT run until
      // the user accepts the first-launch conditions. This function holds all of
      // that. It's invoked now if consent was already given on a previous launch,
      // or the instant the user accepts (see handleAgreeConditions) — no restart.
      async function startNetworkServices() {
        if (networkStartedRef.current) return; // start exactly once
        networkStartedRef.current = true;

        // Start heartbeat with remote config + content pack callbacks
        // Note: getStats callback is called fresh each heartbeat so it always gets current values
        try {
          startHeartbeat(() => {
            const freshStats = getLibraryStats();
            return {
              filesShared: freshStats?.downloadedFiles || 0,
              storageUsedBytes: freshStats?.downloadedSizeBytes || 0,
              peersConnected: 0, // heartbeat.js aggregates live peers from the torrent stats itself
              libraryCoverage: freshStats?.coverage || 0,
              contentMode: contentModeRef.current,
              nodeType: seedUnlockedRef.current ? 'seed' : 'user',
            };
          }, {
            onConfigUpdate: (config) => {
              // Remote config updated from server
              console.log('[App] onConfigUpdate received:', JSON.stringify(config));
              // Apply source mode from server (normalize server keys to app keys)
              if (config.source_mode) {
                console.log('[App] Setting content mode from heartbeat:', config.source_mode);
                setContentMode(normalizeMode(config.source_mode));
              }
              // Apply announcement banner
              if (config.announcement !== undefined) {
                setAnnouncement(config.announcement || '');
              }
            },
            onContentPacks: (packs) => {
              // Content packs received
              setAvailablePacks(packs);
            },
            getSermonInfo: (sermonId) => {
              // Return sermon metadata for seeded torrent reporting
              const sermon = getCatalog().find(s => s.id === sermonId);
              return sermon ? { title: sermon.title, speaker: sermon.speaker, type: sermon.type } : null;
            },
          });
        } catch (e) {
          console.error('[App] Heartbeat start failed (non-critical):', e);
        }

        // Start the BitTorrent node (with 30s timeout for DHT/UPnP init) — unless
        // the user has turned P2P off, in which case we honor that and don't seed
        // or port-forward (Change 2: remembered across restarts).
        if (p2pEnabledRef.current) {
          try {
            const torrentModule = await import('./services/torrent.js').catch((err) => {
              console.error('[App] Torrent module import failed:', err);
              return null;
            });
            if (torrentModule) {
              console.log('[App] Torrent module loaded, starting session...');
              const initPromise = torrentModule.startSession();
              const timeoutPromise = new Promise((_, reject) =>
                setTimeout(() => reject(new Error('P2P init timeout (30s)')), 30000)
              );
              await Promise.race([initPromise, timeoutPromise]);
              setP2pRunning(true);
              setNodeOnline(true);
              console.log('[App] P2P node started successfully');
              // Re-apply the persisted upload cap now the session is live. The
              // Rust session already reads it at creation (persisted_upload_limit_bps),
              // so this is belt-and-braces; read fresh from disk to avoid stale
              // closure state. bytesPerSec = 0 → unlimited.
              try {
                const s = await loadSettings();
                const enabled = s?.upload_limit_enabled === true;
                const kbps = Number(s?.upload_limit_kbps) || 0;
                const bytesPerSec = enabled && kbps > 0 ? Math.round(kbps * 1024) : 0;
                const core = await import('@tauri-apps/api/core').catch(() => null);
                if (core) await core.invoke('set_upload_limit', { bytesPerSec });
              } catch (e) {
                console.warn('[App] Apply upload limit on startup failed:', e?.message || e);
              }
              // The torrent session no longer persists its own list (that caused
              // deleted files to be re-downloaded from their webseeds). Instead we
              // re-seed exactly what's on disk RIGHT NOW — the downloads folder is
              // the single source of truth. Fire-and-forget; never block startup.
              try {
                downloadManager.reseedExisting(getDownloaded())
                  .catch((e) => console.warn('[App] Re-seed on startup failed:', e?.message || e));
              } catch (e) {
                console.warn('[App] Re-seed on startup threw:', e?.message || e);
              }
            }
          } catch (e) {
            console.error('[App] P2P node failed to start (non-critical):', e.message, e.stack);
            setP2pRunning(false);
          }
        } else {
          console.log('[App] P2P disabled by user — torrent session not auto-started');
          setP2pRunning(false);
        }

        // Reflect backend seed-access approval at startup, so the Seed Node page
        // and node type are correct even before the user opens that page.
        try {
          const [net, hb] = await Promise.all([
            import('./services/network.js').catch(() => null),
            import('./services/heartbeat.js').catch(() => null),
          ]);
          if (net?.checkSeedAccess && hb?.getNodeId) {
            const ok = await net.checkSeedAccess(hb.getNodeId());
            // Mirror the answer locally so the Connections panel (which is
            // rendered by a page that passes it no props) can tell a Seed node
            // from a Node without repeating this call. Written from the real
            // server answer only — see utils/nodeStatus.js.
            writeSeedGranted(ok);
            if (ok) setSeedUnlocked(true);
          }
        } catch { /* non-critical */ }
      }
      // Expose so the first-launch Agree handler can start these services with no
      // restart the moment the user accepts.
      startNetServicesRef.current = startNetworkServices;

      // Check for app updates (fire-and-forget — never throws, no-op in dev
      // or while the updater pubkey placeholder hasn't been replaced yet)
      startUpdateChecks();

      // App version shown beside the sidebar title (dynamic — from the Rust
      // CARGO_PKG_VERSION, so it's always the real running version).
      try {
        const tauriMod = await import('@tauri-apps/api/core').catch(() => null);
        if (tauriMod) {
          const v = await tauriMod.invoke('get_app_version').catch(() => null);
          if (v) setAppVersion(v);
        }
      } catch { /* non-critical */ }

      // Consent gate: only begin network participation if the user already accepted
      // on a previous launch. On a fresh install this is held until they accept.
      if (conditionsAgreed) {
        startNetworkServices().catch(e => console.error('[App] Network services start crashed:', e));
      } else {
        console.log('[App] First-launch consent pending — holding P2P/heartbeat/geo/port-forward until accepted');
      }
    }
    init().catch(e => console.error('[App] init crashed:', e));

    // Refresh sermon list when the canonical master list arrives (adds magnets)
    const handleMasterList = () => {
      setCatalog(getCatalog());
      console.log('[App] Catalog refreshed with canonical torrent links');
    };
    window.addEventListener('si-master-list', handleMasterList);

    // Master list unreachable after all retries — inform the user, but never
    // clobber a server-pushed announcement (only show if the banner is empty)
    const handleMasterListFailed = () => {
      setAnnouncement(prev => prev || 'P2P catalog temporarily unreachable — downloads still work normally.');
    };
    window.addEventListener('si-master-list-failed', handleMasterListFailed);

    // Auto-update downloaded & installed — takes effect on next launch
    const handleUpdateReady = () => {
      setAnnouncement(prev => prev || 'Update installed — takes effect next launch.');
    };
    window.addEventListener('si-update-ready', handleUpdateReady);

    // Notify server when app is closing/navigating away
    const handleBeforeUnload = () => {
      stopHeartbeat();
    };
    window.addEventListener('beforeunload', handleBeforeUnload);

    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
      window.removeEventListener('si-master-list', handleMasterList);
      window.removeEventListener('si-master-list-failed', handleMasterListFailed);
      window.removeEventListener('si-update-ready', handleUpdateReady);
      stopHeartbeat();
    };
  }, []);

  // Sidebar node-count badge. Reads the SHARED node-map store, which is the same
  // snapshot the Node Map page and the Dashboard render — so the badge can never
  // disagree with the page it links to. (It used to run its own 60s fetch.)
  useEffect(() => subscribeNodeMap(snap => setNodesOnline(snap.count)), []);

  // Seed backbone count — a DIFFERENT dataset (the seed directory), so it keeps
  // its own poll.
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const hb = await import('./services/heartbeat.js').catch(() => null);
        const seeds = await fetchSeeds().catch(() => []);
        if (cancelled) return;
        // Exclude OUR OWN node from the seed count. Otherwise a volunteer who ran
        // the reachability test on the Seed Node page (which registers them in the
        // directory) sees "[1]" that is really just themselves — not a backbone
        // seed they can rely on. The server already filters to reachable-only;
        // this drops self so the badge reflects OTHER reachable seed nodes.
        let selfShort = '';
        try { selfShort = String(hb?.getNodeId?.() || '').slice(0, 8); } catch {}
        const otherSeeds = selfShort ? seeds.filter(s => s.node !== selfShort) : seeds;
        setSeedsOnline(otherSeeds.length);
      } catch { /* keep last value */ }
    };
    const t = setTimeout(poll, 5000);   // first check shortly after launch
    const iv = setInterval(poll, 60000); // then every minute
    return () => { cancelled = true; clearTimeout(t); clearInterval(iv); };
  }, []);

  // Poll network health for TopBar indicator
  useEffect(() => {
    if (!p2pRunning) {
      setNetworkHealth(deriveNodeState({ running: false }));
      return;
    }
    let cancelled = false;
    const poll = async () => {
      try {
        const torrent = await import('./services/torrent.js').catch(() => null);
        if (!torrent || cancelled) return;
        const status = await torrent.getStatus().catch(() => null);
        if (cancelled) return;

        // Offline / Peer / Node / Seed node — derived by the SHARED helper in
        // utils/nodeStatus.js, the same call the Connections panel makes. This
        // block used to re-implement it and had drifted (it counted IPv6 from
        // the probe but never the passive inbound observation, and it applied a
        // 30-minute freshness window the panel does not — so the TopBar could
        // say one thing while the panel said another about the same node).
        //
        // The freshness window is deliberately gone: the saved reachability
        // result never expires and is only ever replaced by an explicit
        // Re-test, which is the contract the rest of the app already follows.
        let reach = null, ipv6 = null;
        try { reach = readReachability(); } catch {}
        try { ipv6 = readIpv6Observation(); } catch {}

        const state = deriveNodeState({
          running: !!status?.running,
          reachable: isReachable({ reach, ipv6 }),
          // Live value via the ref, so an approval that lands mid-session is
          // picked up on the next tick without re-creating this effect.
          seedGranted: seedUnlockedRef.current,
        });
        setNetworkHealth(state);
      } catch {}
    };
    poll();
    const iv = setInterval(poll, 5000);
    return () => { cancelled = true; clearInterval(iv); };
  }, [p2pRunning]);

  // ── Community chat unread badge ──────────────────────────────────────────
  // Poll the chat server for unread messages — light touch: first check ~10s
  // after mount, then every 60s. Skipped while the Community page is open
  // (it marks messages read itself) or when disabled in Settings.
  useEffect(() => {
    if (!chatNotify || !chatShow || page === 'community') return;
    let cancelled = false;
    const check = async () => {
      const n = await fetchUnreadCount();
      if (!cancelled) setUnreadChat(n);
    };
    const first = setTimeout(check, 10000);
    const iv = setInterval(check, 60000);
    return () => { cancelled = true; clearTimeout(first); clearInterval(iv); };
  }, [page, chatNotify, chatShow]);

  // Opening the Community page clears the badge immediately
  useEffect(() => {
    if (page === 'community') setUnreadChat(0);
  }, [page]);

  // CommunityPage dispatches this after marking new messages as read
  useEffect(() => {
    const onChatRead = () => setUnreadChat(0);
    window.addEventListener('si-chat-read', onChatRead);
    return () => window.removeEventListener('si-chat-read', onChatRead);
  }, []);

  // If the Community page gets hidden in Settings while open, leave it
  useEffect(() => {
    if (!chatShow && page === 'community') setPage('library');
  }, [chatShow, page]);

  const handleChatNotifyChange = useCallback((enabled) => {
    setChatNotify(enabled);
    try { localStorage.setItem('si-chat-notify', enabled ? '1' : '0'); } catch {}
  }, []);

  const handleChatShowChange = useCallback((enabled) => {
    setChatShow(enabled);
    try { localStorage.setItem('si-chat-show', enabled ? '1' : '0'); } catch {}
  }, []);

  // Record agreement to the copying permissions / conditions (first launch)
  const handleAgreeConditions = useCallback(() => {
    try { localStorage.setItem('si-conditions-agreed', CONDITIONS_VERSION); } catch {}
    setConditionsAgreed(true);
    // The consent-mirroring effect below picks this up and writes
    // `conditions_agreed: true` into settings.json for the Rust ping task.
    // Consent just granted — start P2P/heartbeat/geo/port-forward right away, no
    // app restart needed. init() has already run and stashed the starter here.
    try { startNetServicesRef.current?.(); }
    catch (e) { console.warn('[App] Deferred network start failed:', e?.message || e); }
  }, []);

  // Merge-and-persist a partial settings patch to the on-disk settings file.
  // Reads current settings first so we never clobber other keys (e.g. the
  // node_id the heartbeat service stores in the very same settings file).
  const persistSettings = useCallback(async (partial) => {
    try {
      const current = await loadSettings();
      await saveSettings({ ...(current || {}), ...partial });
    } catch (e) {
      console.warn('[App] Persist settings failed:', e?.message || e);
    }
  }, []);

  // Handle P2P node toggle
  const handleP2pToggle = useCallback(async (enabled) => {
    setP2pEnabled(enabled);
    p2pEnabledRef.current = enabled;
    // Remember the choice so a disabled P2P stays disabled across restarts (Change 2).
    persistSettings({ p2p_enabled: enabled });
    try {
      const torrentModule = await import('./services/torrent.js').catch(() => null);
      if (!torrentModule) return;
      if (enabled) {
        await torrentModule.startSession();
        setP2pRunning(true);
        setNodeOnline(true);
      } else {
        await torrentModule.stopSession();
        setP2pRunning(false);
        setNodeOnline(false);
      }
    } catch (e) {
      console.warn('[App] P2P toggle error:', e.message);
      setP2pRunning(false);
    }
  }, [persistSettings]);

  // Persist the download (HTTP) bandwidth limit so it survives restarts.
  const handleBandwidthChange = useCallback((v) => {
    setBandwidthLimitState(v);
    persistSettings({ bandwidth_limit: v });
  }, [persistSettings]);

  // Persist the storage cap (GB). Enforced before new downloads by the manager.
  const handleStorageLimitChange = useCallback((v) => {
    setStorageLimitState(v);
    persistSettings({ storage_limit_gb: v });
  }, [persistSettings]);

  // Persist the background-seeding toggle. The Rust window-close handler reads
  // this key to decide hide-to-tray (on) vs quit (off).
  const handleBackgroundModeChange = useCallback((v) => {
    setBackgroundMode(v);
    persistSettings({ background_mode: v });
  }, [persistSettings]);

  // Push the current upload cap to the running BitTorrent session. KB/s → bytes/s;
  // disabled or 0 → unlimited. Safe no-op (ignored) when no session is running.
  const applyUploadLimit = useCallback(async (enabled, kbps) => {
    try {
      const core = await import('@tauri-apps/api/core').catch(() => null);
      if (!core) return;
      const bytesPerSec = enabled && kbps > 0 ? Math.round(kbps * 1024) : 0;
      await core.invoke('set_upload_limit', { bytesPerSec });
    } catch (e) {
      console.warn('[App] set_upload_limit failed:', e?.message || e);
    }
  }, []);

  // Toggle the upload throttle on/off (persist + apply live). When enabling,
  // also persist the current KB/s value — otherwise a user who flips the toggle
  // on without ever touching the number would lose the cap on restart (the Rust
  // side needs upload_limit_kbps to reconstruct the limit at session start).
  const handleUploadLimitToggle = useCallback((enabled) => {
    setUploadLimitEnabled(enabled);
    persistSettings(
      enabled
        ? { upload_limit_enabled: true, upload_limit_kbps: uploadLimitKbps }
        : { upload_limit_enabled: false }
    );
    applyUploadLimit(enabled, uploadLimitKbps);
  }, [persistSettings, applyUploadLimit, uploadLimitKbps]);

  // Change the cap value in KB/s (persist + apply live when the throttle is on).
  const handleUploadLimitKbpsChange = useCallback((kbps) => {
    const v = Number.isFinite(kbps) && kbps > 0 ? Math.round(kbps) : 0;
    setUploadLimitKbps(v);
    persistSettings({ upload_limit_kbps: v });
    if (uploadLimitEnabled) applyUploadLimit(true, v);
  }, [persistSettings, applyUploadLimit, uploadLimitEnabled]);

  // Low-level: push an ABSOLUTE upload cap (bytes/sec) to the running session.
  // 0 = unlimited; any positive value caps. Safe no-op when no session is running
  // (the native command errors, which we swallow). Used by the schedule/cap
  // enforcement below to throttle to ~off (UPLOAD_OFF_BYTES) or restore the base.
  const applyUploadBytes = useCallback(async (bytesPerSec) => {
    try {
      const core = await import('@tauri-apps/api/core').catch(() => null);
      if (!core) return;
      await core.invoke('set_upload_limit', { bytesPerSec: Math.max(0, Math.round(bytesPerSec)) });
    } catch (e) {
      console.warn('[App] set_upload_limit failed:', e?.message || e);
    }
  }, []);

  // ── Seeding schedule + monthly-cap persist handlers (task 108) ──────────────
  // All merge-persist via persistSettings (never clobbers node_id / other keys).
  const handleSeedScheduleToggle = useCallback((enabled) => {
    setSeedScheduleEnabled(enabled);
    persistSettings({ seed_schedule_enabled: enabled });
  }, [persistSettings]);
  const handleSeedStartChange = useCallback((v) => {
    if (!/^\d{1,2}:\d{2}$/.test(String(v || ''))) return; // ignore malformed time input
    setSeedStart(v);
    persistSettings({ seed_start: v });
  }, [persistSettings]);
  const handleSeedEndChange = useCallback((v) => {
    if (!/^\d{1,2}:\d{2}$/.test(String(v || ''))) return;
    setSeedEnd(v);
    persistSettings({ seed_end: v });
  }, [persistSettings]);
  const handleUploadCapToggle = useCallback((enabled) => {
    setUploadCapEnabled(enabled);
    persistSettings({ upload_cap_enabled: enabled });
  }, [persistSettings]);
  const handleUploadCapGbChange = useCallback((gb) => {
    if (!Number.isFinite(gb) || gb <= 0) return; // ignore empty/invalid — keep last good value
    const v = Math.round(gb);
    setUploadCapGb(v);
    persistSettings({ upload_cap_gb: v });
  }, [persistSettings]);

  // Navigation with revalidation for downloads page
  // Optional 2nd arg: sub-tab (e.g. 'connections' for settings page)
  const navigateTo = useCallback(async (newPage, subTab) => {
    // Leaving Browse Sermons clears the search box. Opening a sermon from the
    // Dashboard sets the search to that sermon's title to jump straight to it —
    // without this, that one-off search was still sitting there on every later
    // visit, so the library looked permanently filtered to a single result
    // instead of returning to the full randomised view.
    if (newPage !== 'library') setSearch('');
    setPage(newPage);
    if (subTab) setSettingsTab(subTab);
    else setSettingsTab(null);
    if (newPage === 'downloads') {
      const changed = await revalidateDownloads();
      if (changed) {
        setCatalog(getCatalog());
        setLibraryStats(getLibraryStats());
      }
    }
  }, []);

  // Expose navigation function for tray menu
  useEffect(() => {
    window.__navigateToSettings = () => navigateTo('settings');
    return () => { delete window.__navigateToSettings; };
  }, [navigateTo]);

  // Listen for download progress updates
  useEffect(() => {
    const markOnceSet = new Set(); // Track which sermons we've already marked
    const unsub = downloadManager.onProgress((sermonId, state) => {
      setDownloadStates(prev => ({ ...prev, [sermonId]: { ...state } }));

      // Mark as downloaded when entering post-processing (file is already saved to disk)
      // States: SEEDING = file saved, seeding to the torrent swarm
      //         COMPLETE = all done (magnet may still arrive via a later notify)
      const postProcessStates = [DL_STATE.SEEDING, DL_STATE.COMPLETE];
      // The size we record is `diskSize` — what the filesystem reported after the
      // Rust save/finalize, NOT `bytesDownloaded` (bytes counted off the wire).
      // Recording the wire count is exactly why a failed write was invisible: the
      // two only ever agree when the write really happened, so the wire count
      // reported a full library, a full coverage %, full Seed Node progress and a
      // heartbeat listing files that were never on disk. bytesDownloaded remains
      // the fallback ONLY for the no-native-backend case (browser dev), where
      // downloadManager sets diskSize to the received count anyway.
      const realSize = state.diskSize || state.bytesDownloaded || 0;
      if (postProcessStates.includes(state.state) && !markOnceSet.has(sermonId)) {
        markOnceSet.add(sermonId);
        markDownloaded(sermonId, state.magnet || `local-${sermonId}`, realSize);
        setCatalog(getCatalog());
        setLibraryStats(getLibraryStats());
      }
      if (state.state === DL_STATE.COMPLETE) {
        markDownloaded(sermonId, state.magnet, realSize);
        setCatalog(getCatalog());
        setLibraryStats(getLibraryStats());
      }
    });
    return unsub;
  }, []);

  // Poll the LIVE torrent peer count every 5s so Settings shows the SAME number
  // the heartbeat reports to the server (and thus the node map). We read the
  // session status DIRECTLY (getStatus → listTorrents), exactly like heartbeat.js
  // does, instead of gating on the React `p2pRunning` flag. That flag can lag the
  // real Rust session — e.g. the 30s startup race can leave it `false` while the
  // session is in fact running — which is precisely what left Settings stuck on
  // "0 peers connected" while the map/heartbeat showed the true live count.
  // Sourcing from the session directly makes the two agree.
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const torrent = await import('./services/torrent.js').catch(() => null);
        if (!torrent || cancelled) return;
        const status = await torrent.getStatus().catch(() => null);
        const torrents = status?.running ? await torrent.listTorrents().catch(() => []) : [];
        if (cancelled) return;
        const livePeers = torrents.reduce((n, t) => n + (t.stats?.live?.snapshot?.peer_stats?.live || 0), 0);
        setNodeStats(prev => (prev.peersConnected === livePeers ? prev : { ...prev, peersConnected: livePeers }));
      } catch {}
    };
    poll(); // immediate first read
    const id = setInterval(poll, 5000);
    return () => { cancelled = true; clearInterval(id); };
  }, [p2pRunning]);

  // ── Seed-node self-healing + low-disk guard (task 105) ──────────────────────
  // One ~60s watchdog that (a) re-reads free disk space and (b) auto-recovers the
  // torrent session if it has died while it SHOULD be running. Self-heal is gated
  // on BOTH first-launch consent and the user's P2P choice — it never starts P2P
  // for someone who disabled it or hasn't accepted the conditions. Backoff: at
  // most ~one restart / 2 min, capped at 5 consecutive tries, reset on success,
  // with a 15-min cooldown before a fresh burst.
  useEffect(() => {
    let cancelled = false;
    // The disk check shells out to `df` (or fsutil on Windows) — a real process
    // spawn. Running it on every 60s tick meant ~1,440 subprocesses a day for the
    // life of the app, which on a machine left running for weeks is pure waste.
    // It is a disk-FULL guard, not a live meter: free space changes slowly, and
    // the only thing that moves it fast is a download, which fails loudly on its
    // own. 15 minutes gives the guard plenty of warning (a full-speed download
    // does not clear tens of GB in a quarter of an hour) at 1/15th the cost.
    // The FIRST tick still checks immediately, so a machine that is already full
    // at launch is caught right away.
    const DISK_CHECK_INTERVAL_MS = 15 * 60 * 1000;
    let lastDiskCheck = 0;
    const MIN_HEAL_GAP_MS = 2 * 60 * 1000;   // ≤ ~one restart attempt / 2 min
    const MAX_HEAL_ATTEMPTS = 5;             // cap consecutive tries…
    const HEAL_COOLDOWN_MS = 15 * 60 * 1000; // …then wait before a fresh burst

    const tick = async () => {
      // (a) Low-disk guard — local, safe pre-consent. Uses the SAME check_disk_space
      // path the Seed Node page uses, against the real configured storage dir.
      // Rate-limited to DISK_CHECK_INTERVAL_MS (see above); the self-heal in (b)
      // is cheap and keeps running on the 60s tick.
      const now = Date.now();
      if (now - lastDiskCheck >= DISK_CHECK_INTERVAL_MS) {
        lastDiskCheck = now;
        try {
          const core = await import('@tauri-apps/api/core').catch(() => null);
          if (core) {
            const dir = await core.invoke('get_storage_dir').catch(() => null);
            if (dir) {
              const info = await core.invoke('check_disk_space', { path: dir }).catch(() => null);
              if (!cancelled && info) {
                const freeBytes = Number(info.available_bytes || 0);
                const low = freeBytes > 0 && freeBytes < LOW_DISK_THRESHOLD_BYTES;
                setLowDisk(low);
                setDiskFreeFormatted(info.available_formatted || null);
                if (low) console.warn(`[App] Low disk space — only ${info.available_formatted} free; new downloads paused (seeding continues).`);
              }
            }
          }
        } catch { /* non-Tauri / dev — skip disk guard */ }
      }

      // (b) Self-heal the torrent session — only with consent AND P2P enabled.
      if (cancelled) return;
      if (!conditionsAgreedRef.current) return;                            // no consent → never auto-start
      if (!p2pEnabledRef.current) { healAttemptsRef.current = 0; return; } // user turned P2P off

      try {
        const torrent = await import('./services/torrent.js').catch(() => null);
        if (!torrent || cancelled) return;
        const status = await torrent.getStatus().catch(() => null);
        if (status?.running) {
          healAttemptsRef.current = 0; // healthy — reset backoff
          setP2pRunning(true);
          return;
        }
        // Session should be up but isn't → attempt recovery under backoff.
        const now = Date.now();
        if (healAttemptsRef.current >= MAX_HEAL_ATTEMPTS) {
          if (now - lastHealRef.current < HEAL_COOLDOWN_MS) return; // still cooling down after a burst
          healAttemptsRef.current = 0;                             // cooldown elapsed — allow a fresh burst
        }
        if (now - lastHealRef.current < MIN_HEAL_GAP_MS) return;   // too soon since the last try
        lastHealRef.current = now;
        healAttemptsRef.current += 1;
        console.warn(`[App] Self-heal: torrent session down — restart attempt ${healAttemptsRef.current}/${MAX_HEAL_ATTEMPTS}`);
        setP2pRunning(false);
        await torrent.startSession();
        if (cancelled) return;
        setP2pRunning(true);
        setNodeOnline(true);
        healAttemptsRef.current = 0; // success — reset backoff
        // The restarted librqbit session starts with NO upload limit applied. Clear
        // the memo so the next policy tick re-applies the throttle/cap — otherwise
        // the user's upload limit and seeding window are silently lost after a heal.
        lastPolicyBytesRef.current = null;
        console.log('[App] Self-heal: torrent session recovered');
      } catch (e) {
        console.warn('[App] Self-heal attempt failed:', e?.message || e);
      }
    };

    // First run after startup settles (session init has its own ~30s window), then every 60s.
    const first = setTimeout(tick, 90 * 1000);
    const iv = setInterval(tick, 60 * 1000);
    return () => { cancelled = true; clearTimeout(first); clearInterval(iv); };
  }, []);

  // ── Seeding schedule + monthly-cap enforcement (task 108) ───────────────────
  // Every ~60s (and immediately whenever the relevant settings change) compute the
  // desired upload cap and push it via set_upload_limit. Schedule/cap only ever
  // throttle DOWNWARD: base is the user's own choice (their KB/s cap if the task-93
  // throttle is on, else unlimited = 0); when we're OUTSIDE the seeding window or
  // OVER the monthly cap we clamp to ~off (UPLOAD_OFF_BYTES — a tiny 1 KB/s, NOT 0,
  // because 0 means UNLIMITED). When BOTH schedule and cap are off (the default)
  // we do nothing, leaving the user's manual upload-limit setting exactly as today.
  const lastPolicyBytesRef = useRef(null);
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;

      // Surface the window state to the UI first — this must happen even on the
      // early-return paths below (schedule off, P2P not up) so the indicator is
      // always truthful. Identity-stable when nothing changed, so no extra renders.
      setSeedStatus((prev) => {
        const next = computeSeedStatus(seedScheduleEnabled, seedStart, seedEnd);
        return (prev.throttled === next.throttled
          && prev.resumesAt === next.resumesAt
          && prev.windowLabel === next.windowLabel) ? prev : next;
      });

      const policyActive = seedScheduleEnabled || (uploadCapEnabled && uploadCapGb > 0);
      const base = uploadLimitEnabled && uploadLimitKbps > 0 ? Math.round(uploadLimitKbps * 1024) : 0; // 0 = unlimited

      if (!policyActive) {
        // Nothing to enforce. If a previous override is still applied, restore the
        // user's base once, then stand down (respect their manual setting exactly).
        if (lastPolicyBytesRef.current !== null) {
          await applyUploadBytes(base);
          lastPolicyBytesRef.current = null;
        }
        return;
      }

      // Only meaningful while P2P is enabled (there is a live session to throttle).
      if (!p2pEnabledRef.current) return;

      let throttle = false;
      if (seedScheduleEnabled && !isWithinSeedWindow(seedStart, seedEnd)) throttle = true;
      if (uploadCapEnabled && uploadCapGb > 0) {
        const capBytes = uploadCapGb * 1024 * 1024 * 1024;
        if (monthlyUploadedBytes(true) >= capBytes) throttle = true;
      }

      // Downward-only clamp: never raise ABOVE the user's chosen cap.
      const desired = throttle ? (base > 0 ? Math.min(base, UPLOAD_OFF_BYTES) : UPLOAD_OFF_BYTES) : base;
      if (desired !== lastPolicyBytesRef.current) {
        await applyUploadBytes(desired);
        lastPolicyBytesRef.current = desired;
        console.log(`[App] Seeding policy → upload cap ${desired === 0 ? 'unlimited' : desired + ' B/s'}${throttle ? ' (throttled: outside window / over monthly cap)' : ''}`);
      }
    };
    tick(); // apply immediately whenever the inputs change
    const iv = setInterval(tick, 60 * 1000);
    return () => { cancelled = true; clearInterval(iv); };
  }, [seedScheduleEnabled, seedStart, seedEnd, uploadCapEnabled, uploadCapGb, uploadLimitEnabled, uploadLimitKbps, p2pRunning, applyUploadBytes]);

  // ── Low-disk / node-offline download reconcile (task 105) ───────────────────
  // The download manager exposes a single pause flag; centralize it here so a
  // critically-low disk (or the node toggled offline) blocks NEW downloads.
  // In-flight downloads still finish (pause only gates the queue), and seeding is
  // never touched — seeding doesn't grow the disk.
  useEffect(() => {
    if (lowDisk || !nodeOnline) downloadManager.pause();
    else downloadManager.resume();
  }, [lowDisk, nodeOnline]);

  // Sync content mode to download manager
  useEffect(() => {
    const modeMap = {
      cdn: SOURCE_MODE.CDN_PRIMARY,
      'p2p-primary': SOURCE_MODE.P2P_PRIMARY,
      'p2p-only': SOURCE_MODE.P2P_ONLY,
    };
    downloadManager.setMode(modeMap[contentMode] || SOURCE_MODE.CDN_PRIMARY);
    console.log('[App] Content mode synced to download manager:', contentMode, '→', modeMap[contentMode] || SOURCE_MODE.CDN_PRIMARY);
  }, [contentMode]);

  // Sync bandwidth limit
  useEffect(() => {
    downloadManager.setBandwidthLimit(bandwidthLimit);
  }, [bandwidthLimit]);

  // Sync storage cap → download manager, which blocks a new download when the
  // cache is already at/over the limit (0 = unlimited).
  useEffect(() => {
    downloadManager.setStorageLimit(storageLimit);
  }, [storageLimit]);

  // ── AUDIO player events ──────────────────────────────────────────────────
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const onTimeUpdate = () => {
      if (mediaType !== 'audio') return; // Don't update if video is playing
      setCurrentTime(audio.currentTime);
      setDuration(audio.duration || 0);
      setProgress(audio.duration ? (audio.currentTime / audio.duration) * 100 : 0);
    };
    const onEnded = () => { setIsPlaying(false); setProgress(0); setCurrentTime(0); };
    const onLoadedMetadata = () => { if (mediaType === 'audio') setDuration(audio.duration || 0); };
    // Keep isPlaying state in sync with actual audio element state
    const onPlay = () => { if (mediaType === 'audio') setIsPlaying(true); };
    const onPause = () => { if (mediaType === 'audio') setIsPlaying(false); };
    const onError = (e) => {
      if (mediaType !== 'audio') return;
      console.warn('[Player] Audio error:', e, 'src:', audio.src);
      if (currentSermon) {
        const currentSrc = audio.src;
        const fallback = currentSrc.includes('b-cdn.net') ? currentSermon.archiveUrl : currentSermon.cdnUrl;
        if (fallback && fallback !== currentSrc) {
          audio.src = fallback;
          audio.load();
          audio.play().catch(() => setIsPlaying(false));
          return;
        }
      }
      setIsPlaying(false);
    };

    audio.addEventListener('timeupdate', onTimeUpdate);
    audio.addEventListener('ended', onEnded);
    audio.addEventListener('loadedmetadata', onLoadedMetadata);
    audio.addEventListener('play', onPlay);
    audio.addEventListener('pause', onPause);
    audio.addEventListener('error', onError);
    return () => {
      audio.removeEventListener('timeupdate', onTimeUpdate);
      audio.removeEventListener('ended', onEnded);
      audio.removeEventListener('loadedmetadata', onLoadedMetadata);
      audio.removeEventListener('play', onPlay);
      audio.removeEventListener('pause', onPause);
      audio.removeEventListener('error', onError);
    };
  }, [currentSermon, mediaType]);

  // ── Close player ─────────────────────────────────────────────────────────
  const closePlayer = useCallback(() => {
    const audio = audioRef.current;
    const video = videoRef.current;
    if (audio) { audio.pause(); audio.src = ''; }
    if (video) {
      video.pause();
      while (video.firstChild) video.removeChild(video.firstChild);
      video.removeAttribute('src');
      video.load();
    }
    setCurrentSermon(null);
    setIsPlaying(false);
    setProgress(0);
    setCurrentTime(0);
    setDuration(0);
    setVideoMini(false);
    setVideoFullscreen(false);
    setVideoError(null);
    setLocalStreamUrl(null);
  }, []);

  // ── Open a video in the OS default player (QuickTime) ────────────────────
  // The in-app WebView can't decode some codecs (notably Opus audio in MP4), so
  // give the user a reliable way to watch/hear it in a native player.
  const openInDefaultPlayer = useCallback(async (sermon) => {
    if (!sermon) return;
    try {
      const tauriMod = await import('@tauri-apps/api/core').catch(() => null);
      if (!tauriMod) return;
      const ext = sermon.type === 'video' ? 'mp4' : 'mp3';
      const filename = `${sermon.id}.${ext}`;
      if (sermon.downloaded) {
        await tauriMod.invoke('open_downloaded_file', { filename });
      } else {
        // Not downloaded — stream the CDN URL in a native media player.
        // (open_url would launch the browser = same WebView = same black screen.)
        const url = sermon.cdnUrl || sermon.archiveUrl || sermon.url;
        if (url) await tauriMod.invoke('open_url_in_player', { url });
      }
    } catch (e) {
      console.warn('[Player] Open in default player failed:', e?.message || e);
    }
  }, []);

  // ── Play a sermon ────────────────────────────────────────────────────────
  const playSermon = useCallback(async (sermon) => {
    const audio = audioRef.current;
    const isVideo = sermon.type === 'video';

    // Toggle play/pause for same sermon
    if (currentSermon?.id === sermon.id) {
      if (isVideo && videoRef.current) {
        if (isPlaying) { videoRef.current.pause(); } else { videoRef.current.play().catch(() => {}); }
      } else if (audio) {
        if (isPlaying) { audio.pause(); } else { audio.play().catch(() => {}); }
      }
      setIsPlaying(!isPlaying);
      return;
    }

    // New sermon — stop any current playback first
    if (audio) { audio.pause(); audio.src = ''; }
    if (videoRef.current) {
      videoRef.current.pause();
      while (videoRef.current.firstChild) videoRef.current.removeChild(videoRef.current.firstChild);
      videoRef.current.removeAttribute('src');
      videoRef.current.load(); // Reset the media element
    }
    // Reset the "did it actually play" watchdog for the new video
    videoStartedRef.current = false;
    if (videoWatchdogRef.current) { clearTimeout(videoWatchdogRef.current); videoWatchdogRef.current = null; }

    setCurrentSermon(sermon);
    setProgress(0);
    setCurrentTime(0);
    setIsPlaying(true);
    setVideoError(null);

    // For downloaded files, try to serve from local disk
    let streamUrl = sermon.cdnUrl || sermon.archiveUrl || sermon.url;
    setLocalStreamUrl(null);
    if (sermon.downloaded) {
      try {
        const tauriMod = await import('@tauri-apps/api/core').catch(() => null);
        if (tauriMod) {
          const ext = sermon.type === 'video' ? 'mp4' : 'mp3';
          const filename = `${sermon.id}.${ext}`;
          const filePath = await tauriMod.invoke('get_sermon_file_path', { filename }).catch(() => null);
          if (filePath && tauriMod.convertFileSrc) {
            const localUrl = tauriMod.convertFileSrc(filePath);
            console.log(`[Player] Using local file: ${filePath} → ${localUrl}`);
            streamUrl = localUrl;
            setLocalStreamUrl(localUrl);
          }
        }
      } catch (e) {
        console.warn('[Player] Local file check failed, falling back to CDN:', e.message);
      }
    }
    console.log(`[Player] Playing ${isVideo ? 'video' : 'audio'}:`, sermon.title, '→', streamUrl);

    if (isVideo) {
      // Video — show mini player
      setVideoMini(true);
      setVideoFullscreen(false);
      setVideoError(null);

      // The <video> element is only mounted when videoMini is true, so on the
      // FIRST video play videoRef.current is still null right here (React hasn't
      // re-rendered yet). Defer setup with requestAnimationFrame until the
      // element actually exists — this is what was breaking video playback.
      const setupVideo = (attempt = 0) => {
        const v = videoRef.current;
        if (!v) {
          if (attempt < 40) requestAnimationFrame(() => setupVideo(attempt + 1));
          else console.warn('[VideoPlayer] video element never mounted');
          return;
        }
        // Remove any stale source, then hint MIME via a <source> (helps WKWebView)
        v.removeAttribute('src');
        v.load();
        while (v.firstChild) v.removeChild(v.firstChild);
        const source = document.createElement('source');
        source.src = streamUrl;
        source.type = 'video/mp4';
        v.appendChild(source);
        v.load();
        console.log(`[VideoPlayer] Set source: ${streamUrl.slice(0, 100)}`);

        const tryPlay = () => {
          v.play().catch((err) => {
            console.warn('[VideoPlayer] Autoplay blocked, trying muted:', err.message);
            v.muted = true;
            v.play().catch((err2) => {
              console.warn('[VideoPlayer] Muted autoplay also failed:', err2.message);
            });
          });
        };

        if (v.readyState >= 3) {
          tryPlay();
        } else {
          v.addEventListener('canplay', tryPlay, { once: true });
          setTimeout(() => {
            if (v.readyState < 3 && !v.paused) return; // Already playing
            if (v.readyState >= 1) tryPlay();
          }, 5000);
        }
      };
      setupVideo();
    } else {
      // Audio — use <audio> element only
      setVideoMini(false);
      setVideoFullscreen(false);
      if (audio) {
        audio.src = streamUrl;
        audio.volume = volume;
        audio.load();
        audio.play().catch((err) => {
          console.warn('[Player] Autoplay blocked:', err);
          if (streamUrl === sermon.cdnUrl && sermon.archiveUrl) {
            audio.src = sermon.archiveUrl;
            audio.load();
            audio.play().catch(() => setIsPlaying(false));
          } else {
            setIsPlaying(false);
          }
        });
      }
    }

    // ── Pressing play also CACHES THE SERMON TO DISK ──────────────────────
    // Behaviour deliberately unchanged (it is what makes the archive available
    // offline and what feeds the swarm), but it is no longer silent:
    //   - it goes through the normal download queue, so the sermon's Library card
    //     shows the same progress bar a manual download does — the storage use is
    //     visible in the UI rather than happening behind the user's back;
    //   - the failure is logged instead of being swallowed by an empty catch,
    //     so a storage-cap refusal or a disk error is diagnosable;
    //   - it is skipped while the low-disk guard is tripped. Quietly filling the
    //     last of someone's disk just because they pressed play is not a
    //     behaviour worth preserving, and it matches the guard the rest of the
    //     app already honours. Playback itself still streams normally.
    // NOT DONE HERE, and it needs an owner: there is still no wording anywhere in
    // the UI telling a user that browsing consumes storage. That belongs in the
    // player/Settings copy, which this file does not own.
    if (!sermon.downloaded) {
      const existing = downloadManager.getState(sermon.id);
      if (lowDiskRef.current) {
        console.warn(`[App] Low disk — not caching "${sermon.title}" to disk; streaming only.`);
      } else if (!existing || existing.state === DL_STATE.ERROR) {
        downloadManager.download(sermon).catch((err) => {
          console.warn(`[App] Background cache of "${sermon.title}" failed:`, err?.message || err);
        });
      }
    }
  }, [currentSermon, isPlaying, volume]);

  // ── Toggle play/pause from PlayerBar ─────────────────────────────────────
  const togglePlay = useCallback(() => {
    if (!currentSermon) return;
    const isVideo = currentSermon.type === 'video';

    if (isVideo && videoRef.current) {
      if (isPlaying) { videoRef.current.pause(); } else { videoRef.current.play().catch(() => {}); }
    } else if (audioRef.current) {
      if (isPlaying) { audioRef.current.pause(); } else { audioRef.current.play().catch(() => {}); }
    }
    setIsPlaying(!isPlaying);
  }, [isPlaying, currentSermon]);

  // ── Seek ─────────────────────────────────────────────────────────────────
  const seekTo = useCallback((percent) => {
    const isVideo = currentSermon?.type === 'video';
    if (isVideo && videoRef.current && videoRef.current.duration) {
      videoRef.current.currentTime = (percent / 100) * videoRef.current.duration;
    } else if (audioRef.current && audioRef.current.duration) {
      audioRef.current.currentTime = (percent / 100) * audioRef.current.duration;
    }
  }, [currentSermon]);

  // ── Volume ───────────────────────────────────────────────────────────────
  const handleVolumeChange = useCallback((val) => {
    setVolume(val);
    if (audioRef.current) audioRef.current.volume = val;
    if (videoRef.current) videoRef.current.volume = val;
  }, []);

  // ── Download ─────────────────────────────────────────────────────────────
  const handleDownload = useCallback(async (sermonId) => {
    const sermon = getCatalog().find(s => s.id === sermonId);
    if (!sermon) return;
    if (sermon.downloaded) return;
    const existing = downloadManager.getState(sermonId);
    if (existing && existing.state !== DL_STATE.ERROR) return;
    try { await downloadManager.download(sermon); } catch (err) { console.error('[App] Download failed:', err); }
  }, []);

  // ── Remove download ──────────────────────────────────────────────────────
  const handleRemoveDownload = useCallback(async (sermonId) => {
    const sermon = getCatalog().find(s => s.id === sermonId);
    if (!sermon) return;
    // Delete file from disk
    try {
      const tauriMod = await import('@tauri-apps/api/core').catch(() => null);
      if (tauriMod) {
        const ext = sermon.type === 'video' ? 'mp4' : 'mp3';
        const filename = `${sermonId}.${ext}`;
        await tauriMod.invoke('delete_sermon_file', { filename }).catch(() => {});
      }
    } catch {}
    // Remove from download state
    markRemoved(sermonId);
    setCatalog(getCatalog());
    setLibraryStats(getLibraryStats());
    // The file is gone from disk — prune its torrent so the session stops
    // seeding/listing it immediately (otherwise it lingers until next restart).
    // Fire-and-forget: deletion already succeeded regardless of this.
    (async () => {
      try {
        const torrentModule = await import('./services/torrent.js').catch(() => null);
        if (torrentModule) await torrentModule.pruneMissing();
      } catch (e) {
        console.warn('[App] Torrent prune after remove failed:', e?.message || e);
      }
    })();
  }, []);

  // ── Re-download (for incomplete files) ────────────────────────────────
  //
  // DOWNLOAD FIRST, REPLACE AFTER. This used to delete the file up front and
  // then start the download, so any failure — offline, 404, full disk — left the
  // user with LESS than they started with: the old copy destroyed and no new one.
  // That is a live hazard the moment the integrity check starts flagging files,
  // because a false positive would then delete a perfectly good sermon.
  //
  // No temp-file juggling is needed here: the Rust writers already stage into
  // `<file>.part` and only rename onto the real filename on a successful
  // finalize. So the existing copy survives untouched until a COMPLETE new file
  // atomically replaces it, and a failed attempt leaves the old file exactly as
  // it was. `markRemoved`/`delete_sermon_file` are gone from this path entirely.
  const handleRedownload = useCallback(async (sermonId) => {
    const sermon = getCatalog().find(s => s.id === sermonId);
    if (!sermon) return;
    // download() short-circuits on a COMPLETE queue entry, so clear it (state
    // only — this touches no files) or the re-download would no-op.
    downloadManager.forget(sermonId);
    try {
      await downloadManager.download(sermon);
      // Success: the progress listener has already re-recorded the entry with the
      // REAL on-disk size and re-run the integrity check against it.
    } catch (err) {
      // The previous file is still on disk and still marked as it was — the user
      // has lost nothing. Leave the Incomplete badge alone so the Re-download
      // button stays available.
      console.error('[App] Re-download failed (previous file left intact):', err);
    }
    setCatalog(getCatalog());
    setLibraryStats(getLibraryStats());
  }, []);

  // ── Open the app downloads folder ────────────────────────────────────────
  const handleOpenFolder = useCallback(async () => {
    try {
      const tauriMod = await import('@tauri-apps/api/core').catch(() => null);
      if (tauriMod) {
        // Open the user's ACTUAL download folder (honors a custom/external-drive
        // location), not the default dir.
        const storagePath = await tauriMod.invoke('get_storage_dir');
        await tauriMod.invoke('open_folder', { path: storagePath });
      }
    } catch (e) {
      console.warn('[App] Open folder failed:', e);
    }
  }, []);

  // ── Export download to Desktop with readable name ────────────────────────
  const handleExportDownload = useCallback(async (sermonId) => {
    const sermon = getCatalog().find(s => s.id === sermonId);
    if (!sermon) return;
    try {
      const tauriMod = await import('@tauri-apps/api/core').catch(() => null);
      if (tauriMod) {
        const ext = sermon.type === 'video' ? 'mp4' : 'mp3';
        const filename = `${sermonId}.${ext}`;
        // Export into Desktop/<Speaker>/<Title>.<ext> — a per-speaker folder with
        // a properly named file, so exports land organized by speaker.
        await tauriMod.invoke('export_sermon', {
          filename,
          speaker: sermon.speaker || 'Unknown',
          title: sermon.title || sermonId,
        });
      }
    } catch (e) {
      console.warn('[App] Export failed:', e);
    }
  }, []);

  // Content mode change
  const handleModeChange = useCallback((mode) => { setContentMode(mode); }, []);

  // Node toggle. Pause/resume of the download queue is centralized in the
  // low-disk / node-offline reconcile effect below (a critically-low disk must
  // also block downloads), so we only flip the flag here.
  const handleNodeToggle = useCallback((online) => {
    setNodeOnline(online);
  }, []);

  // Derived data
  const filteredCatalog = search ? searchCatalog(search) : getCatalog();
  const catalogWithDlState = filteredCatalog.map(s => ({
    ...s, dlState: downloadStates[s.id] || null,
  }));
  const downloadedSermons = getDownloaded().map(s => ({
    ...s, dlState: downloadStates[s.id] || null,
  }));

  // Compute real node stats from catalog. lowDisk/diskFree (task 105) ride along
  // so the Settings UI can surface a low-disk warning.
  const realStats = libraryStats ? {
    peersConnected: nodeStats.peersConnected,
    filesShared: libraryStats.downloadedFiles || 0,
    storageUsed: libraryStats.downloadedSize || '0 B',
    lowDisk,
    diskFree: diskFreeFormatted,
  } : { ...nodeStats, lowDisk, diskFree: diskFreeFormatted };

  const renderPage = () => {
    switch (page) {
      case 'dashboard':
        return <DashboardPage nodeStats={realStats} libraryStats={getLibraryStats()} catalog={getCatalog()} seedStatus={seedStatus} onNavigate={navigateTo} onOpenSermon={(s) => { setSearch(s.title); navigateTo('library'); }} />;
      case 'library':
        return <LibraryPage sermons={catalogWithDlState} currentSermon={currentSermon} isPlaying={isPlaying} onPlay={playSermon} onDownload={handleDownload} onOpenExternal={openInDefaultPlayer} search={search} onSearch={setSearch} />;
      case 'downloads':
        return <DownloadsPage sermons={downloadedSermons} currentSermon={currentSermon} isPlaying={isPlaying} onPlay={playSermon} onRemove={handleRemoveDownload} onExport={handleExportDownload} onOpenExternal={openInDefaultPlayer} onRedownload={handleRedownload} onOpenFolder={handleOpenFolder} downloadStates={downloadStates} />;
      case 'seed':
        return <SeedNodePage seedUnlocked={seedUnlocked} onUnlock={setSeedUnlocked} catalog={getCatalog()} libraryStats={getLibraryStats()} downloadManager={downloadManager} downloadStates={downloadStates} nodeStats={realStats} />;
      case 'stats':
        return <StatsPage catalog={getCatalog()} libraryStats={getLibraryStats()} nodeStats={realStats} downloadStates={downloadStates} />;
      case 'bulk-download':
        return <BulkDownloadPage catalog={getCatalog()} downloadManager={downloadManager} downloadStates={downloadStates} onCatalogUpdate={() => { setCatalog(getCatalog()); setLibraryStats(getLibraryStats()); }} />;
      case 'network':
        return <NetworkPage nodeStats={realStats} />;
      case 'community':
        return <CommunityPage />;
      case 'connections':
        return <ConnectionsPage p2pRunning={p2pRunning} p2pEnabled={p2pEnabled} onP2pToggle={handleP2pToggle} />;
      case 'settings':
        return <SettingsPage contentMode={contentMode} onModeChange={handleModeChange} nodeOnline={nodeOnline} onNodeToggle={handleNodeToggle} p2pEnabled={p2pEnabled} p2pRunning={p2pRunning} onP2pToggle={handleP2pToggle} bandwidthLimit={bandwidthLimit} onBandwidthChange={handleBandwidthChange} storageLimit={storageLimit} onStorageLimitChange={handleStorageLimitChange} backgroundMode={backgroundMode} onBackgroundModeChange={handleBackgroundModeChange} uploadLimitEnabled={uploadLimitEnabled} onUploadLimitToggle={handleUploadLimitToggle} uploadLimitKbps={uploadLimitKbps} onUploadLimitKbpsChange={handleUploadLimitKbpsChange} seedScheduleEnabled={seedScheduleEnabled} onSeedScheduleToggle={handleSeedScheduleToggle} seedStart={seedStart} onSeedStartChange={handleSeedStartChange} seedEnd={seedEnd} onSeedEndChange={handleSeedEndChange} seedStatus={seedStatus} uploadCapEnabled={uploadCapEnabled} onUploadCapToggle={handleUploadCapToggle} uploadCapGb={uploadCapGb} onUploadCapGbChange={handleUploadCapGbChange} chatNotify={chatNotify} onChatNotifyChange={handleChatNotifyChange} chatShow={chatShow} onChatShowChange={handleChatShowChange} nodeStats={realStats} version={appVersion} onNavigate={navigateTo} onShowConditions={() => setConditionsOpen(true)} />;
      case 'about':
        return <AboutPage version={appVersion} onShowConditions={() => setConditionsOpen(true)} />;
      default:
        return <LibraryPage sermons={catalogWithDlState} currentSermon={currentSermon} isPlaying={isPlaying} onPlay={playSermon} onDownload={handleDownload} onOpenExternal={openInDefaultPlayer} search={search} onSearch={setSearch} />;
    }
  };

  // Recovery for the SHELL boundary below. A crash out here is almost always the
  // player: a bad stream URL, a sermon object the PlayerBar can't render, or a
  // media element in a broken state. Tearing the player down is therefore the
  // reset that actually removes the cause — and it also stops audio that would
  // otherwise keep playing behind an error screen with no way to silence it.
  const handleShellReset = useCallback(() => {
    closePlayer();
    setPage('dashboard');
  }, [closePlayer]);

  return (
    // SHELL boundary. The <audio> element, the mini video player, the Sidebar and
    // the PlayerBar all used to sit OUTSIDE every boundary, so a throw in any of
    // them took the whole window to a blank screen with no recovery at all — and
    // an <audio> element with no boundary above it can keep playing through a
    // crash while its controls are gone. React always uses the NEAREST boundary,
    // so page-level crashes are still caught by the inner boundary around
    // renderPage() and never reach this one: the shell (and playback) survives a
    // page crash exactly as it does today.
    <ErrorBoundary onReset={handleShellReset}>
      {/* First-launch agreement gate — blocks the app until conditions are accepted */}
      {!conditionsAgreed && (
        <ConditionsModal mode="agree" onAgree={handleAgreeConditions} />
      )}
      {/* Read-only conditions viewer (opened from About / Settings) */}
      {conditionsAgreed && conditionsOpen && (
        <ConditionsModal mode="view" onClose={() => setConditionsOpen(false)} />
      )}

      {/* Hidden audio element for audio-only playback */}
      <audio ref={audioRef} preload="none" />

      {/* Persistent mini video player — bottom-right corner */}
      {currentSermon && currentSermon.type === 'video' && videoMini && (
        <div className={`video-mini-player ${videoFullscreen ? 'fullscreen' : ''}`}>
          <div className="video-mini-header">
            <div className="video-mini-title">{currentSermon.title}</div>
            <div className="video-mini-controls">
              <button
                className="video-mini-btn"
                onClick={() => openInDefaultPlayer(currentSermon)}
                title="Open in default player (QuickTime)"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /><polyline points="15 3 21 3 21 9" /><line x1="10" y1="14" x2="21" y2="3" /></svg>
              </button>
              <button
                className="video-mini-btn"
                onClick={() => setVideoFullscreen(!videoFullscreen)}
                title={videoFullscreen ? 'Exit Fullscreen' : 'Fullscreen'}
              >
                {videoFullscreen ? (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="4 14 10 14 10 20" /><polyline points="20 10 14 10 14 4" /><line x1="14" y1="10" x2="21" y2="3" /><line x1="3" y1="21" x2="10" y2="14" /></svg>
                ) : (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 3 21 3 21 9" /><polyline points="9 21 3 21 3 15" /><line x1="21" y1="3" x2="14" y2="10" /><line x1="3" y1="21" x2="10" y2="14" /></svg>
                )}
              </button>
              <button className="video-mini-btn" onClick={closePlayer} title="Close">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
              </button>
            </div>
          </div>
          <video
            ref={videoRef}
            className="video-mini-element"
            playsInline
            preload="auto"
            onClick={() => {
              if (videoRef.current) {
                if (isPlaying) videoRef.current.pause(); else videoRef.current.play().catch(() => {});
              }
            }}
            onTimeUpdate={(e) => {
              const v = e.target;
              setCurrentTime(v.currentTime);
              setDuration(v.duration || 0);
              setProgress(v.duration ? (v.currentTime / v.duration) * 100 : 0);
              // Real playback progress => codec decodes fine. Cancel the watchdog.
              if (!videoStartedRef.current && v.currentTime > 0.15) {
                videoStartedRef.current = true;
                if (videoWatchdogRef.current) { clearTimeout(videoWatchdogRef.current); videoWatchdogRef.current = null; }
                setVideoError(null);
              }
            }}
            onEnded={() => { setIsPlaying(false); setProgress(0); setCurrentTime(0); }}
            onPlay={() => {
              setIsPlaying(true);
              // Arm a watchdog: WKWebView "plays" undecodable audio (Opus-in-MP4)
              // without firing an error — it just renders black and never advances.
              // If we're still at ~0 after a few seconds, treat it as unplayable inline.
              if (videoWatchdogRef.current) clearTimeout(videoWatchdogRef.current);
              if (!videoStartedRef.current) {
                videoWatchdogRef.current = setTimeout(() => {
                  const vv = videoRef.current;
                  // "Playing" (not paused) yet no frames advanced => codec can't
                  // decode inline. A paused element is just autoplay-blocked, skip.
                  if (vv && !videoStartedRef.current && !vv.paused && (vv.currentTime || 0) < 0.15) {
                    vv.pause();
                    setVideoError('inline-unsupported');
                    setIsPlaying(false);
                  }
                }, 4000);
              }
            }}
            onPause={() => {
              setIsPlaying(false);
              if (videoWatchdogRef.current) { clearTimeout(videoWatchdogRef.current); videoWatchdogRef.current = null; }
            }}
            onLoadedMetadata={(e) => { setDuration(e.target.duration || 0); }}
            onError={(e) => {
              // When using <source> elements, error may fire on <source> — always use the <video> ref
              const v = videoRef.current;
              if (!v) return;
              const mediaError = v.error;
              const errorCodes = { 1: 'MEDIA_ERR_ABORTED', 2: 'MEDIA_ERR_NETWORK', 3: 'MEDIA_ERR_DECODE', 4: 'MEDIA_ERR_SRC_NOT_SUPPORTED' };
              const errorName = errorCodes[mediaError?.code] || 'UNKNOWN';
              const sourceEl = v.querySelector('source');
              const src = sourceEl?.src || v.src || '';
              console.warn(`[VideoPlayer] Error: ${errorName} (code ${mediaError?.code}) message: ${mediaError?.message || 'none'} src: ${src?.slice(0, 100)}`);
              // If local file failed, try CDN URL directly
              const cdnUrl = currentSermon?.cdnUrl || currentSermon?.archiveUrl || currentSermon?.url;
              if (cdnUrl && src !== cdnUrl && !src.startsWith('blob:')) {
                console.log('[VideoPlayer] Local playback failed, trying CDN:', cdnUrl);
                // Replace source element
                while (v.firstChild) v.removeChild(v.firstChild);
                const newSource = document.createElement('source');
                newSource.src = cdnUrl;
                newSource.type = 'video/mp4';
                v.appendChild(newSource);
                v.load();
                v.play().catch(() => {
                  setVideoError(`Playback failed: ${errorName}`);
                  setIsPlaying(false);
                });
              } else {
                setVideoError(`Playback failed: ${errorName}`);
                setIsPlaying(false);
              }
            }}
          />
          {/* Error overlay */}
          {videoError && (
            <div className="video-error-overlay">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.6, marginBottom: '8px' }}>
                <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                <line x1="12" y1="9" x2="12" y2="13" />
                <line x1="12" y1="17" x2="12.01" y2="17" />
              </svg>
              <div style={{ fontSize: '0.8rem', marginBottom: '8px', textAlign: 'center', lineHeight: 1.4 }}>
                This video can't preview inline. Open it in your Mac's player instead.
              </div>
              <button
                className="btn btn-gold"
                style={{ fontSize: '0.75rem', padding: '4px 12px' }}
                onClick={() => openInDefaultPlayer(currentSermon)}
              >
                Open in default player
              </button>
            </div>
          )}
        </div>
      )}

      <Sidebar
        page={page}
        onNavigate={navigateTo}
        nodeOnline={nodeOnline}
        nodeStats={realStats}
        seedUnlocked={seedUnlocked}
        libraryStats={libraryStats}
        announcement={announcement}
        unreadChat={chatShow && chatNotify ? unreadChat : 0}
        chatShow={chatShow}
        nodesOnline={nodesOnline}
        seedsOnline={seedsOnline}
        version={appVersion}
      />
      <div className="main-content">
        <TopBar contentMode={contentMode} announcement={announcement} onNavigate={navigateTo} networkHealth={networkHealth} />
        <div className={`content-scroll ${page === 'network' || page === 'connections' ? 'no-pad' : ''}`}>
          {/* Page boundary — a crashing page must not take the shell (or
              playback) with it. Its reset returns to a page known to render. */}
          <ErrorBoundary onReset={() => setPage('dashboard')}>
            {renderPage()}
          </ErrorBoundary>
        </div>
        <DonateBanner />
        <ImageContextMenu />
        {/* UpdatePrompt now renders inline in the Sidebar (above the status box) */}
        {currentSermon && (
          <PlayerBar
            sermon={currentSermon}
            isPlaying={isPlaying}
            progress={progress}
            currentTime={currentTime}
            duration={duration}
            volume={volume}
            onTogglePlay={togglePlay}
            onSeek={seekTo}
            onVolumeChange={handleVolumeChange}
            onClose={closePlayer}
          />
        )}
      </div>
    </ErrorBoundary>
  );
}
