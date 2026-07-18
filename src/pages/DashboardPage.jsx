import React, { useState, useEffect, useMemo } from 'react';
import SpeakerAvatar from '../components/SpeakerAvatar.jsx';
import { getNodeId, fetchNodeMap } from '../services/heartbeat.js';
import { getSeedProgress } from '../services/catalog.js';

const TOTAL_SERMONS = 33528;
const AUDIO_FALLBACK = 25587;
const VIDEO_FALLBACK = 7941;

// Lifetime uploaded bytes — same source Your Stats reads, so the figure matches.
function readUploadedLifetime() {
  try { const raw = localStorage.getItem('si-uploaded-lifetime'); if (!raw) return 0; return Number(JSON.parse(raw).lifetime) || 0; } catch { return 0; }
}
function formatContribution(bytes) {
  const b = Number(bytes) || 0;
  const gb = b / 1e9;
  if (gb >= 1) return `${gb.toFixed(gb >= 100 ? 0 : gb >= 10 ? 1 : 2)} GB`;
  const mb = b / 1e6;
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  if (b > 0) return `${Math.max(1, Math.round(b / 1e3))} KB`;
  return '0 GB';
}

// ── icons ────────────────────────────────────────────────────────────────────
const I = {
  play: <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>,
  download: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></svg>,
  arrow: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><line x1="5" y1="12" x2="19" y2="12" /><polyline points="12 5 19 12 12 19" /></svg>,
  globe: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><line x1="2" y1="12" x2="22" y2="12" /><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" /></svg>,
  seed: <svg width="20" height="20" viewBox="0 0 256 256" fill="currentColor"><path d="M208,32H48A16,16,0,0,0,32,48V208a16,16,0,0,0,16,16H208a16,16,0,0,0,16-16V48A16,16,0,0,0,208,32ZM88,160a8,8,0,1,1-8,8A8,8,0,0,1,88,160ZM48,48H80v97.38a24,24,0,1,0,16,0V115.31l48,48V208H48ZM208,208H160V160a8,8,0,0,0-2.34-5.66L96,92.69V48h32V72a8,8,0,0,0,2.34,5.66l16,16A23.74,23.74,0,0,0,144,104a24,24,0,1,0,24-24,23.74,23.74,0,0,0-10.34,2.35L144,68.69V48h64V208ZM168,96a8,8,0,1,1-8,8A8,8,0,0,1,168,96Z" /></svg>,
  stats: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="20" x2="18" y2="10" /><line x1="12" y1="20" x2="12" y2="4" /><line x1="6" y1="20" x2="6" y2="14" /></svg>,
  chat: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>,
};

// ── coverage donut (olive→gold ring) ─────────────────────────────────────────
function CoverageDonut({ pct }) {
  const size = 150, thickness = 15;
  const r = (size - thickness) / 2;
  const C = 2 * Math.PI * r;
  const shown = pct > 0 ? Math.min(100, Math.max(pct, 2)) : 0;
  const len = (shown / 100) * C;
  return (
    <div style={{ position: 'relative', width: size, height: size, flexShrink: 0 }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <defs>
          <linearGradient id="dash-cov-grad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="var(--olive)" />
            <stop offset="100%" stopColor="var(--gold-text)" />
          </linearGradient>
        </defs>
        <g transform={`rotate(-90 ${size / 2} ${size / 2})`}>
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--olive-dim)" strokeWidth={thickness} />
          {pct > 0 && (
            <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="url(#dash-cov-grad)" strokeWidth={thickness} strokeLinecap="round" strokeDasharray={`${len} ${C - len}`} />
          )}
        </g>
      </svg>
      <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ fontSize: '1.7rem', fontWeight: 700, color: 'var(--gold-text)', lineHeight: 1 }}>{pct.toFixed(pct >= 10 ? 0 : 1)}%</div>
        <div style={{ fontSize: '0.58rem', color: 'var(--text-muted)', marginTop: 5, textTransform: 'uppercase', letterSpacing: '0.6px' }}>of library</div>
      </div>
    </div>
  );
}

// ── live-peers area sparkline ────────────────────────────────────────────────
function AreaSparkline({ data, height = 96 }) {
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
        <linearGradient id="dash-spark-grad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--gold-text)" stopOpacity="0.38" />
          <stop offset="100%" stopColor="var(--gold-text)" stopOpacity="0.02" />
        </linearGradient>
      </defs>
      <path d={area} fill="url(#dash-spark-grad)" />
      <path d={line} fill="none" stroke="var(--gold-text)" strokeWidth="2" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

// ── audio / video breakdown bars ─────────────────────────────────────────────
function BreakdownBars({ audio, video }) {
  const total = Math.max(1, audio + video);
  const rows = [
    { label: 'Audio', val: audio, color: 'var(--gold-text)' },
    { label: 'Video', val: video, color: 'var(--olive)' },
  ];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {rows.map((r) => (
        <div key={r.label}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.74rem', marginBottom: 4, color: 'var(--text-secondary)' }}>
            <span>{r.label}</span><span style={{ fontWeight: 700 }}>{r.val.toLocaleString()}</span>
          </div>
          <div style={{ height: 8, background: 'var(--bg-tertiary)', borderRadius: 5, overflow: 'hidden' }}>
            <div style={{ width: `${(r.val / total) * 100}%`, height: '100%', background: r.color, borderRadius: 5 }} />
          </div>
        </div>
      ))}
    </div>
  );
}

// ── compact sermon card ──────────────────────────────────────────────────────
function DashSermon({ s, onOpen }) {
  return (
    <button type="button" className="dash-sermon" onClick={() => onOpen && onOpen(s)} title={`Open “${s.title}” in Browse Sermons`}>
      <SpeakerAvatar speaker={s.speaker} image={s.speakerImage} />
      <div className="dash-sermon-info">
        <div className="dash-sermon-title" title={s.title}>{s.title}</div>
        <div className="dash-sermon-speaker">{s.speaker}</div>
        <div className="dash-sermon-tags">
          <span className={`dash-type ${s.type === 'video' ? 'video' : 'audio'}`}>{s.type === 'video' ? 'Video' : 'Audio'}</span>
          {s.durationFormatted && <span className="dash-dur">{s.durationFormatted}</span>}
        </div>
      </div>
      <span className="dash-sermon-go" aria-hidden="true">{I.arrow}</span>
    </button>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
export default function DashboardPage({ nodeStats, libraryStats, catalog, onNavigate, onOpenSermon }) {
  const cat = Array.isArray(catalog) ? catalog : [];
  const total = libraryStats?.totalFiles || TOTAL_SERMONS;
  const peers = Number(nodeStats?.peersConnected) || 0;
  const filesShared = Number(nodeStats?.filesShared || libraryStats?.downloadedFiles) || 0;
  const storageUsed = nodeStats?.storageUsed || '0 B';
  const nodeId = getNodeId ? (getNodeId() || '') : '';

  // Library coverage — same source + precision as the Your Stats page (1-decimal %).
  const [coverage, setCoverage] = useState({ pct: 0, downloaded: 0, total: 0 });
  useEffect(() => {
    const refresh = () => {
      try {
        const scope = (() => { try { return localStorage.getItem('si-seed-scope') || 'audio'; } catch { return 'audio'; } })();
        const sp = getSeedProgress(scope);
        setCoverage({ pct: sp.pct, downloaded: sp.downloaded, total: sp.total });
      } catch { /* keep last-known */ }
    };
    refresh();
    const id = setInterval(refresh, 12000);
    return () => clearInterval(id);
  }, []);
  const coveragePct = coverage.pct;
  const covLabel = coveragePct.toFixed(coveragePct >= 10 ? 0 : 1);

  // Audio vs video you're actually hosting (downloaded counts) — matches Your Stats.
  const breakdown = useMemo(() => {
    let audio = 0, video = 0;
    for (const s of cat) { if (!s?.downloaded) continue; if (s.type === 'video') video++; else audio++; }
    return { audio, video };
  }, [cat]);

  // Featured sermons — a fresh random handful each time the Dashboard is opened.
  const featured = useMemo(() => {
    if (cat.length <= 6) return cat.slice();
    const a = cat.slice();
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a.slice(0, 6);
  }, [cat.length]);

  // live peer sampling for the sparkline
  const [peersSample, setPeersSample] = useState([peers]);
  useEffect(() => {
    setPeersSample((prev) => [...prev, peers].slice(-26));
  }, [peers]);

  // network-wide reach (best-effort)
  const [net, setNet] = useState({ nodes: null, countries: null });
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const list = await fetchNodeMap();
        if (!alive || !Array.isArray(list)) return;
        const countries = new Set(list.map((n) => n && n.country).filter(Boolean));
        setNet({ nodes: list.length, countries: countries.size });
      } catch { /* offline — leave nulls */ }
    })();
    return () => { alive = false; };
  }, []);

  const tiles = [
    { value: total.toLocaleString(), label: 'Sermons in the library', color: 'var(--gold-text)' },
    { value: `${covLabel}%`, label: 'Your library coverage', color: 'var(--olive)' },
    { value: formatContribution(readUploadedLifetime()), label: "Data you've contributed", color: 'var(--seed-blue)' },
    { value: filesShared.toLocaleString(), label: "Files you're sharing", color: 'var(--green)' },
    { value: storageUsed, label: 'Storage used', color: 'var(--text-primary)' },
  ];

  const links = [
    { key: 'network', icon: I.globe, title: 'Node Map', desc: 'See the live global network light up' },
    { key: 'seed', icon: I.seed, title: 'Seed Node', desc: 'Hold a complete backup of the archive' },
    { key: 'stats', icon: I.stats, title: 'Your Stats', desc: 'Your impact, in detail' },
    { key: 'community', icon: I.chat, title: 'Community', desc: 'Encourage other node runners' },
  ];

  const go = (k) => onNavigate && onNavigate(k);

  return (
    <div className="dash">
      {/* ── welcome / status banner ── */}
      <div className="dash-hero">
        <div className="dash-hero-copy">
          <div className="dash-eyebrow"><span className="dash-dot" /> Your node is online</div>
          <h2>You&rsquo;re helping preserve God&rsquo;s Word.</h2>
          <p>Every sermon you keep and share makes this archive a little more permanent &mdash; carried by believers around the world, not by any single server.</p>
          <div className="dash-hero-meta">
            {nodeId && <span>Node <b>#{nodeId.slice(0, 9)}</b></span>}
            <span><b>{filesShared.toLocaleString()}</b> files shared</span>
          </div>
        </div>
        <div className="dash-hero-viz" aria-hidden="true">
          <svg viewBox="0 0 320 200" preserveAspectRatio="xMidYMid meet">
            <g stroke="#d4af37" strokeOpacity="0.35" strokeWidth="1.3" fill="none">
              <line x1="60" y1="60" x2="130" y2="110" /><line x1="60" y1="60" x2="150" y2="45" />
              <line x1="130" y1="110" x2="220" y2="80" /><line x1="150" y1="45" x2="240" y2="60" />
              <line x1="130" y1="110" x2="200" y2="150" /><line x1="220" y1="80" x2="240" y2="60" />
              <line x1="220" y1="80" x2="270" y2="120" /><line x1="200" y1="150" x2="130" y2="110" />
            </g>
            <circle cx="60" cy="60" r="8" fill="none" stroke="#d4af37" strokeWidth="2" opacity="0.5">
              <animate attributeName="r" values="8;24" dur="3.2s" repeatCount="indefinite" />
              <animate attributeName="opacity" values="0.5;0" dur="3.2s" repeatCount="indefinite" />
            </circle>
            <circle cx="220" cy="80" r="8" fill="none" stroke="#f3efe0" strokeWidth="2" opacity="0.4">
              <animate attributeName="r" values="8;22" dur="3.8s" begin="1.2s" repeatCount="indefinite" />
              <animate attributeName="opacity" values="0.45;0" dur="3.8s" begin="1.2s" repeatCount="indefinite" />
            </circle>
            <g>
              <circle cx="150" cy="45" r="4.5" fill="#f3efe0" opacity="0.85" />
              <circle cx="240" cy="60" r="4.5" fill="#f3efe0" opacity="0.8" />
              <circle cx="200" cy="150" r="5" fill="#f3efe0" opacity="0.85" />
              <circle cx="270" cy="120" r="4" fill="#f3efe0" opacity="0.7" />
              <circle cx="130" cy="110" r="7" fill="#d4af37" />
              <circle cx="60" cy="60" r="7" fill="#d4af37" />
              <circle cx="220" cy="80" r="7" fill="#d4af37" />
            </g>
          </svg>
        </div>
      </div>

      {/* ── stat tiles ── */}
      <div className="dash-tiles">
        {tiles.map((t) => (
          <div key={t.label} className="dash-tile">
            <div className="dash-tile-val" style={{ color: t.color }}>{t.value}</div>
            <div className="dash-tile-label">{t.label}</div>
          </div>
        ))}
      </div>

      {/* ── coverage + live network ── */}
      <div className="dash-cols">
        <div className="seed-card dash-panel">
          <div className="dash-panel-head">
            <h3>Library coverage</h3>
            <button className="dash-linkbtn" onClick={() => go('stats')}>Your Stats {I.arrow}</button>
          </div>
          <div style={{ display: 'flex', gap: 22, alignItems: 'center', flexWrap: 'wrap' }}>
            <CoverageDonut pct={coveragePct} />
            <div style={{ flex: 1, minWidth: 160 }}>
              <BreakdownBars audio={breakdown.audio} video={breakdown.video} />
              <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)', margin: '12px 0 14px', lineHeight: 1.5 }}>
                {coverage.downloaded.toLocaleString()} of {coverage.total.toLocaleString()} sermons
              </p>
              <button className="btn btn-gold" onClick={() => go('seed')} style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                Seed the full library {I.arrow}
              </button>
            </div>
          </div>
        </div>

        <div className="seed-card dash-panel">
          <div className="dash-panel-head">
            <h3>Live network</h3>
            <span className="dash-live"><span className="dash-dot" /> live</span>
          </div>
          <div className="dash-net-nums">
            <div>
              <div className="dash-net-big">{net.nodes != null ? net.nodes.toLocaleString() : '—'}</div>
              <div className="dash-net-cap">nodes online worldwide</div>
            </div>
            {net.countries != null && net.countries > 0 && (
              <div>
                <div className="dash-net-big">{net.countries}</div>
                <div className="dash-net-cap">countries</div>
              </div>
            )}
            <div>
              <div className="dash-net-big" style={{ color: 'var(--gold-text)' }}>{peers.toLocaleString()}</div>
              <div className="dash-net-cap">peers you're serving</div>
            </div>
          </div>
          <div style={{ margin: '4px 0 10px' }}>
            <AreaSparkline data={peersSample} />
          </div>
          <button className="btn btn-outline" onClick={() => go('network')} style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
            Explore the Node Map {I.arrow}
          </button>
        </div>
      </div>

      {/* ── featured sermons ── */}
      <div className="seed-card">
        <div className="dash-panel-head">
          <h3>From the library</h3>
          <button className="dash-linkbtn" onClick={() => go('library')}>Browse all {total.toLocaleString()} {I.arrow}</button>
        </div>
        {featured.length ? (
          <div className="dash-sermons">
            {featured.map((s) => <DashSermon key={s.id} s={s} onOpen={onOpenSermon} />)}
          </div>
        ) : (
          <p style={{ fontSize: '0.82rem', color: 'var(--text-muted)' }}>Your library is loading&hellip;</p>
        )}
      </div>

      {/* ── quick links to full sections ── */}
      <div className="dash-links">
        {links.map((l) => (
          <button key={l.key} className="dash-link" onClick={() => go(l.key)}>
            <span className="dash-link-icon">{l.icon}</span>
            <span className="dash-link-body">
              <span className="dash-link-title">{l.title} {I.arrow}</span>
              <span className="dash-link-desc">{l.desc}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
