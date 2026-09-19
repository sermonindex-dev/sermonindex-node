import React from 'react';

/**
 * PageHead — the masthead every page opens with.
 *
 * WHY THIS EXISTS. Before this, each page began with a plain `<h2>` and a grey
 * line of description sitting directly on the page background, while the
 * sidebar beside it was a deep olive column. The two never looked like parts of
 * the same application — the column read as bolted on, because nothing in the
 * content area shared its material.
 *
 * The masthead is that column's material continued across the top of the
 * content: same olive gradient family, the same gold gesture (there a spine on
 * the active row, here a hairline along the bottom edge), the same cream text.
 * It also gives every page a defined place for its live status, which the pages
 * were previously improvising with inline flex rows in half a dozen shapes.
 *
 * @param {string}     kicker  the gold eyebrow — the section this page is in
 * @param {ReactNode}  title   the page name
 * @param {ReactNode}  sub     one line on what the page is for
 * @param {ReactNode}  icon    optional glyph shown beside the title
 * @param {ReactNode}  aside   right-hand slot: chips, a primary action
 * @param {ReactNode}  art     optional artwork bleeding in from the right
 * @param {Array}      figures optional [{ value, label }] headline numbers
 */
export default function PageHead({ kicker, title, sub, icon, aside, art, figures, children }) {
  return (
    <header className="masthead">
      {art && <div className="masthead-art" aria-hidden="true">{art}</div>}
      <div className="masthead-wrap">
        <div className="masthead-copy">
          {kicker && <div className="masthead-kick">{kicker}</div>}
          <h2>
            {icon && <span style={{ display: 'inline-flex', flexShrink: 0 }}>{icon}</span>}
            <span>{title}</span>
          </h2>
          {sub && <p>{sub}</p>}
          {figures?.length > 0 && (
            <div className="masthead-figures">
              {figures.map((f) => (
                <div key={f.label}>
                  <b>{f.value}</b>
                  <small>{f.label}</small>
                </div>
              ))}
            </div>
          )}
          {children}
        </div>
        {aside && <div className="masthead-aside">{aside}</div>}
      </div>
    </header>
  );
}

/**
 * Panel — a working card with a real header bar.
 *
 * The header carries a gold-ringed medallion, the title, and a slot on the
 * right. That slot is the point: nearly every card in the app had already grown
 * a count, a state word or a single action, and each one was hand-built as a
 * flex row with its own inline styles, so no two sat at the same height or used
 * the same gap.
 */
export function Panel({ mark, title, sub, aside, children, flush, className = '', ...rest }) {
  return (
    <div className={`seed-card panel ${className}`} {...rest}>
      <div className="panel-head">
        {mark && <span className="panel-mark" aria-hidden="true">{mark}</span>}
        <h3 className="panel-title">
          {title}
          {sub && <small>{sub}</small>}
        </h3>
        {aside && <div className="panel-aside">{aside}</div>}
      </div>
      <div className={`panel-body${flush ? ' flush' : ''}`}>{children}</div>
    </div>
  );
}
