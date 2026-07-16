import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { getSeedProgress } from '../services/catalog.js';

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
 * ShareRow — one option in the invite/share dropdown. Manages its own hover /
 * focus highlight (inline styles, no CSS class) and renders as a real <button>
 * so it's keyboard-focusable for accessibility.
 */
function ShareRow({ icon, label, onSelect }) {
  const [hov, setHov] = useState(false);
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onSelect}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      onFocus={() => setHov(true)}
      onBlur={() => setHov(false)}
      style={{
        display: 'flex', alignItems: 'center', gap: '9px', width: '100%',
        textAlign: 'left', background: hov ? 'var(--bg-tertiary)' : 'transparent',
        border: 'none', borderRadius: '6px', padding: '8px 11px', cursor: 'pointer',
        color: hov ? 'var(--gold-text)' : 'var(--text-secondary)',
        fontSize: '0.82rem', fontWeight: 600, fontFamily: 'inherit',
        transition: 'background 0.12s ease, color 0.12s ease',
      }}
    >
      <span style={{ display: 'inline-flex', width: 16, justifyContent: 'center' }}>{icon}</span>
      {label}
    </button>
  );
}

/**
 * CoverageDonut — an olive→gold ring showing the % of the library this node
 * hosts, with the exact figure in the center. Pure inline SVG (no chart dep).
 */
function CoverageDonut({ pct }) {
  const size = 168, thickness = 16;
  const r = (size - thickness) / 2;
  const C = 2 * Math.PI * r;
  // Ensure a tiny non-zero % still shows a visible sliver; center text stays exact.
  const shown = pct > 0 ? Math.min(100, Math.max(pct, 2)) : 0;
  const len = (shown / 100) * C;
  return (
    <div style={{ position: 'relative', width: size, height: size, flexShrink: 0 }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <defs>
          <linearGradient id="stats-cov-grad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="var(--olive)" />
            <stop offset="100%" stopColor="var(--gold-text)" />
          </linearGradient>
        </defs>
        <g transform={`rotate(-90 ${size / 2} ${size / 2})`}>
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--olive-dim)" strokeWidth={thickness} />
          {pct > 0 && (
            <circle
              cx={size / 2} cy={size / 2} r={r} fill="none"
              stroke="url(#stats-cov-grad)" strokeWidth={thickness} strokeLinecap="round"
              strokeDasharray={`${len} ${C - len}`}
            />
          )}
        </g>
      </svg>
      <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ fontSize: '1.9rem', fontWeight: 700, color: 'var(--gold-text)', lineHeight: 1 }}>
          {pct.toFixed(pct >= 10 ? 0 : 1)}%
        </div>
        <div style={{ fontSize: '0.6rem', color: 'var(--text-muted)', marginTop: 5, textTransform: 'uppercase', letterSpacing: '0.6px' }}>
          of library
        </div>
      </div>
    </div>
  );
}

/**
 * BreakdownBars — horizontal bars for the audio vs video you're hosting.
 * Gold = audio, olive = video, scaled to whichever is larger.
 */
function BreakdownBars({ audio, video }) {
  const max = Math.max(1, audio, video);
  const rows = [
    { label: 'Audio sermons', value: audio, color: 'var(--gold-text)' },
    { label: 'Video sermons', value: video, color: 'var(--olive)' },
  ];
  return (
    <div style={{ flex: 1, minWidth: 200, display: 'flex', flexDirection: 'column', gap: 16, justifyContent: 'center' }}>
      {rows.map((r) => (
        <div key={r.label}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', fontSize: '0.8rem', marginBottom: 6 }}>
            <span style={{ color: 'var(--text-secondary)' }}>{r.label}</span>
            <span style={{ color: r.color, fontWeight: 700 }}>{r.value.toLocaleString()}</span>
          </div>
          <div style={{ height: 11, borderRadius: 6, background: 'var(--bg-tertiary)', border: '1px solid var(--border)', overflow: 'hidden' }}>
            <div style={{ width: `${(r.value / max) * 100}%`, height: '100%', background: r.color, borderRadius: 6, transition: 'width 0.5s ease' }} />
          </div>
        </div>
      ))}
      {audio + video === 0 && (
        <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)', margin: 0 }}>
          Download a few sermons and your hosting mix will appear here.
        </p>
      )}
    </div>
  );
}

/**
 * AreaSparkline — a filled area chart of the live "peers helped" samples.
 * Mirrors the hub dashboard's AreaChart: fixed viewBox, responsive width,
 * gold line over a soft gold gradient. Pure inline SVG.
 */
function AreaSparkline({ data, height = 120 }) {
  const w = 340, h = height, pad = 6;
  const arr = data && data.length ? data : [0];
  const max = Math.max(1, ...arr);
  const n = arr.length;
  const pts = arr.map((v, i) => {
    const x = n <= 1 ? w - pad : pad + (i / (n - 1)) * (w - 2 * pad);
    const y = h - pad - ((Number(v) || 0) / max) * (h - 2 * pad);
    return [x, y];
  });
  const line = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
  const area = `${line} L ${w - pad} ${h - pad} L ${pad} ${h - pad} Z`;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} preserveAspectRatio="none">
      <defs>
        <linearGradient id="stats-spark-grad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--gold-text)" stopOpacity="0.38" />
          <stop offset="100%" stopColor="var(--gold-text)" stopOpacity="0.02" />
        </linearGradient>
      </defs>
      <path d={area} fill="url(#stats-spark-grad)" />
      <path d={line} fill="none" stroke="var(--gold-text)" strokeWidth="2" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

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
 *   • Library coverage   — getSeedProgress(scope).pct (files on disk = source of truth)
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
  const copiedTimer = useRef(null);
  const peersRef = useRef(0);                          // latest peers for the sampler
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

  const refresh = useCallback(async () => {
    setUploaded(readUploadedLifetime());
    // Library coverage from the files actually complete on disk (source of truth).
    try {
      const scope = (() => { try { return localStorage.getItem('si-seed-scope') || 'audio'; } catch { return 'audio'; } })();
      const sp = getSeedProgress(scope);
      setCoverage({ pct: sp.pct, scope, downloaded: sp.downloaded, total: sp.total });
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

  const tiles = [
    { value: seeding.toLocaleString(), label: "Sermons you're seeding", color: 'var(--gold-text)' },
    { value: dataLabel, label: "Data you've contributed", color: 'var(--green)' },
    { value: peers.toLocaleString(), label: "Peers you're helping now", color: 'var(--seed-blue)' },
    { value: `${coverage.pct.toFixed(coverage.pct >= 10 ? 0 : 1)}%`, label: 'Library coverage', color: 'var(--gold-text)' },
    { value: storageUsed, label: 'Storage used', color: 'var(--text-primary)' },
  ];

  return (
    <div className="seed-section">
      <div className="page-header">
        <h2 style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <span style={{ display: 'inline-flex', color: 'var(--gold-text)' }}>{iconStats}</span> Your Stats
        </h2>
        <p>Your contribution to preserving God's word for the world</p>
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
              <div role="menu" style={{ position: 'absolute', top: '100%', right: 0, paddingTop: '6px', zIndex: 30 }}>
                <div style={{
                  background: 'var(--bg-secondary)',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius)',
                  boxShadow: '0 10px 28px rgba(0,0,0,0.18)',
                  padding: '5px',
                  minWidth: '190px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '1px',
                }}>
                  <ShareRow icon={iconX} label="X (Twitter)" onSelect={() => { openExternal(SHARE_X); setShareOpen(false); }} />
                  <ShareRow icon={iconFacebook} label="Facebook" onSelect={() => { openExternal(SHARE_FB); setShareOpen(false); }} />
                  <ShareRow icon={iconEmail} label="Email" onSelect={() => { openExternal(SHARE_EMAIL); setShareOpen(false); }} />
                  <div style={{ height: '1px', background: 'var(--border)', margin: '4px 6px' }} />
                  <ShareRow icon={iconCopy} label="Copy link" onSelect={() => { handleInvite(); setShareOpen(false); }} />
                </div>
              </div>
            )}

            {copied && (
              <span style={{
                position: 'absolute', top: '112%', right: 0,
                background: 'var(--olive)', color: '#fff', fontSize: '0.68rem', fontWeight: 600,
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
          Christ — impossible to erase. This is your part in preserving God's word for generations to come.
        </p>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '12px' }}>
          {tiles.map((t) => (
            <div key={t.label} style={{
              background: 'var(--bg-tertiary)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius)',
              padding: '14px 16px',
            }}>
              <div style={{ fontSize: '1.5rem', fontWeight: 700, color: t.color, lineHeight: 1.1 }}>{t.value}</div>
              <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: '4px' }}>{t.label}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Coverage donut + audio/video breakdown */}
      <div className="seed-card">
        <h3>Library Coverage & Your Hosting Mix</h3>
        <p style={{ marginBottom: '18px' }}>
          How much of the {coverage.scope === 'full' ? 'full' : 'audio'} library you're holding right now, and
          the split between audio and video sermons you're sharing with the network.
        </p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '28px', alignItems: 'center' }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px' }}>
            <CoverageDonut pct={coverage.pct} />
            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
              {coverage.downloaded.toLocaleString()} of {coverage.total.toLocaleString()} sermons
            </div>
          </div>
          <BreakdownBars audio={breakdown.audio} video={breakdown.video} />
        </div>
      </div>

      {/* Live "peers helped" sparkline */}
      <div className="seed-card">
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px' }}>
          <h3 style={{ marginBottom: 0 }}>Peers You're Helping (live)</h3>
          <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
            Now: <strong style={{ color: 'var(--gold-text)' }}>{peers.toLocaleString()}</strong>
            {peakPeers > 0 && <> · Peak: <strong style={{ color: 'var(--text-secondary)' }}>{peakPeers.toLocaleString()}</strong></>}
          </span>
        </div>
        <p style={{ marginTop: '6px', marginBottom: '14px' }}>
          Sampled every {Math.round(SAMPLE_MS / 1000)} seconds while the app is open — a live picture of the
          peers pulling sermons from your node right now.
        </p>
        <div style={{
          background: 'var(--bg-tertiary)', border: '1px solid var(--border)',
          borderRadius: 'var(--radius)', padding: '10px 8px 4px',
        }}>
          <AreaSparkline data={samples} />
        </div>
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
  );
}
