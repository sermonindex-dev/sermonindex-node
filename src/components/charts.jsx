import React, { useState, useRef, useEffect, useCallback } from 'react';

/**
 * charts — the app's small chart set, rebuilt.
 *
 * WHY THIS FILE EXISTS. The previous charts were drawn straight into
 * StatsPage.jsx and shared one bug that mattered more than any styling: they
 * used a fixed `viewBox` with `preserveAspectRatio="none"` and `width="100%"`.
 * That does not scale a chart, it STRETCHES it — the horizontal axis is
 * multiplied by whatever (container ÷ 340) happens to be, so a bar drawn 8 units
 * wide renders at 8px in a narrow window and 20px in a wide one, and the slope
 * of a line means something different at every window size. The line survived
 * only because it carried `vector-effect: non-scaling-stroke`, which is a patch
 * over the symptom.
 *
 * Everything here measures its own container and draws at true 1:1 scale, so a
 * pixel is a pixel and the geometry is the same at any width.
 *
 * The rest of what changed, and why, is in the components themselves.
 */

// ── Measure the container, so charts can draw at true scale ──────────────────
// ResizeObserver rather than a window resize listener: the sidebar collapsing,
// a panel opening, or the two-column layout folding all change a chart's width
// without the window changing size at all.
export function useWidth(initial = 320) {
  const ref = useRef(null);
  const [w, setW] = useState(initial);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof ResizeObserver === 'undefined') {
      setW(el.clientWidth || initial);
      return;
    }
    const ro = new ResizeObserver((entries) => {
      const next = Math.round(entries[0]?.contentRect?.width || 0);
      if (next > 0) setW(next);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [initial]);
  return [ref, w];
}

// The left gutter has to fit the WIDEST tick label it will hold. A fixed 34px
// was fine for "50" and silently clipped "20.0 GB" down to "0.0 GB" — an axis
// that shows the wrong number is worse than an axis with no numbers at all,
// because it is quietly believed. Measured off the formatted strings at ~5.7px
// per character for the 10px tabular face, with a floor and a sane ceiling.
function gutterFor(labels) {
  const longest = labels.reduce((m, t) => Math.max(m, String(t).length), 1);
  return Math.min(78, Math.max(30, Math.round(longest * 5.7) + 10));
}

// Clean axis ticks: 0 and one or two round numbers, never 3.7142.
function niceMax(v) {
  if (!(v > 0)) return 1;
  const exp = Math.floor(Math.log10(v));
  const base = Math.pow(10, exp);
  const n = v / base;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return step * base;
}

// A column with a 4px rounded cap and a SQUARE baseline. `rx` on a <rect>
// rounds all four corners, which detaches the bar from the axis it grows from.
function columnPath(x, y, w, h, r = 4) {
  const rr = Math.min(r, w / 2, h);
  if (h <= 0) return '';
  return `M${x} ${y + h} L${x} ${y + rr} Q${x} ${y} ${x + rr} ${y} L${x + w - rr} ${y} Q${x + w} ${y} ${x + w} ${y + rr} L${x + w} ${y + h} Z`;
}

/* ═══════════════════════════════════════════════════════════════════════════
   CoverageMeter — replaces the donut.

   A donut showing one percentage is a two-slice pie, and it could not show the
   thing that actually matters on this page: how far you are from the 95% a
   verified seed node needs. Worse, at the coverage a normal user actually has
   (a fraction of one percent) the ring rendered as an invisible sliver, so the
   picture carried no information at all and the centre label did all the work.

   A hero figure carries the number; the meter carries the distance to the mark.
   ═══════════════════════════════════════════════════════════════════════════ */
export function CoverageMeter({ pct = 0, downloaded = 0, total = 0, threshold = 95 }) {
  const shown = Math.max(0, Math.min(100, pct));
  const met = shown >= threshold;
  return (
    <div className="viz" style={{ flex: 1, minWidth: 220 }}>
      <div className="viz-hero">
        {shown >= 10 ? shown.toFixed(0) : shown.toFixed(shown >= 1 ? 1 : 2)}
        <span className="viz-hero-unit">%</span>
      </div>
      <div className="viz-hero-label">of the library held</div>

      <div className="viz-meter">
        <i className={met ? 'ok' : ''} style={{ width: `${shown}%` }} />
        {/* The target, drawn on the track. A threshold you can see is a
            threshold you can aim at. */}
        <span className="viz-meter-mark" style={{ left: `${threshold}%` }} />
      </div>
      <div className="viz-meter-legend">
        <span>{downloaded.toLocaleString()} of {total.toLocaleString()} sermons</span>
        <span>{threshold}% = verified</span>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   MixBars — audio vs video.

   Two nominal categories, so the colour job is CATEGORICAL: identity, not
   magnitude. The pair is gold + the app's seed-blue, which clears the palette
   validator in both modes (ΔE 25.0 normal, 23.5 protan in light). The previous
   gold + olive failed it outright — olive measured below the chroma floor, so
   it read as grey, and the pair sat at ΔE 7.6 for a full-colour reader.

   Identity is carried by a coloured key BESIDE each label, never by colouring
   the label text: at 12px a mid-gold word on a cream card is hard to read, and
   it puts data ink where it does no work.
   ═══════════════════════════════════════════════════════════════════════════ */
export function MixBars({ audio = 0, video = 0 }) {
  const max = Math.max(1, audio, video);
  const rows = [
    { label: 'Audio sermons', value: audio, key: 'var(--viz-1)' },
    { label: 'Video sermons', value: video, key: 'var(--viz-2)' },
  ];
  return (
    <div className="viz" style={{ flex: 1, minWidth: 210 }}>
      {rows.map((r) => (
        <div className="viz-row" key={r.label}>
          <div className="viz-row-head">
            <span className="viz-row-name">
              <span className="viz-key" style={{ background: r.key }} />
              {r.label}
            </span>
            <span className="viz-row-value">{r.value.toLocaleString()}</span>
          </div>
          <div className="viz-row-track">
            <div
              className="viz-row-fill"
              style={{ width: `${(r.value / max) * 100}%`, background: r.key }}
            />
          </div>
        </div>
      ))}
      {audio + video === 0 && (
        <p style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', margin: '12px 0 0' }}>
          Download a few sermons and your hosting mix will appear here.
        </p>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   TrendArea — a single series over time.

   One series, so there is no legend box: the panel title already says what is
   plotted, and a legend with one swatch just restates it. The area is a ~10%
   wash rather than the old 38% gradient — an area fill is context for the line,
   and a saturated block competes with it.

   It gains three things the old sparkline did not have: a y-scale you can
   actually read a value off, an end-marker with its value direct-labelled, and
   a crosshair you can hover.
   ═══════════════════════════════════════════════════════════════════════════ */
export function TrendArea({ data = [], height = 132, format = (v) => String(v), label = 'value' }) {
  const [ref, w] = useWidth(340);
  const [hover, setHover] = useState(null);

  const padR = 12, padT = 12, padB = 18;
  const arr = data && data.length ? data.map(Number) : [0];
  const top = niceMax(Math.max(...arr, 1));
  const n = arr.length;
  const tickVals = [0, top / 2, top];
  const padL = gutterFor(tickVals.map(format));
  const iw = Math.max(10, w - padL - padR);
  const ih = height - padT - padB;

  const xAt = (i) => (n <= 1 ? padL + iw : padL + (i / (n - 1)) * iw);
  const yAt = (v) => padT + ih - (Math.max(0, v) / top) * ih;

  const pts = arr.map((v, i) => [xAt(i), yAt(v)]);
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ');
  const area = `${line} L${xAt(n - 1).toFixed(1)} ${padT + ih} L${padL} ${padT + ih} Z`;
  const last = pts[pts.length - 1];

  // Nearest-point hover across the WHOLE plot, not a hit target per dot: the
  // points here can be a couple of pixels apart, and a reader should not have
  // to land on one.
  const onMove = useCallback((e) => {
    const box = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - box.left;
    if (n <= 1) { setHover(0); return; }
    const i = Math.round(((x - padL) / iw) * (n - 1));
    setHover(Math.max(0, Math.min(n - 1, i)));
  }, [n, iw]);

  const ticks = tickVals;

  return (
    <div className="viz">
      <div
        className="viz-frame"
        ref={ref}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
        style={{ height }}
      >
        <svg width={w} height={height} role="img" aria-label={`${label} over time`}>
          {/* Gridlines: hairline, solid, one step off the surface. Never dashed —
              a dashed rule reads as a threshold or a projection. */}
          {ticks.map((t) => (
            <g key={t}>
              <line x1={padL} x2={w - padR} y1={yAt(t)} y2={yAt(t)} stroke="var(--viz-grid)" strokeWidth="1" />
              <text className="viz-tick" x={padL - 6} y={yAt(t) + 3.5} textAnchor="end">{format(t)}</text>
            </g>
          ))}

          <path d={area} fill="var(--viz-1)" fillOpacity="0.10" />
          <path d={line} fill="none" stroke="var(--viz-1)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />

          {hover != null && (
            <line
              x1={xAt(hover)} x2={xAt(hover)} y1={padT} y2={padT + ih}
              stroke="var(--viz-1)" strokeWidth="1" strokeOpacity="0.45"
            />
          )}

          {/* End marker — r ≥ 4 with a 2px ring in the surface colour, so it
              stays legible where it sits on the line. */}
          {last && (
            <circle
              cx={last[0]} cy={last[1]} r="4.5"
              fill="var(--viz-1)" stroke="var(--viz-surface)" strokeWidth="2"
            />
          )}
          {hover != null && (
            <circle
              cx={xAt(hover)} cy={yAt(arr[hover])} r="4.5"
              fill="var(--viz-1)" stroke="var(--viz-surface)" strokeWidth="2"
            />
          )}
        </svg>

        {hover != null && (
          <div className="viz-tip" style={{ left: xAt(hover), top: yAt(arr[hover]) - 8 }}>
            <b>{format(arr[hover])}</b>
            <small>{label}</small>
          </div>
        )}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   DailyColumns — one column per day.

   The old version drew its bars into a stretched viewBox, so their width was a
   function of the window; it also filled them with a top-to-bottom gradient
   fading to 30% opacity, which made every bar look like it was evaporating off
   its own baseline. Solid fill, square baseline, 4px cap.

   A zero day still draws nothing. That is the honest picture of a day on which
   nothing was shared, and inventing a 2px stub for it would be a lie told for
   the sake of a tidier chart.
   ═══════════════════════════════════════════════════════════════════════════ */
export function DailyColumns({ data = [], height = 132, format = (v) => String(v), dayLabel = (d) => d }) {
  const [ref, w] = useWidth(340);
  const [hover, setHover] = useState(null);

  const padR = 10, padT = 12, padB = 18;
  const arr = data && data.length ? data : [{ d: '', v: 0 }];
  const top = niceMax(Math.max(1, ...arr.map((x) => Number(x.v) || 0)));
  const padL = gutterFor([0, top / 2, top].map(format));
  const iw = Math.max(10, w - padL - padR);
  const ih = height - padT - padB;
  const slot = iw / arr.length;
  // Capped at 24px per the mark spec — a column that fills its whole band
  // leaves the series no air and reads as a solid block at a glance.
  const bw = Math.max(2, Math.min(24, slot * 0.62));
  const ticks = [0, top / 2, top];

  return (
    <div className="viz">
      <div className="viz-frame" ref={ref} style={{ height }} onMouseLeave={() => setHover(null)}>
        <svg width={w} height={height} role="img" aria-label="Shared each day">
          {ticks.map((t) => (
            <g key={t}>
              <line
                x1={padL} x2={w - padR}
                y1={padT + ih - (t / top) * ih} y2={padT + ih - (t / top) * ih}
                stroke="var(--viz-grid)" strokeWidth="1"
              />
              <text className="viz-tick" x={padL - 6} y={padT + ih - (t / top) * ih + 3.5} textAnchor="end">
                {format(t)}
              </text>
            </g>
          ))}

          {arr.map((x, i) => {
            const v = Number(x.v) || 0;
            const bh = v > 0 ? Math.max(2, (v / top) * ih) : 0;
            const bx = padL + slot * i + (slot - bw) / 2;
            return (
              <g key={x.d || i}>
                {bh > 0 && (
                  <path
                    d={columnPath(bx, padT + ih - bh, bw, bh)}
                    fill="var(--viz-1)"
                    fillOpacity={hover === i ? 1 : 0.86}
                  />
                )}
                {/* The hit target is the whole band, full height — a 3px column
                    you must land on dead-centre is not a hover target. */}
                <rect
                  x={padL + slot * i} y={padT} width={slot} height={ih}
                  fill="transparent"
                  onMouseEnter={() => setHover(i)}
                />
              </g>
            );
          })}

          <line
            x1={padL} x2={w - padR} y1={padT + ih} y2={padT + ih}
            stroke="var(--border)" strokeWidth="1"
          />
        </svg>

        {hover != null && arr[hover] && (
          <div
            className="viz-tip"
            style={{
              left: padL + slot * hover + slot / 2,
              top: padT + ih - Math.max(2, ((Number(arr[hover].v) || 0) / top) * ih) - 8,
            }}
          >
            <b>{format(Number(arr[hover].v) || 0)}</b>
            <small>{dayLabel(arr[hover].d)}</small>
          </div>
        )}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   ChartTable — the table-view twin every chart gets.

   A tooltip may enhance a value; it may never be the only way to reach one.
   This is what makes these charts readable with a screen reader, in a
   screenshot, or by anyone who simply wants the numbers.
   ═══════════════════════════════════════════════════════════════════════════ */
export function ChartTable({ rows = [], head = ['', ''], id }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="viz-table-toggle"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? 'Hide table' : 'Show table'}
      </button>
      {open && (
        <div className="viz-table-scroll" id={id}>
          <table className="viz-table">
            <thead><tr><th>{head[0]}</th><th>{head[1]}</th></tr></thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r[0] || i}><td>{r[0]}</td><td>{r[1]}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
