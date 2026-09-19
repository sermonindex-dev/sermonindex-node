import React from 'react';
import { CONDITIONS_SUMMARY } from '../data/conditions.jsx';
import { Panel } from '../components/PageHead.jsx';
// The white wordmark that used to be imported here is gone. It appeared TWICE
// on this page — once pinned over the portrait in the band, once in the eyebrow
// row — inside an app whose sidebar already carries the wordmark at all times.
// A logo repeated three times on one screen stops being a mark and becomes
// wallpaper, and it was competing with the one image on the page that is
// actually saying something.

// A scroll — the conditions block's medallion. Drawn in the same 24-unit,
// 1.8px-stroke outline language as the sidebar's icons.
const iconScroll = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M6 3h11a2 2 0 0 1 2 2v13a3 3 0 0 0 3 3H8a3 3 0 0 1-3-3V5a2 2 0 0 0-2 2h3" />
    <path d="M9 8h7M9 12h7M9 16h4" />
  </svg>
);

const iconExt = (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /><polyline points="15 3 21 3 21 9" /><line x1="10" y1="14" x2="21" y2="3" /></svg>
);

async function openExternal(url) {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('open_url', { url });
  } catch (e) {
    console.warn('[About] open_url failed:', e);
  }
}

// Small gold outgoing-link icon shown inline right before a linked "SermonIndex" mention.
const siteLinkIcon = (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--gold-text)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: '3px', verticalAlign: '-2px', flexShrink: 0 }} aria-hidden="true">
    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    <polyline points="15 3 21 3 21 9" />
    <line x1="10" y1="14" x2="21" y2="3" />
  </svg>
);

// Inline gold link to the main SermonIndex site (reuses the openExternal helper above).
function SiteLink({ children }) {
  const open = () => openExternal('https://www.sermonindex.net');
  return (
    <span
      role="link"
      tabIndex={0}
      onClick={open}
      onKeyDown={(e) => { if (e.key === 'Enter') open(); }}
      onMouseEnter={(e) => { e.currentTarget.style.textDecoration = 'underline'; }}
      onMouseLeave={(e) => { e.currentTarget.style.textDecoration = 'none'; }}
      style={{ color: 'var(--gold-text)', cursor: 'pointer', textDecoration: 'none', whiteSpace: 'nowrap' }}
    >
      {siteLinkIcon}{children}
    </span>
  );
}

// The `h` and `p` inline style objects that used to live here are gone: the
// essay's headings and paragraphs are now `.essay-mark` and `.essay p`, so the
// measure, the leading and the rhythm are set in one place instead of being
// re-asserted at every paragraph.

// ── About hero band ───────────────────────────────────────────────────────
// Built to match `SeedNodeHero()` on the Seed Node page: a full-width band that
// sits inside `.page-header-wide` above `.connections-layout`, so it spans both
// columns and lines up with them. Like that band it carries its OWN dark olive
// surface in both themes (see `.si-abouthero` in styles.css) and uses fixed
// light text colours rather than the --text-* tokens, which flip with the theme.
//
// The Spurgeon portrait replaces the seed band's SVG: it bleeds in from the left
// and is feathered out toward the copy on the right.
//
// The portrait is referenced as a PLAIN PUBLIC URL, deliberately NOT a Vite
// `import`. The file is not in the repo yet; a missing `import` would fail the
// build, whereas a missing public asset just 404s. `onError` then hides the
// element so the band degrades cleanly to logo + text.
const SPURGEON_SRC = '/images/about-spurgeon.png';

function AboutHero({ version = '' }) {
  return (
    <div className="si-abouthero">
      <div className="si-abouthero-portrait" aria-hidden="true">
        <img
          src={SPURGEON_SRC}
          alt=""
          aria-hidden="true"
          onError={(e) => { e.currentTarget.style.display = 'none'; }}
        />
      </div>
      <div className="si-abouthero-wrap">
        <div className="si-abouthero-copy">
          {/* The page title lives INSIDE the band, above a rule — the same fix
              the Seed Node page needed. The page used to open twice: a quiet
              grey "SermonIndex — Node Software" on cream, then "Our Mission" in
              serif on olive a moment later. One opening. */}
          <div className="brand-eyebrow">
            <div>
              <h1>SermonIndex — Node Software</h1>
              <p>{version ? `Version ${version}` : 'Preserving revival preaching for generations to come'}</p>
            </div>
          </div>
          <h2>Our Mission</h2>
          <p className="si-abouthero-lede">
            "<SiteLink>SermonIndex</SiteLink>'s assignment is to honour and preserve the past preaching of
            God's Word and to promote revival to this generation."
          </p>
          <p>
            Since 2002 — begun by Greg Gordon after reading Leonard Ravenhill's
            <em> Why Revival Tarries</em> — <SiteLink>SermonIndex</SiteLink> has grown into a library of tens
            of thousands of sermons from voices such as Charles Spurgeon, A.W. Tozer, and
            Leonard Ravenhill. These messages have been made freely available and
            distributed over 100 million times, reaching nearly every nation on earth.
            Being undenominational, we seek to serve all who love our Lord Jesus Christ in
            sincerity, holding to the Scriptures as the inspired Word of God.
          </p>
        </div>
      </div>
    </div>
  );
}

export default function AboutPage({ version = '', onShowConditions }) {
  return (
    <div className="settings-page-root">
      {/* The band spans the full 1100px and lines up with the reading column
          below it. It carries the page title too — see `.brand-eyebrow`. */}
      <div className="page-header-wide" style={{ padding: '4px 0 0' }}>
        <AboutHero version={version} />
      </div>

      {/* ── One reading column ──────────────────────────────────────────────
          This page used to be two ~530px columns of prose inside cards, which
          gave neither of them a comfortable measure and made the reader choose
          a column before they could start a sentence. It is an essay, so it is
          now set as one: ~68 characters, generous leading, section marks rather
          than card headers, and a pull-quote that breaks out of the measure.
          The only card left is the conditions block — that genuinely IS
          reference material and should look like it. */}
      <div className="page-header-wide">
        <article className="essay">

          <div className="essay-mark">Why this software exists</div>

          <p className="essay-lede">
            There is a quiet danger in &ldquo;one place.&rdquo; Everything that lives on a single
            set of servers can be lost from a single set of servers — through cost, hardware
            failure, pressure, or a decision made far above our heads. An archive this
            precious should not hang on so thin a thread.
          </p>

          <p>
            This software turns your computer into a living part of the archive. You use it
            to browse and download sermons to keep and hear offline — and in the background,
            your app quietly shares those same files with others, computer to computer,
            around the world. There is no central server doing the work.{' '}
            <strong>The network is the people running it</strong>, and the more of us who run
            it, the more permanent the archive becomes.
          </p>

          <div className="essay-points">
            <div className="essay-point">
              <b>No single point of failure</b>
              <span>Every copy is a full copy. The library survives any one machine going dark.</span>
            </div>
            <div className="essay-point">
              <b>Nothing to sign in to</b>
              <span>No account, no server deciding who may listen. The files are simply there.</span>
            </div>
            <div className="essay-point">
              <b>Carried by the church</b>
              <span>Ordinary computers in homes and offices across dozens of nations.</span>
            </div>
          </div>

          <blockquote className="pullquote">
            With seed nodes distributed across the world, the sermon library becomes
            essentially indestructible. No single point of failure. No authority can censor
            it. The content lives on across the body of Christ.
            <cite>Isaiah 52:7 — &ldquo;How beautiful on the mountains are the feet of those who bring good news&rdquo;</cite>
          </blockquote>

          <p>
            Not a company guarding an archive, but the church herself carrying it — thousands
            of ordinary computers in homes, on shelves, beside routers, across dozens of
            nations, together forming something no outage and no authority can erase. A fire
            handed from house to house that cannot be put out.
          </p>

          <div className="essay-mark">What you may do with the sermons</div>

          <p>
            The short version is below. It is worth reading once — it is four sentences, and
            it is the whole agreement.
          </p>

          <Panel mark={iconScroll} title="Copying Permissions & Conditions" sub="In short">
            <ul style={{ margin: '0 0 16px', paddingLeft: '20px' }}>
              {CONDITIONS_SUMMARY.map((line, i) => (
                <li key={i} style={{ fontSize: 'var(--text-sm)', lineHeight: 1.65, color: 'var(--text-secondary)', marginBottom: '10px' }}>
                  {line}
                </li>
              ))}
            </ul>
            {onShowConditions && (
              <button className="btn btn-gold" onClick={onShowConditions}>
                Read the full conditions
              </button>
            )}
          </Panel>

          <div className="essay-mark">Elsewhere</div>
          <div className="essay-links">
            {[
              ['About SermonIndex', 'https://www.sermonindex.net/md/about/'],
              ['Forums', 'https://forums.sermonindex.net'],
              ['Copying Permissions', 'https://www.sermonindex.net/md/copying-permissions/'],
              ['Donate', 'https://www.sermonindex.net/md/donate/'],
            ].map(([label, url]) => (
              <button
                key={url}
                type="button"
                className="btn btn-outline btn-sm"
                onClick={() => openExternal(url)}
              >
                {iconExt} {label}
              </button>
            ))}
          </div>

        </article>
      </div>
    </div>
  );
}
