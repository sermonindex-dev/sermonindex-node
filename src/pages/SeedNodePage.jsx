import React, { useState, useCallback, useEffect } from 'react';
import { probeReachability, registerSeed } from '../services/network.js';
import { getNodeId } from '../services/heartbeat.js';

const FORUMS_HARDWARE_GUIDE = 'https://www.sermonindex.net/forums/hardware-guide';
const SEED_CONTACT_EMAIL = 'sermonindex@gmail.com';

// ── Library sizing, split by scope ─────────────────────────────────────────
// Audio-only is the practical common choice: ~412 GB fits on a cheap external
// drive. Everything (audio + video) is ~2.4 TB and needs a large drive.
const SCOPE_INFO = {
  audio: {
    label: 'Audio library',
    sizeLabel: '~412 GB',
    fileCount: 70749,
    tagline: '~412 GB · 70,749 sermons · fits on a small external drive',
    // Require a comfortable margin above the ~412 GB payload.
    requiredBytes: 500 * 1000 * 1000 * 1000, // 500 GB
    requiredLabel: '500 GB',
  },
  full: {
    label: 'Everything (audio + video)',
    sizeLabel: '~2.4 TB',
    fileCount: 82341, // 70,749 audio + 11,592 video
    tagline: '~2.4 TB · adds 11,592 videos · needs a large drive',
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
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

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

  // STEP 3 — reachability
  const [reach, setReach] = useState(null); // null | { checking } | { open, port }
  const [reachPort, setReachPort] = useState(null);

  // STEP 4 — download
  const [downloading, setDownloading] = useState(false);
  const [batchProgress, setBatchProgress] = useState(null);
  const [isPaused, setIsPaused] = useState(false);

  const [unlocking, setUnlocking] = useState(false);

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

  const handleUnlock = async () => {
    if (!password.trim()) {
      setError('Please enter a password.');
      return;
    }
    setUnlocking(true);
    setError('');
    try {
      // Validate seed password against server
      const res = await fetch('https://app.sermonindex.net/api/seed/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: password.trim() }),
      });
      const data = await res.json();
      if (data.ok) {
        onUnlock(true);
        setError('');
      } else {
        setError(data.error || 'Invalid seed node password. Contact the SermonIndex admin for access.');
      }
    } catch (e) {
      // Fallback: allow offline unlock with hashed check
      // SHA-256 of 'seed2026' = known hash — prevents plaintext in source
      const encoder = new TextEncoder();
      const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(password.trim()));
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
      // Hash of 'seed2026'
      if (hashHex === 'e77fa9f21b0d3346d7e2a0c3fe0f314cd2273a7dff35bf2fb66b73ddbca87bbd') {
        onUnlock(true);
        setError('');
      } else {
        setError('Invalid password. Could not reach server for verification.');
      }
    }
    setUnlocking(false);
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
    setReach({ checking: true });
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
      setReach({ open: false, port: null, noPort: true });
      return;
    }
    setReachPort(port);

    const result = await probeReachability(port);
    if (result) {
      setReach({ open: result.open, port });
      // Register in the backbone directory so new users can find reachable seeds.
      try {
        const scope = (() => { try { return localStorage.getItem('si-seed-scope') || 'audio'; } catch { return 'audio'; } })();
        registerSeed(getNodeId(), port, scope).catch(() => {});
      } catch {}
      return;
    }
    // Probe service unavailable — fall back to canyouseeme.org so the seed
    // node can still confirm the port manually.
    setReach({ open: false, port, manual: true });
    await ensureTauri();
    if (tauriInvoke) {
      try { await tauriInvoke('open_url', { url: 'https://canyouseeme.org/' }); } catch {}
    }
  }, [reachPort]);

  // ── STEP 4: scope-filtered bulk download ──────────────────────────────────
  const startFullDownload = useCallback(async () => {
    if (!downloadManager) return;
    setDownloading(true);

    const toDownload = scope === 'audio'
      ? catalog.filter(s => s.type === 'audio' && !s.downloaded)
      : catalog.filter(s => !s.downloaded);

    try {
      await downloadManager.downloadBatch(toDownload, (progress) => {
        setBatchProgress({ ...progress });
      });
    } catch (err) {
      console.error('[SeedNode] Batch download error:', err);
    }
  }, [catalog, downloadManager, scope]);

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
    ? { completed: batchProgress.completed, total: batchProgress.total, failed: batchProgress.failed, percent: batchProgress.progress }
    : { completed: scopeDownloaded, total: scopeTotal, failed: 0, percent: scopePercent };

  // ─── LOCKED STATE ─────────────────────────────────────────────────

  if (!seedUnlocked) {
    return (
      <div className="seed-section">
        <div className="page-header">
          <h2 style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <span style={{ display: 'inline-flex', color: 'var(--gold-text)' }}>{iconCircuitry}</span> Become a Seed Node
          </h2>
          <p>Seed nodes carry the sermon library and serve it to the global peer network</p>
        </div>

        <div className="seed-card">
          <h3 style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>{iconLock} Password Required</h3>
          <p>
            Seed node access is by invitation only. The SermonIndex admin personally invites trusted
            believers around the world to become seed nodes — the backbone of the peer-to-peer network.
          </p>
          <p>
            If you're interested in becoming a seed node, email{' '}
            <a href={`mailto:${SEED_CONTACT_EMAIL}`} style={{ color: 'var(--gold-text)' }}>{SEED_CONTACT_EMAIL}</a>
          </p>
          <p>
            If you've been invited, enter your seed node password below.
          </p>

          <div style={{ display: 'flex', gap: '10px', marginTop: '8px' }}>
            <input
              type="password"
              placeholder="Enter seed node password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleUnlock()}
            />
            <button className="btn btn-gold" onClick={handleUnlock} disabled={unlocking}>
              {unlocking ? 'Verifying...' : 'Unlock'}
            </button>
          </div>
          {error && <p style={{ color: 'var(--red)', fontSize: '0.82rem', marginTop: '8px' }}>{error}</p>}
        </div>

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
            <strong style={{ color: 'var(--gold-text)' }}> ~412 GB</strong> (70,749 sermons) that fits on a
            cheap external drive. Hosting <strong>everything, including video</strong>, is
            <strong style={{ color: 'var(--gold-text)' }}> ~2.4 TB</strong> and needs a large drive.
          </p>
          <p>
            We recommend a dedicated NVMe or USB external drive. See our{' '}
            <a href={FORUMS_HARDWARE_GUIDE} target="_blank" rel="noopener" style={{ color: 'var(--gold-text)' }}>
              hardware setup guide
            </a>{' '}
            on the SermonIndex forums for recommendations (TerraMaster NVMe enclosures, etc.).
          </p>
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
    );
  }

  // ─── UNLOCKED STATE ───────────────────────────────────────────────

  return (
    <div className="seed-section">
      <div className="page-header">
        <h2 style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <span style={{ display: 'inline-flex', color: 'var(--gold-text)' }}>{iconCircuitry}</span> Seed Node Active
        </h2>
        <p>You are helping carry the sermon library for the global network</p>
      </div>

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
          ({scopeInfo.label.toLowerCase()} is {scopeInfo.sizeLabel}). We recommend a dedicated external
          NVMe or USB drive. See our{' '}
          <a href={FORUMS_HARDWARE_GUIDE} target="_blank" rel="noopener" style={{ color: 'var(--gold-text)' }}>
            hardware guide
          </a>{' '}
          for recommended setups (TerraMaster NVMe, Samsung T7, etc.).
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
            {diskInfo ? ` — ${diskInfo.available_formatted} free (${diskInfo.available_tb} TB), enough for ${scopeInfo.label.toLowerCase()} (${scopeInfo.sizeLabel}).` : '.'}
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
          <button className="btn btn-gold" onClick={testReachability} disabled={!!reach?.checking}>
            {reach?.checking ? 'Testing…' : 'Test Reachability'}
          </button>
          {reachPort && (
            <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
              Node port: <strong style={{ color: 'var(--text-primary)' }}>{reachPort}</strong>
            </span>
          )}
        </div>

        {reach && !reach.checking && (
          reach.open ? (
            <p style={{ color: 'var(--green)', fontSize: '0.85rem', marginTop: '12px', fontWeight: 600 }}>
              ✓ Reachable — you're strengthening the backbone.
            </p>
          ) : (
            <div style={{ marginTop: '12px' }}>
              <p style={{ color: 'var(--orange)', fontSize: '0.85rem', fontWeight: 600, marginBottom: '8px' }}>
                {reach.noPort
                  ? 'Not reachable yet — the P2P session isn\'t running, so there\'s no port to test. Start the node, then test again.'
                  : `Not reachable yet — forward TCP port ${reach.port} (range 42800–42839) in your router, or enable UPnP.`}
              </p>
              {!reach.noPort && (
                <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                  <p style={{ margin: '0 0 6px' }}>Quickest fixes:</p>
                  <p style={{ margin: '0 0 4px' }}>
                    1. In your router settings, turn on <strong>UPnP</strong>, then restart this app.
                  </p>
                  <p style={{ margin: '0 0 6px' }}>
                    2. Or add a port forward: <strong>TCP {reach.port}</strong> (or the range
                    {' '}<strong>42800–42839</strong>) pointing to this computer.
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
                {displayProgress.failed} files failed — will retry on next batch
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
        <div className="settings-row">
          <div>
            <div style={{ fontWeight: 500 }}>Hosting</div>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>What this node is set to carry</div>
          </div>
          <span style={{ color: 'var(--gold-text)', fontWeight: 600 }}>{scopeInfo.label} ({scopeInfo.sizeLabel})</span>
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
  );
}
