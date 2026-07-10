import React from 'react';
import { CONDITIONS_SUMMARY } from '../data/conditions.jsx';

const seedMark = (
  <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 2C7 6 5 10 5 14a7 7 0 0 0 14 0c0-4-2-8-7-12z" />
    <path d="M12 22V9" />
    <path d="M12 13c-1.6-.5-2.8-1.7-3.3-3.3" />
    <path d="M12 11c1.5-.5 2.6-1.6 3.1-3.1" />
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

const h = { fontSize: '1rem', fontWeight: 700, color: 'var(--gold-text)', margin: '0 0 10px' };
const p = { fontSize: '0.9rem', lineHeight: 1.7, color: 'var(--text-secondary)', margin: '0 0 12px' };

export default function AboutPage({ version = '', onShowConditions }) {
  const extLink = {
    display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '0.82rem',
    color: 'var(--gold-text)', background: 'var(--bg-tertiary)', border: '1px solid var(--border)',
    borderRadius: '6px', padding: '7px 12px', cursor: 'pointer', fontWeight: 600,
  };

  return (
    <div className="settings-page-root">
      <div style={{ maxWidth: '760px', margin: '0 auto', padding: '4px 0 40px' }}>

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '14px', marginBottom: '22px', color: 'var(--gold-text)' }}>
          <span style={{ display: 'flex' }}>{seedMark}</span>
          <div>
            <h2 style={{ margin: 0, fontSize: '1.35rem', color: 'var(--text-primary)' }}>SermonIndex — Node Software</h2>
            <div style={{ fontSize: '0.82rem', color: 'var(--text-muted)' }}>
              {version ? `Version ${version}` : 'Preserving revival preaching for generations to come'}
            </div>
          </div>
        </div>

        {/* Mission */}
        <div className="seed-card" style={{ marginBottom: '16px' }}>
          <h3 style={h}>Our Mission</h3>
          <p style={{ ...p, color: 'var(--text-primary)', fontStyle: 'italic' }}>
            "SermonIndex's assignment is to honour and preserve the past preaching of
            God's Word and to promote revival to this generation."
          </p>
          <p style={p}>
            Since 2002 — begun by Greg Gordon after reading Leonard Ravenhill's
            <em> Why Revival Tarries</em> — SermonIndex has grown into a library of tens
            of thousands of sermons from voices such as Charles Spurgeon, A.W. Tozer, and
            Leonard Ravenhill. These messages have been made freely available and
            distributed over 100 million times, reaching nearly every nation on earth.
            Being undenominational, we seek to serve all who love our Lord Jesus Christ in
            sincerity, holding to the Scriptures as the inspired Word of God.
          </p>
        </div>

        {/* Node vision */}
        <div className="seed-card" style={{ marginBottom: '16px' }}>
          <h3 style={h}>Why the Node Software Exists</h3>
          <p style={p}>
            There is a quiet danger in "one place." Everything that lives on a single set
            of servers can be lost from a single set of servers — through cost, hardware
            failure, pressure, or a decision made far above our heads. An archive this
            precious should not hang on so thin a thread.
          </p>
          <p style={p}>
            This software turns your computer into a living part of the archive. You use
            it to browse and download sermons to keep and hear offline — and in the
            background, your app quietly shares those same files with others, computer to
            computer, around the world. There is no central server doing the work.
            <strong style={{ color: 'var(--text-primary)' }}> The network is the people running it</strong>,
            and the more of us who run it, the more permanent the archive becomes.
          </p>
          <p style={{
            fontSize: '0.9rem', lineHeight: 1.7, color: 'var(--text-secondary)',
            borderLeft: '3px solid var(--gold)', paddingLeft: '14px', margin: '0 0 12px', fontStyle: 'italic',
          }}>
            With seed nodes distributed across the world, the sermon library becomes
            essentially indestructible. No single point of failure. No authority can
            censor it. The content lives on across the body of Christ.
            <br /><br />
            "How beautiful on the mountains are the feet of those who bring good news"
            — Isaiah 52:7
          </p>
          <p style={{ ...p, margin: 0 }}>
            Not a company guarding an archive, but the church herself carrying it —
            thousands of ordinary computers in homes, on shelves, beside routers, across
            dozens of nations, together forming something no outage and no authority can
            erase. A fire handed from house to house that cannot be put out.
          </p>
        </div>

        {/* Conditions summary */}
        <div className="seed-card" style={{ marginBottom: '16px' }}>
          <h3 style={h}>Copying Permissions &amp; Conditions</h3>
          <p style={{ ...p, marginBottom: '10px' }}>
            In short:
          </p>
          <ul style={{ margin: '0 0 14px', paddingLeft: '20px' }}>
            {CONDITIONS_SUMMARY.map((line, i) => (
              <li key={i} style={{ fontSize: '0.88rem', lineHeight: 1.6, color: 'var(--text-secondary)', marginBottom: '8px' }}>
                {line}
              </li>
            ))}
          </ul>
          {onShowConditions && (
            <button className="btn btn-gold" onClick={onShowConditions} style={{ fontSize: '0.82rem' }}>
              Read the full conditions
            </button>
          )}
        </div>

        {/* External links */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px' }}>
          <span style={extLink} onClick={() => openExternal('https://www.sermonindex.net/md/about/')}>{iconExt} About SermonIndex</span>
          <span style={extLink} onClick={() => openExternal('https://forums.sermonindex.net')}>{iconExt} Forums</span>
          <span style={extLink} onClick={() => openExternal('https://www.sermonindex.net/md/copying-permissions/')}>{iconExt} Copying Permissions</span>
          <span style={extLink} onClick={() => openExternal('https://www.sermonindex.net/md/donate/')}>{iconExt} Donate</span>
        </div>

      </div>
    </div>
  );
}
