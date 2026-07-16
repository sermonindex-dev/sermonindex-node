import React, { useState, useEffect, useCallback, useRef } from 'react';

// Persisted "snooze" for a dismissed update: { version, until: <epoch ms> }.
// Updating matters, so a dismissal is never permanent — the banner returns ~24h
// later (and on any relaunch past that window) until the user actually updates.
const DISMISS_KEY = 'si-update-dismissed-until';
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_TIMEOUT = 2147483647; // 32-bit setTimeout ceiling (~24.8d); clamp & re-arm beyond it

function readDismissal() {
  try {
    const raw = localStorage.getItem(DISMISS_KEY);
    if (!raw) return null;
    const d = JSON.parse(raw);
    if (!d || typeof d.version !== 'string' || typeof d.until !== 'number') return null;
    return d;
  } catch {
    return null; // corrupt JSON or storage unavailable — treat as no snooze
  }
}

function writeDismissal(version, until) {
  try {
    localStorage.setItem(DISMISS_KEY, JSON.stringify({ version, until }));
  } catch {
    /* storage full/unavailable — snooze just won't persist across relaunch */
  }
}

/**
 * One-click update alert (mounted once, inline in the Sidebar directly above the
 * scripture/announcement + "Local Node Online" status box).
 *
 * Listens for the 'si-update-available' event fired by updater.js in "prompt"
 * mode. Renders an inline banner that BLENDS with the olive sidebar (gold theme
 * tokens) but reads as an important alert: a gold accent bar + a soft attention
 * pulse, an up-arrow icon, and the wording "Click to update to vX". Clicking
 * anywhere on the banner runs the provided install() — which downloads,
 * installs, and relaunches the app in place (no reinstall; ~/.sermonindex data
 * is kept). A small ✕ dismisses it (snoozes ~24h; the dismissal logic below is
 * unchanged). Pass `inline` (the Sidebar does) for the sidebar-width margins.
 */
const iconUpCircle = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="9" />
    <path d="M12 16.5V8" />
    <path d="M8.5 11.5 12 8l3.5 3.5" />
  </svg>
);

const iconRefresh = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="23 4 23 10 17 10" />
    <polyline points="1 20 1 14 7 14" />
    <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
  </svg>
);

const iconClose = (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="18" y1="6" x2="6" y2="18" />
    <line x1="6" y1="6" x2="18" y2="18" />
  </svg>
);

export default function UpdatePrompt({ inline = false }) {
  const [update, setUpdate] = useState(null); // { version, notes, install } — latest known update
  const [visible, setVisible] = useState(false); // whether the banner is currently shown
  const [state, setState] = useState('idle');  // idle | working | error
  const timerRef = useRef(null); // pending "re-show after snooze" timeout id

  const clearTimer = useCallback(() => {
    if (timerRef.current != null) { clearTimeout(timerRef.current); timerRef.current = null; }
  }, []);

  // Re-show the banner at `until` (epoch ms). Clamps very large delays and
  // re-arms so it still fires at the right moment past setTimeout's 32-bit max.
  const scheduleReshow = useCallback((until) => {
    clearTimer();
    const tick = () => {
      const remaining = until - Date.now();
      if (remaining <= 0) { timerRef.current = null; setVisible(true); return; }
      timerRef.current = setTimeout(tick, Math.min(remaining, MAX_TIMEOUT));
    };
    tick();
  }, [clearTimer]);

  // si-update-available fires repeatedly (updater re-checks ~every 6h, and once
  // per new version per run). Show the banner unless THIS version is still under
  // an active snooze; a newer version resets the nag, and an older/mismatched
  // snooze is ignored.
  useEffect(() => {
    const onAvailable = (e) => {
      const detail = e.detail;
      setUpdate(detail);
      setState('idle');
      const d = readDismissal();
      if (d && d.version === detail.version && Date.now() < d.until) {
        setVisible(false);       // still snoozed for this version…
        scheduleReshow(d.until); // …reappear exactly when the snooze expires
      } else {
        clearTimer();            // no snooze / expired / older version → show now
        setVisible(true);
      }
    };
    window.addEventListener('si-update-available', onAvailable);
    return () => window.removeEventListener('si-update-available', onAvailable);
  }, [scheduleReshow, clearTimer]);

  // On mount, honor a still-active snooze so the banner reappears when it
  // expires even without a fresh event; clear any pending timer on unmount.
  useEffect(() => {
    const d = readDismissal();
    if (d && Date.now() < d.until) scheduleReshow(d.until);
    return clearTimer;
  }, [scheduleReshow, clearTimer]);

  const doUpdate = useCallback(async () => {
    if (!update?.install) return;
    setState('working');
    try {
      await update.install(); // downloads, installs, then relaunches (won't return)
    } catch (e) {
      console.warn('[UpdatePrompt] Update failed:', e?.message || e);
      setState('error');
    }
  }, [update]);

  if (!update || !visible) return null;

  const working = state === 'working';
  const error = state === 'error';
  const label = working
    ? 'Updating…'
    : error
    ? 'Update failed — click to retry'
    : `Click to update to v${update.version}`;

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={working ? 'Updating' : error ? 'Update failed — click to retry' : `Click to update to version ${update.version}`}
      title={update.notes ? String(update.notes).slice(0, 160) : `Update to v${update.version} — installs and restarts in place`}
      className={`si-update-alert${inline ? ' si-update-alert--sidebar' : ''}${working ? ' is-working' : ''}`}
      onClick={working ? undefined : doUpdate}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return; // let the ✕ button handle its own keys
        if (!working && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); doUpdate(); }
      }}
    >
      {/* Up-arrow (idle) / spinning refresh (working, error) — gold accent */}
      <span
        className={working ? 'si-update-alert__spin' : undefined}
        style={{ display: 'inline-flex', flexShrink: 0, color: error ? 'var(--orange, #b85c00)' : 'var(--gold, #D4AF37)' }}
      >
        {working || error ? iconRefresh : iconUpCircle}
      </span>
      <span
        style={{
          flex: 1, minWidth: 0,
          fontSize: '0.78rem', fontWeight: 600, lineHeight: 1.35,
          color: error ? 'var(--orange, #b85c00)' : 'var(--sidebar-text, #F8F8F2)',
        }}
      >
        {label}
      </span>
      {!working && (
        <button
          type="button"
          aria-label="Dismiss update"
          onClick={(e) => {
            e.stopPropagation();
            const until = Date.now() + DAY_MS;
            writeDismissal(update.version, until); // persist per-version snooze
            setVisible(false);                     // hide now…
            scheduleReshow(until);                 // …but nudge again in ~24h
          }}
          style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: 20, height: 20, padding: 0, flexShrink: 0,
            border: 'none', background: 'transparent', borderRadius: 6,
            color: 'var(--sidebar-muted, rgba(248,248,242,0.55))', cursor: 'pointer',
          }}
        >
          {iconClose}
        </button>
      )}
    </div>
  );
}
