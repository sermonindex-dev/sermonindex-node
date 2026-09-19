import React, { useState } from 'react';
import CgnatNotice from './CgnatNotice.jsx';
import { timeAgo } from '../utils/time.js';

/**
 * ReachabilityBanner — the user's OWN reachability status, made prominent and
 * honest. There are THREE real outcomes, not two:
 *
 *   1. IPv4 inbound works              → NODE (green). Fully reachable.
 *   2. IPv4 closed, IPv6 inbound works → NODE (green). Also genuinely reachable
 *      — over IPv6. This is the NORMAL GOOD OUTCOME on Starlink, T-Mobile Home
 *      Internet and mobile broadband, where IPv4 inbound is impossible forever
 *      but the ISP hands out real routable IPv6. Treating this person as
 *      "unreachable" (as the old two-state banner did) was simply wrong, and
 *      sent them off to port-forward something that can never work.
 *   3. Neither                         → PEER (yellow). The existing honest
 *      "you still contribute by connecting outward" messaging. "Peer" is the
 *      SAME word and the SAME colour the node map uses for a port-closed node
 *      (NODE_COLORS.peer → var(--gold-text)), so the two views agree.
 *
 * Honesty rule: this NEVER claims "reachable" unless we have EVIDENCE. There are
 * exactly two kinds of evidence and both are real:
 *
 *   ACTIVE  — the probe server dialled us and got through (`reachOpen`,
 *             `reachOpen6`).
 *   PASSIVE — a peer out on the internet opened a connection TO US over a public
 *             IPv6 address (`v6InboundSeen`). Our probe runs on a Bunny edge
 *             script that has no outbound IPv6 whatsoever, so `reachOpen6` can
 *             NEVER become true for anyone; this passive observation is the only
 *             route to an honest IPv6 answer, and for a Starlink user it's the
 *             only way they'll learn they are genuinely reachable.
 *
 * An outbound upload count is still deliberately NOT treated as proof — nor is
 * an outbound IPv6 connection, which only shows we can dial out. And
 * open_v6:false is only believed when v6Probe === 'ok'; if the probe server
 * itself couldn't make an IPv6 connection we say nothing rather than blaming
 * the user.
 *
 * Props:
 *   running  {boolean}          — the P2P session is up
 *   port     {number|null}      — the node's TCP listening port
 *   reachOpen {boolean|null}    — IPv4 probe result: true=open, false=closed, null=unknown
 *   reachOpen6 {boolean}        — an IPv6 peer really connected to us
 *   v6Probe  {string}           — 'ok' | 'unsupported' | 'error' | 'invalid' | 'none'
 *                                 (only 'ok' makes reachOpen6===false meaningful)
 *   hasIpv6  {boolean}          — this machine has a global IPv6 address of its own
 *   cgnat    {boolean}          — the probe actually saw a carrier-NAT (100.64/10)
 *                                 address. Usually false even for CGNAT users, so
 *                                 the copy is worded as a possibility either way.
 *   testing  {boolean}          — a reachability test is in flight
 *   testedAt {number|null}      — epoch ms of the result being shown. The saved
 *                                 result NEVER expires, so its age is the only
 *                                 thing telling the user how current it is.
 *   v6InboundSeen {boolean}     — PASSIVE PROOF: a peer at a public IPv6 address
 *                                 opened a connection to this node. Sticky and
 *                                 persisted: once it has happened it stays true,
 *                                 because reachability is a "has this ever been
 *                                 demonstrated" fact, not a momentary one.
 *   v6InboundAt {number|null}   — epoch ms we first observed that.
 *   v6ThisSession {boolean}     — the CURRENT session's own observation says an
 *                                 IPv6 peer has dialled in. This is what
 *                                 separates "is true now" from "was true once".
 *                                 The native observation is sticky for the
 *                                 session only; the localStorage blob behind
 *                                 `v6InboundSeen` survives restarts, which is
 *                                 why the two must be reported separately.
 *   inboundPeersPeak {number|null} — how many peers (any family) have connected
 *                                 IN to us during this session. Context for the
 *                                 claim above, not evidence for it.
 *   v6EgressSeen {boolean}      — we connected OUT to an IPv6 peer. Proves this
 *                                 machine has working IPv6 and NOTHING MORE. It
 *                                 is never shown as reachability; it is only used
 *                                 to soften the "no IPv6" silence.
 *   onTest   {function}         — optional: trigger a (re)test
 */
export default function ReachabilityBanner({
  running, port, reachOpen, reachOpen6 = false, v6Probe = 'none',
  hasIpv6 = false, cgnat, testing, testedAt = null, onTest,
  v6InboundSeen = false, v6InboundAt = null, v6EgressSeen = false,
  v6ThisSession = false, inboundPeersPeak = null,
}) {
  // Inline "how to open your port" directions — collapsed by default, expands
  // in place (no external link). Hook is declared unconditionally, above the
  // early returns, so hook order stays stable across renders.
  const [showGuide, setShowGuide] = useState(false);

  // The result on screen is a SAVED one that never expires and is never
  // silently re-probed, so the button is an explicit "Re-test" and the age line
  // beneath it is what keeps the display honest about how old the reading is.
  const age = timeAgo(testedAt);
  const testBtn = onTest ? (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '4px', flexShrink: 0 }}>
      <button
        className="btn btn-outline"
        style={{ fontSize: 'var(--text-sm)', padding: '6px 14px', whiteSpace: 'nowrap' }}
        onClick={onTest}
        disabled={testing}
      >
        {testing ? 'Testing…' : 'Re-test'}
      </button>
      {(testing || age) && (
        <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
          {testing ? 'Checking now…' : `Last tested ${age}`}
        </span>
      )}
    </div>
  ) : null;

  // ── Node offline — no session, so no honest claim to make ──
  if (!running) {
    return (
      <div className="verdict plain quiet">
        <span className="verdict-mark" aria-hidden="true">{<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="9" strokeDasharray="3 3" /></svg>}</span>
        <div className="verdict-copy">
          <div className="verdict-title">Node offline</div>
          <p>Start your node to join the network and check whether you're reachable.</p>
        </div>
      </div>
    );
  }

  // ── Reachable → full NODE (green, celebratory, with a gold "backbone" accent) ──
  if (reachOpen === true) {
    return (
      <div className="verdict ok">
        <span className="verdict-mark" aria-hidden="true">{<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>}</span>
        <div className="verdict-copy">
          <div className="verdict-title">
            Reachable — your node is a full node
            <span className="verdict-flag">Backbone</span>
          </div>
          <p>
            You're actively serving sermons to peers around the world — this is exactly what keeps the
            library indestructible. Thank you for strengthening the network.
          </p>
        </div>
        <div className="verdict-aside">{testBtn}</div>
      </div>
    );
  }

  // ── IPv4 closed but IPv6 OPEN → still a full node, over IPv6. This is a
  // POSITIVE result and must be shown as one: peers with IPv6 (a large and
  // growing share of the network) connect straight to this node. Deliberately
  // NO port-forward instructions here — there is nothing to fix.
  if (reachOpen === false && reachOpen6 === true) {
    return (
      <div className="verdict ok">
        <span className="verdict-mark" aria-hidden="true">{<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>}</span>
        <div className="verdict-copy">
          <div className="verdict-title">
            Reachable over IPv6 — your node is a full node
            <span className="verdict-flag">Backbone</span>
          </div>
          <p>
            Other people can reach your node over IPv6 — nothing to forward or change. That's the normal
            good result on Starlink and mobile broadband. Thank you for strengthening the network.
          </p>
        </div>
        <div className="verdict-aside">{testBtn}</div>
      </div>
    );
  }

  // ── PASSIVE PROOF of inbound IPv6 → a full node, over IPv6. ──
  // Nobody dialled this person on our behalf: a real peer, somewhere out on the
  // internet, opened a connection TO THEM over a public IPv6 address. That is
  // ground truth, and it is the ONLY way we can ever answer this question —
  // our probe server has no IPv6 route at all, so `reachOpen6` above can never
  // become true for anyone.
  //
  // Placed BEFORE the "closed" branch on purpose: a node with proven inbound
  // IPv6 is not a peer, and must never be shown port-forward instructions it
  // does not need. It is deliberately NOT placed before the IPv4 branch — if
  // IPv4 inbound works too, that fuller result is the one worth showing.
  //
  // Sticky: this stays true after the peer disconnects and across restarts. A
  // reachability fact that flickers off is worse than no fact at all.
  if (reachOpen !== true && v6InboundSeen === true) {
    const seenAgo = timeAgo(v6InboundAt);
    // 0.0.331 — this claim is STICKY: once a peer has dialled in, it is true
    // for ever, because reachability is a has-this-ever-happened fact. That is
    // still the right rule, but the banner used to state it in the present
    // tense with no date on it, so a single inbound connection months ago read
    // as "you are reachable right now". Worse, the map disagreed out loud: it
    // classifies from the heartbeat's `reachable`, which until 0.0.331 never
    // looked at this observation at all — so the same node showed a green
    // "full node" banner here and a yellow peer dot there, and people quite
    // reasonably concluded one of them was lying.
    //
    // Both ends are fixed now (heartbeat.js reads v6_inbound_seen), so the two
    // views agree. What remains is honesty about age: say WHEN, in the heading,
    // where it cannot be missed.
    // 0.0.334 — 14 days, matching network.js REACH_CONFIRM_DAYS and the CLI's
    // config::reach_confirm_days. Beyond it the claim is no longer made in the
    // present tense at all: the branch below takes over and says plainly that
    // nothing has come in since, which is what a node with one connection a
    // month ago deserves to be told.
    const ageMs = v6InboundAt == null ? 0 : Date.now() - v6InboundAt;
    const stale = v6InboundAt != null && ageMs > 14 * 24 * 60 * 60 * 1000;
    const ageDays = Math.floor(ageMs / 86400000);
    // ── Proof has gone stale ──────────────────────────────────────────────
    // Not a failure, and not green either. The node WAS reachable; nothing has
    // come in for a fortnight, and the honest thing is to say exactly that
    // rather than keep a confident badge alive on month-old evidence.
    if (stale) {
      return (
        <div className="verdict plain">
          <span className="verdict-mark" aria-hidden="true">{<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3l9 9-9 9-9-9z" /></svg>}</span>
          <div className="verdict-copy">
            <div className="verdict-title" style={{ color: 'var(--gold-text)' }}>
              No one has reached you in {ageDays} days
            </div>
            <p>
              A peer did connect straight to your node over IPv6 {seenAgo}, so this
              worked at least once — but nothing has come in since, and we would rather
              say so than keep a green badge alive on evidence that old.
              <br /><br />
              Two innocent explanations, both common: the swarm has simply been quiet,
              or your connection changed — a new router, a new address from your
              provider, a firewall rule that reset. Your node is still uploading to
              every peer it reaches either way.
              {port ? <> If you can, check that <strong style={{ color: 'var(--text-primary)' }}>port {port}</strong> is still open.</> : null}
            </p>
          </div>
          <div className="verdict-aside">{testBtn}</div>
        </div>
      );
    }

    return (
      <div className="verdict ok">
        <span className="verdict-mark" aria-hidden="true">{<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>}</span>
        <div className="verdict-copy">
          <div className="verdict-title">
            {/* The "· confirmed 36 minutes ago" that used to hang off this
                heading has moved to the age line below, on its own. A heading
                is where a reader looks for the ANSWER; a timestamp tucked into
                it gets read as decoration, which is how a green badge on
                month-old evidence kept passing for a live one. */}
            Reachable over IPv6 — your node is a full node
            <span className="verdict-flag">Backbone</span>
          </div>
          <p>
            Someone out there connected straight to your node — not the other way round — using the newer
            kind of internet address (IPv6). That's the proof that matters: people <em>can</em> find you and
            take sermons from you directly.
            {reachOpen === false
              ? <> The older kind of address (IPv4) stays closed, and on Starlink, T-Mobile Home Internet or
                  mobile broadband it always will — those providers share one old-style address between many
                  homes while giving every home a real modern one. Nothing to change, and nothing to
                  forward.</>
              : <> We haven't been able to check the older kind of address (IPv4) from outside, but it doesn't
                  matter much: you're already reachable.</>}
            {' '}Thank you for strengthening the network.
          </p>
          {/* 0.0.334 — THE TENSE FIX.
              This used to read "Last seen 36 minutes ago" under a present-tense
              green heading, with nothing to say whether that was this run of the
              app or a previous one. It was routinely both: the proof is kept in
              localStorage across restarts, so a node four minutes into a fresh
              session with zero live peers would report a confident "confirmed 36
              minutes ago" — a true fact, stated as though it were happening.

              A measurement and WHEN it was measured are two different facts, and
              running them together is exactly how a stale reading passes for a
              current one. So: which session, and what has actually happened in
              THIS one, said plainly. */}
          <div className="verdict-age">
            {v6ThisSession
              ? <>Confirmed <strong style={{ color: 'var(--text-secondary)' }}>in this session</strong>
                  {seenAgo ? <> — first seen {seenAgo}</> : null}
                  {' '}· noticed from a real connection, not a test.</>
              : <>Last confirmed {seenAgo || 'earlier'}, <strong style={{ color: 'var(--text-secondary)' }}>in a previous session</strong>.
                  {' '}{inboundPeersPeak != null
                    ? (inboundPeersPeak > 0
                        ? <>{inboundPeersPeak} peer{inboundPeersPeak === 1 ? ' has' : 's have'} connected in since this app started.</>
                        : <>Nobody has connected in since this app started — which is normal on a quiet swarm.</>)
                    : null}</>}
          </div>
        </div>
        <div className="verdict-aside">{testBtn}</div>
      </div>
    );
  }

  // ── Port closed → PEER. Honest, and deliberately NOT alarming: for a
  // great many people (Starlink, T-Mobile Home Internet, mobile broadband) this
  // is permanent and unfixable, and they are still contributing every day.
  // "Peer" is the node map's own word for a port-closed node, and the colour
  // below is the map's peer colour (NODE_COLORS.peer, #f8d355 / var(--gold-text))
  // so someone who sees themselves on the map sees the same category here.
  if (reachOpen === false) {
    return (
      <div className="verdict plain">
        <span className="verdict-mark" aria-hidden="true">{<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3l9 9-9 9-9-9z" /></svg>}</span>
        <div className="verdict-copy">
          <div className="verdict-title" style={{ color: 'var(--gold-text)' }}>
            Your node is a <em>peer</em> — still sharing, just not reachable
          </div>
          <p>
            Other people can't connect <em>to</em> you, so your node goes out and connects to them instead —
            and uploads sermons to every peer it reaches. If you can open{' '}
            {port
              ? <>port <strong style={{ color: 'var(--text-primary)' }}>{port}</strong></>
              : <>your node's port</>}{' '}
            on your router you'll also become a meeting point for others. Many people can't, and that's
            genuinely fine.
          </p>

          {/* The router-firewall diagnosis only counts when the edge really did
              attempt an IPv6 connection (v6Probe === 'ok'). If it couldn't, the
              silence tells us nothing about this user and we stay quiet. */}
          <CgnatNotice
            detected={!!cgnat}
            v6Firewalled={hasIpv6 && v6Probe === 'ok' && reachOpen6 === false}
          />

          {/* The WEAKER, honest claim. We have connected OUT to peers over IPv6,
              which proves this machine's IPv6 works — but an outbound connection
              says nothing whatsoever about whether anyone can come IN. So this
              is worded as "not yet known", never as a result, and it is styled as
              a quiet note rather than a green verdict. If an inbound IPv6 peer
              ever does arrive, the branch above takes over and says so properly.
              We can't test this ourselves: the probe server has no IPv6 route. */}
          {v6EgressSeen && !v6InboundSeen && (
            <div style={{ ...guidePanel, marginTop: '8px' }}>
              Your connection has IPv6, which may let others reach you. We'll say so here if it happens.
            </div>
          )}

          {/* Inline, collapsible directions — reuses the gold "disclosure" idiom
              from the Connections panel's "Help the network more" section, with a
              caret that rotates on open like the Downloads speaker rows. Everything
              the user needs is right here; no dead external link. */}
          <button
            type="button"
            onClick={() => setShowGuide((v) => !v)}
            aria-expanded={showGuide}
            style={{
              marginTop: '8px',
              background: 'none',
              border: 'none',
              padding: 0,
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              gap: '5px',
              color: 'var(--gold-text)',
              fontWeight: 600,
              fontSize: 'var(--text-sm)',
              lineHeight: 1.4,
            }}
          >
            How to open your port
            <span style={{
              display: 'inline-flex',
              fontSize: 'var(--text-xs)',
              transform: showGuide ? 'rotate(180deg)' : 'none',
              transition: 'transform 0.15s ease',
            }}>▾</span>
          </button>

          {showGuide && (
            <div style={guidePanel}>
              <ol style={{ margin: '0 0 8px', paddingLeft: '20px' }}>
                <li style={guideStep}>
                  Open your router's admin page in a web browser — usually{' '}
                  <strong style={{ color: 'var(--text-primary)' }}>http://192.168.0.1</strong> or{' '}
                  <strong style={{ color: 'var(--text-primary)' }}>http://192.168.1.1</strong>. The
                  username and password are often printed on a sticker on the router itself.
                </li>
                <li style={guideStep}>
                  Find <strong>Port Forwarding</strong> — sometimes tucked under Advanced, NAT, or
                  Virtual Server.
                </li>
                <li style={guideStep}>
                  Add a rule that forwards{' '}
                  <strong style={{ color: 'var(--text-primary)' }}>TCP port {port || "your node's port"}</strong>{' '}
                  to <strong>this computer</strong> (the device running SermonIndex). Its local IP
                  usually starts with 192.168 — you can find it in your computer's network settings.
                </li>
                <li style={{ ...guideStep, marginBottom: 0 }}>
                  Save or apply the rule, then come back here and press <strong>Re-test</strong>.
                </li>
              </ol>
              <p style={{ margin: 0, color: 'var(--text-muted)' }}>
                Many routers can do this automatically (UPnP) — if yours does, the port may open on
                its own. Giving this computer a static or reserved local IP helps the rule stick.
              </p>
            </div>
          )}
        </div>
        <div className="verdict-aside">{testBtn}</div>
      </div>
    );
  }

  // ── Unknown — probe hasn't resolved (or is running). Don't claim either way. ──
  return (
    <div className="verdict plain quiet">
      <span className="verdict-mark" aria-hidden="true">{<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="9" /><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" stroke="none" /></svg>}</span>
      <div className="verdict-copy">
        <div className="verdict-title">
          {testing ? 'Checking reachability…' : 'Reachability not confirmed yet'}
        </div>
        <p>Run the test to see whether other peers can connect directly to your node.</p>
      </div>
      {onTest && (
        <button
          className="btn btn-outline"
          style={{ fontSize: 'var(--text-sm)', padding: '6px 14px', whiteSpace: 'nowrap', flexShrink: 0 }}
          onClick={onTest}
          disabled={testing}
        >
          {testing ? 'Testing…' : 'Test now'}
        </button>
      )}
    </div>
  );
}

// `box()`, `glyph()`, `title()` and `sub` used to live here — six branches each
// rebuilding the same banner out of inline objects, with the colour of every
// state hand-passed as an argument. All six are now `.verdict` in the
// stylesheet, in two tones: brand (olive) for a settled answer, plain (cream)
// for a state that has something in it for the reader to do. That distinction
// is the only one the colours were ever really making, and it now lives in one
// place instead of being re-argued at every call site.

// Expanded "how to open your port" panel — mirrors the Connections panel's
// disclosure body (small text, secondary color, relaxed line-height), set on a
// tertiary surface so it reads as a distinct inline panel within the gold banner.
const guidePanel = {
  marginTop: '8px',
  fontSize: 'var(--text-sm)',
  color: 'var(--text-secondary)',
  lineHeight: 1.6,
  padding: '10px 12px',
  background: 'var(--bg-tertiary)',
  border: '1px solid var(--border)',
  borderRadius: '8px',
};
const guideStep = { marginBottom: '7px' };
