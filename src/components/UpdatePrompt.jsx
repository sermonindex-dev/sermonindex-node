import React, { useState, useEffect, useCallback } from 'react';

/**
 * One-click update prompt (mounted once in App).
 *
 * Listens for the 'si-update-available' event fired by updater.js in "prompt"
 * mode. Shows a small card bottom-left with the new version and an Update
 * button. Clicking it runs the provided install() — which downloads, installs,
 * and relaunches the app in place (no reinstall; ~/.sermonindex data is kept).
 */
const iconDownload = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <polyline points="7 10 12 15 17 10" />
    <line x1="12" y1="15" x2="12" y2="3" />
  </svg>
);

export default function UpdatePrompt() {
  const [update, setUpdate] = useState(null); // { version, notes, install }
  const [state, setState] = useState('idle');  // idle | working | error

  useEffect(() => {
    const onAvailable = (e) => {
      setUpdate(e.detail);
      setState('idle');
    };
    window.addEventListener('si-update-available', onAvailable);
    return () => window.removeEventListener('si-update-available', onAvailable);
  }, []);

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

  if (!update) return null;

  return (
    <div
      style={{
        position: 'fixed', left: 16, bottom: 16, zIndex: 10002, width: 300,
        background: 'var(--bg-secondary, #fff)', border: '1px solid var(--border, #e0e0e0)',
        borderRadius: 10, boxShadow: '0 8px 28px rgba(0,0,0,0.22)', padding: '14px 16px',
        fontFamily: 'var(--font, inherit)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <span style={{ display: 'inline-flex', color: 'var(--gold-text, #8a7a2a)' }}>{iconDownload}</span>
        <strong style={{ fontSize: '0.85rem', color: 'var(--text-primary, #222)' }}>
          Update available — v{update.version}
        </strong>
      </div>
      <p style={{ margin: '0 0 10px', fontSize: '0.76rem', color: 'var(--text-muted, #777)', lineHeight: 1.45 }}>
        {state === 'working'
          ? 'Downloading and installing… the app will restart automatically.'
          : state === 'error'
          ? 'Update failed. It will retry next launch — you can keep using this version.'
          : (update.notes
              ? update.notes.slice(0, 140)
              : 'Installs and restarts in a few seconds. Your downloads and settings are kept.')}
      </p>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        {state !== 'working' && (
          <button
            type="button"
            onClick={() => setUpdate(null)}
            style={{
              padding: '6px 12px', fontSize: '0.76rem', border: 'none', background: 'none',
              color: 'var(--text-muted, #888)', cursor: 'pointer', borderRadius: 6,
            }}
          >
            Later
          </button>
        )}
        <button
          type="button"
          onClick={doUpdate}
          disabled={state === 'working'}
          className="btn btn-gold"
          style={{
            padding: '6px 14px', fontSize: '0.76rem', borderRadius: 6,
            cursor: state === 'working' ? 'default' : 'pointer', opacity: state === 'working' ? 0.7 : 1,
          }}
        >
          {state === 'working' ? 'Updating…' : state === 'error' ? 'Retry' : 'Update now'}
        </button>
      </div>
    </div>
  );
}
