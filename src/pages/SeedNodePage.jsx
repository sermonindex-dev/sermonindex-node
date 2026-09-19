import React, { useState, useCallback, useEffect } from 'react';
import PiBoard from '../components/PiBoard.jsx';
import PageHead, { Panel } from '../components/PageHead.jsx';
import { probeReachability, registerSeed, checkSeedAccess, requestSeedAccess, saveReachability, readReachability, readIpv6Observation } from '../services/network.js';
import { timeAgo } from '../utils/time.js';
import { isReachable, writeSeedGranted } from '../utils/nodeStatus.js';
import CgnatNotice from '../components/CgnatNotice.jsx';
import { TORRENT_PORT_RANGE } from '../services/constants.js';
import { getNodeId } from '../services/heartbeat.js';

const SEED_CONTACT_EMAIL = 'sermonindex@gmail.com';

// ── Library sizing, split by scope ─────────────────────────────────────────
// Audio-only is the practical common choice: ~412 GB fits on a cheap external
// drive. Everything (audio + video) is ~2.4 TB and needs a large drive.
const SCOPE_INFO = {
  audio: {
    label: 'Audio library',
    sizeLabel: '~412 GB',
    fileCount: 25587,
    tagline: '~412 GB · 25,587 sermons · fits on a small external drive',
    // Require a comfortable margin above the ~412 GB payload.
    requiredBytes: 500 * 1000 * 1000 * 1000, // 500 GB
    requiredLabel: '500 GB',
  },
  full: {
    label: 'Full library (audio + video)',
    sizeLabel: '~2.4 TB',
    fileCount: 33528, // 25,587 audio + 7,941 video
    tagline: '~2.4 TB · adds 7,941 videos · needs a large drive',
    requiredBytes: 2600 * 1000 * 1000 * 1000, // 2.6 TB
    requiredLabel: '2.6 TB',
  },
};

const SEED_SCOPE_KEY = 'si-seed-scope';

// Solid yellow lock SVG icon
const iconLock = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="#d4af37" stroke="none">
    <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
    <path d="M7 11V7a5 5 0 0 1 10 0v4" fill="none" stroke="#d4af37" strokeWidth="2" />
  </svg>
);

// Phosphor circuitry icon for seed node branding
// Feather-style marks for the right-hand panels' medallions.
const iconRefresh = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" />
    <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
  </svg>
);
const iconGauge = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 12a9 9 0 1 0-18 0" /><line x1="12" y1="12" x2="17" y2="8" /><circle cx="12" cy="12" r="1.6" fill="currentColor" />
  </svg>
);
const iconMail = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="2" y="4" width="20" height="16" rx="2" /><path d="m22 6-10 7L2 6" />
  </svg>
);

// (`iconCircuitry` lived here — the locked page it decorated is now a
// photograph, so the glyph has no job left.)

// ── Seed-node hero band ───────────────────────────────────────────────────
// Ported from the website's node-software landing page (the `.nlp-seed`
// section). Full-width band that sits above the two-column layout in BOTH the
// locked and unlocked states, since it is the page's introduction either way.
//
// The SVG bleeds in from the left and is masked out toward the copy on the
// right. Its colours are the site's literal gold/cream, so the band carries its
// own dark olive surface in both app themes (see `.si-seedhero` in styles.css)
// — cream dots would be invisible on the light theme's #F8F8F2.
//
// The gradient/pattern ids are document-global, so they are namespaced
// (`siSeedHero*`) to avoid the kind of id collision already fixed on StatsPage.
// ── The network artwork ───────────────────────────────────────────────────
// This used to be the body of a `SeedNodeHero()` band that the locked page
// rendered above everything else. The locked page now opens with a PHOTOGRAPH
// of a real node instead — an actual machine in an actual room persuades far
// better than a diagram of one — so the band itself is gone.
//
// The drawing is not: it moves to the UNLOCKED page's masthead, where "your
// node is carrying the library" is exactly what it depicts. Nothing here is
// dead code; it just changed jobs.
const seedArt = (
  <svg viewBox="0 0 620 560" preserveAspectRatio="xMidYMid slice">
            <defs>
              <pattern id="siSeedHeroDots" width="42" height="42" patternUnits="userSpaceOnUse">
                <circle cx="3" cy="3" r="1.5" fill="#f3efe0" opacity="0.09" />
              </pattern>
              <linearGradient id="siSeedHeroArea" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="#d4af37" stopOpacity="0.32" />
                <stop offset="1" stopColor="#d4af37" stopOpacity="0.02" />
              </linearGradient>
              <radialGradient id="siSeedHeroGlow" cx="0.5" cy="0.5" r="0.5">
                <stop offset="0" stopColor="#f3efe0" stopOpacity="0.45" />
                <stop offset="1" stopColor="#f3efe0" stopOpacity="0" />
              </radialGradient>
            </defs>
            <rect x="0" y="0" width="620" height="560" fill="url(#siSeedHeroDots)" />
            {/* rising library-growth area chart */}
            <path
              d="M0,474 C70,464 120,452 180,432 C240,412 300,372 360,344 C420,316 470,268 520,232 C560,203 590,190 620,176 L620,560 L0,560 Z"
              fill="url(#siSeedHeroArea)"
            />
            <path
              d="M0,474 C70,464 120,452 180,432 C240,412 300,372 360,344 C420,316 470,268 520,232 C560,203 590,190 620,176"
              fill="none"
              stroke="#d4af37"
              strokeWidth="2.6"
              strokeOpacity="0.6"
              strokeLinecap="round"
            />
            {/* peer links */}
            <g stroke="#d4af37" strokeOpacity="0.32" strokeWidth="1.4">
              <line x1="80" y1="130" x2="150" y2="210" />
              <line x1="80" y1="130" x2="175" y2="80" />
              <line x1="150" y1="210" x2="270" y2="140" />
              <line x1="150" y1="210" x2="240" y2="255" />
              <line x1="270" y1="140" x2="360" y2="95" />
              <line x1="240" y1="255" x2="390" y2="205" />
              <line x1="270" y1="140" x2="390" y2="205" />
              <line x1="175" y1="80" x2="360" y2="95" />
              <line x1="390" y1="205" x2="460" y2="150" />
              <line x1="120" y1="320" x2="150" y2="210" />
              <line x1="120" y1="320" x2="240" y2="255" />
              <line x1="240" y1="255" x2="270" y2="140" />
            </g>
            {/* signal pulses on two hub nodes */}
            <circle className="si-seedhero-pulse" cx="80" cy="130" r="9" fill="none" stroke="#d4af37" strokeWidth="2" opacity="0.5">
              <animate attributeName="r" values="9;30" dur="3.2s" repeatCount="indefinite" />
              <animate attributeName="opacity" values="0.5;0" dur="3.2s" repeatCount="indefinite" />
            </circle>
            <circle className="si-seedhero-pulse" cx="240" cy="255" r="9" fill="none" stroke="#f3efe0" strokeWidth="2" opacity="0.4">
              <animate attributeName="r" values="9;28" dur="3.6s" begin="1.1s" repeatCount="indefinite" />
              <animate attributeName="opacity" values="0.45;0" dur="3.6s" begin="1.1s" repeatCount="indefinite" />
            </circle>
            {/* node glows */}
            <circle cx="80" cy="130" r="26" fill="url(#siSeedHeroGlow)" />
            <circle cx="240" cy="255" r="24" fill="url(#siSeedHeroGlow)" />
            {/* peer nodes */}
            <g>
              <circle cx="175" cy="80" r="5" fill="#f3efe0" opacity="0.85" />
              <circle cx="270" cy="140" r="6" fill="#f3efe0" opacity="0.9" />
              <circle cx="360" cy="95" r="5" fill="#f3efe0" opacity="0.8" />
              <circle cx="390" cy="205" r="6.5" fill="#d4af37" />
              <circle cx="460" cy="150" r="4.5" fill="#f3efe0" opacity="0.7" />
              <circle cx="120" cy="320" r="6" fill="#f3efe0" opacity="0.85" />
              <circle cx="150" cy="210" r="8" fill="#d4af37" />
              <circle cx="80" cy="130" r="8" fill="#d4af37" />
              <circle cx="240" cy="255" r="8" fill="#d4af37" />
            </g>
          </svg>
);



/**
 * SeedNodeGuide — everything that explains what a seed node IS.
 *
 * This lived only on the locked page, which meant the moment somebody was
 * approved it all vanished: the two setup paths, the photographs, the drive
 * sizing and every answer to "what does this actually cost me" disappeared at
 * exactly the point they started buying hardware and wiring it up. The
 * reference material a person needs is not the recruiting material — it only
 * looked that way because the recruiting page was the only place it existed.
 *
 * Rendered by BOTH states now. Locked, it follows the requirements and does the
 * persuading. Unlocked, it sits at the foot of the control panel as the manual.
 */
function SeedNodeGuide({ scopeInfo }) {
  return (
    <>
      {/* ── WHAT ONE LOOKS LIKE ──────────────────────────────────────────
          Three more photographs of the same node. Small, captioned, and
          deliberately unglamorous: a machine on a shelf, a screen in a hand.
          The point is that this is ordinary and achievable, not a datacentre. */}
      <div className="page-header-wide">
        <div className="photo-strip">
          <figure
            className="photo-tile"
            style={{ backgroundImage: 'url(/images/seednode/shelf.jpg)' }}
          >
            <figcaption>On a shelf beside the router, next to the books it is keeping.</figcaption>
          </figure>
          <figure
            className="photo-tile"
            style={{ backgroundImage: 'url(/images/seednode/dashboard.jpg)' }}
          >
            <figcaption>The node&rsquo;s own display — coverage, peers, and what it is giving back.</figcaption>
          </figure>
          <figure
            className="photo-tile"
            style={{ backgroundImage: 'url(/images/seednode/in-hand.jpg)' }}
          >
            <figcaption>Small enough to hold. Quiet enough to forget it is running.</figcaption>
          </figure>
        </div>
      </div>

      {/* ── THE EXPLANATION ──────────────────────────────────────────────
          One column, not two. This used to sit beside the request form and
          open by repeating the hero's own paragraph almost word for word —
          the same "SermonIndex is built on a peer-to-peer network where every
          user helps share sermon content" sentence, twice on one screen. The
          hero makes the case; this answers the practical questions. */}
      <div className="page-header-wide">
        <article className="essay essay-wide">

          <div className="essay-mark">What a seed node actually does</div>
          <p className="essay-lede">
            Ordinary users share the sermons they have listened to. A seed node goes further: it
            downloads and serves a large portion of the whole library, so that the archive does not
            depend on anyone in particular staying online.
          </p>
          <p>
            You choose how much to hold. <strong>Audio-only</strong> is the practical, common choice —
            about <strong>{SCOPE_INFO.audio.sizeLabel}</strong>, which fits on a cheap external drive.
            Holding <strong>everything, including video</strong>, is about{' '}
            <strong>{SCOPE_INFO.full.sizeLabel}</strong> and needs a large one.
          </p>
          <p>
            Nothing about it is dramatic in daily life. The machine sits there. Every so often
            somebody, somewhere, pulls a sermon from it. That is the whole of it — and it is the
            reason the library cannot be switched off.
          </p>

          <div className="essay-mark">Two ways to do this</div>
          <p>
            There are exactly two, and most people know within a sentence which one is theirs. You
            do not need both, and neither is better for the network — a node is a node.
          </p>

        </article>
      </div>

      {/* The two paths break OUT of the essay's ~68-character measure and take
          the full page width. Inside the reading column the grid has room for
          one card, so they stacked — and two alternatives stacked vertically
          read as a list of recommendations rather than as a choice between
          them. Side by side, the choice is the point. */}
      <div className="page-header-wide">
        <div className="paths">

            <div className="path">
              <div
                className="path-photo"
                style={{ backgroundImage: 'url(/images/seednode/shelf.jpg)' }}
              >
                <span className="path-badge"><i>1</i>Use what you have</span>
              </div>
              <div className="path-body">
                <h4>A computer you already own, left switched on</h4>
                <p className="path-lede">
                  This same app, on an old laptop or a desktop that stays powered up, with a drive
                  attached. Nothing new to learn and nothing else to buy if you already have the
                  space.
                </p>
                <ul className="path-list">
                  <li><span><b>The machine:</b> any Mac, Windows or Linux computer that can stay awake — an old laptop with the lid open is perfect.</span></li>
                  <li><span><b>The drive:</b> internal if it has room, or an external USB/NVMe drive plugged in and left plugged in.</span></li>
                  <li><span><b>The size:</b> about {SCOPE_INFO.audio.sizeLabel} for audio, {SCOPE_INFO.full.sizeLabel} for everything including video.</span></li>
                  <li><span><b>Sleep is the enemy:</b> set the computer never to sleep. A sleeping node serves nobody.</span></li>
                </ul>
                <div className="path-for">
                  <b>Best for</b>
                  Anyone with a spare machine already sitting there. Start today, spend nothing.
                </div>
              </div>
            </div>

            <div className="path">
              <div
                className="path-photo"
                style={{ backgroundImage: 'url(/images/seednode/in-hand.jpg)' }}
              >
                <span className="path-badge"><i>2</i>A dedicated node</span>
              </div>
              <div className="path-body">
                <h4>A small machine that does nothing else</h4>
                <p className="path-lede">
                  A Raspberry Pi or similar single-board computer with a drive attached — the setup
                  in the photographs on this page. It sips power, makes no noise, and leaves your
                  main computer alone.
                </p>
                <ul className="path-list">
                  <li><span><b>The machine:</b> a Raspberry&nbsp;Pi&nbsp;5 with 8&nbsp;GB of memory, or any small always-on box.</span></li>
                  <li><span><b>The drive:</b> an NVMe SSD in the case, or an external 2.5&quot; SATA SSD over USB. Both work; NVMe is faster and quieter.</span></li>
                  <li><span><b>The size:</b> the same — around 500&nbsp;GB covers the audio library, 2.6&nbsp;TB or more with video.</span></li>
                  <li><span><b>Runs the CLI:</b> the command-line node, so it needs no screen — though a small touchscreen makes a lovely one.</span></li>
                </ul>
                <div className="path-for">
                  <b>Best for</b>
                  A node you set up once and forget, running quietly on a shelf for years.
                </div>
              </div>
            </div>

        </div>
      </div>

      <div className="page-header-wide">
        <article className="essay essay-wide" style={{ paddingTop: 0 }}>

          <p style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>
            Either way: use a solid-state drive if you can — spinning disks wear out in a machine
            that never sleeps — size it for the scope you choose, and keep the node powered on and
            online as much as you can. A node the internet can reach helps most, and this app will
            tell you plainly whether yours is.
          </p>

          <blockquote className="pullquote">
            With seed nodes spread across the world, the library becomes something that cannot
            usefully be attacked. There is no single place to pressure, no one server to lose, no
            company to outlive it. It is simply held, in thousands of homes, by the people it
            belongs to.
            <cite>Isaiah 52:7 &mdash; &ldquo;How beautiful&hellip; are the feet of those who bring good news&rdquo;</cite>
          </blockquote>

          <div className="essay-mark">Questions people ask</div>
          <p>
            The honest answers, including the ones that are not entirely comfortable. If
            yours is not here, ask &mdash; a real person reads the email.
          </p>

          <div className="faq">
            <details>
              <summary>Does this cost me anything?</summary>
              <div className="faq-a">
                <p>Two things, both small. <strong>Electricity</strong> — a Raspberry Pi draws around
      5&ndash;10 watts, which is a few pounds or dollars a year; an old laptop is perhaps
      three times that. And <strong>bandwidth</strong>, which is only a cost if your
      provider caps or bills you for it.</p>
      <p>Nothing is charged by SermonIndex, ever. There is no account, no subscription and
      nothing to cancel.</p>
              </div>
            </details>
            <details>
              <summary>How much of my internet will it use? Can I limit it?</summary>
              <div className="faq-a">
                <p>Yes, and you should set it deliberately rather than find out. In <strong>Settings</strong>
      there is an <strong>upload speed cap</strong> in KB/s and a <strong>monthly data cap</strong>;
      there is also a <strong>quiet window</strong>, so the node can share hard overnight and
      sit still during the day.</p>
      <p>Downloading the library the first time is the big one — that is a fixed, one-off
      cost of roughly the size you chose. After that a node only uses what people actually
      pull from it, which on a quiet day is nothing at all.</p>
              </div>
            </details>
            <details>
              <summary>Will it slow down my internet?</summary>
              <div className="faq-a">
                <p>It can if you let it, which is what the upload cap is for. Set it to something
      comfortable — a good rule is about half your upload speed — and you will not notice
      it. BitTorrent also yields to other traffic by design, so a video call or a large
      download will generally push it out of the way on its own.</p>
              </div>
            </details>
            <details>
              <summary>Can other people see my IP address?</summary>
              <div className="faq-a">
                <p>Yes, and you should know that before you start. Anyone you share a sermon with sees
      your internet address, because that is how any computer talks to any other computer —
      it is not specific to this app or to BitTorrent.</p>
      <p>What they cannot see is who you are, what else is on your machine, or anything you
      have listened to. If this is a concern where you live, turning sharing off in
      <strong>Settings</strong> stops it completely — you can still download and keep
      sermons.</p>
              </div>
            </details>
            <details>
              <summary>What happens if I turn the machine off, or go away for a fortnight?</summary>
              <div className="faq-a">
                <p>Nothing breaks. Your node simply stops serving while it is off and picks up where
      it left off when it comes back. Downloads resume; nothing is lost and nothing has to
      be re-fetched.</p>
      <p>The network is built on the assumption that any individual node is sometimes away.
      That is the entire reason there are many of them.</p>
              </div>
            </details>
            <details>
              <summary>Do I need to change anything on my router?</summary>
              <div className="faq-a">
                <p>Usually not. The app tries to open its own port automatically, and on many home
      connections &mdash; Starlink, mobile broadband, most modern providers &mdash; the newer
      kind of internet address (IPv6) means there is nothing to forward at all.</p>
      <p>The <strong>Connections</strong> page tells you plainly where you stand, and if a
      port forward would help it walks you through it. A node that cannot be reached from
      outside still contributes every day by connecting outward.</p>
              </div>
            </details>
            <details>
              <summary>Will it fill up my main drive?</summary>
              <div className="faq-a">
                <p>Only if you point it at your main drive. Step 2 of the setup asks where to put the
      library, and the sensible answer is a separate drive. The app checks there is enough
      free space before it starts and tells you if there is not.</p>
              </div>
            </details>
            <details>
              <summary>Which drive should I buy?</summary>
              <div className="faq-a">
                <p>A solid-state one. A mechanical hard disk in a machine that never sleeps is the
      thing most likely to fail on you in a couple of years. An NVMe stick in an enclosure
      or a 2.5&quot; SATA SSD over USB both work well.</p>
      <p>Size it for what you chose to hold, with some room spare &mdash; the library grows.</p>
              </div>
            </details>
            <details>
              <summary>What am I actually sharing? Is any of it restricted?</summary>
              <div className="faq-a">
                <p>Only the sermon files from the SermonIndex archive, unmodified. Nothing else on your
      computer is touched, offered or visible. These recordings are given freely for the
      glory of God: they may be shared, played and used in ministry, but never sold or used
      commercially.</p>
              </div>
            </details>
            <details>
              <summary>What happens when new sermons are added?</summary>
              <div className="faq-a">
                <p>They appear in the library on their own. A seed node can then download the new batch
      to stay complete &mdash; the <strong>Library Updates</strong> panel on this page tells
      you when there is something new.</p>
              </div>
            </details>
            <details>
              <summary>Do I have to leave the app open?</summary>
              <div className="faq-a">
                <p>On a computer you use day to day, yes &mdash; this app shares while it is running.
      On a dedicated machine, the <strong>command-line node</strong> is the better answer: it
      runs as a background service with no window and no screen, starts itself after a power
      cut, and serves the same library.</p>
              </div>
            </details>
            <details>
              <summary>Can I stop later, or remove everything?</summary>
              <div className="faq-a">
                <p>Yes, at any moment and without telling anyone. Turn sharing off in
      <strong>Settings</strong> and your node stops serving immediately; delete the folder
      and it is gone. Nothing is registered anywhere that you have to undo.</p>
              </div>
            </details>
          </div>

          <p style={{ marginTop: 'var(--space-5)', marginBottom: 0 }}>
            Still stuck? Email{' '}
            <a href={`mailto:${SEED_CONTACT_EMAIL}`} style={{ color: 'var(--gold-text)' }}>{SEED_CONTACT_EMAIL}</a>
            {' '}about hardware, storage, or getting approved.
          </p>

        </article>
      </div>
    </>
  );
}

export default function SeedNodePage({
  seedUnlocked,
  onUnlock,
  catalog,
  libraryStats,
  downloadManager,
  downloadStates,
  nodeStats,
}) {
  const [error, setError] = useState('');
  // Seed access is granted per-device via the backend allowlist (no password).
  const [nodeId] = useState(() => { try { return getNodeId(); } catch { return ''; } });
  const [checkingAccess, setCheckingAccess] = useState(false);
  const [accessMsg, setAccessMsg] = useState('');
  const [reqEmail, setReqEmail] = useState('');
  const [requested, setRequested] = useState(false);
  // Inline hardware-recommendations panel shown in the locked "What is a Seed
  // Node?" card — expands in-app in place of the old external forums link.
  // `showHardware` lived here: the hardware guide used to be a disclosure the
  // reader had to find and open. It is now just part of the page, under its own
  // heading, because a recommendation nobody opens is a recommendation nobody
  // reads — and this one is the difference between a node that works and a
  // drive that dies in six months.

  // STEP 1 — what to host. Persisted to localStorage; default 'audio'.
  const [scope, setScope] = useState(() => {
    try {
      const saved = localStorage.getItem(SEED_SCOPE_KEY);
      if (saved === 'audio' || saved === 'full') return saved;
    } catch {}
    return 'audio';
  });
  const setScopePersisted = useCallback((next) => {
    setScope(next);
    try { localStorage.setItem(SEED_SCOPE_KEY, next); } catch {}
    // Changing scope invalidates a prior space check (thresholds differ).
    setStorageVerified(false);
    setStorageError('');
  }, []);

  // STEP 2 — storage location
  const [storagePath, setStoragePath] = useState('');
  const [confirmedPath, setConfirmedPath] = useState(''); // what the backend reports
  const [storageVerified, setStorageVerified] = useState(false);
  const [storageError, setStorageError] = useState('');
  const [savingPath, setSavingPath] = useState(false);
  const [diskInfo, setDiskInfo] = useState(null); // { available_bytes, available_formatted, available_tb }

  // STEP 3 — reachability. Seeded from the SAVED probe result so leaving this
  // page and coming back (or reopening the app) still shows the answer you
  // already got — and so the "Verified Seed Node" badge below, which depends on
  // it, doesn't claim you're unreachable simply because you haven't re-tested
  // this session. The saved result never expires and is only replaced by an
  // explicit Re-test. Shape: null | { open, open_v6, …, ts, port? }
  const [reach, setReach] = useState(() => readReachability());
  // PASSIVE inbound-IPv6 observation, read once on mount. Separate from `reach`
  // on purpose: it is sticky and survives a node that has never been probed. A
  // seed node reachable ONLY over IPv6 (the normal outcome on Starlink) is
  // genuinely reachable, and the badge below must not call it unreachable.
  const [v6obs] = useState(() => readIpv6Observation());
  // In flight, kept out of `reach` so a running (or failed) test never blanks
  // the result already on screen.
  const [testing, setTesting] = useState(false);
  const [reachPort, setReachPort] = useState(null);

  // STEP 4 — download
  const [downloading, setDownloading] = useState(false);
  const [batchProgress, setBatchProgress] = useState(null);
  // Files still failing after the download manager's automatic retry passes.
  const [failedItems, setFailedItems] = useState([]);
  const [isPaused, setIsPaused] = useState(false);

  // On unlock, show whatever storage dir the backend already has configured.
  useEffect(() => {
    if (!seedUnlocked) return;
    let cancelled = false;
    (async () => {
      await ensureTauri();
      if (!tauriInvoke) return;
      try {
        const current = await tauriInvoke('get_storage_dir');
        if (!cancelled && current) {
          setConfirmedPath(current);
          setStoragePath(prev => prev || current);
        }
      } catch {}
    })();
    return () => { cancelled = true; };
  }, [seedUnlocked]);

  // Auto-check access on mount: if the admin has enabled this node id in the
  // backend allowlist, unlock the page automatically.
  useEffect(() => {
    if (seedUnlocked || !nodeId) return;
    let cancelled = false;
    (async () => {
      const ok = await checkSeedAccess(nodeId);
      if (cancelled) return;
      // Mirror the server's answer locally — see utils/nodeStatus.js. This is
      // what lets the Connections panel tell a Seed node from a Node.
      writeSeedGranted(ok);
      if (ok) onUnlock(true);
    })();
    return () => { cancelled = true; };
  }, [seedUnlocked, nodeId, onUnlock]);

  const checkAccess = async () => {
    if (!nodeId) return;
    setCheckingAccess(true);
    setAccessMsg('');
    const ok = await checkSeedAccess(nodeId);
    writeSeedGranted(ok);
    if (ok) onUnlock(true);
    else setAccessMsg('Not approved yet. Once the admin enables your node, press "Check access" again.');
    setCheckingAccess(false);
  };

  const submitRequest = async () => {
    if (!nodeId) return;
    setCheckingAccess(true);
    setAccessMsg('');
    const res = await requestSeedAccess(nodeId, reqEmail.trim());
    if (res?.enabled) { writeSeedGranted(true); onUnlock(true); }
    else if (res?.requested) {
      setRequested(true);
      setAccessMsg("Request sent. You'll get access once the admin approves your node — then press \"Check access\".");
    } else {
      setAccessMsg('Could not send the request — check your connection and try again.');
    }
    setCheckingAccess(false);
  };

  // ── STEP 2: browse for + save a REAL storage directory ────────────────────
  const browsePath = useCallback(async () => {
    await ensureTauri();
    if (tauriDialog) {
      try {
        const selected = await tauriDialog.open({ directory: true, title: 'Select Seed Node Storage Location' });
        if (selected) {
          // Immediately apply the chosen folder so downloads actually use it.
          await applyStoragePath(selected);
        }
      } catch (e) {
        console.warn('[SeedNode] Dialog failed:', e);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope]);

  // Apply + verify a storage path: tell the backend to use it (so real
  // downloads land there), read it back for display, then check free space
  // against the current scope's requirement.
  const applyStoragePath = useCallback(async (rawPath) => {
    const path = (rawPath ?? storagePath ?? '').trim();
    if (!path) {
      setStorageError('Please choose a storage folder.');
      return;
    }
    setStoragePath(path);
    setSavingPath(true);
    setStorageError('');
    setStorageVerified(false);
    setDiskInfo(null);

    await ensureTauri();
    if (!tauriInvoke) {
      // Browser mode — no backend; accept the path so the UI can proceed.
      setConfirmedPath(path);
      setStorageVerified(true);
      setSavingPath(false);
      return;
    }

    // 1. Make downloads ACTUALLY use this folder (persisted in settings.json).
    try {
      const saved = await tauriInvoke('set_storage_dir', { path });
      setConfirmedPath(saved || path);
    } catch (e) {
      setStorageError(`Could not set storage folder: ${e}`);
      setSavingPath(false);
      return;
    }

    // 2. Read back the confirmed path from the backend for display.
    try {
      const current = await tauriInvoke('get_storage_dir');
      if (current) setConfirmedPath(current);
    } catch {}

    // 3. Verify free space against the scope requirement.
    const req = SCOPE_INFO[scope];
    try {
      const info = await tauriInvoke('check_disk_space', { path });
      setDiskInfo(info);
      const availableBytes = Number(info?.available_bytes || 0);
      if (availableBytes < req.requiredBytes) {
        setStorageVerified(false);
        setStorageError(
          `Only ${info.available_formatted} free (${info.available_tb} TB) on this drive. ` +
          `The ${req.label.toLowerCase()} needs at least ${req.requiredLabel} of free space.`
        );
      } else {
        setStorageVerified(true);
        setStorageError('');
      }
    } catch (e) {
      // Path saved but space check failed (e.g. df couldn't read it).
      setStorageError(`Storage folder saved, but could not verify free space: ${e}`);
    }
    setSavingPath(false);
  }, [scope, storagePath]);

  // ── STEP 3: reachability test (mirrors ConnectionsPanel) ──────────────────
  const testReachability = useCallback(async () => {
    setTesting(true);
    // Get the node's listening port from the torrent session.
    let port = reachPort;
    try {
      const mod = await ensureTorrent();
      if (mod) {
        const st = await mod.getStatus().catch(() => null);
        port = st?.tcp_listen_port || port;
      }
    } catch {}
    if (!port) {
      setTesting(false);
      setReach({ open: false, port: null, noPort: true, ts: Date.now() });
      return;
    }
    setReachPort(port);

    const result = await probeReachability(port);
    setTesting(false);
    if (result) {
      setReach({ ...result, port, ts: Date.now() });
      saveReachability(result);
      // Register in the backbone directory so new users can find reachable seeds.
      try {
        const scope = (() => { try { return localStorage.getItem('si-seed-scope') || 'audio'; } catch { return 'audio'; } })();
        registerSeed(getNodeId(), port, scope).catch(() => {});
      } catch {}
      return;
    }
    // Probe service unavailable — fall back to canyouseeme.org so the seed
    // node can still confirm the port manually.
    setReach({ open: false, port, manual: true, ts: Date.now() });
    await ensureTauri();
    if (tauriInvoke) {
      try { await tauriInvoke('open_url', { url: 'https://canyouseeme.org/' }); } catch {}
    }
  }, [reachPort]);

  // ── STEP 4: scope-filtered bulk download ──────────────────────────────────
  const runSeedBatch = useCallback(async (toDownload) => {
    if (!downloadManager || toDownload.length === 0) return;
    setDownloading(true);
    setFailedItems([]);

    let result = { failures: [] };
    try {
      // downloadBatch retries each file (backoff + Archive↔CDN fallback) and
      // then automatically re-runs the whole failed set a couple of times
      // before it reports anything as failed.
      result = await downloadManager.downloadBatch(toDownload, (progress) => {
        setBatchProgress({ ...progress });
      });
    } catch (err) {
      console.error('[SeedNode] Batch download error:', err);
    }
    setFailedItems(result.failures || []);
    setDownloading(false);
  }, [downloadManager]);

  const startFullDownload = useCallback(() => {
    const toDownload = scope === 'audio'
      ? catalog.filter(s => s.type === 'audio' && !s.downloaded)
      : catalog.filter(s => !s.downloaded);
    runSeedBatch(toDownload);
  }, [catalog, scope, runSeedBatch]);

  const retryFailed = useCallback(() => {
    const sermons = failedItems.map(f => f.sermon).filter(Boolean);
    runSeedBatch(sermons);
  }, [failedItems, runSeedBatch]);

  const togglePause = useCallback(() => {
    if (!downloadManager) return;
    if (isPaused) {
      downloadManager.resume();
      setIsPaused(false);
    } else {
      downloadManager.pause();
      setIsPaused(true);
    }
  }, [downloadManager, isPaused]);

  // ── The whole corpus, for the recruiting header ───────────────────────────
  // The header used to carry "25,000+ / ~412 GB / Always-on", which is not three
  // readings of anything: the first two are the same fact stated twice and the
  // third is a word. These are three different facts about the actual library,
  // counted from the catalogue this app is holding — so the number moves when
  // the library does, and a figure row means something again.
  const corpus = React.useMemo(() => {
    const list = Array.isArray(catalog) ? catalog : [];
    const speakers = new Set();
    let audio = 0, video = 0;
    for (const s of list) {
      if (s?.speaker) speakers.add(s.speaker);
      if (s?.type === 'video') video++; else audio++;
    }
    return { total: list.length, speakers: speakers.size, audio, video };
  }, [catalog]);

  // ── Scope-aware counts ────────────────────────────────────────────────────
  const scopeInfo = SCOPE_INFO[scope];
  const inScope = scope === 'audio'
    ? catalog.filter(s => s.type === 'audio')
    : catalog;
  const scopeTotal = inScope.length;
  const scopeDownloaded = inScope.filter(s => s.downloaded).length;
  const scopeRemaining = scopeTotal - scopeDownloaded;
  const scopePercent = scopeTotal > 0 ? (scopeDownloaded / scopeTotal) * 100 : 0;

  const displayProgress = batchProgress
    ? { completed: batchProgress.completed, total: batchProgress.total, failed: batchProgress.failed, percent: batchProgress.progress, retrying: !!batchProgress.retrying }
    : { completed: scopeDownloaded, total: scopeTotal, failed: 0, percent: scopePercent, retrying: false };

  // ── Where the operator actually is in the four-step setup ──────────────────
  // Every one of these is MEASURED, not remembered. A step is done because the
  // thing it asks for is true right now — the folder is verified, a probe or a
  // real inbound peer says we're reachable, the library is on disk — so the
  // rail can never claim a step is finished after the drive is unplugged or the
  // port closes. That matters more here than on an ordinary wizard: a seed node
  // that silently stopped being reachable looks exactly like one that never
  // was, and the operator is the only person who can fix it.
  //
  // Step 1 has a default (audio), so it is complete on arrival. Saying
  // otherwise would put a red mark against a choice the app made for you.
  const reachableNow = isReachable({ reach, ipv6: v6obs });
  const stepDone = [
    true,
    !!storageVerified || !!confirmedPath,
    reachableNow,
    scopeTotal > 0 && scopeRemaining === 0,
  ];
  // The current step is the first unfinished one. Once they are all finished
  // there is no current step, and nothing on the page pulses for attention —
  // which is the correct end state for a node that is simply running.
  const currentStep = stepDone.findIndex(d => !d);
  // ── Which steps are OPEN ──────────────────────────────────────────────────
  // A finished step collapses; the one you are on stays open. Clicking a row
  // overrides that for the session, which is why this holds explicit entries
  // rather than a single index: "I finished step 2 but want to look at it
  // again" and "step 3 is next" are two different facts and both have to be
  // true at once.
  const [stepToggled, setStepToggled] = useState({});
  const stepOpen = (i) => (i in stepToggled ? stepToggled[i] : !stepDone[i]);
  const toggleStep = (i) => setStepToggled((m) => ({ ...m, [i]: !stepOpen(i) }));

  // What each finished step PRODUCED. Shown in its collapsed row, because the
  // answer is more use than the form that produced it.
  const stepValue = [
    `${scopeInfo.label} · ${scopeInfo.sizeLabel}`,
    confirmedPath || storagePath || '',
    reachableNow ? (reach?.open ? 'Reachable over IPv4' : 'Reachable over IPv6') : '',
    scopeTotal > 0 ? `${scopeDownloaded.toLocaleString()} of ${scopeTotal.toLocaleString()} files` : '',
  ];

  const stepClass = (i, opts = {}) => [
    'seed-card', 'step-card',
    stepDone[i] ? 'done' : '',
    currentStep === i ? 'current' : '',
    stepOpen(i) ? 'open' : '',
    opts.locked ? 'locked' : '',
  ].filter(Boolean).join(' ');

  // One head for all four, so the medallion, the value line, the state chip and
  // the caret can never drift apart between steps.
  const StepHead = ({ i, n, title, locked }) => (
    <button
      type="button"
      className="step-head"
      aria-expanded={stepOpen(i)}
      onClick={() => toggleStep(i)}
    >
      <span className="step-num" aria-hidden="true">{stepDone[i] ? '\u2713' : n}</span>
      <div className="step-title">
        <h3>{title}</h3>
        {!stepOpen(i) && stepValue[i] && <span className="step-value">{stepValue[i]}</span>}
      </div>
      {stepState(i, { locked })}
      <span className="step-caret" aria-hidden="true">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </span>
    </button>
  );
  const stepState = (i, opts = {}) => {
    if (stepDone[i]) return <span className="step-state done">Done</span>;
    if (opts.locked) return <span className="step-state">Locked</span>;
    if (currentStep === i) return <span className="step-state current">Next</span>;
    return <span className="step-state">To do</span>;
  };

  // ─── LOCKED STATE ─────────────────────────────────────────────────

  if (!seedUnlocked) {
    return (
      <div className="settings-page-root">

        {/* ── THE HERO IS A PHOTOGRAPH ─────────────────────────────────────
            This page's whole job is to persuade somebody to put a machine in
            their house and leave it running. It was doing that with a line
            drawing and an SVG chart — honest, and completely abstract.

            These are photographs of a real node: a small screen glowing on a
            stack of old theology books, in somebody's actual room. That does
            more than any paragraph about indestructible archives, because it
            answers the question the reader is really asking, which is not "why
            does this matter" but "what would this look like in my house". */}
        <div className="page-header-wide">
          <header className="photo-hero">
            <div className="photo-hero-wrap">
              <div className="masthead-kick">Become a Seed Node</div>
              <h2>Keep a complete copy of the library in your own home.</h2>
              <p>
                Over 25,000 sermons — everything SermonIndex has gathered in more than two decades —
                held on one drive, on one machine, in one room. Enough of us doing that and there is
                no longer any single place this can be taken from.
              </p>
              {/* Three facts about the WHOLE corpus, counted from the catalogue
                  rather than typed into the markup — so they move when the
                  library does. The previous row ("25,000+ / ~412 GB /
                  Always-on") stated the same fact twice and then a word. */}
              <div className="masthead-figures photo-hero-figures">
                <div>
                  <b>{corpus.total > 0 ? corpus.total.toLocaleString() : '25,000+'}</b>
                  <small>Sermons in the library</small>
                </div>
                <div>
                  <b>{corpus.speakers > 0 ? corpus.speakers.toLocaleString() : '—'}</b>
                  <small>Preachers</small>
                </div>
                <div>
                  <b>{corpus.video > 0 ? corpus.video.toLocaleString() : '—'}</b>
                  <small>With video</small>
                </div>
              </div>
            </div>
          </header>
        </div>

        {/* ── THE ASK, IMMEDIATELY ─────────────────────────────────────────
            This was a half-width card underneath the hero AND three requirement
            columns, so on a laptop you scrolled past everything to reach the one
            thing the page is for. Full width, directly under the hero. */}
        <div className="page-header-wide">
          <div className="ask">
            <div>
              <h3 style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                {iconLock} Ask to be a seed node
              </h3>
              <p style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', margin: '0 0 var(--space-3)' }}>
                Access is granted per machine by the SermonIndex admin — seed nodes are the trusted
                backbone of the network, so a person approves each one.
              </p>
              <div className="ask-label">This machine&rsquo;s ID</div>
              <div className="credential" style={{ margin: 0 }}>
                <span className="credential-value">#{(nodeId || '').slice(0, 8)}</span>
                <button
                  className="btn btn-outline"
                  onClick={() => { try { navigator.clipboard.writeText(nodeId); setAccessMsg('Full node ID copied to clipboard.'); } catch {} }}
                >
                  Copy
                </button>
              </div>
            </div>

            <div>
              <div className="ask-label">Your email</div>
              <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', marginBottom: 'var(--space-3)' }}>
                <input
                  type="email"
                  placeholder="you@example.com"
                  value={reqEmail}
                  onChange={e => setReqEmail(e.target.value)}
                  style={{ flex: 1, minWidth: '200px' }}
                />
                <button className="btn btn-gold" onClick={submitRequest} disabled={checkingAccess || requested}>
                  {requested ? 'Requested ✓' : 'Request access'}
                </button>
                <button className="btn btn-outline" onClick={checkAccess} disabled={checkingAccess}>
                  {checkingAccess ? 'Checking…' : 'Check access'}
                </button>
              </div>
              <p style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', margin: 0 }}>
                Or email{' '}
                <a href={`mailto:${SEED_CONTACT_EMAIL}`} style={{ color: 'var(--gold-text)' }}>{SEED_CONTACT_EMAIL}</a>
                {' '}with the ID above. Once your node is enabled, press <strong>Check access</strong> and this
                page turns into your control panel.
              </p>
              {accessMsg && (
                <p style={{ color: 'var(--text-secondary)', fontSize: 'var(--text-sm)', marginTop: '10px' }}>{accessMsg}</p>
              )}
            </div>
          </div>
        </div>

        {/* ── WHAT IT ACTUALLY TAKES ──────────────────────────────────────
            A recruiting page that only says why the thing matters, and never
            what it costs, reads like a pitch. Three plain requirements, so
            somebody can decide whether this is for them — and so nobody is
            approved and then discovers they needed a drive they haven't got. */}
        <div className="page-header-wide">
          <div className="essay-points" style={{ margin: '0 0 var(--space-5)' }}>
            <div className="essay-point">
              <b>A spare drive</b>
              <span>
                About {SCOPE_INFO.audio.sizeLabel} for the audio library, or {SCOPE_INFO.full.sizeLabel} for
                everything including video. An external NVMe is ideal.
              </span>
            </div>
            <div className="essay-point">
              <b>A machine you leave on</b>
              <span>
                A Raspberry Pi, an old laptop, anything quiet. A node only serves while it is running.
              </span>
            </div>
            <div className="essay-point">
              <b>An ordinary connection</b>
              <span>
                No fixed address and no port-forwarding needed — most homes work as they are, and the
                app tells you plainly where you stand.
              </span>
            </div>
          </div>
        </div>

        <SeedNodeGuide scopeInfo={scopeInfo} />

      </div>
    );
  }

  // ─── UNLOCKED STATE ───────────────────────────────────────────────

  return (
    <div className="settings-page-root">
      {/* The page changes character once you are approved. Locked, it is a
          recruiting pitch and gets the full hero. Unlocked, it is an instrument
          panel for a machine that is already running, so the masthead goes
          compact and spends its width on live figures instead of copy. Showing
          an approved operator the "why you should do this" pitch every time
          they open the page is asking them to buy something they already own. */}
      <div className="page-header-wide">
        <PageHead
          kicker="Seed Node"
          art={seedArt}
          icon={<PiBoard size={46} />}
          title="Your node is carrying the library"
          sub="Set up in four steps below. Everything here is measured live — nothing is remembered from a previous run."
          figures={[
            { value: `${scopeTotal > 0 ? Math.round(scopePercent) : 0}%`, label: 'Library held' },
            { value: scopeDownloaded.toLocaleString(), label: 'Files seeded' },
            { value: libraryStats?.downloadedSize || '0 B', label: 'On disk' },
          ]}
          aside={
            <>
              <span className={`brand-chip ${reachableNow ? 'ok' : 'gold'}`}>
                <i className="dot" />{reachableNow ? 'Reachable' : 'Not confirmed'}
              </span>
              <span className="brand-chip gold">
                <b>{scopeInfo.label}</b>
              </span>
            </>
          }
        />
      </div>

      {/* ── MISSION CONTROL ────────────────────────────────────────────────
          The four readings an operator opens this page to check, directly under
          the masthead. They used to live at the bottom of the RIGHT column,
          below Library Updates — beneath a setup wizard the reader finished
          months ago. The thing you came for goes first. */}
      <div className="page-header-wide">
        <div className="control">
          <div>
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '12px' }}>
              <b style={{ fontSize: 'var(--text-xl)', fontWeight: 700, color: 'var(--text-primary)' }}>
                {scopeTotal > 0 ? scopePercent.toFixed(scopePercent >= 10 ? 0 : 1) : 0}%
              </b>
              <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>95% = verified</span>
            </div>
            <div className="viz-meter" style={{ marginTop: '8px', height: '12px' }}>
              <i
                className={scopePercent >= 95 ? 'ok' : ''}
                style={{ width: `${Math.min(100, Math.max(0, scopePercent))}%` }}
              />
              <span className="viz-meter-mark" style={{ left: '95%' }} />
            </div>
            <div style={{ marginTop: '7px', fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
              {scopeDownloaded.toLocaleString()} of {scopeTotal.toLocaleString()} · {scopeInfo.label}
            </div>
          </div>

          <div className="control-read">
            <b style={{ color: reachableNow ? 'var(--green)' : 'var(--text-muted)' }}>
              {reachableNow ? 'Yes' : 'Not yet'}
            </b>
            <small>Reachable</small>
          </div>

          <div className="control-read">
            <b>{libraryStats?.downloadedSize || '0 B'}</b>
            <small>On disk</small>
          </div>

          <div className="control-read">
            <b style={{ color: isPaused ? 'var(--gold-text)' : downloading ? 'var(--green)' : 'var(--text-muted)' }}>
              {isPaused ? 'Paused' : downloading ? 'Active' : 'Idle'}
            </b>
            <small>Downloading</small>
          </div>
        </div>
      </div>

      {/* Two columns (the shared Settings/Connections layout).
          This page is a numbered setup flow, so Steps 1–4 stay together in ONE
          column, in order, top to bottom — splitting a "step 1, 2, 3, 4"
          sequence across two columns would make the order ambiguous. Only the
          genuinely independent cards (updates, live status readout, contact)
          move to the right, where the status figures now sit alongside the
          steps that produce them instead of far below them. */}
      <div className="connections-layout">
      <div className="connections-left">

      {/* The four steps are one object, not four cards that happen to be
          stacked: the rail down the left binds them, and each medallion reports
          that step's real state. See `stepDone` above. */}
      <div className="step-list">

      {/* Step 1: Choose what to host */}
      <div className={stepClass(0)}>
        <StepHead i={0} n="1" title="Choose What to Host" />
        <div className="step-body">
        <p>
          Pick how much of the library your node will hold. Audio-only is the common choice and fits
          a small drive; the full set adds every video and needs a large drive. You can start with
          audio and expand later.
        </p>
        {/* The selection lives in `aria-pressed`, which the stylesheet reads
            directly — so a sighted user and a screen-reader user can never be
            shown different answers, and the styling cannot drift from the
            state the way a parallel `active ? ... : ...` inline style does. */}
        <div className="scope-grid">
          {['audio', 'full'].map((key) => {
            const info = SCOPE_INFO[key];
            const active = scope === key;
            return (
              <button
                key={key}
                type="button"
                className="scope-opt"
                aria-pressed={active}
                onClick={() => setScopePersisted(key)}
              >
                {/* The flag row exists on both options so their titles share a
                    baseline; only one of them has anything in it. */}
                <div className="scope-opt-flag">
                  {key === 'audio' && <span className="scope-rec">Recommended</span>}
                </div>
                <div className="scope-opt-head">
                  <span className="scope-radio" aria-hidden="true">{active && <i />}</span>
                  <span className="scope-opt-name">{info.label}</span>
                </div>
                <div className="scope-opt-desc">{info.tagline}</div>
              </button>
            );
          })}
        </div>
        </div>
      </div>

      {/* Step 2: Storage location (real) */}
      <div className={stepClass(1)}>
        <StepHead i={1} n="2" title="Choose Your Storage Location" />
        <div className="step-body">
        <p>
          Pick a folder on a drive with at least{' '}
          <strong style={{ color: 'var(--gold-text)' }}>{scopeInfo.requiredLabel}</strong> of free space
          — the {scopeInfo.label.toLowerCase()} is {scopeInfo.sizeLabel}. We recommend a dedicated external
          NVMe drive — for example a <strong style={{ color: 'var(--gold-text)' }}>TerraMaster D4</strong> NVMe
          enclosure with NVMe sticks, or a <strong style={{ color: 'var(--gold-text)' }}>Raspberry Pi 5</strong> in
          a Pironman 5 case with an NVMe SSD for a quiet, always-on node.
        </p>
        <p style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>
          Downloads and seeding will use this exact folder. Changing it only affects future downloads —
          files already on disk stay where they are.
        </p>

        <div style={{ display: 'flex', gap: '8px', marginTop: '8px', alignItems: 'center' }}>
          <input
            type="text"
            placeholder="/Volumes/SermonIndex-Drive/sermons"
            value={storagePath}
            onChange={e => { setStoragePath(e.target.value); setStorageVerified(false); setStorageError(''); }}
            onKeyDown={e => e.key === 'Enter' && applyStoragePath()}
            style={{ flex: 1 }}
          />
          <button
            className="btn btn-outline"
            onClick={browsePath}
            style={{ whiteSpace: 'nowrap' }}
          >
            Browse…
          </button>
          <button
            className="btn btn-gold"
            onClick={() => applyStoragePath()}
            disabled={savingPath}
          >
            {savingPath ? 'Checking...' : 'Use & Verify'}
          </button>
        </div>

        {confirmedPath && (
          <p style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', marginTop: '10px' }}>
            Downloads will be saved to:{' '}
            <span style={{ fontFamily: 'monospace', color: 'var(--text-primary)' }}>{confirmedPath}</span>
          </p>
        )}

        {storageError && (
          <p style={{ color: 'var(--red)', fontSize: 'var(--text-sm)', marginTop: '8px' }}>✕ {storageError}</p>
        )}
        {storageVerified && !storageError && (
          <p style={{ color: 'var(--green)', fontSize: 'var(--text-sm)', marginTop: '8px' }}>
            ✓ Storage set and space verified
            {diskInfo ? ` — ${diskInfo.available_formatted} free (${diskInfo.available_tb} TB), enough for the ${scopeInfo.label.toLowerCase()} at ${scopeInfo.sizeLabel}.` : '.'}
          </p>
        )}
        </div>
      </div>

      {/* Step 3: Reachability */}
      <div className={stepClass(2)}>
        <StepHead i={2} n="3" title={<>Verify You&rsquo;re Reachable</>} />
        <div className="step-body">
        <p>
          Seed nodes are most valuable when other peers can connect <em>directly</em> to your node.
          This test checks whether your node's port is reachable from the internet.
        </p>

        <div style={{ display: 'flex', gap: '10px', alignItems: 'center', marginTop: '8px' }}>
          <button className="btn btn-gold" onClick={testReachability} disabled={testing}>
            {testing ? 'Testing…' : reach ? 'Re-test' : 'Test Reachability'}
          </button>
          {reachPort && (
            <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>
              Node port: <strong style={{ color: 'var(--text-primary)' }}>{reachPort}</strong>
            </span>
          )}
          {/* The result is kept indefinitely and never re-probed on its own, so
              its age is shown alongside the button that refreshes it. */}
          {!testing && reach?.ts && (
            <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>
              Last tested {timeAgo(reach.ts)}
            </span>
          )}
        </div>

        {reach && !testing && (
          reach.open ? (
            <p style={{ color: 'var(--green)', fontSize: 'var(--text-sm)', marginTop: '12px', fontWeight: 600 }}>
              ✓ Reachable — you're strengthening the backbone.
            </p>
          ) : reach.open_v6 ? (
            /* IPv4 closed, IPv6 open. A full, reachable seed node — just over the
               newer kind of address. No port-forward steps: there is nothing to
               forward, and on Starlink or mobile broadband there never will be. */
            <div style={{ marginTop: '12px' }}>
              <p style={{ color: 'var(--green)', fontSize: 'var(--text-sm)', fontWeight: 600, marginBottom: '6px' }}>
                ✓ Reachable over IPv6 — you're strengthening the backbone.
              </p>
              <p style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', lineHeight: 1.6, margin: 0 }}>
                We connected to your node from outside, so other people can too. They reach you on the newer
                kind of internet address (IPv6). The older kind (IPv4) is closed, which is completely normal on
                Starlink, T-Mobile Home Internet and mobile broadband — those providers share one old-style
                address between many homes but give each home a real modern one. There&rsquo;s nothing here for
                you to change or forward.
              </p>
            </div>
          ) : (
            <div style={{ marginTop: '12px' }}>
              {/* Peer colour — the same one the node map uses for a port-closed
                  node (NODE_COLORS.peer → var(--gold-text) in NetworkPage.jsx). */}
              <p style={{ color: reach.noPort ? 'var(--orange)' : 'var(--gold-text)', fontSize: 'var(--text-sm)', fontWeight: 600, marginBottom: '8px' }}>
                {reach.noPort
                  ? 'Not reachable yet — the P2P session isn\'t running, so there\'s no port to test. Start the node, then test again.'
                  /* A result restored from a previous session has no port recorded,
                     so fall back to neutral wording rather than "Port undefined". */
                  : `${reach.port || reachPort ? `Port ${reach.port || reachPort}` : "Your node's port"} isn't reachable from outside — your node still uploads to every peer it reaches, but others can't connect to you.`}
              </p>
              {!reach.noPort && (
                <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                  {/* Explain the cause nobody can fix BEFORE the router steps —
                      a seed node on Starlink or mobile broadband will never be
                      able to follow them, and shouldn't be sent chasing. */}
                  <CgnatNotice
                    detected={!!reach.cgnat}
                    v6Firewalled={!!reach.has_ipv6 && reach.v6_probe === 'ok' && reach.open_v6 === false}
                    style={{ marginTop: 0, marginBottom: '10px' }}
                  />
                  <p style={{ margin: '0 0 6px' }}>If your connection does allow it, the quickest fixes are:</p>
                  <p style={{ margin: '0 0 4px' }}>
                    1. In your router settings, turn on <strong>UPnP</strong>, then restart this app.
                  </p>
                  <p style={{ margin: '0 0 6px' }}>
                    2. Or add a port forward: <strong>TCP {reach.port || reachPort || "your node's port"}</strong> (or the range
                    {' '}<strong>{TORRENT_PORT_RANGE}</strong>) pointing to this computer.
                  </p>
                  {reach.manual && (
                    <p style={{ margin: 0, color: 'var(--text-muted)' }}>
                      Opened canyouseeme.org — enter port <strong>{reach.port}</strong> there to double-check.
                    </p>
                  )}
                </div>
              )}
            </div>
          )
        )}
        </div>
      </div>

      {/* Step 4: Download the library (scope-filtered) */}
      {/* Locked until a storage folder is verified — but `.locked` dims to 0.68
          and keeps pointer-events off only the body, where `opacity: 0.4` used
          to take this entire card below the contrast floor. The step you cannot
          start yet is exactly the one you most want to read ahead on. */}
      <div className={stepClass(3, { locked: !storageVerified })}>
        <StepHead
          i={3}
          n="4"
          title={`Download the ${scope === 'audio' ? 'Audio Library' : 'Full Library'}`}
          locked={!storageVerified}
        />
        <div className="step-body">
        <p>
          Download the {scopeInfo.label.toLowerCase()} to your drive. The total size is approximately{' '}
          <strong style={{ color: 'var(--gold-text)' }}>{scopeInfo.sizeLabel}</strong>
          {' '}({scopeTotal.toLocaleString()} {scope === 'audio' ? 'sermons' : 'files'}).
        </p>
        <p style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>
          This can take <strong>several days or weeks</strong> depending on your connection speed. The download will
          automatically resume if you shut down the computer and turn it back on. You can pause and resume anytime.
        </p>

        {!downloading ? (
          <div style={{ marginTop: '12px' }}>
            <p style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', marginBottom: '16px' }}>
              Already downloaded: <strong style={{ color: 'var(--gold-text)' }}>{scopeDownloaded.toLocaleString()}</strong>
              {' '}· Remaining: <strong>{scopeRemaining.toLocaleString()}</strong>
            </p>
            {failedItems.length > 0 && (
              <div style={{
                padding: '12px 14px', marginBottom: '14px', borderRadius: 'var(--radius)',
                background: 'var(--bg-tertiary)', border: '1px solid var(--red)',
              }}>
                <div style={{ fontWeight: 600, color: 'var(--red)', marginBottom: '4px' }}>
                  {failedItems.length} file{failedItems.length === 1 ? '' : 's'} failed after retries
                </div>
                <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', marginBottom: '10px' }}>
                  Every other file finished. These are usually temporary source hiccups (rate limiting or a
                  dropped connection) — retrying later almost always clears them.
                </div>
                <button className="btn btn-gold" onClick={retryFailed}>Retry failed ({failedItems.length})</button>
              </div>
            )}
            {scopeRemaining > 0 ? (
              <button className="btn btn-gold" onClick={startFullDownload}>
                {scopeDownloaded > 0 ? `Resume ${scope === 'audio' ? 'Audio' : 'Full'} Library Download` : `Start ${scope === 'audio' ? 'Audio' : 'Full'} Library Download`}
              </button>
            ) : (
              <p style={{ color: 'var(--green)', fontWeight: 600 }}>
                ✓ {scope === 'audio' ? 'Audio library' : 'Full library'} downloaded! You are a complete seed node.
              </p>
            )}
          </div>
        ) : (
          <div className="seed-progress">
            <div className="seed-progress-bar">
              <div
                className="seed-progress-fill"
                style={{ width: `${displayProgress.percent}%` }}
              ></div>
            </div>
            <div className="seed-progress-text">
              <span>{displayProgress.completed.toLocaleString()} of {displayProgress.total.toLocaleString()} files</span>
              <span>{displayProgress.percent.toFixed(1)}% complete</span>
            </div>
            {displayProgress.failed > 0 && (
              <p style={{ fontSize: 'var(--text-xs)', color: 'var(--red)', marginTop: '6px' }}>
                {displayProgress.failed} file{displayProgress.failed === 1 ? '' : 's'} failed so far
                {displayProgress.retrying ? ' — retrying them now…' : ' — they are retried automatically at the end of the run'}
              </p>
            )}
            <div style={{ marginTop: '12px', display: 'flex', gap: '10px' }}>
              <button className="btn btn-gold" onClick={togglePause}>
                {isPaused ? '▶ Resume' : '⏸ Pause'}
              </button>
            </div>
            <p style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginTop: '12px' }}>
              Downloading from Archive.org (free) with Bunny CDN fallback · Each file is seeded to the P2P network
              {displayProgress.percent >= 100 && ' · Download complete!'}
            </p>
          </div>
        )}
        </div>
      </div>

      </div>{/* /.step-list */}

      </div>

      {/* ── RIGHT: independent of the step sequence ── */}
      <div className="connections-right">

      {/* Updates section */}
      <Panel mark={iconRefresh} title="Library Updates" sub="New sermons added to the network">
        <p>
          When new sermons are added to SermonIndex, they'll appear here. You can choose to download
          the new batch to keep your seed node fully up to date.
        </p>
        <p style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', marginBottom: 0 }}>
          No updates available at this time. We'll notify you when new content is ready.
        </p>
      </Panel>

      {/* Status */}
      <Panel
        mark={iconGauge}
        title="Your Seed Node Status"
        sub="Measured now, not remembered"
      >

        {/* Verified badge — a real seed node holds ~all of its scope on disk AND
            is reachable so peers can actually pull from it. Both are measured,
            not claimed: coverage from files on disk, reachability from the probe
            OR from a real peer that connected in over IPv6. (It used to test
            `reach.open` alone, which wrongly told every IPv6-only-reachable seed
            node — Starlink, mobile broadband — that it was unreachable.) */}
        {(() => {
          const reachableSeed = reachableNow;
          const verified = scopeTotal > 0 && (scopePercent >= 95) && reachableSeed;
          const nearly = scopeTotal > 0 && scopePercent >= 95 && !reachableSeed;
          return (
            <div className={`seed-verdict ${verified ? 'ok' : ''}`}>
              {/* Drawn, not typed. ✓ and ◐ as text render at whatever weight the
                  platform's fallback font happens to have — on macOS the half
                  circle came out as a speck inside a 38px badge. */}
              <span className="seed-verdict-mark" aria-hidden="true">
                {verified ? (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="12" cy="12" r="9" />
                    <path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" stroke="none" />
                  </svg>
                )}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="seed-verdict-title">
                  {verified ? 'Verified Seed Node' : nearly ? 'Library complete — not yet reachable' : 'Not yet a full seed node'}
                </div>
                <div className="seed-verdict-sub">
                  {verified
                    ? `Hosting ${scopePercent.toFixed(1)}% of the ${scopeInfo.label.toLowerCase()} and reachable from the internet — you are backbone.`
                    : nearly
                      ? `You hold ${scopePercent.toFixed(1)}% of the ${scopeInfo.label.toLowerCase()}, but your port isn't reachable. Forward the port (Step 3) to become verified.`
                      : `${scopePercent.toFixed(1)}% of the ${scopeInfo.label.toLowerCase()} downloaded. A verified seed node holds ~95%+ and is reachable.`}
                </div>
              </div>
            </div>
          );
        })()}

        {/* The coverage meter and the two stat tiles that used to sit here have
            moved UP into the mission-control strip under the masthead. They were
            the headline readings of the page, printed at the bottom of its
            right-hand column; leaving a second copy down here would just be two
            places to read the same number and one of them eventually going
            stale. What stays is the detail — the things you check occasionally
            rather than every time. */}

        <div className="seed-detail">
          <span className="seed-detail-k">Hosting</span>
          <span className="seed-detail-v" style={{ color: 'var(--gold-text)' }}>
            {scopeInfo.label} · {scopeInfo.sizeLabel}
          </span>
        </div>
        <div className="seed-detail">
          <span className="seed-detail-k">Library held</span>
          <span className="seed-detail-v">
            {scopeDownloaded.toLocaleString()} / {scopeTotal.toLocaleString()}
          </span>
        </div>
        <div className="seed-detail">
          <span className="seed-detail-k">Reachable</span>
          <span className="seed-detail-v" style={{ color: reachableNow ? 'var(--green)' : 'var(--text-muted)' }}>
            {reachableNow ? 'Yes' : 'Not confirmed'}
          </span>
        </div>
        <div className="seed-detail">
          <span className="seed-detail-k">Download status</span>
          <span className="seed-detail-v" style={{ color: isPaused ? 'var(--gold-text)' : downloading ? 'var(--green)' : 'var(--text-muted)' }}>
            {isPaused ? 'Paused' : downloading ? 'Active' : 'Idle'}
          </span>
        </div>
        <div className="seed-detail">
          <span className="seed-detail-k">Storage path</span>
          <span className="seed-detail-v mono">{confirmedPath || storagePath || 'Not set'}</span>
        </div>
      </Panel>

      {/* Contact */}
      <Panel mark={iconMail} title="Questions?" sub="A real person reads this">
        <p style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', marginBottom: 0 }}>
          Email{' '}
          <a href={`mailto:${SEED_CONTACT_EMAIL}`} style={{ color: 'var(--gold-text)' }}>{SEED_CONTACT_EMAIL}</a>
          {' '}with anything about seed nodes — hardware, storage, or getting approved.
        </p>
      </Panel>

      </div>
      </div>

      {/* ── THE MANUAL ────────────────────────────────────────────────────
          The same guide the locked page shows. It used to disappear the moment
          somebody was approved — which is precisely when they start buying a
          drive, wiring it up and wondering what it will cost them in
          electricity. The reference material is not the recruiting material; it
          only looked that way because the recruiting page was the only place it
          existed. */}
      <SeedNodeGuide scopeInfo={scopeInfo} />
    </div>
  );
}
