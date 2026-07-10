import React from 'react';

// Bump this string whenever the conditions text changes materially. The app
// stores the agreed version in localStorage ('si-conditions-agreed'); if it no
// longer matches CONDITIONS_VERSION, the agreement modal is shown again.
export const CONDITIONS_VERSION = '2026-07-08';

// Short, plain-language summary shown on the About page (with a link to open the
// full conditions modal). Keep each line to one idea.
export const CONDITIONS_SUMMARY = [
  'These sermons are given freely for the glory of God — they may be shared, played, and used in ministry, but never sold or used commercially.',
  'Running a node volunteers a portion of your bandwidth and storage to preserve and re-share the archive with others over a peer-to-peer network.',
  'Content is distributed unmodified, in its original form; the software is provided as-is, and no personal account or personal data is required.',
];

const h = {
  fontSize: '0.95rem',
  fontWeight: 700,
  color: 'var(--gold-text)',
  margin: '18px 0 6px',
  letterSpacing: '0.01em',
};
const p = {
  fontSize: '0.86rem',
  lineHeight: 1.65,
  color: 'var(--text-secondary)',
  margin: '0 0 10px',
};
const quote = {
  fontSize: '0.82rem',
  lineHeight: 1.6,
  color: 'var(--text-muted)',
  fontStyle: 'italic',
  borderLeft: '2px solid var(--border)',
  padding: '2px 0 2px 12px',
  margin: '0 0 12px',
};
const verse = { color: 'var(--gold-text)', fontStyle: 'italic' };

// The full conditions body — reused by the first-launch modal and (optionally)
// the About page. Faithful to sermonindex.net/md/copying-permissions, abridged,
// with node-software-specific operating terms added.
export function ConditionsBody() {
  return (
    <div>
      <p style={{ ...p, color: 'var(--text-primary)' }}>
        For more than twenty years, SermonIndex has been entrusted with a sacred
        privilege: preserving the preaching of God's Word so that it might continue
        to speak to future generations. This software carries that same trust onto
        the network of people who choose to help keep the archive alive. Please read
        and agree to the following before you begin.
      </p>

      <div style={h}>Freely Received, Freely Given</div>
      <p style={p}>
        The sermons, recordings, and materials shared through SermonIndex are made
        available without cost, for the glory of God and the strengthening of His
        Church. Our desire is simply that these messages continue to spread the
        knowledge of Christ throughout the world.
      </p>
      <p style={quote}>
        "Christ commanded His ministers to give freely, as they had received freely…
        The Gospel of Christ is not to be sold for money, but to be declared freely."
        — George Fox
      </p>

      <div style={h}>For Personal and Ministry Use</div>
      <p style={p}>
        All materials are freely available for personal edification and for the work
        of discipleship and evangelism. These messages may be shared with others;
        played in churches, homes, Bible studies, and ministry gatherings; and used
        in teaching and other ministry settings. Online sharing or translation into
        other languages may also be undertaken where it serves personal ministry,
        missionary outreach, or the edification of believers — done in a careful and
        respectful manner that honors the original message.
      </p>

      <div style={h}>Never for Commercial Use</div>
      <p style={p}>
        While these materials are freely available for ministry purposes, they are
        not to be bought or sold for commercial gain. Please do not package, sell, or
        use them in commercial products or profit-driven ventures. The sermons
        represent the lives and ministries of many faithful servants of God; our hope
        is that they will always remain freely accessible to the Body of Christ,
        without financial barriers. <span style={verse}>"Freely you have received;
        freely give." (Matthew 10:8)</span>
      </p>

      <div style={h}>Content Is Unmodified</div>
      <p style={p}>
        Audio, video, and text sermons are distributed in their original, unmodified
        form. The views expressed are those of the original speakers and do not
        necessarily reflect those of SermonIndex or of other people on the network.
      </p>

      <div style={h}>Running a Node</div>
      <p style={p}>
        This is not an ordinary media player — it is a preservation node. By running
        it you agree that:
      </p>
      <p style={p}>
        • You <strong style={{ color: 'var(--text-primary)' }}>volunteer a portion of
        your device's storage, bandwidth, and network connection</strong> to help
        preserve and redistribute the archive to others over a peer-to-peer
        (BitTorrent) network.<br />
        • Sermons you download are <strong style={{ color: 'var(--text-primary)' }}>
        automatically re-shared (seeded)</strong> with other people, so the archive
        cannot be lost. You may limit or pause sharing at any time in Settings.<br />
        • You are responsible for using the content in keeping with the permissions
        above and with the laws of your own jurisdiction.<br />
        • The software is provided <strong style={{ color: 'var(--text-primary)' }}>
        "as is," without warranty of any kind</strong>.
      </p>

      <div style={h}>Your Privacy</div>
      <p style={p}>
        No account, sign-up, or personal information is required. Your node uses a
        randomly generated ID and shares only basic connectivity status (such as
        whether it is reachable) so the network can measure its own health. It does
        not collect your name, email, or the contents of your library.
      </p>

      <div style={h}>Our Prayer</div>
      <p style={p}>
        May the Lord, in His mercy, use these sermons to awaken the hearts of many, to
        strengthen His Church in holiness, and to proclaim the glory of Jesus Christ
        throughout the earth. If through these messages the Gospel continues to pass
        from generation to generation, we give thanks to God, who has entrusted us
        with this solemn and sacred stewardship.
      </p>
    </div>
  );
}
