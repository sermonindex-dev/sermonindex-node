import React, { useRef, useCallback } from 'react';
import { speakerImageCandidates } from '../services/catalog.js';

/**
 * Inline silhouette placeholder — rendered as SVG MARKUP (not an <img src>), so
 * it appears instantly with zero network and can NEVER show a broken-image icon.
 * Same art as assets/default-speaker.svg.
 */
function DefaultSilhouette() {
  return (
    <svg
      viewBox="0 0 120 120"
      width="100%"
      height="100%"
      preserveAspectRatio="xMidYMid slice"
      style={{ display: 'block' }}
      aria-hidden="true"
    >
      <rect width="120" height="120" fill="#707035" />
      <g fill="#F8F8F2">
        <circle cx="60" cy="46" r="20" />
        <path d="M60 72c-19.9 0-36 13.4-36 30 0 1.1.9 2 2 2h68c1.1 0 2-.9 2-2 0-16.6-16.1-30-36-30z" />
      </g>
    </svg>
  );
}

/**
 * Speaker portrait.
 *
 * The silhouette above is always present as the base layer, so there is never a
 * broken-image flash. A real portrait is layered on top at opacity 0 and only
 * revealed (opacity 1) once it has actually loaded — while it cycles through the
 * candidate URLs (local bundled copy first, then CDN), it stays invisible, so a
 * failing/404 candidate never shows the browser's broken-image icon. If every
 * candidate fails, the portrait <img> hides itself and the silhouette shows.
 *
 * Right-click opens our own tiny menu (just "Download image") instead of the
 * native macOS WebView menu — dispatched to the single app-level ImageContextMenu.
 */
export default function SpeakerAvatar({ speaker, image, className = 'sermon-speaker-avatar' }) {
  const candidates = speakerImageCandidates(speaker, image);
  // A fetchable REMOTE url for the loaded portrait (so the native downloader can
  // save it — it can't read images bundled inside the app). Null until a real
  // portrait loads; a silhouette-only avatar has nothing to download.
  const loadedRemoteRef = useRef(null);

  const onContextMenu = useCallback((e) => {
    e.preventDefault(); // suppress the native "Open/Copy Image/Copy Subject" menu
    window.dispatchEvent(new CustomEvent('si-image-menu', {
      detail: {
        x: e.clientX,
        y: e.clientY,
        url: loadedRemoteRef.current, // null → menu shows Download disabled
        name: speaker || 'speaker',
      },
    }));
  }, [speaker]);

  return (
    <div className={className} style={{ position: 'relative', overflow: 'hidden' }} onContextMenu={onContextMenu}>
      <DefaultSilhouette />
      {candidates.length > 0 && (
        <img
          src={candidates[0]}
          alt=""
          loading="lazy"
          draggable={false}
          data-i="0"
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', opacity: 0, transition: 'opacity 0.25s ease' }}
          onLoad={(e) => {
            // Map whatever loaded (local bundled copy OR CDN) to the canonical
            // remote URL, which the native downloader can actually fetch.
            const shown = e.currentTarget.currentSrc || e.currentTarget.src;
            let remote = shown;
            try {
              const u = new URL(shown, window.location.href);
              if (u.pathname.includes('/images/speakers/')) {
                remote = `https://www.sermonindex.net${u.pathname}`;
              }
            } catch { /* keep shown */ }
            loadedRemoteRef.current = remote;
            e.currentTarget.style.opacity = 1;
          }}
          onError={(e) => {
            const el = e.currentTarget;
            const i = Number(el.dataset.i) + 1;
            if (i < candidates.length) {
              el.dataset.i = String(i);
              el.src = candidates[i];
            } else {
              // All candidates exhausted — hide the (invisible) img; the inline
              // silhouette base shows through. No broken icon, ever.
              el.style.display = 'none';
            }
          }}
        />
      )}
    </div>
  );
}
