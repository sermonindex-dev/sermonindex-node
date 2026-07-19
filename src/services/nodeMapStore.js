/**
 * nodeMapStore — ONE live view of the network's node map.
 *
 * WHY THIS EXISTS
 * ---------------
 * Three places used to show "how many nodes are online": the sidebar badge
 * ("Node Map [N]"), the Node Map page's own "Online N", and the Dashboard's
 * network-reach tile. All three called `heartbeat.fetchNodeMap()` themselves on
 * different schedules (60s / 30s / once-on-mount-and-never-again), so they drifted
 * apart and the app appeared to contradict itself.
 *
 * They now all read THIS store, which polls once and fans the result out. Two
 * views can no longer disagree, because there is only one number.
 *
 * BEHAVIOUR
 *   • Lazy: the interval starts on the FIRST subscriber and stops when the LAST
 *     one unsubscribes — no background traffic when nothing is rendering it.
 *   • Wakes up: re-fetches when the window becomes visible again or the machine
 *     comes back online (laptop sleep/wake, wifi blips), debounced so a burst of
 *     wake events can't hammer the endpoint.
 *   • Never throws, and never blanks out good data: if a poll comes back empty
 *     (which is also what a network error looks like here) we KEEP the previous
 *     snapshot rather than flashing "0 nodes".
 *
 * API
 *   subscribe(fn) → unsubscribe()   fn is called immediately with the current
 *                                   snapshot, then on every change.
 *   getSnapshot() → { nodes, count, isLive, ts }
 *   refreshNow()                    optional manual nudge (respects the debounce)
 */

import { fetchNodeMap, getNodeId, getCachedGeo } from './heartbeat.js';

const POLL_MS = 30000;   // same cadence the Node Map page used
const MIN_GAP_MS = 10000; // debounce wake/online re-fires (cf. updater.js's 30-min
                          // debounce on a 6-hour poller — same idea, scaled to 30s)

let _snapshot = { nodes: [], count: 0, isLive: false, ts: 0 };
let _sig = '';               // signature of _snapshot.nodes (see nodesSig)
const _subs = new Set();
let _timer = null;
let _lastFetch = 0;
let _inFlight = false;
let _listeners = false;

/**
 * Stable signature of the fields that actually matter to any consumer, so an
 * unchanged poll keeps the SAME `nodes` array reference. The Node Map canvas
 * rebuilds itself whenever that reference changes, so this is what stops the map
 * tearing down and redrawing every 30 seconds.
 */
function nodesSig(list) {
  return list.map(n =>
    `${n.id}|${n.lat}|${n.lon}|${n.coverage}|${n.category || ''}|${n.type || ''}|${n.reachable ? 1 : 0}|${n.city || ''}|${n.region || ''}|${n.country || ''}`
  ).sort().join(';');
}

/**
 * The map server sometimes has us listed before it has resolved our location.
 * Patch in the geo we already cached locally so our own dot isn't stranded at
 * "Unknown".
 */
function withOwnGeo(list) {
  const myId = getNodeId();
  const geo = getCachedGeo();
  if (!geo) return list;
  return list.map(n => (
    n.id === myId && (n.city === 'Unknown' || !n.city)
      ? { ...n, city: geo.city, region: geo.region || '', country: geo.country, lat: geo.lat, lon: geo.lon }
      : n
  ));
}

/**
 * Fallback for when the map server reports nothing at all (first launch, or the
 * server is having a moment): show the user their OWN node.
 *
 * This deliberately lives in the STORE, not in the Node Map page. It used to be
 * page-local, which meant the page could show "1" while the sidebar badge showed
 * "0" — exactly the kind of contradiction this store exists to prevent. Anything
 * every view should see belongs here; anything only one view shows does not.
 */
function selfNode() {
  const geo = getCachedGeo();
  if (!geo || !geo.lat) return null;
  return {
    id: getNodeId(),
    lat: geo.lat, lon: geo.lon,
    city: geo.city, region: geo.region || '', country: geo.country,
    coverage: 0,
    type: 'user',
  };
}

function publish(nodes, isLive) {
  const sig = nodesSig(nodes);
  const changed = sig !== _sig;
  _sig = sig;
  _snapshot = {
    nodes: changed ? nodes : _snapshot.nodes, // keep the old reference when equal
    count: nodes.length,
    isLive,
    ts: Date.now(),
  };
  for (const fn of _subs) {
    try { fn(_snapshot); } catch { /* a bad subscriber must not stop the others */ }
  }
}

async function refresh() {
  if (_inFlight) return;
  const now = Date.now();
  if (now - _lastFetch < MIN_GAP_MS) return; // debounce wake/online/resubscribe bursts
  _inFlight = true;
  _lastFetch = now;
  try {
    const live = await fetchNodeMap(); // never throws; returns [] on failure
    const list = Array.isArray(live) ? live : [];
    if (list.length > 0) {
      publish(withOwnGeo(list), true);
    } else if (_snapshot.isLive) {
      // Empty here is indistinguishable from a failed request, and we already
      // have real data — keep it rather than blanking the map to zero.
    } else {
      const me = selfNode();
      publish(me ? [me] : [], false);
    }
  } catch {
    // Keep the previous snapshot. Silence is correct: a transient map-server
    // hiccup is not something to bother the user about.
  } finally {
    _inFlight = false;
  }
}

function attachWakeListeners() {
  if (_listeners || typeof window === 'undefined') return;
  _listeners = true;
  const wake = () => { if (_timer) refresh(); }; // only while someone's subscribed
  try {
    window.addEventListener('online', wake);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') wake();
    });
  } catch { /* non-browser env */ }
}

/** Manual nudge (still debounced). */
export function refreshNow() {
  refresh();
}

/** The current node map. Safe to call before anyone has subscribed. */
export function getSnapshot() {
  return _snapshot;
}

/**
 * Subscribe to the node map. Calls `fn` immediately with the current snapshot,
 * then on every change. Returns an unsubscribe function — call it on unmount.
 */
export function subscribe(fn) {
  if (typeof fn !== 'function') return () => {};
  _subs.add(fn);
  if (!_timer) {
    attachWakeListeners();
    _timer = setInterval(() => refresh(), POLL_MS);
    refresh(); // first read straight away (debounced, so a component that
               // resubscribes on a prop change can't re-hit the endpoint)
  }
  try { fn(_snapshot); } catch {}

  let done = false;
  return () => {
    if (done) return;      // idempotent — double-unsubscribe can't unbalance the count
    done = true;
    _subs.delete(fn);
    if (_subs.size === 0 && _timer) {
      clearInterval(_timer);
      _timer = null;
    }
  };
}
