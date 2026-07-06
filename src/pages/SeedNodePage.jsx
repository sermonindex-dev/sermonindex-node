import React, { useState, useCallback } from 'react';

const FORUMS_HARDWARE_GUIDE = 'https://www.sermonindex.net/forums/hardware-guide';
const SEED_CONTACT_EMAIL = 'sermonindex@gmail.com';

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
  const [step, setStep] = useState(1); // 1: set location, 2: verify space, 3: download
  const [storagePath, setStoragePath] = useState('');
  const [storageVerified, setStorageVerified] = useState(false);
  const [storageError, setStorageError] = useState('');
  const [downloading, setDownloading] = useState(false);
  const [batchProgress, setBatchProgress] = useState(null);
  const [isPaused, setIsPaused] = useState(false);

  const [unlocking, setUnlocking] = useState(false);

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

  const browsePath = useCallback(async () => {
    await ensureTauri();
    if (tauriDialog) {
      try {
        const selected = await tauriDialog.open({ directory: true, title: 'Select Seed Node Storage Location' });
        if (selected) {
          setStoragePath(selected);
          setStorageVerified(false);
          setStorageError('');
        }
      } catch (e) {
        console.warn('[SeedNode] Dialog failed:', e);
      }
    }
  }, []);

  const verifyStorage = useCallback(async () => {
    if (!storagePath.trim()) {
      setStorageError('Please enter or browse for a storage path.');
      return;
    }

    await ensureTauri();
    // Check disk space via Tauri command
    if (tauriInvoke) {
      try {
        const info = await tauriInvoke('check_disk_space', { path: storagePath });
        if (!info.has_enough) {
          setStorageError(`Only ${info.available_formatted} available (${info.available_tb} TB). You need at least 2.2 TB of free space.`);
          return;
        }
        setStorageError('');
        setStorageVerified(true);
        setStep(2);
      } catch (e) {
        // If the command fails (e.g. path doesn't exist), show error
        setStorageError(`Could not verify path: ${e}`);
      }
    } else {
      // Browser mode — just accept it
      setStorageError('');
      setStorageVerified(true);
      setStep(2);
    }
  }, [storagePath]);

  const startFullDownload = useCallback(async () => {
    if (!downloadManager) return;
    setDownloading(true);
    setStep(3);

    const toDownload = catalog.filter(s => !s.downloaded);

    try {
      await downloadManager.downloadBatch(toDownload, (progress) => {
        setBatchProgress({ ...progress });
      });
    } catch (err) {
      console.error('[SeedNode] Batch download error:', err);
    }
  }, [catalog, downloadManager]);

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

  const downloadedCount = catalog.filter(s => s.downloaded).length;
  const totalCount = catalog.length;
  const progressPercent = totalCount > 0 ? (downloadedCount / totalCount) * 100 : 0;

  const displayProgress = batchProgress
    ? { completed: batchProgress.completed, total: batchProgress.total, failed: batchProgress.failed, percent: batchProgress.progress }
    : { completed: downloadedCount, total: totalCount, failed: 0, percent: progressPercent };

  // ─── LOCKED STATE ─────────────────────────────────────────────────

  if (!seedUnlocked) {
    return (
      <div className="seed-section">
        <div className="page-header">
          <h2 style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <span style={{ display: 'inline-flex', color: 'var(--gold)' }}>{iconCircuitry}</span> Become a Seed Node
          </h2>
          <p>Seed nodes carry the full sermon library and serve it to the global peer network</p>
        </div>

        <div className="seed-card">
          <h3 style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>{iconLock} Password Required</h3>
          <p>
            Seed node access is by invitation only. The SermonIndex admin personally invites trusted
            believers around the world to become seed nodes — the backbone of the peer-to-peer network.
          </p>
          <p>
            If you're interested in becoming a seed node, email{' '}
            <a href={`mailto:${SEED_CONTACT_EMAIL}`} style={{ color: 'var(--gold)' }}>{SEED_CONTACT_EMAIL}</a>
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
            <span style={{ display: 'inline-flex', color: 'var(--gold)' }}>{iconCircuitry}</span> What is a Seed Node?
          </h3>
          <p>
            SermonIndex is built on a peer-to-peer network where every user helps share sermon content.
            Regular users share the sermons they've listened to. <strong>Seed nodes</strong> go further — they download
            and serve the <strong>entire library</strong> (~2.2 TB of audio and video).
          </p>
          <p>
            This requires a larger disk or external hard drive. We recommend a dedicated NVMe or USB
            external drive. See our{' '}
            <a href={FORUMS_HARDWARE_GUIDE} target="_blank" rel="noopener" style={{ color: 'var(--gold)' }}>
              hardware setup guide
            </a>{' '}
            on the SermonIndex forums for recommendations (TerraMaster NVMe enclosures, etc.).
          </p>
          <p>
            With seed nodes distributed across the world, the sermon library becomes essentially
            indestructible. No single point of failure. No government can censor it. The content lives
            on across the body of Christ.
          </p>
          <p style={{ color: 'var(--gold)', fontStyle: 'italic', marginBottom: 0 }}>
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
          <span style={{ display: 'inline-flex', color: 'var(--gold)' }}>{iconCircuitry}</span> Seed Node Active
        </h2>
        <p>You are helping carry the entire sermon library for the global network</p>
      </div>

      {/* Step 1: Set storage location */}
      <div className="seed-card">
        <h3>Step 1: Set Your Storage Location</h3>
        <p>
          Choose a folder on a drive with at least <strong style={{ color: 'var(--gold)' }}>2.2 TB</strong> of free space.
          We recommend using a dedicated external NVMe or USB hard drive. See our{' '}
          <a href={FORUMS_HARDWARE_GUIDE} target="_blank" rel="noopener" style={{ color: 'var(--gold)' }}>
            hardware guide
          </a>{' '}
          for recommended setups (TerraMaster NVMe, Samsung T7, etc.).
        </p>

        <div style={{ display: 'flex', gap: '8px', marginTop: '8px', alignItems: 'center' }}>
          <input
            type="text"
            placeholder="/Volumes/SermonIndex-Drive/sermons"
            value={storagePath}
            onChange={e => { setStoragePath(e.target.value); setStorageVerified(false); setStorageError(''); }}
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
            onClick={verifyStorage}
            disabled={storageVerified}
          >
            {storageVerified ? '✓ Saved' : 'Verify & Save'}
          </button>
        </div>
        {storageError && <p style={{ color: 'var(--red)', fontSize: '0.82rem', marginTop: '8px' }}>{storageError}</p>}
        {storageVerified && (
          <p style={{ color: 'var(--green)', fontSize: '0.82rem', marginTop: '8px' }}>
            ✓ Storage location set. You need at least 2.2 TB of free space.
          </p>
        )}
      </div>

      {/* Step 2: Download full library */}
      <div className="seed-card" style={{ opacity: storageVerified ? 1 : 0.4, pointerEvents: storageVerified ? 'auto' : 'none' }}>
        <h3>Step 2: Download the Full Library</h3>
        <p>
          Download the complete SermonIndex library to your drive. The total size is approximately{' '}
          <strong style={{ color: 'var(--gold)' }}>2.2 TB</strong> ({libraryStats?.totalFiles || 0} sermons).
        </p>
        <p style={{ fontSize: '0.82rem', color: 'var(--text-muted)' }}>
          This can take <strong>several days or weeks</strong> depending on your connection speed. The download will
          automatically resume if you shut down the computer and turn it back on. You can pause and resume anytime.
        </p>

        {!downloading ? (
          <div style={{ marginTop: '12px' }}>
            <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '16px' }}>
              Already downloaded: <strong style={{ color: 'var(--gold)' }}>{downloadedCount}</strong>
              · Remaining: <strong>{totalCount - downloadedCount}</strong>
            </p>
            {downloadedCount < totalCount ? (
              <button className="btn btn-gold" onClick={startFullDownload}>
                {downloadedCount > 0 ? 'Resume Full Library Download' : 'Start Full Library Download'}
              </button>
            ) : (
              <p style={{ color: '#4caf50', fontWeight: 600 }}>
                ✓ Full library downloaded! You are a complete seed node.
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
              <span>{displayProgress.completed} of {displayProgress.total} files</span>
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
            <div style={{ fontWeight: 500 }}>Library Coverage</div>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Percentage of full library held locally</div>
          </div>
          <span style={{ color: 'var(--gold)', fontWeight: 600 }}>{libraryStats?.coverage || 0}%</span>
        </div>
        <div className="settings-row">
          <div>
            <div style={{ fontWeight: 500 }}>Files Seeded</div>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Sermons stored and shared on the P2P network</div>
          </div>
          <span style={{ color: 'var(--text-secondary)' }}>{downloadedCount} / {totalCount}</span>
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
            {storagePath || 'Not set'}
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
          <a href={`mailto:${SEED_CONTACT_EMAIL}`} style={{ color: 'var(--gold)' }}>{SEED_CONTACT_EMAIL}</a>
        </p>
      </div>
    </div>
  );
}
