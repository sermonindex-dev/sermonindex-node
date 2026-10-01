import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import PageHead, { Panel } from '../components/PageHead.jsx';
import { CoverageMeter, MixBars, TrendArea, DailyColumns, ChartTable } from '../components/charts.jsx';
import { openNodeDisplay, nodeDisplayUrl, ensureNodeDisplay } from '../services/nodeDisplay.js';
import { readSeedGranted } from '../utils/nodeStatus.js';
import { getSeedProgress, formatPct } from '../services/catalog.js';
import { getIpv6Observation } from '../services/torrent.js';
import ConnectivityChart from '../components/ConnectivityChart.jsx';

// ── Invite / share (moved here from ImpactPanel) ────────────────────────────
// Canonical public landing page for the node software — shared verbatim in
// every invite (X / Facebook / email / copied link). NOTE: this is the public
// node-software page, NOT the raw installer download or the updater endpoint.
const TOTAL_SERMONS = 33528; // 25,587 audio + 7,941 video (matches Seed Node page)
const SHARE_URL = 'https://www.sermonindex.net/node-software/';
const SHARE_TEXT = `Help Preserve Godly Preaching.`;
// What the "Copy link" option puts on the clipboard (blurb + canonical URL).
const INVITE_MESSAGE = `${SHARE_TEXT} ${SHARE_URL}`;

// Pre-filled share targets. X/Facebook are http(s) and open via the app's
// `open_url` command; email is a mailto: handled by the webview / OS mail client.
const SHARE_X = `https://twitter.com/intent/tweet?text=${encodeURIComponent(SHARE_TEXT)}&url=${encodeURIComponent(SHARE_URL)}`;
const SHARE_FB = `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(SHARE_URL)}`;
const SHARE_EMAIL = `mailto:?subject=${encodeURIComponent('Help preserve historic Christian preaching')}&body=${encodeURIComponent(SHARE_TEXT + '\n\n' + SHARE_URL)}`;

// Open an external target the same way the rest of the app does. http(s) links
// go through the Rust `open_url` command (About page + Donate banner use it too);
// mailto: can't (that command only permits http/https), so it's handed to the
// webview, which delegates it to the OS mail handler. Falls back to an anchor
// click in a non-Tauri/dev context.
async function openExternal(url) {
  if (/^https?:/i.test(url)) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('open_url', { url });
      return;
    } catch (e) {
      console.warn('[Stats] open_url failed:', e);
    }
  }
  try {
    const a = document.createElement('a');
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
  } catch (e) {
    console.warn('[Stats] external open failed:', e);
  }
}

// Refresh cadence for the headline figures (peers / seeded count / coverage).
const REFRESH_MS = 12000;
// How often we sample "peers helped" into the live sparkline.
const SAMPLE_MS = 10000;
// Sparkline window: seed with this many points so it's never empty, cap the total.
const SEED_POINTS = 14;
const MAX_POINTS = 44;

// Torrent service — lazy-loaded, same pattern the rest of the app uses so this
// page never blocks first paint and works in non-Tauri dev too.
let torrentModule = null;
let torrentLoadAttempted = false;
async function ensureTorrent() {
  if (torrentLoadAttempted) return torrentModule;
  torrentLoadAttempted = true;
  try { torrentModule = await import('../services/torrent.js'); } catch { torrentModule = null; }
  return torrentModule;
}

// Lifetime uploaded bytes — the SAME source heartbeat.js accumulates into, so
// this figure matches what the network dashboard reports for this node.
function readUploadedLifetime() {
  try {
    const raw = localStorage.getItem('si-uploaded-lifetime');
    if (!raw) return 0;
    const st = JSON.parse(raw);
    return Number(st.lifetime) || 0;
  } catch { return 0; }
}

// ── Daily record (task: two more honest graphs) ─────────────────────────────
// The app stores NO history: `downloadState` entries are { downloaded, magnet,
// diskSize, incomplete } with no timestamp anywhere, and `si-uploaded-lifetime`
// is a single running total. So there is no past to chart — which means either
// we invent one (never) or we start keeping one. This keeps one, and the charts
// say plainly that the record starts the day you first open this page.
//
// Deliberately TINY, given the 22.7 MB master-list incident that silently blew
// the ~5 MB localStorage quota: ONE row per day, at most 30 days, roughly 1.5 KB
// in total. Nothing per-sermon ever goes in here. Writes are guarded and a
// failure only warns — a chart is never worth breaking the page for.
const HISTORY_KEY = 'si-daily-record';
const HISTORY_MAX_DAYS = 30;

// Local calendar day, e.g. "2026-07-19" (local on purpose — "today" should mean
// the volunteer's today, not UTC's).
function dayKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// "19 Jul" — short, plain, and in the reader's own locale order.
function dayLabel(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ''));
  if (!m) return '';
  // Constructed from parts, not Date.parse, so "2026-07-19" isn't read as UTC
  // and shown as the previous day west of Greenwich.
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  try { return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }); }
  catch { return key; }
}

// Shape: { base, days: [{ d:'YYYY-MM-DD', v:<lifetime uploaded bytes>, n:<sermons held>,
//                          i:<peak peers that came to us>, o:<peak peers we dialled> }] }
//
// `i` and `o` (0.0.331) are the two figures the old record could not produce.
// They are stored as the DAY'S PEAK rather than the latest reading, because the
// seeding rotation pauses torrents outside its live window — so the
// instantaneous count legitimately falls back to 0 many times a day, and
// recording the latest value would mean a day when twenty people took sermons
// from you could easily end up written down as a zero.
// `base` is the lifetime-uploaded figure at the START of the retained window, so
// the oldest kept day still has something honest to subtract from.
const EMPTY_HISTORY = { base: 0, days: [] };

function readHistory() {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return null;
    const rec = JSON.parse(raw);
    if (!rec || !Array.isArray(rec.days)) return null;
    const days = rec.days
      .filter(d => d && typeof d.d === 'string')
      .map(d => ({
        d: d.d,
        v: Number(d.v) || 0,
        n: Number(d.n) || 0,
        i: Number(d.i) || 0,
        o: Number(d.o) || 0,
      }))
      .slice(-HISTORY_MAX_DAYS);
    return { base: Number(rec.base) || 0, days };
  } catch { return null; }
}

function writeHistory(rec) {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(rec));
  } catch (e) {
    // Same spirit as catalog.js's _warnStorageWrite: say so, carry on.
    console.warn('[Stats] Could not save your daily record:', e?.message || e);
  }
}

/**
 * Fold today's readings into the record and hand back the updated copy.
 * Called with the live figures, so today's row simply tracks the latest values
 * seen today. Returns the PREVIOUS object unchanged (and writes nothing) when
 * nothing has actually moved, so this can be called as often as we like.
 */
function recordToday(uploadedLifetime, sermonsHeld, peersIn = 0, peersOut = 0) {
  const today = dayKey();
  const prev = readHistory();
  const up = Number(uploadedLifetime) || 0;
  const held = Number(sermonsHeld) || 0;
  const pin = Math.max(0, Number(peersIn) || 0);
  const pout = Math.max(0, Number(peersOut) || 0);

  // First run ever: today's uploaded total becomes the baseline, so the first
  // bar counts only what is shared from now on rather than crediting today with
  // everything uploaded since the app was installed.
  if (!prev) {
    const fresh = { base: up, days: [{ d: today, v: up, n: held, i: pin, o: pout }] };
    writeHistory(fresh);
    return fresh;
  }

  const days = prev.days.map(d => ({ ...d }));
  const last = days[days.length - 1];
  if (last && last.d === today) {
    // Peaks only ever rise (see the note on the shape above).
    const nextI = Math.max(Number(last.i) || 0, pin);
    const nextO = Math.max(Number(last.o) || 0, pout);
    if (last.v === up && last.n === held && nextI === last.i && nextO === last.o) {
      return prev; // nothing changed
    }
    last.v = up;
    last.n = held;
    last.i = nextI;
    last.o = nextO;
  } else {
    days.push({ d: today, v: up, n: held, i: pin, o: pout });
  }

  // Trim to the window, carrying `base` forward as days fall off the front so
  // the oldest surviving day keeps a correct figure to subtract from.
  let base = prev.base;
  while (days.length > HISTORY_MAX_DAYS) base = days.shift().v;

  const next = { base, days };
  writeHistory(next);
  return next;
}

// Decimal GB (1000^3), matching how the app sizes the library elsewhere.
// Falls back to MB/KB for small contributions.
function formatContribution(bytes) {
  const b = Number(bytes) || 0;
  const gb = b / 1e9;
  if (gb >= 1) return `${gb.toFixed(gb >= 100 ? 0 : gb >= 10 ? 1 : 2)} GB`;
  const mb = b / 1e6;
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  if (b > 0) return `${Math.max(1, Math.round(b / 1e3))} KB`;
  return '0 GB';
}

// A screen on a stand — the Node display launcher.
const iconDisplay = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="2" y="4" width="20" height="13" rx="2" />
    <path d="M9 21h6M12 17v4" />
  </svg>
);

// Feather-style bar-chart glyph for the page heading + sidebar nav.
const iconStats = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <line x1="18" y1="20" x2="18" y2="10" /><line x1="12" y1="20" x2="12" y2="4" /><line x1="6" y1="20" x2="6" y2="14" />
  </svg>
);

// Feather-style share glyph for the invite button.
const iconShare = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: '6px', verticalAlign: '-2px' }}>
    <circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" />
    <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" /><line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
  </svg>
);

// Small glyphs for the share dropdown rows (feather-style, inherit currentColor).
const iconX = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <line x1="5" y1="5" x2="19" y2="19" /><line x1="19" y1="5" x2="5" y2="19" />
  </svg>
);
const iconFacebook = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M18 2h-3a5 5 0 0 0-5 5v3H7v4h3v8h4v-8h3l1-4h-4V7a1 1 0 0 1 1-1h3z" />
  </svg>
);
const iconEmail = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="2" y="4" width="20" height="16" rx="2" /><path d="m22 6-10 7L2 6" />
  </svg>
);
const iconCopy = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </svg>
);
const iconChevron = (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <polyline points="6 9 12 15 18 9" />
  </svg>
);

/**
 * ShareRow — one option in the invite/share dropdown.
 *
 * This used to carry its own `useState(hov)` plus four mouse/focus handlers to
 * paint its own highlight. That is a React re-render on every pointer crossing,
 * for an effect :hover gives away, and it only worked for the keyboard because
 * the component ALSO listened for focus — a second source of truth for one
 * visual state. `.menu-item` in the stylesheet does both, in one place.
 */
function ShareRow({ icon, label, onSelect }) {
  return (
    <button type="button" role="menuitem" className="menu-item" onClick={onSelect}>
      <span className="menu-item-icon">{icon}</span>
      {label}
    </button>
  );
}

/* The four chart components that used to live here — CoverageDonut,
   BreakdownBars, AreaSparkline and DailyBars — now live in
   `components/charts.jsx`, rebuilt. They shared one bug that mattered more than
   any styling: a fixed `viewBox` with `preserveAspectRatio="none"` and
   `width="100%"`, which does not scale a chart but STRETCHES it. Bar widths and
   line slopes were a function of the window size. See that file for the rest. */

/**
 * StatsPage — "Your Stats": a worshipful, encouraging view of THIS node's real
 * contribution to preserving God's word, with graphical (dependency-free, inline
 * SVG) charts plus the one-click invite.
 *
 * All figures come from what the app already tracks (same sources as heartbeat.js
 * and the Seed Node page):
 *   • Sermons seeding   — finished torrents (t.stats.finished) from listTorrents()
 *   • Data contributed  — localStorage si-uploaded-lifetime { lifetime }
 *   • Peers helped now   — Σ t.stats.live.snapshot.peer_stats.live
 *   • Library coverage   — getSeedProgress('full').pct (files on disk = source of truth).
 *                        Whole catalogue, audio and video, matching the Dashboard
 *                        ring and the library_coverage this node reports.
 *   • Audio/video mix    — downloaded counts from the catalog
 */
export default function StatsPage({ catalog, libraryStats, nodeStats, downloadStates }) {
  const [seeding, setSeeding] = useState(0);
  const [peers, setPeers] = useState(0);
  const [uploaded, setUploaded] = useState(() => readUploadedLifetime());
  const [coverage, setCoverage] = useState({ pct: 0, scope: 'audio', downloaded: 0, total: 0 });
  const [samples, setSamples] = useState([]);        // live "peers helped" sparkline
  const [copied, setCopied] = useState(false);
  const [shareOpen, setShareOpen] = useState(false); // invite/share dropdown (hover / click / focus)
  // The node display. This used to be a React overlay inside the app window —
  // close to the CLI's screen, which was exactly the problem: two files to keep
  // in step and a fullscreen fighting the app's own window. It is now the CLI's
  // actual page, served by the app over HTTP and opened in a browser, where
  // fullscreen is the browser's own and simply works. See
  // services/nodeDisplay.js and src-tauri/src/nodedisplay.rs.
  const [displayUrl, setDisplayUrl] = useState(null);
  const [displayErr, setDisplayErr] = useState('');
  const copiedTimer = useRef(null);
  const peersRef = useRef(0);                          // latest peers for the sampler
  // Direction (0.0.331). `peers` above is a bare total; these say who dialled
  // whom, which is the only thing that answers "am I serving, or just taking?"
  const [dir, setDir] = useState({ inb: 0, out: 0, peak: 0 });
  const seededRef = useRef(false);                     // seed the sparkline exactly once

  // Audio vs video you're hosting — downloaded counts straight from the catalog
  // (the same list the Seed Node page reads; `downloaded` reflects files on disk).
  const breakdown = useMemo(() => {
    const list = Array.isArray(catalog) ? catalog : [];
    let audio = 0, video = 0;
    for (const s of list) {
      if (!s?.downloaded) continue;
      if (s.type === 'video') video++; else audio++;
    }
    return { audio, video };
  }, [catalog]);

  // Storage used — prefer the live node stats, fall back to the library stats.
  const storageUsed = nodeStats?.storageUsed || libraryStats?.downloadedSize || '0 B';

  // ── The daily record behind the two day-by-day charts ─────────────────────
  // Sermons complete on disk: libraryStats.downloadedFiles counts only the
  // files that passed the size check, with the catalog tally as a fallback.
  const sermonsHeld = Number(libraryStats?.downloadedFiles) || (breakdown.audio + breakdown.video);
  const [history, setHistory] = useState(() => readHistory() || EMPTY_HISTORY);

  // Fold the live figures into today's row. recordToday returns the previous
  // object untouched when nothing has moved, so this settles immediately.
  useEffect(() => {
    setHistory(recordToday(uploaded, sermonsHeld, dir.peak, dir.out));
  }, [uploaded, sermonsHeld, dir.peak, dir.out]);

  // Direction poll. The native side throttles the real peer-table scan to once
  // every 30 s, so asking every 20 s costs nothing and keeps the reading fresh.
  // A missing answer (session down, older native build) is left as the previous
  // value rather than written down as zero — absence is not evidence.
  useEffect(() => {
    let alive = true;
    const read = async () => {
      const obs = await getIpv6Observation();
      if (!alive || !obs) return;
      setDir({
        inb: Number(obs.inbound_peers) || 0,
        out: Number(obs.outbound_peers) || 0,
        peak: Number(obs.inbound_peers_peak) || 0,
      });
    };
    read();
    const id = setInterval(read, 20000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  // The seven most recent recorded days, oldest first.
  const weekDirection = useMemo(
    () => history.days.slice(-7).map(d => ({
      d: d.d,
      label: dayLabel(d.d),
      inb: Number(d.i) || 0,
      out: Number(d.o) || 0,
    })),
    [history]
  );

  // Match the chart's stepped palette to the theme actually in force.
  const themeMode = (() => {
    try {
      const attr = document.documentElement.getAttribute('data-theme');
      if (attr === 'dark' || attr === 'light') return attr;
      return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    } catch { return 'light'; }
  })();

  // Shared per day = the rise in the lifetime uploaded total since the previous
  // recorded day. Clamped at zero so a cleared browser store or a reinstalled
  // app can never draw a negative day.
  const dailyShared = useMemo(() => {
    let prev = Number(history.base) || 0;
    return history.days.map((d) => {
      const v = Math.max(0, (Number(d.v) || 0) - prev);
      prev = Number(d.v) || 0;
      return { d: d.d, v };
    });
  }, [history]);

  // Sermons held per day — the figure as it stood on each recorded day.
  const dailyHeld = useMemo(
    () => history.days.map(d => ({ d: d.d, v: Number(d.n) || 0 })),
    [history]
  );

  const daysRecorded = history.days.length;
  const firstDayLabel = daysRecorded ? dayLabel(history.days[0].d) : '';
  const sharedInWindow = dailyShared.reduce((a, x) => a + x.v, 0);
  const bestDay = dailyShared.reduce((a, x) => (x.v > a ? x.v : a), 0);
  const heldGained = daysRecorded > 1
    ? Math.max(0, dailyHeld[dailyHeld.length - 1].v - dailyHeld[0].v)
    : 0;

  const refresh = useCallback(async () => {
    setUploaded(readUploadedLifetime());
    // Library coverage from the files actually complete on disk (source of truth).
    try {
      // Whole catalogue, matching the Dashboard ring and the reported
      // library_coverage. The sub-heading below reads the scope back out of
      // this state, so it now says "the full library" rather than "the audio
      // library" — which is what is actually being measured.
      const sp = getSeedProgress('full');
      setCoverage({ pct: sp.pct, scope: 'full', downloaded: sp.downloaded, total: sp.total });
    } catch { /* keep last-known coverage */ }
    // Live seeding + peer figures from the running torrent session.
    try {
      const mod = await ensureTorrent();
      if (!mod) { if (!seededRef.current) { seededRef.current = true; setSamples(Array(SEED_POINTS).fill(0)); } return; }
      const st = await mod.getStatus().catch(() => null);
      if (!st?.running) {
        setSeeding(0); setPeers(0); peersRef.current = 0;
        if (!seededRef.current) { seededRef.current = true; setSamples(Array(SEED_POINTS).fill(0)); }
        return;
      }
      const list = await mod.listTorrents().catch(() => []);
      const seedingCount = list.filter(t => t.stats?.finished).length;
      const peerCount = list.reduce((n, t) => n + (t.stats?.live?.snapshot?.peer_stats?.live || 0), 0);
      setSeeding(seedingCount);
      setPeers(peerCount);
      peersRef.current = peerCount;
      // Seed the sparkline with the first real reading so it's never empty.
      if (!seededRef.current) { seededRef.current = true; setSamples(Array(SEED_POINTS).fill(peerCount)); }
    } catch { /* leave last-known values */ }
  }, []);

  // Headline figures: refresh now + every ~12s.
  useEffect(() => {
    refresh();
    const id = setInterval(refresh, REFRESH_MS);
    return () => clearInterval(id);
  }, [refresh]);

  // Live sparkline: sample "peers helped" every ~10s from the latest reading.
  useEffect(() => {
    const id = setInterval(() => {
      setSamples(prev => {
        const base = prev.length ? prev : Array(SEED_POINTS).fill(peersRef.current);
        return [...base, peersRef.current].slice(-MAX_POINTS);
      });
    }, SAMPLE_MS);
    return () => clearInterval(id);
  }, []);

  // Clean up the "Copied!" timer on unmount.
  useEffect(() => () => { if (copiedTimer.current) clearTimeout(copiedTimer.current); }, []);

  const handleInvite = useCallback(async () => {
    let ok = false;
    // Preferred path — the async Clipboard API.
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(INVITE_MESSAGE);
        ok = true;
      }
    } catch { /* fall through to the legacy path */ }
    // Fallback — hidden textarea + execCommand, for older webviews or when the
    // clipboard permission is unavailable.
    if (!ok) {
      try {
        const ta = document.createElement('textarea');
        ta.value = INVITE_MESSAGE;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.top = '-1000px';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        ok = document.execCommand('copy');
        document.body.removeChild(ta);
      } catch { /* give up quietly */ }
    }
    if (ok) {
      setCopied(true);
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopied(false), 2200);
    }
  }, []);

  const dataLabel = formatContribution(uploaded);
  const peakPeers = samples.length ? Math.max(...samples) : peers;

  // The display reads its own sources (see services/nodeDisplay.js) rather than
  // being fed from here. It used to take a callback built from this page's
  // props, which meant it could only ever know what this one page happened to
  // hold — and this page holds no `running`, no listen port, no uptime and no
  // storage path. A kiosk screen also has to keep moving after its owner has
  // navigated away, which a page-owned callback cannot do.

  const launchDisplay = useCallback(async () => {
    setDisplayErr('');
    try {
      const url = await openNodeDisplay();
      setDisplayUrl(url);
    } catch (e) {
      console.warn('[Stats] node display failed:', e);
      setDisplayErr(String(e?.message || e));
    }
  }, []);

  // If the server is already up from an earlier visit, say so rather than
  // making the user press the button to find out.
  useEffect(() => {
    let alive = true;
    // Start it if nothing has yet, so the address is live without the user
    // having to ask for it first.
    ensureNodeDisplay()
      .then(u => { if (alive && u) setDisplayUrl(u); })
      .catch(() => nodeDisplayUrl().then(u => { if (alive && u) setDisplayUrl(u); }).catch(() => {}));
    return () => { alive = false; };
  }, []);

  const tiles = [
    { value: seeding.toLocaleString(), label: "Sermons you're seeding", color: 'var(--gold-text)' },
    { value: dataLabel, label: "Data you've contributed", color: 'var(--green)' },
    { value: peers.toLocaleString(), label: "Peers you're helping now", color: 'var(--seed-blue)' },
    { value: `${formatPct(coverage.pct)}%`, label: 'Library coverage', color: 'var(--gold-text)' },
    { value: storageUsed, label: 'Storage used', color: 'var(--text-primary)' },
  ];

  return (
    <div className="settings-page-root">
      {/* Heading AND the hero card span the full width above the two columns:
          the five headline tiles are the most-looked-at thing on the page and
          they lay out far better across the whole width than squeezed into one
          column. Everything below is split into two. */}
      <div className="page-header-wide">
      <PageHead
        kicker="Your node"
        icon={iconStats}
        title="Your Stats"
        sub="What you have contributed to preserving God's Word for the world."
      />

      {/* ── Node display ───────────────────────────────────────────────────
          This used to be a button in the masthead that did nothing visible
          until you pressed it, which buried the most useful thing on the page.
          The server now starts with the page, so the card can simply state the
          address: on a machine left running in a cupboard, the point is that
          somebody can open it from a phone WITHOUT first walking over to the
          app and pressing a button. */}
      <div className="page-header-wide" style={{ marginBottom: 'var(--space-4)' }}>
        <div className="verdict plain quiet" style={{ marginBottom: 0 }}>
          <span className="verdict-mark" aria-hidden="true">{iconDisplay}</span>
          <div className="verdict-copy">
            <div className="verdict-title">
              {displayErr ? 'The node display could not start' : 'Node display'}
            </div>
            <p>
              {displayErr || (
                <>
                  The same screen the command-line node serves — coverage, peers, the map
                  and what this node is giving back. It is a real server on this machine,
                  so the address below also works from a phone or tablet on this network,
                  and full screen there is the browser&rsquo;s own (<strong>F11</strong>, or{' '}
                  <strong>⌃⌘F</strong> on a Mac).
                </>
              )}
            </p>
            {displayUrl && !displayErr && (
              <div className="credential" style={{ maxWidth: '460px' }}>
                <span className="credential-value" style={{ fontSize: 'var(--text-base)' }}>{displayUrl}</span>
                <button
                  className="btn btn-outline"
                  onClick={() => { try { navigator.clipboard.writeText(displayUrl); } catch {} }}
                >
                  Copy
                </button>
                <button
                  className="btn btn-gold"
                  onClick={launchDisplay}
                  title="Open the node display in your browser"
                >
                  Open
                </button>
              </div>
            )}
            {!displayUrl && !displayErr && (
              <button className="btn btn-gold" onClick={launchDisplay}>Open the display</button>
            )}
          </div>
        </div>
      </div>

      {/* Hero — encouraging framing, the live stat tiles, and the one-click invite */}
      <div
        className="seed-card"
        style={{
          background: 'linear-gradient(135deg, rgba(212,175,55,0.12), rgba(212,175,55,0.03))',
          border: '1px solid var(--gold-dim)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' }}>
          <h3 style={{ margin: 0, color: 'var(--gold-text)' }}>Your Contribution</h3>
          <span
            style={{ position: 'relative', display: 'inline-block' }}
            onMouseEnter={() => setShareOpen(true)}
            onMouseLeave={() => setShareOpen(false)}
            onFocus={() => setShareOpen(true)}
            onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setShareOpen(false); }}
          >
            <button
              className="btn btn-gold"
              onClick={() => setShareOpen((o) => !o)}
              aria-haspopup="menu"
              aria-expanded={shareOpen}
              style={{ whiteSpace: 'nowrap', display: 'inline-flex', alignItems: 'center' }}
            >
              {iconShare}Invite / Share
              <span style={{ display: 'inline-flex', marginLeft: '6px', transform: shareOpen ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s ease' }}>{iconChevron}</span>
            </button>

            {shareOpen && (
              <div role="menu" className="menu" style={{ top: 'calc(100% + 6px)', right: 0 }}>
                <ShareRow icon={iconX} label="X (Twitter)" onSelect={() => { openExternal(SHARE_X); setShareOpen(false); }} />
                <ShareRow icon={iconFacebook} label="Facebook" onSelect={() => { openExternal(SHARE_FB); setShareOpen(false); }} />
                <ShareRow icon={iconEmail} label="Email" onSelect={() => { openExternal(SHARE_EMAIL); setShareOpen(false); }} />
                <div className="menu-sep" role="separator" />
                <ShareRow icon={iconCopy} label="Copy link" onSelect={() => { handleInvite(); setShareOpen(false); }} />
              </div>
            )}

            {copied && (
              <span style={{
                position: 'absolute', top: '112%', right: 0,
                background: 'var(--olive)', color: '#fff', fontSize: 'var(--text-xs)', fontWeight: 600,
                padding: '4px 10px', borderRadius: '4px', whiteSpace: 'nowrap',
                pointerEvents: 'none', zIndex: 40, boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
              }}>
                Copied invite!
              </span>
            )}
          </span>
        </div>

        <p style={{ marginTop: '6px', marginBottom: '16px' }}>
          Every sermon you hold and every byte you share keeps the library alive across the body of
          Christ — impossible to erase. This is your part in preserving God's Word for generations to come.
        </p>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '12px' }}>
          {tiles.map((t) => (
            <div key={t.label} style={{
              background: 'var(--bg-tertiary)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius)',
              padding: '14px 16px',
            }}>
              <div style={{ fontSize: 'var(--text-xl)', fontWeight: 700, color: t.color, lineHeight: 1.1 }}>{t.value}</div>
              <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginTop: '4px' }}>{t.label}</div>
            </div>
          ))}
        </div>
      </div>
      </div>

      {/* Two columns — the shared Settings/Connections layout.
          LEFT  — what you are holding right now (coverage + hosting mix) and
                  what you have given day by day. These two are the substance
                  of "your contribution", so they lead.
          RIGHT — the live peers picture, the library growth curve, and the
                  closing encouragement. Split by visual weight, not by card
                  count: the tall donut card balances the two shorter charts. */}
      <div className="connections-layout">
      <div className="connections-left">

      {/* Coverage donut + audio/video breakdown */}
      <Panel
        mark={iconStats}
        title="Library Coverage & Your Hosting Mix"
        sub={`How much of the ${coverage.scope === 'full' ? 'full' : 'audio'} library you hold`}
      >
        <p style={{ marginBottom: '18px' }}>
          How much of the {coverage.scope === 'full' ? 'full' : 'audio'} library you're holding right now, and
          the split between audio and video sermons you're sharing with the network.
        </p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '32px', alignItems: 'flex-start' }}>
          <CoverageMeter
            pct={coverage.pct}
            downloaded={coverage.downloaded}
            total={coverage.total}
          />
          <MixBars audio={breakdown.audio} video={breakdown.video} />
        </div>
      </Panel>

      {/* What you've shared each day — real figures from the SAME lifetime
          uploaded total heartbeat.js reports (si-uploaded-lifetime). Each bar
          is the rise in that total since the previous recorded day, so nothing
          here is estimated. The app kept no history before now, so the record
          honestly begins the first day this page is opened. */}
      <Panel
        mark={iconStats}
        title="What You've Shared Each Day"
        sub="Real figures — no estimates, no back-fill"
        aside={
          <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
            Total <strong style={{ color: 'var(--gold-text)' }}>{formatContribution(sharedInWindow)}</strong>
            {bestDay > 0 && <> · Best <strong style={{ color: 'var(--text-secondary)' }}>{formatContribution(bestDay)}</strong></>}
          </span>
        }
      >
        <p style={{ marginTop: 0, marginBottom: '14px' }}>
          Every bar is what your computer passed on to other believers that day. Each one covers the
          time since the last day you had the app open, so nothing you gave is missed.
        </p>
        <DailyColumns data={dailyShared} format={formatContribution} dayLabel={dayLabel} />
        <ChartTable
          id="tbl-shared"
          head={['Day', 'Shared']}
          rows={[...dailyShared].reverse().map(x => [dayLabel(x.d), formatContribution(x.v)])}
        />
        <p style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', margin: '10px 0 0' }}>
          {daysRecorded > 1
            ? `Keeping a record since ${firstDayLabel} — the last ${daysRecorded} days you had the app open.`
            : 'This started keeping a record today, so it will fill out over the coming days.'}
        </p>
      </Panel>

      </div>

      {/* ── RIGHT ── */}
      <div className="connections-right">

      {/* ── Giving vs taking, day by day ──────────────────────────────────
          The card this app was missing. Everything else counts peers without
          direction, and a total cannot tell "people are taking sermons from me"
          apart from "I am taking from them" — which is the one thing a person
          running a node wants to know. */}
      <div className="seed-card">
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px' }}>
          <h3 style={{ marginBottom: 0 }}>Giving vs Taking</h3>
          <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>
            Served all-time: <strong style={{ color: 'var(--text-primary)' }}>{dir.peak.toLocaleString()}</strong>
          </span>
        </div>
        <p style={{ marginTop: '6px', marginBottom: '14px' }}>
          A connection someone opened <em>to you</em> means they found your node and took a sermon from
          it — that is you serving the network. A connection you opened to them only shows your own
          line works. Over a week, the balance between the two is the honest picture.
        </p>
        <ConnectivityChart days={weekDirection} mode={themeMode} />
      </div>

      {/* Live peers connected right now */}
      <div className="seed-card">
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px' }}>
          {/* Renamed in 0.0.331. This was "Peers You're Helping (live)", which
              read as a lifetime total of people served — but the figure behind
              it is `peer_stats.live` summed across torrents, i.e. peers
              connected AT THIS INSTANT. Under seeding rotation that is 0 most
              of the time, so long-running nodes were being told they had helped
              nobody. The number was fine; the heading was a lie about it. The
              lifetime figure now lives in the card above. */}
          <h3 style={{ marginBottom: 0 }}>Peers Connected Right Now</h3>
          <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>
            Now: <strong style={{ color: 'var(--gold-text)' }}>{peers.toLocaleString()}</strong>
            {peakPeers > 0 && <> · Peak: <strong style={{ color: 'var(--text-secondary)' }}>{peakPeers.toLocaleString()}</strong></>}
          </span>
        </div>
        <p style={{ marginTop: '6px', marginBottom: '14px' }}>
          Sampled every {Math.round(SAMPLE_MS / 1000)} seconds while the app is open. This rises and falls
          all day as your node rotates through the library — a zero here means nobody is mid-download
          this second, not that you have helped nobody.
        </p>
        <TrendArea data={samples} label="peers connected" format={(v) => Math.round(v).toLocaleString()} />
      </div>

      {/* Sermons safe on your computer, day by day — the count of files that
          are complete on disk (libraryStats.downloadedFiles, the same figure
          the rest of the app uses), recorded once a day. Real readings only:
          no back-fill, no estimate for days the app wasn't open. */}
      <div className="seed-card">
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px' }}>
          <h3 style={{ marginBottom: 0 }}>Sermons Safe on Your Computer</h3>
          <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>
            Now: <strong style={{ color: 'var(--gold-text)' }}>{sermonsHeld.toLocaleString()}</strong>
            {heldGained > 0 && <> · Added since {firstDayLabel}: <strong style={{ color: 'var(--text-secondary)' }}>+{heldGained.toLocaleString()}</strong></>}
          </span>
        </div>
        <p style={{ marginTop: '6px', marginBottom: '14px' }}>
          How the number of sermons kept safe on your computer has grown. Every one of them is a
          message that survives even if it disappears everywhere else.
        </p>
        {daysRecorded > 1 ? (
          <>
            <TrendArea
              data={dailyHeld.map(x => x.v)}
              label="sermons held"
              format={(v) => Math.round(v).toLocaleString()}
            />
            <ChartTable
              id="tbl-held"
              head={['Day', 'Sermons held']}
              rows={[...dailyHeld].reverse().map(x => [dayLabel(x.d), Math.round(x.v).toLocaleString()])}
            />
            <p style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', margin: '10px 0 0' }}>
              From {firstDayLabel} to today.
            </p>
          </>
        ) : (
          <p style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', margin: 0 }}>
            Today is the first day of this record, so there is nothing to compare against yet. Come
            back tomorrow and the line will begin.
          </p>
        )}
      </div>

      {/* Closing encouragement */}
      <div className="seed-card">
        <p style={{ marginBottom: '8px' }}>
          Thank you for standing in the gap. Whether you host one sermon or the whole library, you are
          part of a worldwide body keeping these messages within reach of everyone who will hear them.
        </p>
        <p style={{ color: 'var(--gold-text)', fontStyle: 'italic', marginBottom: 0 }}>
          "The grass withereth, the flower fadeth: but the word of our God shall stand for ever." — Isaiah 40:8
        </p>
      </div>

      </div>
      </div>
    </div>
  );
}
