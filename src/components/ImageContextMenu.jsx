import React, { useState, useEffect, useCallback } from 'react';

/**
 * Single app-level context menu for speaker images (mounted once in App).
 *
 * SpeakerAvatar suppresses the native macOS WebView menu (which offered
 * "Open Image", "Copy Image", "Copy Subject" — none useful here) and dispatches
 * a `si-image-menu` window event with { x, y, url, name }. This renders one small
 * menu with "Download image", which saves the portrait NATIVELY (via Rust) into
 * <your downloads folder>/speaker-images/<name>.<ext>. Native saving bypasses the
 * WebView's cross-origin download restrictions, which silently dropped the file.
 */
async function tauriInvoke(cmd, args) {
  const mod = await import('@tauri-apps/api/core');
  return mod.invoke(cmd, args);
}

// Browser fallback (no Tauri) — best-effort blob download.
async function browserSave(url, filename) {
  try {
    const resp = await fetch(url);
    const blob = await resp.blob();
    const objUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = objUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(objUrl), 5000);
  } catch {
    /* nothing else we can safely do */
  }
}

const iconDownload = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <polyline points="7 10 12 15 17 10" />
    <line x1="12" y1="15" x2="12" y2="3" />
  </svg>
);

export default function ImageContextMenu() {
  const [menu, setMenu] = useState(null);   // { x, y, url, name }
  const [toast, setToast] = useState(null); // { msg, ok }

  useEffect(() => {
    const onOpen = (e) => setMenu(e.detail);
    window.addEventListener('si-image-menu', onOpen);
    return () => window.removeEventListener('si-image-menu', onOpen);
  }, []);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    const id = setTimeout(() => {
      window.addEventListener('click', close);
      window.addEventListener('contextmenu', close);
      window.addEventListener('scroll', close, true);
      window.addEventListener('resize', close);
      window.addEventListener('keydown', onKey);
    }, 0);
    return () => {
      clearTimeout(id);
      window.removeEventListener('click', close);
      window.removeEventListener('contextmenu', close);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [menu]);

  const showToast = useCallback((msg, ok) => {
    setToast({ msg, ok });
    setTimeout(() => setToast(null), 3200);
  }, []);

  const download = useCallback(async () => {
    if (!menu?.url) return;
    const { url, name } = menu;
    setMenu(null);
    const safeName = (name || 'speaker')
      .replace(/[^a-z0-9]+/gi, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase() || 'speaker';
    const isTauri = typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__;
    if (isTauri) {
      try {
        const path = await tauriInvoke('download_speaker_image', { url, name: safeName });
        showToast('Saved to speaker-images/', true);
        console.log('[Image] Saved portrait →', path);
      } catch (e) {
        console.warn('[Image] Native save failed:', e);
        showToast('Could not save image', false);
      }
    } else {
      // Plain browser (not the Tauri app) — best-effort blob download.
      await browserSave(url, `${safeName}.png`);
      showToast('Downloaded', true);
    }
  }, [menu, showToast]);

  return (
    <>
      {menu && (() => {
        const left = Math.min(menu.x, (typeof window !== 'undefined' ? window.innerWidth : 9999) - 190);
        const top = Math.min(menu.y, (typeof window !== 'undefined' ? window.innerHeight : 9999) - 60);
        const enabled = !!menu.url;
        return (
          <div
            role="menu"
            onClick={(e) => e.stopPropagation()}
            onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}
            style={{
              position: 'fixed', left, top, zIndex: 10000,
              background: 'var(--bg-secondary, #ffffff)', border: '1px solid var(--border, #e0e0e0)',
              borderRadius: 8, boxShadow: '0 6px 22px rgba(0,0,0,0.18)', padding: 4, minWidth: 170,
            }}
          >
            <button
              type="button"
              onClick={download}
              disabled={!enabled}
              style={{
                display: 'flex', alignItems: 'center', gap: 8, width: '100%',
                padding: '8px 10px', background: 'none', border: 'none',
                cursor: enabled ? 'pointer' : 'default',
                fontSize: '0.8rem', color: enabled ? 'var(--text-primary, #222)' : 'var(--text-muted, #999)',
                borderRadius: 6, textAlign: 'left', fontFamily: 'var(--font, inherit)', opacity: enabled ? 1 : 0.6,
              }}
              onMouseEnter={(e) => { if (enabled) e.currentTarget.style.background = 'var(--bg-tertiary, #f0f0f0)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'none'; }}
            >
              {iconDownload} {enabled ? 'Download image' : 'No image to download'}
            </button>
          </div>
        );
      })()}

      {toast && (
        <div
          style={{
            position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)',
            zIndex: 10001, background: toast.ok ? 'var(--bg-secondary, #fff)' : '#4a1f1f',
            color: toast.ok ? 'var(--text-primary, #222)' : '#ffd7d7',
            border: `1px solid ${toast.ok ? 'var(--border, #ddd)' : '#7a2b2b'}`,
            borderRadius: 8, padding: '9px 16px', fontSize: '0.8rem',
            boxShadow: '0 6px 22px rgba(0,0,0,0.22)', display: 'flex', alignItems: 'center', gap: 8,
          }}
        >
          {toast.ok ? iconDownload : null} {toast.msg}
        </div>
      )}
    </>
  );
}
