import React from 'react';

/**
 * PageHead — the slim header every inner page opens with.
 *
 * It used to be a full olive "masthead": the sidebar's material continued
 * across the top of the content, with a gold eyebrow, a serif title, artwork
 * bleeding in from the right, and room for figures. It looked deliberate on the
 * Dashboard and About, where a page earns an introduction. On Library,
 * Downloads, Settings and the rest it was a coloured slab ~150px tall that
 * said nothing the highlighted sidebar row hadn't already said, and pushed the
 * actual work below the fold.
 *
 * So inner pages get a header bar instead: the page name, one line on what it
 * is for, and on the right whatever is LIVE — figures and status chips — which
 * is the part of the masthead that carried information. No eyebrow (the
 * sidebar is the "you are here"), no artwork, no slab. A breadcrumb was
 * considered and rejected: the app is flat, so "Dashboard › Library" would
 * describe a hierarchy that doesn't exist.
 *
 * Dashboard and About keep their own olive heroes (`.dash-hero`,
 * `.si-abouthero`); they don't use this component.
 *
 * `kicker`, `icon` and `art` are still accepted so no caller breaks, and are
 * intentionally not drawn.
 *
 * @param {ReactNode}  title   the page name
 * @param {ReactNode}  sub     one line on what the page is for
 * @param {ReactNode}  aside   right-hand slot: chips, a primary action
 * @param {Array}      figures optional [{ value, label }] live numbers
 */
// eslint-disable-next-line no-unused-vars
export default function PageHead({ kicker, title, sub, icon, aside, art, figures, children }) {
  const hasRight = (figures && figures.length > 0) || aside;
  return (
    <header className="pagehead">
      <div className="pagehead-copy">
        <h2>{title}</h2>
        {sub && <p>{sub}</p>}
        {children}
      </div>
      {hasRight && (
        <div className="pagehead-right">
          {figures?.length > 0 && (
            <div className="pagehead-figures">
              {figures.map((f) => (
                <div key={f.label}>
                  <b>{f.value}</b>
                  <small>{f.label}</small>
                </div>
              ))}
            </div>
          )}
          {aside && <div className="pagehead-aside">{aside}</div>}
        </div>
      )}
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
