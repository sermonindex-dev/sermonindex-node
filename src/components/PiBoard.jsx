import React from 'react';

/**
 * PiBoard — a hand-drawn single-board computer, for the Seed Node page hero.
 *
 * Inline SVG rather than an asset: it costs nothing to ship, stays sharp at any
 * size, and — the reason that actually matters — it is drawn in `currentColor`
 * and the app's own theme tokens, so it re-themes itself in dark mode instead of
 * sitting there as a pale rectangle the way a PNG would.
 *
 * It is a generic board, not a photograph of any particular product: a
 * rectangle, a 40-pin header, a chip, ports and mounting holes. That is enough
 * for anyone to read "a small computer you leave switched on", which is the
 * whole job, and it keeps the page from looking like an endorsement.
 *
 * Decorative by default — `aria-hidden` unless a label is passed — because a
 * screen reader announcing "illustration of a circuit board" before the actual
 * heading helps nobody.
 */
export default function PiBoard({ size = 92, label = null, style = {} }) {
  const traces = 'var(--gold-text)';
  const board = 'var(--bg-tertiary)';
  const edge = 'var(--border-light, var(--border))';

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 120 120"
      fill="none"
      role={label ? 'img' : undefined}
      aria-label={label || undefined}
      aria-hidden={label ? undefined : true}
      style={{ display: 'block', flexShrink: 0, ...style }}
    >
      {/* Faint circuit traces running off the board, so it sits in a context
          rather than floating. Drawn first, under everything. */}
      <g stroke={traces} strokeWidth="1" opacity="0.28" strokeLinecap="round">
        <path d="M2 30h14M2 46h20M2 74h16M2 90h24" />
        <path d="M118 36h-18M118 58h-14M118 82h-22" />
        <circle cx="4" cy="30" r="1.6" fill={traces} stroke="none" />
        <circle cx="4" cy="74" r="1.6" fill={traces} stroke="none" />
        <circle cx="116" cy="58" r="1.6" fill={traces} stroke="none" />
      </g>

      {/* Board */}
      <rect x="16" y="22" width="88" height="76" rx="6" fill={board} stroke={edge} strokeWidth="1.5" />

      {/* Mounting holes */}
      <g fill="none" stroke={edge} strokeWidth="1.3">
        <circle cx="25" cy="31" r="2.6" />
        <circle cx="95" cy="31" r="2.6" />
        <circle cx="25" cy="89" r="2.6" />
        <circle cx="95" cy="89" r="2.6" />
      </g>

      {/* 40-pin GPIO header — two rows, the silhouette everyone recognises */}
      <g fill={traces} opacity="0.9">
        {Array.from({ length: 20 }, (_, i) => (
          <React.Fragment key={i}>
            <rect x={31 + i * 3.1} y="38" width="1.7" height="1.7" rx="0.4" />
            <rect x={31 + i * 3.1} y="41.4" width="1.7" height="1.7" rx="0.4" />
          </React.Fragment>
        ))}
      </g>
      <rect x="29.5" y="36.5" width="63" height="8.5" rx="1.5" fill="none" stroke={traces} strokeWidth="0.9" opacity="0.55" />

      {/* SoC — the square in the middle, with a highlight so it reads as a chip
          sitting on the board rather than a hole cut in it */}
      <rect x="47" y="55" width="26" height="26" rx="3" fill={traces} opacity="0.16" />
      <rect x="47" y="55" width="26" height="26" rx="3" fill="none" stroke={traces} strokeWidth="1.4" />
      <path d="M50 58h8" stroke={traces} strokeWidth="1.2" strokeLinecap="round" opacity="0.7" />

      {/* Traces leaving the chip */}
      <g stroke={traces} strokeWidth="1" opacity="0.45" strokeLinecap="round">
        <path d="M47 62h-9v-14" />
        <path d="M47 74h-12v12" />
        <path d="M73 62h9v-9" />
        <path d="M73 74h11v10" />
      </g>

      {/* Ports along the bottom edge */}
      <g fill="none" stroke={edge} strokeWidth="1.3">
        <rect x="26" y="86" width="15" height="7" rx="1.5" />
        <rect x="46" y="86" width="15" height="7" rx="1.5" />
        <rect x="66" y="88" width="10" height="5" rx="1.2" />
      </g>

      {/* Power light. The one warm spot in the drawing, and the only part that
          says "this is switched on and doing something" — which is the whole
          idea being illustrated. */}
      <circle cx="88" cy="63" r="3.4" fill="var(--green)" opacity="0.22" />
      <circle cx="88" cy="63" r="1.9" fill="var(--green)" />
    </svg>
  );
}
