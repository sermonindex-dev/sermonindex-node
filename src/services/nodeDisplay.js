/**
 * nodeDisplay — the CLI's dashboard, served by this app.
 *
 * WHAT CHANGED AND WHY. There was a React re-creation of the CLI's kiosk screen
 * living inside the app window. It looked close, and "close" was the problem:
 * two files to keep in step, a fullscreen that fought the app's own window, and
 * a display that could drift from the one on the Pi without anyone noticing.
 *
 * This is the real thing instead. `src-tauri/src/nodedisplay.rs` is the CLI's
 * `dashboard.rs`, and the page it serves is a byte-for-byte copy of the CLI's
 * `assets/dashboard.html`. The app's job is now only to feed it the same
 * `/stats` payload the CLI's `Shared::render()` produces, and to open a browser
 * at it — where fullscreen is the browser's own, and works.
 *
 * It is a real HTTP server on the same port the CLI uses, so the display also
 * opens from a phone or tablet on the same network, which is most of why anyone
 * wants one.
 *
 * WHY THIS FILE READS ITS OWN DATA (0.0.334)
 * ------------------------------------------
 * The first version took a `getInput()` callback from the Stats page and fed
 * whatever that returned. Three things went wrong with that, and they are all
 * the same mistake:
 *
 *   1. It could only ever be as good as the props ONE page happened to hold.
 *      `nodeStats` on the Stats page carries no `running`, no `tcp_listen_port`,
 *      no `uptime_secs` and no `storage_path`, so the display was told the node
 *      was unavailable and sat on "STARTING · IDLE" while the app itself showed
 *      a running node with peers. Nothing to do with dev mode.
 *   2. Where a key was merely misspelled the display did not go blank, it went
 *      WRONG: `libraryStats.downloadedBytes` does not exist (the field is
 *      `downloadedSizeBytes`), so the library size arrived as 0 and the page
 *      fell through to the host meter's `disk_used` — the whole boot volume,
 *      382 GB of a laptop, presented as the size of the sermon library. The
 *      `network` block was simply never passed at all, which is why the map
 *      read 0 nodes, 0 countries.
 *   3. A display fed by a page dies with the page. The whole point of a kiosk
 *      screen is that it keeps going while its owner does something else.
 *
 * So the display now collects from the same primary sources the rest of the app
 * uses — the torrent session, the catalogue, the node map — on its own clock,
 * and owes nothing to whichever page pressed the button. Each source is polled
 * at the cadence its data actually changes at: peers every couple of seconds,
 * the library every half minute, the network map every minute. A source that
 * fails leaves the last good reading in place rather than writing a zero,
 * because "I could not read it" and "it is zero" are different statements and
 * only one of them is usually true.
 */

import { getLibraryStats, getSeedProgress } from './catalog.js';
import { fetchNodeMap, fetchNetworkStats, getNodeId, getCachedGeo } from './heartbeat.js';
import { readReachability, readIpv6Observation } from './network.js';
import { isReachable, readSeedGranted, deriveNodeState } from '../utils/nodeStatus.js';

let tauriInvoke = null;
let pushTimer = null;
let currentUrl = null;

async function invoke(cmd, args) {
  if (!tauriInvoke) {
    const core = await import('@tauri-apps/api/core');
    tauriInvoke = core.invoke;
  }
  return tauriInvoke(cmd, args);
}

// torrent.js is loaded on demand — the same pattern the pages use, so a build
// without a torrent session still opens the display (it just reports a node
// that isn't running, which is the truth).
let torrentModule = null;
let torrentLoadAttempted = false;
async function ensureTorrent() {
  if (torrentLoadAttempted) return torrentModule;
  torrentLoadAttempted = true;
  try { torrentModule = await import('./torrent.js'); } catch { torrentModule = null; }
  return torrentModule;
}

/** Lifetime uploaded bytes — the same counter heartbeat.js accumulates into. */
function readUploadedLifetime() {
  try {
    const raw = localStorage.getItem('si-uploaded-lifetime');
    if (!raw) return 0;
    return Number(JSON.parse(raw).lifetime) || 0;
  } catch { return 0; }
}

function readScope() {
  try { return localStorage.getItem('si-seed-scope') || 'audio'; } catch { return 'audio'; }
}

// ── Rolling windows for the trend lines, mirroring the CLI's `Trends` ────────

const TREND_MAX = 120;
const trends = {
  up_bps: [], down_bps: [], cpu: [], temp: [],
  peers: [], peers_in: [], peers_out: [], net_up: [],
};
function pushTrend(key, v) {
  const arr = trends[key];
  arr.push(Number(v) || 0);
  if (arr.length > TREND_MAX) arr.shift();
}

// ── The live reading ────────────────────────────────────────────────────────
// One object, updated in place by the pollers below. Every field starts at a
// value that is honest before anything has been read: a node that has not been
// looked at yet is not running, and nothing is claimed about its reachability.

const live = {
  running: false,
  port: 0,
  uptimeSecs: 0,
  peers: 0,
  peersIn: 0,
  peersOut: 0,
  peersPeak: 0,
  held: 0,
  catalogTotal: 0,
  coveragePct: 0,
  storageBytes: 0,
  uploadedBytes: 0,
  upBps: 0,
  reachable: null,
  seedGranted: false,
  category: 'peer',
  storagePath: '',
  network: null,
  history: [],
};

// Upload rate, differenced from the cumulative counter. librqbit does report a
// live speed, but it is a formatted string plus an Mbps float whose shape has
// changed between releases; bytes are bytes, and two readings of a monotonic
// counter cannot disagree with themselves.
let lastUp = { bytes: 0, at: 0 };

/** Peers, seeding count and upload rate. Cheap; every tick. */
async function pollSession() {
  const mod = await ensureTorrent();
  if (!mod) { live.running = false; return; }
  const st = await mod.getStatus().catch(() => null);
  if (!st) { live.running = false; return; }
  live.running = !!st.running;
  live.port = Number(st.tcp_listen_port) || 0;
  live.uptimeSecs = Number(st.uptime_secs) || 0;
  if (!st.running) { live.peers = 0; live.upBps = 0; return; }

  const list = await mod.listTorrents().catch(() => null);
  if (!Array.isArray(list)) return;
  live.peers = list.reduce((n, t) => n + (t.stats?.live?.snapshot?.peer_stats?.live || 0), 0);

  const upNow = list.reduce((n, t) => n + (t.stats?.uploaded_bytes || 0), 0);
  const at = Date.now();
  if (lastUp.at && at > lastUp.at && upNow >= lastUp.bytes) {
    live.upBps = ((upNow - lastUp.bytes) * 1000) / (at - lastUp.at);
  }
  lastUp = { bytes: upNow, at };
}

/**
 * Who dialled whom. The native side throttles the real peer-table scan to once
 * every 30s, so this is polled at 20s and costs nothing. A missing answer is
 * left as the previous value: absence of evidence is not evidence of zero.
 */
async function pollDirection() {
  const mod = await ensureTorrent();
  if (!mod) return;
  const obs = await mod.getIpv6Observation().catch(() => null);
  if (!obs) return;
  live.peersIn = Number(obs.inbound_peers) || 0;
  live.peersOut = Number(obs.outbound_peers) || 0;
  live.peersPeak = Math.max(live.peersPeak, Number(obs.inbound_peers_peak) || 0);
}

/**
 * The library — size on disk and coverage of the chosen scope.
 *
 * `downloadedSizeBytes` is the sum of REAL on-disk file sizes for the sermons
 * this node holds. That is the number the display's "Library size" should show.
 * The Rust side's `system.disk_used` is the whole volume, which on a dedicated
 * Pi drive happens to be nearly the same figure and on a laptop is nothing like
 * it — the user's boot disk, hundreds of gigabytes of everything else.
 */
function pollLibrary() {
  try {
    const st = getLibraryStats();
    live.storageBytes = Number(st?.downloadedSizeBytes) || 0;
  } catch { /* keep last good */ }
  try {
    const sp = getSeedProgress(readScope());
    live.held = Number(sp?.downloaded) || 0;
    live.catalogTotal = Number(sp?.total) || 0;
    live.coveragePct = Number(sp?.pct) || 0;
  } catch { /* keep last good */ }
  live.uploadedBytes = readUploadedLifetime();
  live.seedGranted = readSeedGranted();
}

/** Reachability and the resulting category, from the same readings the UI uses. */
function pollStatus() {
  try {
    const reach = readReachability();
    const ipv6 = readIpv6Observation();
    const open = isReachable({ reach, ipv6 });
    // `null` only while nothing has ever been measured. Once a probe has run,
    // "not reachable" is a real answer and the display should say so.
    live.reachable = (reach || ipv6) ? open : null;
    live.category = deriveNodeState({
      running: live.running, reachable: open, seedGranted: live.seedGranted,
    }).key;
  } catch { /* keep last good */ }
}

/** Where the sermons actually live — read once; it only changes in Settings. */
async function pollStoragePath() {
  if (live.storagePath) return;
  try {
    const dir = await invoke('get_storage_dir');
    if (typeof dir === 'string' && dir) live.storagePath = dir;
  } catch { /* the Rust side falls back to "/" — still a true answer */ }
}

/**
 * The network block, shaped exactly as the CLI's `state::build_network_view`
 * shapes it, from the same two endpoints (`/api/node/map`, `/api/node/stats`).
 *
 * Kept last-good on an empty answer for the same reason the CLI does it: a
 * timed-out fetch and an empty network look identical from here, and blanking
 * a working map to zero is the worse of the two mistakes.
 */
async function pollNetwork() {
  const [nodes, stats] = await Promise.all([
    fetchNodeMap().catch(() => []),
    fetchNetworkStats().catch(() => null),
  ]);
  const list = Array.isArray(nodes) ? nodes : [];
  if (!list.length) return;

  const myId = getNodeId();
  const geo = getCachedGeo();
  const view = list.map(n => {
    const mine = n.id === myId;
    const city = (mine && (!n.city || n.city === 'Unknown') && geo) ? geo.city : (n.city || '');
    const country = (mine && !n.country && geo) ? geo.country : (n.country || '');
    const category = n.category || (
      n.type === 'seed' ? 'seed' : (n.reachable ? 'node' : 'peer')
    );
    return {
      name: city,
      self: mine,
      online: true,
      category,
      lat: mine && geo && n.lat == null ? geo.lat : n.lat,
      lon: mine && geo && n.lon == null ? geo.lon : n.lon,
      city,
      country,
      sermons: Number(n.files ?? n.sermons) || 0,
      coverage: Math.min(100, Math.max(0, Number(n.coverage) || 0)),
    };
  });

  const s = stats || {};
  live.network = {
    nodes: view,
    online_count: Number(s.totalNodes) || view.length,
    total_count: Number(s.totalNodesEver) || view.length,
    seeds: Number(s.seedNodes) || view.filter(n => n.category === 'seed').length,
    total_sermons: Number(s.totalFiles) || 0,
    storage: Number(s.totalStorage) || 0,
    countries: Number(s.countries) || new Set(view.map(n => n.country).filter(Boolean)).size,
    net_peers: Number(s.peers) || 0,
    up_bps: 0,
  };
}

/**
 * The seven-day direction record the app already keeps, converted to the hourly
 * rows the display's `dirBars()` folds into days. The app stores one row per
 * day; the display keeps each day's peak, so a day maps to a single row without
 * losing anything.
 */
function pollHistory() {
  try {
    const raw = localStorage.getItem('si-daily-record');
    if (!raw) return;
    const days = JSON.parse(raw)?.days;
    if (!Array.isArray(days)) return;
    live.history = days.slice(-7).map(d => ({
      // Noon local, so the display's own `new Date(ts*1000)` lands on the same
      // calendar day in any timezone it happens to be read in.
      ts: Math.floor(new Date(`${d.d}T12:00:00`).getTime() / 1000) || 0,
      peers_in: Number(d.i) || 0,
      peers_out: Number(d.o) || 0,
      peers_in_peak: Number(d.i) || 0,
      peers: (Number(d.i) || 0) + (Number(d.o) || 0),
      up: Number(d.v) || 0,
      held: Number(d.n) || 0,
    })).filter(r => r.ts);
  } catch { /* keep last good */ }
}

// ── The payload ─────────────────────────────────────────────────────────────

/**
 * Build the `/stats` payload in the CLI's own shape.
 *
 * The `system` half is deliberately absent: CPU, temperature, memory and NIC
 * throughput are host facts and a WebView cannot measure any of them. The Rust
 * side fills those in from the CLI's own `system.rs` before serving. Asking this
 * layer for numbers it would have to invent is how a dashboard starts lying.
 *
 * Exported with an optional override so a caller can still feed it by hand —
 * used by the tests, and by anything that wants to render a fixed snapshot.
 */
export function buildStats(override = {}) {
  const s = { ...live, ...override };

  pushTrend('peers', s.peers);
  pushTrend('peers_in', s.peersIn);
  pushTrend('peers_out', s.peersOut);
  pushTrend('up_bps', s.upBps);
  pushTrend('net_up', s.upBps);

  return {
    node: {
      available: !!s.running,
      port: Number(s.port) || 0,
      peers: Number(s.peers) || 0,
      uptime_s: Math.round(s.uptimeSecs) || 0,
      coverage_pct: Number(s.coveragePct) || 0,
      held: Number(s.held) || 0,
      catalog: Number(s.catalogTotal) || 0,
      storage_bytes: Number(s.storageBytes) || 0,
      uploaded_bytes: Number(s.uploadedBytes) || 0,
      reachable: s.reachable === true ? 'yes' : s.reachable === false ? 'no' : 'unknown',
      quiet: false,
      disk_full: false,
      seed_granted: !!s.seedGranted,
      category: s.category || 'peer',
      peers_in: Number(s.peersIn) || 0,
      peers_out: Number(s.peersOut) || 0,
      peers_in_peak: Number(s.peersPeak) || 0,
      // Read by the Rust side to decide which filesystem to report on — a seed
      // node's "disk used" means the library's drive, not the boot volume.
      storage_path: s.storagePath || '',
      up_bps: Number(s.upBps) || 0,
    },
    network: s.network || {},
    trends: { ...trends },
    history: Array.isArray(s.history) ? s.history : [],
    at: Math.floor(Date.now() / 1000),
  };
}

/** Send one payload to the server. Safe to call before it has started. */
export async function pushStats(override) {
  try {
    await invoke('node_display_push', { stats: JSON.stringify(buildStats(override)) });
  } catch (e) {
    console.warn('[nodeDisplay] push failed:', e);
  }
}

// ── The clock ───────────────────────────────────────────────────────────────
// Each source on its own cadence, counted in ticks of the 2s push loop so there
// is only ever one timer to start, stop and reason about.

const TICK_MS = 2000;
const EVERY_DIRECTION = 10;  // 20s
const EVERY_LIBRARY = 15;    // 30s
const EVERY_NETWORK = 30;    // 60s
let tickCount = 0;

async function tick() {
  tickCount++;
  // Never let one slow source hold up the push: gather what we can, push what
  // we have. A display that stutters is worse than one figure being 2s old.
  const jobs = [pollSession()];
  if (tickCount === 1 || tickCount % EVERY_DIRECTION === 0) jobs.push(pollDirection());
  if (tickCount === 1 || tickCount % EVERY_NETWORK === 0) jobs.push(pollNetwork());
  if (tickCount === 1) jobs.push(pollStoragePath());
  await Promise.allSettled(jobs);
  if (tickCount === 1 || tickCount % EVERY_LIBRARY === 0) { pollLibrary(); pollHistory(); }
  pollStatus();
  await pushStats();
}

/**
 * Start the server if needed, keep it fed, and open a browser at it.
 *
 * Takes nothing: the display reads its own sources, so it keeps updating after
 * the user has walked away from whichever page launched it — which is the
 * entire point of a display.
 */
export async function openNodeDisplay() {
  const url = await invoke('node_display_start');
  currentUrl = url;
  startFeeding();
  // One full gather before the browser opens, so the first paint is real data
  // rather than an empty screen that fills in two seconds later.
  await tick().catch(() => {});
  await invoke('open_url', { url });
  return url;
}

/** Begin (or restart) the feed without opening a browser. */
export function startFeeding() {
  if (pushTimer) return;
  tickCount = 0;
  pushTimer = setInterval(() => { tick().catch(() => {}); }, TICK_MS);
}

/** The URL if the server is up — for showing "open this on your phone". */
export async function nodeDisplayUrl() {
  if (currentUrl) return currentUrl;
  try { return await invoke('node_display_url'); } catch { return null; }
}

/** Stop feeding it. The server stays up; the page simply stops changing. */
export function stopFeeding() {
  if (pushTimer) { clearInterval(pushTimer); pushTimer = null; }
}
