import React, { useId, useMemo, useState } from 'react';

/**
 * ConnectivityChart — inbound vs outbound peer connections, day by day.
 *
 * WHY THIS CHART EXISTS
 *
 * Every other peer figure in this app is a single number with no direction in
 * it, and a single number cannot answer the question people running a node
 * actually ask: "am I giving to this network, or only taking from it?" The
 * worry behind that question is real and specific — peers will happily take a
 * sermon and never serve one back — and a total labelled "peers" is exactly the
 * shape of number that hides it.
 *
 * So the two series here are directions, not quantities of the same thing:
 *
 *   INBOUND   a peer opened a connection TO this node. They found us, dialled
 *             us, and took something across a connection we never had to make.
 *             This is the only evidence that we are serving the internet.
 *   OUTBOUND  we dialled them. Proves our egress works and nothing else. A node
 *             with a wall of outbound and no inbound is participating, but it
 *             is not yet a place other people can come to.
 *
 * Reading it: inbound bars growing is the healthy picture. All outbound and no
 * inbound means the port is closed — which is honest, common and fine, and the
 * Connections page explains what can and cannot be done about it.
 *
 * DESIGN NOTES (why it looks the way it does)
 *
 * Grouped bars, not stacked. Stacking would imply the two add up to a
 * meaningful total; they do not — they are two different facts about the same
 * day, and the comparison between them IS the message.
 *
 * One axis. Both series are counts of peers, so one scale is honest. (Bytes
 * belong on a separate chart, never on a second y-axis here.)
 *
 * Colour. The app's own green/gold pair fails colour-blind separation badly
 * (ΔE 3.1 under protanopia — effectively identical), so this chart does NOT
 * reuse it. The blue/gold pair below is validated in both light and dark mode:
 * every check passes, including the normal-vision floor and CVD separation.
 * Identity is never carried by colour alone — every series is named in the
 * legend, the hovered day names both, and the table view drops colour entirely.
 */

// Validated categorical pair. Light and dark are separately stepped for their
// own surface — not an automatic flip of one another.
const SERIES = {
  in: { light: '#2a78d6', dark: '#3987e5', label: 'Came to you' },
  out: { light: '#a97400', dark: '#c98500', label: 'You reached out' },
};

const H = 150;          // plot height
const PAD_T = 12;
const PAD_B = 4;        // the day labels live in HTML below, not in here
const GAP = 2;          // surface gap between the two bars of a day (spec: 2px)
const R = 4;            // rounded data-end radius (spec: 4px, baseline-anchored)

/**
 * A bar with only its top corners rounded, anchored to the baseline.
 * Drawn as a path rather than <rect rx> so the bottom stays square against the
 * axis — a rounded foot reads as a floating object rather than a measurement.
 */
function barPath(x, y, w, h) {
  const r = Math.min(R, w / 2, h);
  if (h <= 0) return '';
  return `M${x},${y + h} L${x},${y + r} Q${x},${y} ${x + r},${y} `
       + `L${x + w - r},${y} Q${x + w},${y} ${x + w},${y + r} L${x + w},${y + h} Z`;
}

export default function ConnectivityChart({ days = [], mode = 'light' }) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '');
  const [hover, setHover] = useState(null);
  const [asTable, setAsTable] = useState(false);

  const cIn = SERIES.in[mode] || SERIES.in.light;
  const cOut = SERIES.out[mode] || SERIES.out.light;

  const rows = useMemo(
    () => days.map(d => ({
      d: d.d,
      label: d.label || d.d,
      inb: Math.max(0, Number(d.inb) || 0),
      out: Math.max(0, Number(d.out) || 0),
    })),
    [days]
  );

  const totals = useMemo(() => rows.reduce(
    (a, r) => ({ inb: a.inb + r.inb, out: a.out + r.out }),
    { inb: 0, out: 0 }
  ), [rows]);

  if (!rows.length) {
    return (
      <div style={empty}>
        No record yet — this fills in as your node runs. Come back tomorrow.
      </div>
    );
  }

  // One scale for both series (never two y-axes). A floor of 1 keeps an
  // all-zero week from dividing by zero and from drawing full-height bars.
  const max = Math.max(1, ...rows.map(r => Math.max(r.inb, r.out)));
  const W = 100; // viewBox units; the SVG scales to its container
  const slot = W / rows.length;
  const barW = Math.max(1.5, (slot - 4) / 2 - GAP / 2);
  const plotH = H - PAD_T - PAD_B;
  const scale = v => (v / max) * plotH;

  // The sentence the whole chart exists to produce.
  const verdict = totals.inb === 0
    ? 'Nobody has reached you directly yet this week — every connection was one you made.'
    : totals.inb >= totals.out
      ? 'More peers came to you than you reached out to. Your node is a place others can find.'
      : 'You reached out more often than peers came to you — normal when your port is closed.';

  return (
    <div>
      <div style={legendRow}>
        <div style={{ display: 'flex', gap: '14px', flexWrap: 'wrap' }}>
          <Key color={cIn} label={SERIES.in.label} value={totals.inb} />
          <Key color={cOut} label={SERIES.out.label} value={totals.out} />
        </div>
        <button
          type="button"
          onClick={() => setAsTable(v => !v)}
          style={tableToggle}
          aria-pressed={asTable}
        >
          {asTable ? 'Show chart' : 'Show numbers'}
        </button>
      </div>

      {asTable ? (
        <table style={table}>
          <thead>
            <tr>
              <th style={th}>Day</th>
              <th style={{ ...th, textAlign: 'right' }}>{SERIES.in.label}</th>
              <th style={{ ...th, textAlign: 'right' }}>{SERIES.out.label}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.d}>
                <td style={td}>{r.label}</td>
                <td style={{ ...td, textAlign: 'right' }}>{r.inb.toLocaleString()}</td>
                <td style={{ ...td, textAlign: 'right' }}>{r.out.toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div style={{ position: 'relative' }}>
          <svg
            viewBox={`0 0 ${W} ${H}`}
            preserveAspectRatio="none"
            style={{ width: '100%', height: `${H}px`, display: 'block', overflow: 'visible' }}
            role="img"
            aria-label={`Peer connections by day. ${verdict}`}
          >
            {/* Recessive baseline only — no grid. With at most seven bars per
                series the eye compares heights directly and gridlines are noise. */}
            <line
              x1="0" y1={PAD_T + plotH} x2={W} y2={PAD_T + plotH}
              stroke="var(--border)" strokeWidth="0.4" vectorEffect="non-scaling-stroke"
            />
            {rows.map((r, i) => {
              const x0 = i * slot + 2;
              const hIn = scale(r.inb);
              const hOut = scale(r.out);
              const on = hover === i;
              return (
                <g key={r.d}>
                  {/* Hit target spans the whole day slot, not just the bars —
                      a 3px-wide bar is not something anyone can point at. */}
                  <rect
                    x={i * slot} y={0} width={slot} height={H}
                    fill="transparent"
                    onMouseEnter={() => setHover(i)}
                    onMouseLeave={() => setHover(null)}
                  />
                  {on && (
                    <rect
                      x={i * slot} y={0} width={slot} height={PAD_T + plotH}
                      fill="var(--bg-hover)" opacity="0.55" pointerEvents="none"
                    />
                  )}
                  <path
                    d={barPath(x0, PAD_T + plotH - hIn, barW, hIn)}
                    fill={cIn} pointerEvents="none"
                  />
                  <path
                    d={barPath(x0 + barW + GAP, PAD_T + plotH - hOut, barW, hOut)}
                    fill={cOut} pointerEvents="none"
                  />
                </g>
              );
            })}
          </svg>

          {/* Day labels in HTML, NOT inside the <svg>.
              The plot uses preserveAspectRatio="none" so the bars stretch to
              whatever width the card is — which is right for bars and fatal for
              text, because the same transform stretches every glyph with them.
              A flex row of equal-width cells lines up with the bar slots exactly
              and renders at the real font. */}
          <div style={{ display: 'flex', marginTop: '4px' }}>
            {rows.map((r, i) => (
              <div
                key={r.d}
                style={{
                  flex: 1,
                  textAlign: 'center',
                  fontSize: '0.66rem',
                  whiteSpace: 'nowrap',
                  color: hover === i ? 'var(--text-primary)' : 'var(--text-muted)',
                  fontWeight: hover === i ? 600 : 400,
                }}
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(null)}
              >
                {r.label}
              </div>
            ))}
          </div>

          {/* Tooltip. Positioned in DOM rather than SVG so the text is not
              stretched by preserveAspectRatio="none". */}
          {hover != null && (
            <div style={{
              ...tip,
              left: `${((hover + 0.5) / rows.length) * 100}%`,
              transform: `translateX(${hover < rows.length / 2 ? '-10%' : '-90%'})`,
            }}>
              <div style={{ fontWeight: 700, marginBottom: '4px', color: 'var(--text-primary)' }}>
                {rows[hover].label}
              </div>
              <TipRow color={cIn} label={SERIES.in.label} value={rows[hover].inb} />
              <TipRow color={cOut} label={SERIES.out.label} value={rows[hover].out} />
            </div>
          )}
        </div>
      )}

      <p style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', margin: '12px 0 0', lineHeight: 1.55 }}>
        {verdict}
      </p>
    </div>
  );
}

function Key({ color, label, value }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '0.78rem' }}>
      <span style={{ width: '10px', height: '10px', borderRadius: '3px', background: color, flexShrink: 0 }} />
      {/* Text wears text tokens — never the series colour. The swatch carries
          identity; the label carries meaning. */}
      <span style={{ color: 'var(--text-secondary)' }}>{label}</span>
      <strong style={{ color: 'var(--text-primary)' }}>{value.toLocaleString()}</strong>
    </span>
  );
}

function TipRow({ color, label, value }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.75rem', whiteSpace: 'nowrap' }}>
      <span style={{ width: '8px', height: '8px', borderRadius: '2px', background: color, flexShrink: 0 }} />
      <span style={{ color: 'var(--text-secondary)' }}>{label}</span>
      <strong style={{ marginLeft: 'auto', paddingLeft: '10px', color: 'var(--text-primary)' }}>
        {value.toLocaleString()}
      </strong>
    </div>
  );
}

const legendRow = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
  gap: '10px', flexWrap: 'wrap', marginBottom: '10px',
};
const tableToggle = {
  background: 'none', border: '1px solid var(--border)', borderRadius: '6px',
  padding: '3px 10px', fontSize: '0.72rem', color: 'var(--text-secondary)', cursor: 'pointer',
};
const tip = {
  position: 'absolute', top: '4px', pointerEvents: 'none',
  background: 'var(--bg-secondary)', border: '1px solid var(--border)',
  borderRadius: '8px', padding: '8px 10px', minWidth: '150px',
  boxShadow: '0 4px 14px rgba(0,0,0,0.18)', zIndex: 3,
};
const table = { width: '100%', borderCollapse: 'collapse', fontSize: '0.8rem' };
const th = {
  textAlign: 'left', padding: '5px 8px', color: 'var(--text-muted)',
  fontWeight: 600, borderBottom: '1px solid var(--border)', fontSize: '0.72rem',
  textTransform: 'uppercase', letterSpacing: '0.4px',
};
const td = { padding: '5px 8px', color: 'var(--text-secondary)', borderBottom: '1px solid var(--border)' };
const empty = {
  padding: '26px 16px', textAlign: 'center', fontSize: '0.82rem',
  color: 'var(--text-muted)', background: 'var(--bg-tertiary)',
  border: '1px dashed var(--border)', borderRadius: 'var(--radius)',
};
