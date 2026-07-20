import React, { useState, useEffect, useRef } from 'react';
import { getNodeId } from '../services/heartbeat.js';
// Shared with App.jsx's seeding-status derivation so the two never drift.
import { to12h } from '../utils/time.js';
import { checkForUpdatesNow } from '../services/updater.js';
// The verification sweep lives in catalog.js beside the one and only definition
// of "is this file complete" — this page just drives it and reports the result.
import { verifyLibrary } from '../services/catalog.js';
// Repair goes through the download manager's EXISTING public reseedExisting():
// it prefers the canonical torrent from the signed master list, which makes the
// torrent engine check the file already on disk and pull only the broken parts
// from the CDN webseed instead of downloading the whole sermon again.
import downloadManager from '../services/downloadManager.js';

// 48 half-hour slots: 00:00 → 23:30
const TIME_SLOTS = Array.from({ length: 48 }, (_, i) => {
  const h = String(Math.floor(i / 2)).padStart(2, '0');
  const mm = i % 2 === 0 ? '00' : '30';
  return `${h}:${mm}`;
});

// Normalize an incoming value to the "HH:MM" shape the options use, so the
// <select> matches even if the stored value is e.g. "7:00".
function normalizeTime(v) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(v || ''));
  return m ? `${String(Number(m[1]) % 24).padStart(2, '0')}:${m[2]}` : '';
}

export default function SettingsPage({
  contentMode,
  onModeChange,
  nodeOnline,
  onNodeToggle,
  p2pEnabled,
  p2pRunning,
  onP2pToggle,
  bandwidthLimit,
  onBandwidthChange,
  storageLimit,
  onStorageLimitChange,
  backgroundMode,
  onBackgroundModeChange,
  uploadLimitEnabled,
  onUploadLimitToggle,
  uploadLimitKbps,
  onUploadLimitKbpsChange,
  seedScheduleEnabled,
  onSeedScheduleToggle,
  seedStart,
  onSeedStartChange,
  seedEnd,
  onSeedEndChange,
  seedStatus,
  uploadCapEnabled,
  onUploadCapToggle,
  uploadCapGb,
  onUploadCapGbChange,
  chatNotify,
  onChatNotifyChange,
  chatShow,
  onChatShowChange,
  nodeStats,
  version = '',
  onNavigate,
  onShowConditions,
}) {
  const [nodeId, setNodeId] = useState('');
  const [modeStatus, setModeStatus] = useState(''); // 'saved', ''
  const [copiedNodeId, setCopiedNodeId] = useState(false);
  const [monthUsedGb, setMonthUsedGb] = useState(0); // GB uploaded this month (read-only display)
  // Local draft for the KB/s upload cap — type a number, then press Set to apply.
  // Committing reuses onUploadLimitKbpsChange (the same setter that persists + applies).
  const [uploadKbpsDraft, setUploadKbpsDraft] = useState(String(uploadLimitKbps ?? ''));
  const [uploadKbpsSaved, setUploadKbpsSaved] = useState(false);

  // "Check for update" outcome. Component-local ON PURPOSE and never persisted:
  // navigating away and back must reset it to the plain button, so the result
  // shown is always one the user just asked for and can never go stale.
  //   null | { status:'checking' } | { status:'latest' }
  //   | { status:'available', version, install } | { status:'dev'|'error', message }
  const [updateCheck, setUpdateCheck] = useState(null);
  const [installing, setInstalling] = useState(false);

  const handleCheckForUpdate = async () => {
    setUpdateCheck({ status: 'checking' });
    const result = await checkForUpdatesNow(); // never throws
    setUpdateCheck(result);
  };

  // Reuses the install() handed back by the updater — the same download +
  // install + relaunch the update banner performs, not a second implementation.
  const handleInstallUpdate = async () => {
    if (!updateCheck?.install) return;
    setInstalling(true);
    try {
      await updateCheck.install(); // relaunches on success, so this won't return
    } catch (e) {
      setInstalling(false);
      setUpdateCheck({
        status: 'error',
        message: e?.message ? String(e.message) : 'The update could not be installed.',
      });
    }
  };

  // ── Verify & Repair Library ───────────────────────────────────────────────
  // Component-local and never persisted, exactly like the update check above: a
  // result the user sees must be one they just asked for, never a stale one.
  //   null | { status:'running', done, total }
  //   | { status:'done'|'stopped', ...counts } | { status:'unavailable' }
  const [verify, setVerify] = useState(null);
  //   null | { status:'starting'|'started'|'failed', count }
  const [repair, setRepair] = useState(null);
  // Sermons the last sweep found damaged or missing, kept out of render state so
  // a large list never re-renders the page.
  const damagedRef = useRef([]);
  const cancelVerifyRef = useRef(false);
  // Guards a setState after unmount if the user navigates away mid-sweep.
  const mountedRef = useRef(true);
  // MUST set mountedRef back to true on mount, not just false on unmount.
  // React.StrictMode (main.jsx) deliberately mounts → unmounts → remounts every
  // component in development. A cleanup-only effect therefore leaves this ref
  // stuck at false forever, which silently disabled the whole verification
  // sweep: shouldStop() returned true so it aborted on the first batch,
  // onProgress was ignored, and the result was discarded — the UI just sat on
  // "Looking through your sermon folder…" doing nothing.
  useEffect(() => {
    mountedRef.current = true;
    cancelVerifyRef.current = false;
    return () => { mountedRef.current = false; cancelVerifyRef.current = true; };
  }, []);

  const handleVerifyLibrary = async () => {
    if (verify?.status === 'running') return;
    cancelVerifyRef.current = false;
    damagedRef.current = [];
    setRepair(null);
    setVerify({ status: 'running', done: 0, total: 0 });
    let result;
    try {
      result = await verifyLibrary({
        onProgress: ({ done, total }) => {
          if (mountedRef.current) setVerify({ status: 'running', done, total });
        },
        shouldStop: () => cancelVerifyRef.current,
      });
    } catch (e) {
      // verifyLibrary is written not to throw, but a surprise must still never
      // reach the user as a raw error string.
      console.warn('[Settings] Library verification failed:', e?.message || e);
      if (mountedRef.current) setVerify({ status: 'unavailable' });
      return;
    }
    if (!mountedRef.current) return;
    if (!result.ok) { setVerify({ status: 'unavailable' }); return; }
    damagedRef.current = result.repairable || [];
    setVerify({
      status: result.stopped ? 'stopped' : 'done',
      total: result.total,
      checked: result.checked,
      complete: result.complete,
      damaged: result.damaged,
      missing: result.missing,
      unchecked: result.unchecked,
    });
  };

  const handleRepairLibrary = async () => {
    const items = damagedRef.current;
    if (!items.length || repair?.status === 'starting') return;
    setRepair({ status: 'starting', count: items.length });
    try {
      // Fire and forget: reseedExisting walks the list in the background and
      // yields between files, so a big repair never freezes the window.
      downloadManager.reseedExisting(items).catch((e) => {
        console.warn('[Settings] Repair pass reported a problem:', e?.message || e);
      });
      if (mountedRef.current) setRepair({ status: 'started', count: items.length });
    } catch (e) {
      console.warn('[Settings] Repair could not be started:', e?.message || e);
      if (mountedRef.current) setRepair({ status: 'failed', count: items.length });
    }
  };

  // Read-only monthly upload usage for the cap readout. App.jsx owns writing the
  // per-month baseline (`si-upload-month`); here we only READ it + the lifetime
  // accumulator to show progress. Refreshed lightly while the cap is enabled.
  useEffect(() => {
    if (!uploadCapEnabled) { setMonthUsedGb(0); return; }
    const read = () => {
      try {
        const lifeRaw = localStorage.getItem('si-uploaded-lifetime');
        const lifetime = lifeRaw ? Number(JSON.parse(lifeRaw).lifetime) || 0 : 0;
        const rec = JSON.parse(localStorage.getItem('si-upload-month') || 'null');
        const d = new Date();
        const month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        const usedBytes = (!rec || rec.month !== month) ? 0 : Math.max(0, lifetime - (Number(rec.baseLifetime) || 0));
        setMonthUsedGb(usedBytes / (1024 ** 3));
      } catch { setMonthUsedGb(0); }
    };
    read();
    const iv = setInterval(read, 5000);
    return () => clearInterval(iv);
  }, [uploadCapEnabled]);

  // Keep the KB/s draft in sync with the applied value whenever it changes
  // elsewhere (persisted value loads on mount, or it's set outside this field).
  useEffect(() => { setUploadKbpsDraft(String(uploadLimitKbps ?? '')); }, [uploadLimitKbps]);

  // navigator.clipboard often fails silently in the WKWebView; fall back to a
  // temp-textarea + execCommand so Copy actually works, and give feedback.
  async function copyNodeId() {
    let ok = false;
    try { await navigator.clipboard.writeText(nodeId); ok = true; } catch { /* fall through */ }
    if (!ok) {
      try {
        const ta = document.createElement('textarea');
        ta.value = nodeId;
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        ok = true;
      } catch { /* give up */ }
    }
    if (ok) { setCopiedNodeId(true); setTimeout(() => setCopiedNodeId(false), 1500); }
  }

  // Show the persistent node ID (generated locally, survives restarts)
  useEffect(() => {
    try { setNodeId(getNodeId()); } catch {}
  }, []);

  const selectStyle = {
    background: 'var(--bg-tertiary)',
    border: '1px solid var(--border)',
    color: 'var(--text-primary)',
    padding: '6px 10px',
    borderRadius: '6px',
    fontSize: '0.82rem',
    fontFamily: 'var(--font)',
  };

  // Small button matching the app's existing tertiary buttons (see About section).
  const setButtonStyle = {
    fontSize: '0.8rem',
    fontWeight: 600,
    fontFamily: 'var(--font)',
    color: 'var(--gold-text)',
    background: 'var(--bg-tertiary)',
    border: '1px solid var(--border)',
    borderRadius: '6px',
    padding: '6px 12px',
  };

  // Upload-cap draft → derived flags + a commit that reuses the existing setter prop.
  const uploadKbpsDraftNum = parseInt(uploadKbpsDraft, 10);
  const uploadKbpsValid = Number.isFinite(uploadKbpsDraftNum) && uploadKbpsDraftNum > 0;
  const uploadKbpsDirty = uploadKbpsValid && uploadKbpsDraftNum !== uploadLimitKbps;
  const commitUploadKbps = () => {
    if (!uploadKbpsDirty) return;
    onUploadLimitKbpsChange(uploadKbpsDraftNum);
    setUploadKbpsSaved(true);
    setTimeout(() => setUploadKbpsSaved(false), 2000);
  };

  // Muted, secondary "status" line used under the two section headings.
  const summaryLineStyle = {
    fontSize: '0.78rem',
    color: 'var(--text-muted)',
    marginBottom: '16px',
    lineHeight: 1.5,
  };

  // Live one-liner for "Seeding Schedule & Limits" — reflects the actual state.
  const seedSummary = [
    seedScheduleEnabled && normalizeTime(seedStart) && normalizeTime(seedEnd)
      ? `Seeding ${to12h(seedStart)} – ${to12h(seedEnd)}`
      : 'Seeding around the clock',
    uploadLimitEnabled && uploadLimitKbps > 0
      ? `upload capped at ${uploadLimitKbps} KB/s`
      : 'upload unlimited',
    uploadCapEnabled && uploadCapGb > 0
      ? `monthly cap ${uploadCapGb} GB`
      : 'no monthly cap',
    // Live window state from App.jsx (windowLabel is null when there's no usable
    // schedule, so this drops out entirely rather than claiming "active").
    seedStatus?.windowLabel
      ? (seedStatus.throttled ? 'paused right now' : 'active right now')
      : null,
  ].filter(Boolean).join(' · ');

  // Live one-liner for "Peer-to-Peer Network" — degrades gracefully when
  // nodeStats hasn't arrived yet or the counts are zero.
  const p2pSummary = (() => {
    if (!p2pEnabled) return "Off — you're downloading only, not sharing";
    if (!p2pRunning) return 'Enabled, starting up…';
    const peers = Number(nodeStats?.peersConnected) || 0;
    const files = Number(nodeStats?.filesShared) || 0;
    const storage = nodeStats?.storageUsed;
    const parts = ['Running'];
    parts.push(peers === 1 ? '1 peer connected' : `${peers} peers connected`);
    parts.push(
      files > 0
        ? `sharing ${files} file${files === 1 ? '' : 's'}${storage ? ` (${storage})` : ''}`
        : 'nothing shared yet'
    );
    return parts.join(' · ');
  })();

  // Thousands separators — "2,318" reads far better than "2318" to the audience
  // running these nodes.
  const fmtCount = (n) => Number(n || 0).toLocaleString();

  // How many the last sweep found that can be repaired (damaged + missing).
  const repairableCount = (verify?.damaged || 0) + (verify?.missing || 0);
  const verifyPct = verify?.status === 'running' && verify.total > 0
    ? Math.min(100, Math.round((verify.done / verify.total) * 100))
    : 0;

  const modes = [
    {
      key: 'cdn',
      label: 'Archive.org + CDN',
      desc: 'Download from Archive.org (free), Bunny CDN as fallback — files are seeded to the peer swarm after download',
    },
    {
      key: 'p2p-primary',
      label: 'P2P Primary',
      desc: 'Download from the peer swarm first, Archive.org and CDN as fallback',
    },
    {
      key: 'p2p-only',
      label: 'P2P Only',
      desc: 'Fully decentralized — peer network only, no CDN dependency',
    },
  ];

  return (
    <div className="settings-page-root">
      {/* page-header-wide matches .connections-layout's 1100px max-width and
          centring, so the heading lines up with the columns below it rather
          than sitting flush to the window edge. */}
      <div className="page-header-wide">
        <div className="page-header">
          <h2>Settings</h2>
          <p>Configure your node and app preferences</p>
        </div>
      </div>

      {/* Two-column layout: Settings left, Stats + About right */}
      <div className="connections-layout">
        {/* ── LEFT: Settings ── */}
        <div className="connections-left">
          {/* Low-disk warning (task 105): surfaced from nodeStats. New downloads
              are paused automatically until space is freed; seeding continues. */}
          {nodeStats?.lowDisk && (
            <div className="seed-card" style={{ background: 'rgba(230,160,30,0.08)', border: '1px solid rgba(230,160,30,0.4)' }}>
              <div style={{ fontWeight: 700, color: 'var(--gold-text)', marginBottom: '4px' }}>
                Low disk space
              </div>
              <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                Only {nodeStats.diskFree || 'very little space'} free on the storage drive.
                New downloads are paused until space is freed. Seeding of files you
                already have continues normally.
              </div>
            </div>
          )}
          <div className="seed-card">
            <h3>Peer-to-Peer Network</h3>
            <p style={{ marginBottom: '8px' }}>
              SermonIndex is a peer-to-peer sermon library. When you download sermons, your computer
              helps share them with other believers around the world. The more people who run this app,
              the faster and more resilient the network becomes.
            </p>

            {/* Live status of what's actually happening right now */}
            <div style={summaryLineStyle}>{p2pSummary}</div>

            <div className="settings-row">
              <div>
                <div style={{ fontWeight: 500 }}>P2P Node (BitTorrent)</div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                  {p2pRunning
                    ? <span style={{ color: 'var(--green)' }}>Running — sharing sermons with the peer network</span>
                    : p2pEnabled
                      ? 'Starting up...'
                      : 'Disabled — sermons will only download from CDN'}
                </div>
              </div>
              <div
                className={`toggle ${p2pEnabled ? 'on' : ''}`}
                onClick={() => onP2pToggle(!p2pEnabled)}
              ></div>
            </div>

            <div className="settings-row">
              <div>
                <div style={{ fontWeight: 500 }}>Background Seeding</div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                  Keep sharing sermons when the window is closed
                </div>
              </div>
              <div
                className={`toggle ${backgroundMode ? 'on' : ''}`}
                onClick={() => onBackgroundModeChange(!backgroundMode)}
              ></div>
            </div>

            <div className="settings-row">
              <div>
                <div style={{ fontWeight: 500 }}>Storage Limit</div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                  Maximum disk space for cached sermons:{' '}
                  <strong style={{ color: 'var(--gold-text)' }}>
                    {storageLimit === 0 ? 'Unlimited' : `${storageLimit} GB`}
                  </strong>
                </div>
              </div>
              <select
                value={storageLimit}
                onChange={e => onStorageLimitChange(parseInt(e.target.value))}
                style={selectStyle}
              >
                <option value={0}>Unlimited</option>
                <option value={5}>5 GB</option>
                <option value={10}>10 GB</option>
                <option value={20}>20 GB</option>
                <option value={50}>50 GB</option>
                <option value={100}>100 GB</option>
                <option value={500}>500 GB</option>
              </select>
            </div>

            <div className="settings-row">
              <div>
                <div style={{ fontWeight: 500 }}>Download Bandwidth Limit</div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                  Limit how much bandwidth downloads (Archive.org / CDN) may use, in bits per second:{' '}
                  <strong style={{ color: 'var(--gold-text)' }}>
                    {bandwidthLimit === 0 ? 'Unlimited' : bandwidthLimit < 1 ? `${bandwidthLimit * 1000} kbps` : `${bandwidthLimit} Mbps`}
                  </strong>
                </div>
              </div>
              <select
                value={bandwidthLimit}
                onChange={e => onBandwidthChange(parseFloat(e.target.value))}
                style={selectStyle}
              >
                <option value={0.1}>100 kbps</option>
                <option value={0.25}>250 kbps</option>
                <option value={0.5}>500 kbps</option>
                <option value={1}>1 Mbps</option>
                <option value={5}>5 Mbps</option>
                <option value={10}>10 Mbps</option>
                <option value={25}>25 Mbps</option>
                <option value={50}>50 Mbps</option>
                <option value={0}>Unlimited</option>
              </select>
            </div>

            {/* Real BitTorrent UPLOAD throttle (task 93). Opt-in: default off =
                unlimited, so nothing changes unless the user turns it on. This
                actually caps how fast sermons are shared to the peer swarm —
                unlike the download limit above, which only affects HTTP fetches. */}
            <div className="settings-row" style={uploadLimitEnabled ? undefined : { border: 'none' }}>
              <div>
                <div style={{ fontWeight: 500 }}>Limit upload speed</div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                  Cap how fast sermons are shared to the peer swarm (BitTorrent uploads), in kilobytes per second:{' '}
                  <strong style={{ color: 'var(--gold-text)' }}>
                    {uploadLimitEnabled ? `${uploadLimitKbps} KB/s` : 'Unlimited'}
                  </strong>
                </div>
              </div>
              <div
                className={`toggle ${uploadLimitEnabled ? 'on' : ''}`}
                onClick={() => onUploadLimitToggle(!uploadLimitEnabled)}
              ></div>
            </div>

            {uploadLimitEnabled && (
              <div className="settings-row" style={{ border: 'none' }}>
                <div>
                  <div style={{ fontWeight: 500 }}>Upload speed cap</div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                    Maximum upload rate, in kilobytes per second
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <input
                    type="number"
                    min="1"
                    step="50"
                    value={uploadKbpsDraft}
                    onChange={e => setUploadKbpsDraft(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') commitUploadKbps(); }}
                    style={{ ...selectStyle, width: '90px', textAlign: 'right' }}
                  />
                  <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>KB/s</span>
                  <button
                    onClick={commitUploadKbps}
                    disabled={!uploadKbpsDirty}
                    title="Apply the upload speed cap"
                    style={{
                      ...setButtonStyle,
                      color: uploadKbpsSaved ? 'var(--green)' : setButtonStyle.color,
                      border: `1px solid ${uploadKbpsSaved ? 'var(--green)' : 'var(--border)'}`,
                      opacity: (uploadKbpsDirty || uploadKbpsSaved) ? 1 : 0.5,
                      cursor: uploadKbpsDirty ? 'pointer' : 'default',
                    }}
                  >
                    {uploadKbpsSaved ? 'Set ✓' : 'Set'}
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* ── Seeding schedule + monthly upload cap (task 108) — opt-in ──
              Both default OFF, so seeding stays continuous unless the user opts in.
              Enforcement lives in App.jsx (throttles uploads via set_upload_limit). */}
          <div className="seed-card">
            <h3>Seeding Schedule &amp; Limits</h3>
            <p style={{ marginBottom: '8px' }}>
              Optional controls over how much you share back to the peer swarm. Both
              are off by default — leave them off to keep seeding continuously.
            </p>

            {/* Live summary of the settings currently in effect */}
            <div style={summaryLineStyle}>{seedSummary}</div>

            <div className="settings-row">
              <div>
                <div style={{ fontWeight: 500 }}>Only seed during set hours</div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                  Outside the window, uploads throttle to near-zero (about 1 KB/s).
                  Downloads and playback are unaffected — handy for overnight-only seeding.
                </div>
              </div>
              <div
                className={`toggle ${seedScheduleEnabled ? 'on' : ''}`}
                onClick={() => onSeedScheduleToggle(!seedScheduleEnabled)}
              ></div>
            </div>

            {seedScheduleEnabled && (
              <div className="settings-row">
                <div>
                  <div style={{ fontWeight: 500 }}>Seeding window</div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                    Local time. A window like 23:00 → 07:00 seeds overnight and throttles by day.
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <select
                    value={normalizeTime(seedStart)}
                    onChange={e => onSeedStartChange(e.target.value)}
                    style={selectStyle}
                  >
                    {!TIME_SLOTS.includes(normalizeTime(seedStart)) && (
                      <option value={normalizeTime(seedStart)}>{to12h(seedStart)}</option>
                    )}
                    {TIME_SLOTS.map(t => (
                      <option key={t} value={t}>{to12h(t)}</option>
                    ))}
                  </select>
                  <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>to</span>
                  <select
                    value={normalizeTime(seedEnd)}
                    onChange={e => onSeedEndChange(e.target.value)}
                    style={selectStyle}
                  >
                    {!TIME_SLOTS.includes(normalizeTime(seedEnd)) && (
                      <option value={normalizeTime(seedEnd)}>{to12h(seedEnd)}</option>
                    )}
                    {TIME_SLOTS.map(t => (
                      <option key={t} value={t}>{to12h(t)}</option>
                    ))}
                  </select>
                </div>
              </div>
            )}

            <div className="settings-row" style={{ border: 'none' }}>
              <div>
                <div style={{ fontWeight: 500 }}>Monthly upload cap</div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                  Pause seeding once you've uploaded this much in a calendar month;
                  it resumes automatically when the month resets.
                  {uploadCapEnabled && (
                    <>
                      {' '}
                      <strong style={{ color: 'var(--gold-text)' }}>
                        {monthUsedGb.toFixed(2)} GB of {uploadCapGb} GB used this month
                      </strong>
                    </>
                  )}
                </div>
              </div>
              <div
                className={`toggle ${uploadCapEnabled ? 'on' : ''}`}
                onClick={() => onUploadCapToggle(!uploadCapEnabled)}
              ></div>
            </div>

            {uploadCapEnabled && (
              <div className="settings-row" style={{ border: 'none' }}>
                <div>
                  <div style={{ fontWeight: 500 }}>Cap size</div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                    Upload allowance per month, in gigabytes
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <input
                    type="number"
                    min="1"
                    step="10"
                    value={uploadCapGb}
                    onChange={e => {
                      const n = parseInt(e.target.value, 10);
                      if (Number.isFinite(n) && n > 0) onUploadCapGbChange(n);
                    }}
                    style={{ ...selectStyle, width: '90px', textAlign: 'right' }}
                  />
                  <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>GB</span>
                </div>
              </div>
            )}
          </div>

          <div className="seed-card">
            <h3>Content Source</h3>
            <p style={{ marginBottom: '8px' }}>
              Controls where the app fetches sermon content from. Click to switch modes.
            </p>
            <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginBottom: '16px' }}>
              The network defines which sources are available.
            </p>

            <div className="content-source-visual">
              {modes.map((mode, i) => {
                const isActive = contentMode === mode.key;
                return (
                  <div
                    key={mode.key}
                    className={`settings-row ${isActive ? 'active-mode' : ''}`}
                    style={{
                      ...(i === modes.length - 1 ? { border: 'none' } : {}),
                      cursor: 'pointer',
                      transition: 'background 0.15s',
                    }}
                    onClick={() => {
                      if (!isActive) {
                        onModeChange(mode.key);
                        setModeStatus('saved');
                        setTimeout(() => setModeStatus(''), 2500);
                      }
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                      <div style={{
                        width: 14, height: 14, borderRadius: '50%',
                        border: `2px solid ${isActive ? 'var(--gold)' : 'var(--border-light)'}`,
                        background: isActive ? 'var(--gold)' : 'transparent',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        flexShrink: 0,
                        transition: 'all 0.15s',
                      }}>
                        {isActive && (
                          <div style={{ width: 6, height: 6, borderRadius: '50%', background: '#fff' }} />
                        )}
                      </div>
                      <div style={{ opacity: isActive ? 1 : 0.85 }}>
                        <div style={{ fontWeight: 500, color: isActive ? 'var(--text-primary)' : 'var(--text-muted)' }}>{mode.label}</div>
                        <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{mode.desc}</div>
                      </div>
                    </div>
                    {isActive && <span className="mode-badge cdn">Active</span>}
                  </div>
                );
              })}
            </div>
            {modeStatus === 'saved' && (
              <div style={{ fontSize: '0.75rem', color: 'var(--green)', marginTop: '8px', transition: 'opacity 0.3s' }}>
                Mode updated successfully
              </div>
            )}
          </div>

          <div className="seed-card">
            <h3>Community</h3>

            <div className="settings-row">
              <div>
                <div style={{ fontWeight: 500 }}>Community notifications</div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                  Show an unread-message count beside Community in the sidebar
                </div>
              </div>
              <div
                className={`toggle ${chatNotify ? 'on' : ''}`}
                onClick={() => onChatNotifyChange(!chatNotify)}
              ></div>
            </div>

            <div className="settings-row" style={{ border: 'none' }}>
              <div>
                <div style={{ fontWeight: 500 }}>Show Community page</div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                  Hide the community chat entirely if you prefer no interaction
                </div>
              </div>
              <div
                className={`toggle ${chatShow ? 'on' : ''}`}
                onClick={() => onChatShowChange(!chatShow)}
              ></div>
            </div>
          </div>
        </div>

        {/* ── RIGHT: Verify & Repair + Node Statistics + About ── */}
        <div className="connections-right">
          {/* ── Verify & Repair Library (task 145) ──
              Same size-against-the-signed-list check that already runs quietly at
              startup, but on demand, watchable, stoppable, and with a one-press
              repair for whatever it finds. Wording is deliberately plain: the
              people running these nodes are volunteers, not engineers. */}
          <div className="seed-card">
            <h3>Verify &amp; Repair Library</h3>
            <p style={{ marginBottom: '8px' }}>
              This checks that every sermon you are hosting is complete and undamaged.
              A file can end up part-written after a power cut, a dropped connection or
              a disk problem, and it then stops being useful to anyone downloading from you.
            </p>
            <p style={{ ...summaryLineStyle, marginBottom: '16px' }}>
              Finding a few damaged sermons is normal and they can be put right. Nothing is
              ever deleted — repairing only fetches back the parts that are missing. You can
              stop the check at any time and carry on using the app while it runs.
            </p>

            <div className="settings-row" style={{ border: 'none' }}>
              <div>
                <div style={{ fontWeight: 500 }}>Check my sermons</div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                  Looks at every sermon in your download folder. Large libraries can take a
                  few minutes.
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <button
                  onClick={handleVerifyLibrary}
                  disabled={verify?.status === 'running'}
                  title="Check that every sermon you are hosting is complete"
                  style={{
                    ...setButtonStyle,
                    cursor: verify?.status === 'running' ? 'default' : 'pointer',
                    opacity: verify?.status === 'running' ? 0.5 : 1,
                    whiteSpace: 'nowrap',
                  }}
                >
                  {verify?.status === 'running' ? 'Checking…' : 'Check now'}
                </button>
                {verify?.status === 'running' && (
                  <button
                    onClick={() => { cancelVerifyRef.current = true; }}
                    title="Stop checking"
                    style={{
                      ...setButtonStyle,
                      color: 'var(--text-secondary)',
                      cursor: 'pointer',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    Stop
                  </button>
                )}
              </div>
            </div>

            {verify?.status === 'running' && (
              <div style={{ marginTop: '4px' }}>
                <div style={{
                  height: '6px', width: '100%', background: 'var(--bg-tertiary)',
                  border: '1px solid var(--border)', borderRadius: '4px', overflow: 'hidden',
                }}>
                  <div style={{
                    height: '100%', width: `${verifyPct}%`,
                    background: 'var(--gold)', transition: 'width 0.2s',
                  }} />
                </div>
                <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginTop: '6px' }}>
                  {verify.total > 0
                    ? `Checking ${fmtCount(verify.done)} of ${fmtCount(verify.total)}…`
                    : 'Looking through your sermon folder…'}
                </div>
              </div>
            )}

            {(verify?.status === 'done' || verify?.status === 'stopped') && (
              <div style={{ marginTop: '4px', fontSize: '0.8rem', color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                {verify.total === 0 ? (
                  <div>You have not downloaded any sermons yet, so there is nothing to check.</div>
                ) : (
                  <>
                    <div>
                      {verify.status === 'stopped'
                        ? `Stopped early. Of ${fmtCount(verify.total)} sermons, ${fmtCount(verify.checked)} were looked at before you stopped.`
                        : `Checked ${fmtCount(verify.total)} sermon${verify.total === 1 ? '' : 's'}.`}
                    </div>
                    <div style={{ marginTop: '4px' }}>
                      <span style={{ color: 'var(--green)', fontWeight: 600 }}>
                        {fmtCount(verify.complete)} complete
                      </span>
                      {verify.damaged > 0 && (
                        <>
                          {' · '}
                          <span style={{ color: 'var(--orange)', fontWeight: 600 }}>
                            {fmtCount(verify.damaged)} damaged
                          </span>
                        </>
                      )}
                      {verify.missing > 0 && (
                        <>
                          {' · '}
                          <span style={{ color: 'var(--orange)', fontWeight: 600 }}>
                            {fmtCount(verify.missing)} no longer in your folder
                          </span>
                        </>
                      )}
                    </div>
                    {verify.unchecked > 0 && (
                      <div style={{ color: 'var(--text-muted)', marginTop: '4px' }}>
                        {fmtCount(verify.unchecked)} could not be checked this time and have been
                        left exactly as they are.
                      </div>
                    )}
                    {repairableCount === 0 && verify.status === 'done' && (
                      <div style={{ color: 'var(--text-muted)', marginTop: '6px' }}>
                        Everything is in good order. Nothing needs repairing.
                      </div>
                    )}
                    {repairableCount > 0 && !repair && (
                      <div style={{ marginTop: '10px', display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                        <button
                          onClick={handleRepairLibrary}
                          title="Fetch back the missing parts of these sermons"
                          style={{ ...setButtonStyle, cursor: 'pointer', whiteSpace: 'nowrap' }}
                        >
                          Repair {fmtCount(repairableCount)} sermon{repairableCount === 1 ? '' : 's'}
                        </button>
                        <span style={{ fontSize: '0.76rem', color: 'var(--text-muted)' }}>
                          Only the missing parts are fetched, so this is usually far quicker
                          than downloading them again.
                        </span>
                      </div>
                    )}
                    {repair?.status === 'starting' && (
                      <div style={{ color: 'var(--text-muted)', marginTop: '10px' }}>
                        Starting the repair…
                      </div>
                    )}
                    {repair?.status === 'started' && (
                      <div style={{ color: 'var(--green)', marginTop: '10px' }}>
                        Repair started for {fmtCount(repair.count)} sermon{repair.count === 1 ? '' : 's'}.
                        It carries on quietly in the background, so you can keep using the app or
                        close this page. Run the check again later to confirm they are all complete.
                      </div>
                    )}
                    {repair?.status === 'failed' && (
                      <div style={{ color: 'var(--text-muted)', marginTop: '10px' }}>
                        The repair could not be started just now. Please try again in a moment.
                      </div>
                    )}
                  </>
                )}
              </div>
            )}

            {verify?.status === 'unavailable' && (
              <div style={{ marginTop: '4px', fontSize: '0.8rem', color: 'var(--text-muted)', lineHeight: 1.6 }}>
                Your sermons could not be checked just now, so nothing has been changed.
                Please try again in a moment.
              </div>
            )}
          </div>

          <div className="seed-card">
            <h3>Node Statistics</h3>
            <div className="settings-row">
              <span style={{ color: 'var(--text-muted)' }}>Peers Connected</span>
              <span style={{ color: 'var(--gold-text)', fontWeight: 600 }}>{nodeStats.peersConnected}</span>
            </div>
            <div className="settings-row">
              <span style={{ color: 'var(--text-muted)' }}>Files Shared</span>
              <span>{nodeStats.filesShared}</span>
            </div>
            <div className="settings-row" style={{ border: 'none' }}>
              <span style={{ color: 'var(--text-muted)' }}>Storage Used</span>
              <span>{nodeStats.storageUsed}</span>
            </div>
          </div>

          <div className="seed-card">
            <h3>About</h3>
            <div className="settings-row">
              <span style={{ color: 'var(--text-muted)' }}>Version</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                <span>{version ? `v${version}` : '—'}</span>

                {/* Idle → plain button. Every other state below is local-only,
                    so leaving Settings and returning shows this again. */}
                {(!updateCheck || updateCheck.status === 'checking') && (
                  <button
                    onClick={handleCheckForUpdate}
                    disabled={updateCheck?.status === 'checking'}
                    style={{ fontSize: '0.78rem', fontWeight: 600, color: 'var(--text-secondary)', background: 'var(--bg-tertiary)', border: '1px solid var(--border)', borderRadius: '6px', padding: '6px 12px', cursor: updateCheck?.status === 'checking' ? 'default' : 'pointer', whiteSpace: 'nowrap' }}
                  >
                    {updateCheck?.status === 'checking' ? 'Checking…' : 'Check for update'}
                  </button>
                )}

                {updateCheck?.status === 'latest' && (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '0.78rem', fontWeight: 600, color: 'var(--green)' }}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                    You&rsquo;re on the latest version
                  </span>
                )}

                {updateCheck?.status === 'available' && (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                    <span style={{ fontSize: '0.78rem', fontWeight: 600, color: 'var(--gold-text)' }}>
                      Version {updateCheck.version} is available
                    </span>
                    <button
                      onClick={handleInstallUpdate}
                      disabled={installing}
                      style={{ fontSize: '0.78rem', fontWeight: 600, color: 'var(--gold-text)', background: 'var(--bg-tertiary)', border: '1px solid var(--border)', borderRadius: '6px', padding: '6px 12px', cursor: installing ? 'default' : 'pointer', whiteSpace: 'nowrap' }}
                    >
                      {installing ? 'Installing…' : 'Install now'}
                    </button>
                  </span>
                )}

                {/* Dev builds are unsigned and unpublished, so there is genuinely
                    nothing to check — say that rather than sitting silent. */}
                {(updateCheck?.status === 'dev' || updateCheck?.status === 'error') && (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                    <span style={{ fontSize: '0.76rem', color: 'var(--text-muted)', maxWidth: '260px', textAlign: 'right' }}>
                      {updateCheck.status === 'dev'
                        ? updateCheck.message
                        : `Couldn't check for updates — ${updateCheck.message}`}
                    </span>
                    <button
                      onClick={handleCheckForUpdate}
                      style={{ fontSize: '0.78rem', fontWeight: 600, color: 'var(--text-secondary)', background: 'var(--bg-tertiary)', border: '1px solid var(--border)', borderRadius: '6px', padding: '6px 12px', cursor: 'pointer', whiteSpace: 'nowrap' }}
                    >
                      Try again
                    </button>
                  </span>
                )}
              </div>
            </div>
            {(onNavigate || onShowConditions) && (
              <div className="settings-row" style={{ gap: '8px', flexWrap: 'wrap' }}>
                {onNavigate && (
                  <button
                    onClick={() => onNavigate('about')}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '0.78rem', fontWeight: 600, color: 'var(--gold-text)', background: 'var(--bg-tertiary)', border: '1px solid var(--border)', borderRadius: '6px', padding: '7px 12px', cursor: 'pointer' }}
                  >
                    About &amp; Vision
                  </button>
                )}
                {onShowConditions && (
                  <button
                    onClick={onShowConditions}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '0.78rem', fontWeight: 600, color: 'var(--text-secondary)', background: 'var(--bg-tertiary)', border: '1px solid var(--border)', borderRadius: '6px', padding: '7px 12px', cursor: 'pointer' }}
                  >
                    Copying Permissions &amp; Conditions
                  </button>
                )}
              </div>
            )}
            <div className="settings-row">
              <span style={{ color: 'var(--text-muted)' }}>Content Source Mode</span>
              <span>{contentMode === 'cdn' ? 'Archive.org + CDN' : contentMode === 'p2p-primary' ? 'P2P Primary' : 'P2P Only'}</span>
            </div>
            <div className="settings-row">
              <span style={{ color: 'var(--text-muted)' }}>P2P Status</span>
              <span style={{ color: p2pRunning ? '#4caf50' : 'var(--text-muted)' }}>
                {p2pRunning ? 'Running' : p2pEnabled ? 'Starting...' : 'Disabled'}
              </span>
            </div>
            {nodeId && (
              <div className="settings-row" style={{ border: 'none', flexDirection: 'column', alignItems: 'flex-start', gap: '6px' }}>
                <span style={{ color: 'var(--text-muted)', fontSize: '0.82rem' }}>Node ID</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', width: '100%' }}>
                  <code style={{
                    fontSize: '0.72rem', fontFamily: 'monospace', color: 'var(--text-secondary)',
                    background: 'var(--bg-primary)', padding: '6px 10px', borderRadius: '6px',
                    border: '1px solid var(--border)', flex: 1, wordBreak: 'break-all',
                    overflowWrap: 'anywhere', userSelect: 'all',
                  }}>
                    {nodeId}
                  </code>
                  <button
                    onClick={copyNodeId}
                    style={{
                      fontSize: '0.7rem', color: copiedNodeId ? 'var(--green)' : 'var(--text-muted)', background: 'none',
                      border: `1px solid ${copiedNodeId ? 'var(--green)' : 'var(--border)'}`, borderRadius: '4px', padding: '4px 10px',
                      cursor: 'pointer', flexShrink: 0, minWidth: '58px',
                    }}
                    title="Copy Node ID"
                  >
                    {copiedNodeId ? 'Copied!' : 'Copy'}
                  </button>
                </div>
              </div>
            )}
          </div>

          <div className="seed-card" style={{ background: 'rgba(212,175,55,0.04)', border: '1px solid rgba(212,175,55,0.15)' }}>
            <h3 style={{ color: 'var(--gold-text)' }}>Network Layers</h3>
            <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginBottom: '12px' }}>
              Your node uses standard BitTorrent connectivity for maximum reachability:
            </p>
            <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', lineHeight: 1.8 }}>
              <div>1. TCP — direct peer connections</div>
              <div>2. Mainline DHT — trackerless peer discovery (millions of nodes)</div>
              <div>3. Public Trackers — secondary peer discovery</div>
              <div>4. UPnP — automatic router port forwarding</div>
            </div>
            <p style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: '12px' }}>
              See the Connections page for live status of each layer. Seeded sermons can also
              be shared with any standard torrent client.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
