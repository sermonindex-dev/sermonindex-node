/**
 * SermonIndex Network Services — client wrapper.
 *
 * Talks to the Bunny Edge Script in server/network-edge-script.js:
 *   POST /probe  { port, ipv6? }    → { ok, open, ip, port, open_v6, ipv6, v6_probe }
 *   POST /seeds  { node_id, port, scope } → { ok, reachable }
 *   GET  /seeds                     → { ok, seeds:[...] }
 *
 * After deploying that script, replace NETWORK_API below with its bunny.run
 * hostname (same as we did for the community chat).
 */

// Deployed network Edge Script (see server/network-edge-script.js).
export const NETWORK_API = 'https://app-endpoints-gkb5p.bunny.run';

const isConfigured = () => !NETWORK_API.includes('REPLACE-WITH');

/**
 * Is this IPv4 address inside the carrier-grade NAT range, 100.64.0.0/10?
 * (RFC 6598 — the block ISPs use for the "shared" address space between the
 * customer's router and the carrier's own NAT.)
 *
 * A /10 fixes the first 10 bits: the whole first octet (100) plus the top TWO
 * bits of the second octet, which must be `01`. That makes the second octet
 * anything from 0b01000000 (64) to 0b01111111 (127) — so the range runs
 * 100.64.0.0 through 100.127.255.255 inclusive. Note 100.63.x.x and 100.128.x.x
 * are ordinary public addresses and must NOT match.
 *
 * Deliberately conservative: anything we can't parse with confidence (IPv6,
 * hostnames, empty, malformed, out-of-range octets) returns false, so the app
 * falls back to its normal "port closed" messaging rather than telling someone
 * they're behind CGNAT when we don't actually know.
 */
export function isCgnatAddress(ip) {
  if (typeof ip !== 'string') return false;
  const m = ip.trim().match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;                       // not a plain IPv4 literal
  const oct = m.slice(1).map(Number);
  if (oct.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  return oct[0] === 100 && oct[1] >= 64 && oct[1] <= 127;
}

/**
 * This machine's own globally-routable IPv6 address(es), from the Rust
 * `local_ipv6` command. Empty array when there is no IPv6, when the command
 * isn't available (older build / browser dev server), or on any error.
 *
 * We have to discover this locally because nothing else can: the probe server
 * sees whatever address our HTTPS request happened to arrive on, and the
 * address a BitTorrent peer should dial is the one the OS would pick for global
 * IPv6 egress. Rust asks the kernel that question directly.
 */
export async function localIpv6() {
  try {
    const tauri = await import('@tauri-apps/api/core');
    const list = await tauri.invoke('local_ipv6');
    return Array.isArray(list) ? list.filter((s) => typeof s === 'string' && s.includes(':')).slice(0, 3) : [];
  } catch {
    return [];
  }
}

/**
 * Ask the server to TCP-connect back to us — over IPv4 AND, when we have one,
 * over IPv6 — and report what it actually measured.
 *
 * Returns { open, open_v6, ip, ipv6, port, v6_probe, has_ipv6, cgnat } or null
 * if the service isn't reachable (caller should fall back to canyouseeme.org).
 *
 *   open      IPv4 inbound worked. UNCHANGED in meaning; the seed directory and
 *             every older reader still depend on exactly this field.
 *   open_v6   an IPv6 peer really did open a TCP connection to us. On a CGNAT
 *             connection (Starlink, T-Mobile Home Internet, mobile broadband)
 *             this is routinely true while `open` is permanently false — that
 *             person IS reachable, just not over IPv4.
 *   v6_probe  'ok' the edge genuinely attempted an IPv6 dial (so open_v6 means
 *             something) · 'unsupported' the edge could not make an IPv6 socket
 *             at all, so open_v6:false says nothing about the user and must NOT
 *             be shown as a failure · 'error' unexpected · 'invalid' our
 *             addresses were rejected · 'none' we had no IPv6 to offer.
 *   has_ipv6  this machine has a global IPv6 address of its own. Combined with
 *             open_v6 === false and v6_probe === 'ok', that is the actionable
 *             diagnosis "your router is firewalling inbound IPv6".
 *
 * `cgnat` is true ONLY when the address the probe saw is itself inside
 * 100.64.0.0/10. In practice this rarely fires: the probe reports the address it
 * observes, which for most carrier-NAT customers is the carrier's public egress
 * IP — the 100.64.x.x address lives on the customer's own WAN interface, which
 * the server can't see. So treat `cgnat === false` as "not proven", never as
 * "definitely not behind CGNAT". A successful IPv6 dial-back is the reliable
 * signal that replaces it.
 */
export async function probeReachability(port) {
  if (!isConfigured() || !port) return null;
  const mine = await localIpv6();
  try {
    const res = await fetch(`${NETWORK_API}/probe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(mine.length ? { port, ipv6: mine } : { port }),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || !data.ok) return null;
    // Older deployments of the edge script don't know about IPv6 at all; they
    // simply omit these fields, which reads as "no IPv6 result" — never as a
    // failure. `open` keeps working either way.
    return {
      open: !!data.open,
      open_v6: !!data.open_v6,
      ip: data.ip || null,
      ipv6: data.ipv6 || null,
      port: data.port,
      v6_probe: typeof data.v6_probe === 'string' ? data.v6_probe : 'none',
      has_ipv6: mine.length > 0,
      cgnat: isCgnatAddress(data.ip),
    };
  } catch {
    return null;
  }
}

// ── Last-probe cache ────────────────────────────────────────────────────────
// One place that reads/writes localStorage['si-reach'], so every view (the
// Connections panel, the banner, the Seed Node page, the TopBar health score,
// the heartbeat) sees the same reachability facts without re-probing.
// Shape: { open:boolean, open_v6:boolean, ip:string|null, ipv6:string|null,
//          v6_probe:string, has_ipv6:boolean, cgnat:boolean, ts:number }
// The IPv6 fields are ADDITIVE. `open` keeps its exact old meaning and position
// so anything already reading si-reach (TopBar health score, heartbeat) is
// unaffected; readers that predate IPv6 simply ignore the extra keys.
const REACH_KEY = 'si-reach';

// ── Sticky passive-observation fields ───────────────────────────────────────
// These live in the SAME si-reach blob but have completely different semantics
// from the probe fields above, and the difference matters:
//
//   probe fields (open / open_v6 / …) are a MEASUREMENT AT A MOMENT. They are
//   replaced wholesale every time the user presses Re-test.
//
//   observation fields (v6_inbound_seen / v6_egress_seen) are a HISTORICAL FACT:
//   "at some point, a peer out on the internet opened a connection to us over a
//   public IPv6 address." Reachability is a has-this-ever-happened question, so
//   once true they are NEVER set back to false — not when that peer disconnects,
//   not when the app restarts, not when a later probe comes back negative. A
//   probe can fail for reasons that have nothing to do with the user (our edge
//   has no IPv6 at all); a real inbound connection cannot.
//
// They are therefore carried forward untouched by `saveReachability`, which
// would otherwise wipe them on the next Re-test.
const STICKY_KEYS = ['v6_inbound_seen', 'v6_inbound_ts', 'v6_egress_seen', 'v6_egress_ts'];

const STICKY_DEFAULTS = {
  /** A global-IPv6 peer connected IN to us. PROOF of inbound IPv6 reachability. */
  v6_inbound_seen: false,
  /** When we first saw that (epoch ms), so the UI can say how long we've known. */
  v6_inbound_ts: null,
  /** We dialled OUT to a global-IPv6 peer. Proves IPv6 works outbound, nothing more. */
  v6_egress_seen: false,
  v6_egress_ts: null,
};

/** The raw stored blob, or `{}`. Never throws. */
function rawReach() {
  try {
    const r = JSON.parse(localStorage.getItem(REACH_KEY) || 'null');
    return r && typeof r === 'object' ? r : {};
  } catch { return {}; }
}

/** Remember the latest probe result. Never throws. */
export function saveReachability({
  open, open_v6 = false, ip = null, ipv6 = null,
  v6_probe = 'none', has_ipv6 = false, cgnat = false,
} = {}) {
  try {
    // Carry the sticky observation forward — a fresh probe replaces the probe
    // fields only. Losing v6_inbound_seen here would make a proven-reachable
    // Starlink node look unreachable again after any Re-test.
    const prev = rawReach();
    const carried = {};
    for (const k of STICKY_KEYS) {
      if (prev[k] !== undefined) carried[k] = prev[k];
    }
    localStorage.setItem(REACH_KEY, JSON.stringify({
      open: !!open,
      open_v6: !!open_v6,
      ip,
      ipv6,
      v6_probe: String(v6_probe || 'none'),
      has_ipv6: !!has_ipv6,
      cgnat: !!cgnat,
      ...carried,
      ts: Date.now(),
    }));
  } catch { /* private mode / quota — the UI still works, it just re-probes */ }
}

/**
 * Record what the node PASSIVELY observed about IPv6 from its real peer
 * connections (see `Ipv6Observation` in src-tauri/src/torrent_node.rs).
 *
 * Monotonic by design: this can only ever turn a flag ON. Pass
 * `{ inbound_ipv6: false }` a thousand times and a previously-proven inbound
 * connection stays proven — "we didn't see one in the last 30 seconds" is not
 * evidence that it never happened.
 *
 * Writes even when there is no probe result yet, so a node that has never run
 * the reachability test can still learn it is IPv6-reachable. Returns the merged
 * sticky record (so callers can update state without a second read).
 */
export function recordIpv6Observation(obs) {
  const prev = { ...STICKY_DEFAULTS, ...rawReach() };
  const next = { ...prev };
  const now = Date.now();

  if (obs && obs.inbound_ipv6 === true && !prev.v6_inbound_seen) {
    next.v6_inbound_seen = true;
    next.v6_inbound_ts = now;
  }
  if (obs && obs.outbound_ipv6 === true && !prev.v6_egress_seen) {
    next.v6_egress_seen = true;
    next.v6_egress_ts = now;
  }

  // Nothing new — don't touch storage (keeps `ts` meaning "last probed").
  if (next.v6_inbound_seen === prev.v6_inbound_seen
      && next.v6_egress_seen === prev.v6_egress_seen) {
    return pickSticky(prev);
  }

  try {
    localStorage.setItem(REACH_KEY, JSON.stringify({ ...rawReach(), ...pickSticky(next) }));
  } catch { /* private mode / quota — the observation just won't survive a restart */ }
  return pickSticky(next);
}

function pickSticky(o) {
  const out = {};
  for (const k of STICKY_KEYS) out[k] = o[k] ?? STICKY_DEFAULTS[k];
  return out;
}

/**
 * The latest probe result, or null if there isn't one. Never throws.
 *
 * NOTE the asymmetry: this returns null when no PROBE has ever run, even if a
 * passive IPv6 observation exists. Use `readIpv6Observation()` for that — it is
 * independent of whether the user ever pressed "Test".
 */
export function readReachability() {
  try {
    const r = JSON.parse(localStorage.getItem(REACH_KEY) || 'null');
    if (!r || typeof r.open !== 'boolean') return null;
    // Entries written before the IPv6 probe existed have no v6 keys — fill them
    // with "we don't know", never with "failed".
    return {
      open_v6: false, ipv6: null, v6_probe: 'none', has_ipv6: false, cgnat: false,
      ...STICKY_DEFAULTS,
      ...r,
    };
  } catch { return null; }
}

/**
 * The sticky passive IPv6 observation, independent of any probe result.
 * Always returns an object; all-false means "nothing observed yet", which is
 * NOT the same as "no IPv6".
 */
export function readIpv6Observation() {
  return pickSticky({ ...STICKY_DEFAULTS, ...rawReach() });
}

/** Register/refresh this node in the seed-backbone directory. Fire-and-forget. */
export async function registerSeed(nodeId, port, scope) {
  if (!isConfigured() || !nodeId || !port) return null;
  try {
    const res = await fetch(`${NETWORK_API}/seeds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ node_id: nodeId, port, scope: scope === 'full' ? 'full' : 'audio' }),
      signal: AbortSignal.timeout(15000),
    });
    const data = await res.json().catch(() => null);
    return data && data.ok ? data : null;
  } catch {
    return null;
  }
}

// Seed-access + node tracking live in the si-app admin dashboard (the same
// backend the app heartbeats to), so the admin can enable a node with a flip
// switch and see it alongside live serving/location data.
const DASHBOARD_API = 'https://app.sermonindex.net';

/**
 * Is this node approved for Seed Node access? Checks the dashboard allowlist
 * (an admin flips the switch for a node id). Returns false on any error.
 */
export async function checkSeedAccess(nodeId) {
  if (!nodeId) return false;
  try {
    const res = await fetch(`${DASHBOARD_API}/api/seed/access?node_id=${encodeURIComponent(nodeId)}`, {
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return false;
    const data = await res.json();
    return !!(data && data.ok && data.enabled);
  } catch {
    return false;
  }
}

/**
 * Submit a seed-access request with an email so the admin can enable this node.
 * Shows up as a pending request on the dashboard's Nodes page.
 * Returns the server response ({ requested, enabled }) or null on failure.
 */
export async function requestSeedAccess(nodeId, email) {
  if (!nodeId) return null;
  try {
    const res = await fetch(`${DASHBOARD_API}/api/seed/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ node_id: nodeId, email: email || '' }),
      signal: AbortSignal.timeout(10000),
    });
    const data = await res.json().catch(() => null);
    return data && data.ok ? data : null;
  } catch {
    return null;
  }
}

/** Fetch the currently-active backbone seed nodes. Returns [] on any error. */
export async function fetchSeeds() {
  if (!isConfigured()) return [];
  try {
    const res = await fetch(`${NETWORK_API}/seeds`, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return [];
    const data = await res.json();
    return data && data.ok && Array.isArray(data.seeds) ? data.seeds : [];
  } catch {
    return [];
  }
}
