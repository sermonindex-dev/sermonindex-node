import React, { useState, useEffect, useRef, useCallback } from 'react';

// Where new users go to grab the app. Shared verbatim in the invite message.
const DOWNLOAD_URL = 'https://sermonindex4.b-cdn.net/app/download/';
const TOTAL_SERMONS = 33528; // 25,587 audio + 7,941 video (matches Seed Node page)
const INVITE_MESSAGE =
  `Help preserve ${TOTAL_SERMONS.toLocaleString()} sermons — run a free SermonIndex node: ${DOWNLOAD_URL}`;

// Refresh cadence for the live figures (peers / seeded count).
const REFRESH_MS = 12000;

// Torrent service — lazy-loaded, same pattern the rest of the app uses so this
// component never blocks first paint and works in non-Tauri dev too.
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

// Decimal GB (1000^3), matching how the app sizes the library elsewhere
// (~412 GB audio, ~2.4 TB full). Falls back to MB/KB for small contributions.
function formatContribution(bytes) {
  const b = Number(bytes) || 0;
  const gb = b / 1e9;
  if (gb >= 1) return `${gb.toFixed(gb >= 100 ? 0 : gb >= 10 ? 1 : 2)} GB`;
  const mb = b / 1e6;
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  if (b > 0) return `${Math.max(1, Math.round(b / 1e3))} KB`;
  return '0 GB';
}

// Feather-style hand-heart glyph for the panel heading.
const iconImpact = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M11 14h2a2 2 0 0 0 2-2 2 2 0 0 0-2-2H9.5a3 3 0 0 0-2.12.88L3 15" />
    <path d="M7 18l-2 2" />
    <path d="M18.4 7.6a2.7 2.7 0 0 0-3.8 0L14 8.2l-.6-.6a2.7 2.7 0 1 0-3.8 3.8l.6.6 3.8 3.8 3.8-3.8.6-.6a2.7 2.7 0 0 0 0-3.8z" />
  </svg>
);

// Feather-style share glyph for the invite button.
const iconShare = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: '6px', verticalAlign: '-2px' }}>
    <circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" />
    <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" /><line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
  </svg>
);

/**
 * ImpactPanel — a prominent, encouraging card showing this node's REAL
 * contribution, plus a one-click invite/share.
 *
 * All figures come from what the app already tracks (same sources as
 * heartbeat.js):
 *   • Sermons seeding   — finished torrents (t.stats.finished) from listTorrents()
 *   • Data contributed  — localStorage si-uploaded-lifetime { lifetime }
 *   • Peers helped now   — Σ t.stats.live.snapshot.peer_stats.live
 */
export default function ImpactPanel() {
  const [seeding, setSeeding] = useState(0);
  const [peers, setPeers] = useState(0);
  const [uploaded, setUploaded] = useState(() => readUploadedLifetime());
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef(null);

  const refresh = useCallback(async () => {
    setUploaded(readUploadedLifetime());
    try {
      const mod = await ensureTorrent();
      if (!mod) return;
      const st = await mod.getStatus().catch(() => null);
      if (!st?.running) { setSeeding(0); setPeers(0); return; }
      const list = await mod.listTorrents().catch(() => []);
      setSeeding(list.filter(t => t.stats?.finished).length);
      setPeers(list.reduce((n, t) => n + (t.stats?.live?.snapshot?.peer_stats?.live || 0), 0));
    } catch { /* leave last-known values */ }
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, REFRESH_MS);
    return () => clearInterval(id);
  }, [refresh]);

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

  const tiles = [
    { value: seeding.toLocaleString(), label: "Sermons you're seeding", color: 'var(--gold-text)' },
    { value: dataLabel, label: "Data you've contributed", color: 'var(--green)' },
    { value: peers.toLocaleString(), label: "Peers you're helping now", color: 'var(--seed-blue)' },
  ];

  return (
    <div
      className="seed-card"
      style={{
        background: 'linear-gradient(135deg, rgba(212,175,55,0.12), rgba(212,175,55,0.03))',
        border: '1px solid var(--gold-dim)',
      }}
    >
      {/* Heading + invite */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ display: 'inline-flex', color: 'var(--gold-text)' }}>{iconImpact}</span>
          Your Impact
        </h3>
        <span style={{ position: 'relative', display: 'inline-block' }}>
          <button className="btn btn-gold" onClick={handleInvite} style={{ whiteSpace: 'nowrap' }}>
            {iconShare}Invite / Share
          </button>
          {copied && (
            <span style={{
              position: 'absolute', top: '112%', right: 0,
              background: 'var(--olive)', color: '#fff', fontSize: '0.68rem', fontWeight: 600,
              padding: '4px 10px', borderRadius: '4px', whiteSpace: 'nowrap',
              pointerEvents: 'none', zIndex: 10, boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
            }}>
              Copied invite!
            </span>
          )}
        </span>
      </div>

      <p style={{ marginTop: '6px', marginBottom: '16px' }}>
        You're helping preserve God's Word for the world — every sermon you hold and every byte you
        share keeps the library alive and impossible to erase.
      </p>

      {/* Live stat tiles */}
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

      {/* Encouraging one-liner that folds the live numbers together */}
      <p style={{ marginTop: '16px', marginBottom: 0, fontSize: '0.9rem', color: 'var(--text-secondary)', lineHeight: 1.6 }}>
        <strong style={{ color: 'var(--gold-text)' }}>{seeding.toLocaleString()}</strong>{' '}
        {seeding === 1 ? 'sermon' : 'sermons'} shared ·{' '}
        <strong style={{ color: 'var(--gold-text)' }}>{dataLabel}</strong> contributed ·{' '}
        helping <strong style={{ color: 'var(--gold-text)' }}>{peers.toLocaleString()}</strong>{' '}
        {peers === 1 ? 'peer' : 'peers'} right now. Invite a friend to multiply it.
      </p>
    </div>
  );
}
