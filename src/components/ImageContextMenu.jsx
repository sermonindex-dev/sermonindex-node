import React, { useState, useEffect, useCallback } from 'react';

/**
 * Single app-level context menu for images (mounted once in App).
 *
 * SpeakerAvatar suppresses the native macOS WebView menu (which offered
 * "Open Image", "Copy Image", "Copy Subject" — none useful here) and instead
 * dispatches a `si-image-menu` window event. This component renders one small
 * menu with just "Download image". Centralizing it avoids many per-avatar menus
 * and keeps only one open at a time.
 */
async function saveImage(url, filename) {
  // Blob download works reliably for same-origin images — which, once the
  // portraits are bundled into the app, is the common case. Falls back to a
  // direct anchor for anything the fetch can't read (e.g. a cross-origin CDN
  // image without CORS headers).
  try {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
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
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.target = '_blank';
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
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
  const [menu, setMenu] = useState(null); // { x, y, src, name }

  useEffect(() => {
    const onOpen = (e) => setMenu(e.detail);
    window.addEventListener('si-image-menu', onOpen);
    return () => window.removeEventListener('si-image-menu', onOpen);
  }, []);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    // Defer attaching so the opening event doesn't immediately close it.
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

  const download = useCallback(() => {
    if (!menu) return;
    const src = menu.src;
    const safe = (menu.name || 'speaker')
      .replace(/[^a-z0-9]+/gi, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase() || 'speaker';
    const ext = src.startsWith('data:')
      ? 'png'
      : ((src.split('?')[0].split('.').pop() || 'png').slice(0, 4));
    saveImage(src, `${safe}.${ext}`);
    setMenu(null);
  }, [menu]);

  if (!menu) return null;

  // Keep the menu on-screen near the right/bottom edges.
  const left = Math.min(menu.x, (typeof window !== 'undefined' ? window.innerWidth : 9999) - 180);
  const top = Math.min(menu.y, (typeof window !== 'undefined' ? window.innerHeight : 9999) - 60);

  return (
    <div
      role="menu"
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}
      style={{
        position: 'fixed',
        left,
        top,
        zIndex: 10000,
        background: 'var(--bg-secondary, #ffffff)',
        border: '1px solid var(--border, #e0e0e0)',
        borderRadius: 8,
        boxShadow: '0 6px 22px rgba(0,0,0,0.18)',
        padding: 4,
        minWidth: 160,
      }}
    >
      <button
        type="button"
        onClick={download}
        style={{
          display: 'flex', alignItems: 'center', gap: 8, width: '100%',
          padding: '8px 10px', background: 'none', border: 'none', cursor: 'pointer',
          fontSize: '0.8rem', color: 'var(--text-primary, #222)', borderRadius: 6,
          textAlign: 'left', fontFamily: 'var(--font, inherit)',
        }}
        onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-tertiary, #f0f0f0)'; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = 'none'; }}
      >
        {iconDownload} Download image
      </button>
    </div>
  );
}
