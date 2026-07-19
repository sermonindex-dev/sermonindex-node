import React, { useState } from 'react';
import CgnatNotice from './CgnatNotice.jsx';

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
 *   3. Neither                         → LEAF (blue). The existing honest
 *      "you still contribute by connecting outward" messaging.
 *
 * Honesty rule: this NEVER claims "reachable" unless the probe actually said so.
 * `reachOpen` / `reachOpen6` are authoritative probe results; an outbound upload
 * count is deliberately NOT treated as proof of reachability. And open_v6:false
 * is only believed when v6Probe === 'ok' — if the probe server itself couldn't
 * make an IPv6 connection we say nothing rather than blaming the user.
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
 *   onTest   {function}         — optional: trigger a (re)test
 */
export default function ReachabilityBanner({
  running, port, reachOpen, reachOpen6 = false, v6Probe = 'none',
  hasIpv6 = false, cgnat, testing, onTest,
}) {
  // Inline "how to open your port" directions — collapsed by default, expands
  // in place (no external link). Hook is declared unconditionally, above the
  // early returns, so hook order stays stable across renders.
  const [showGuide, setShowGuide] = useState(false);

  const testBtn = onTest ? (
    <button
      className="btn btn-outline"
      style={{ fontSize: '0.78rem', padding: '6px 14px', whiteSpace: 'nowrap', flexShrink: 0 }}
      onClick={onTest}
      disabled={testing}
    >
      {testing ? 'Testing…' : 'Test again'}
    </button>
  ) : null;

  // ── Node offline — no session, so no honest claim to make ──
  if (!running) {
    return (
      <div style={box('var(--bg-tertiary)', 'var(--border)')}>
        <span style={glyph('var(--text-muted)')}>◌</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={title('var(--text-primary)')}>Node offline</div>
          <div style={sub}>Start your node to join the network and check whether you're reachable.</div>
        </div>
      </div>
    );
  }

  // ── Reachable → full NODE (green, celebratory, with a gold "backbone" accent) ──
  if (reachOpen === true) {
    return (
      <div style={box('rgba(61,138,65,0.12)', 'rgba(61,138,65,0.40)')}>
        <span style={glyph('var(--green)')}>✓</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            <span style={title('var(--green)')}>Reachable — your node is a full node</span>
            <span style={{
              fontSize: '0.6rem', fontWeight: 700, letterSpacing: '0.5px', textTransform: 'uppercase',
              color: 'var(--gold-text)', background: 'var(--gold-dim)', padding: '2px 8px', borderRadius: '10px',
            }}>
              Backbone
            </span>
          </div>
          <div style={sub}>
            You're actively serving sermons to peers around the world — this is exactly what keeps the
            library indestructible. Thank you for strengthening the network.
          </div>
        </div>
      </div>
    );
  }

  // ── IPv4 closed but IPv6 OPEN → still a full node, over IPv6. This is a
  // POSITIVE result and must be shown as one: peers with IPv6 (a large and
  // growing share of the network) connect straight to this node. Deliberately
  // NO port-forward instructions here — there is nothing to fix.
  if (reachOpen === false && reachOpen6 === true) {
    return (
      <div style={box('rgba(61,138,65,0.12)', 'rgba(61,138,65,0.40)')}>
        <span style={glyph('var(--green)')}>✓</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            <span style={title('var(--green)')}>Reachable over IPv6 — your node is a full node</span>
            <span style={{
              fontSize: '0.6rem', fontWeight: 700, letterSpacing: '0.5px', textTransform: 'uppercase',
              color: 'var(--gold-text)', background: 'var(--gold-dim)', padding: '2px 8px', borderRadius: '10px',
            }}>
              Backbone
            </span>
          </div>
          <div style={sub}>
            We connected to your node from the outside world, so other people can too — they reach you on the
            newer kind of internet address (IPv6). The older kind (IPv4) is closed, which is completely normal
            on Starlink, T-Mobile Home Internet and mobile broadband: those providers share one old-style
            address between many homes, but give every home a real modern one. Nothing to change here, and
            nothing to forward. Thank you for strengthening the network.
          </div>
        </div>
        {testBtn}
      </div>
    );
  }

  // ── Port closed → LEAF node. Honest, and deliberately NOT alarming: for a
  // great many people (Starlink, T-Mobile Home Internet, mobile broadband) this
  // is permanent and unfixable, and they are still contributing every day.
  if (reachOpen === false) {
    return (
      <div style={{ ...box('rgba(45,108,181,0.10)', 'rgba(45,108,181,0.35)'), alignItems: 'flex-start' }}>
        <span style={glyph('var(--seed-blue)')}>◈</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={title('var(--seed-blue)')}>
            Your node is a <em>leaf</em> — still sharing, just not reachable
          </div>
          <div style={sub}>
            Other people can't connect <em>to</em> you, so your node goes out and connects to them instead —
            and uploads sermons to every peer it reaches. If you can open{' '}
            {port
              ? <>port <strong style={{ color: 'var(--text-primary)' }}>{port}</strong></>
              : <>your node's port</>}{' '}
            on your router you'll also become a meeting point for others. Many people can't, and that's
            genuinely fine.
          </div>

          {/* The router-firewall diagnosis only counts when the edge really did
              attempt an IPv6 connection (v6Probe === 'ok'). If it couldn't, the
              silence tells us nothing about this user and we stay quiet. */}
          <CgnatNotice
            detected={!!cgnat}
            v6Firewalled={hasIpv6 && v6Probe === 'ok' && reachOpen6 === false}
          />

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
              fontSize: '0.82rem',
              lineHeight: 1.4,
            }}
          >
            How to open your port
            <span style={{
              display: 'inline-flex',
              fontSize: '0.7rem',
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
                  Save or apply the rule, then come back here and press <strong>Test again</strong>.
                </li>
              </ol>
              <p style={{ margin: 0, color: 'var(--text-muted)' }}>
                Many routers can do this automatically (UPnP) — if yours does, the port may open on
                its own. Giving this computer a static or reserved local IP helps the rule stick.
              </p>
            </div>
          )}
        </div>
        {testBtn}
      </div>
    );
  }

  // ── Unknown — probe hasn't resolved (or is running). Don't claim either way. ──
  return (
    <div style={box('var(--bg-tertiary)', 'var(--border)')}>
      <span style={glyph('var(--gold-text)')}>◐</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={title('var(--text-primary)')}>
          {testing ? 'Checking reachability…' : 'Reachability not confirmed yet'}
        </div>
        <div style={sub}>Run the test to see whether other peers can connect directly to your node.</div>
      </div>
      {onTest && (
        <button
          className="btn btn-outline"
          style={{ fontSize: '0.78rem', padding: '6px 14px', whiteSpace: 'nowrap', flexShrink: 0 }}
          onClick={onTest}
          disabled={testing}
        >
          {testing ? 'Testing…' : 'Test now'}
        </button>
      )}
    </div>
  );
}

// ── Shared inline styles (all theme tokens) ──
function box(bg, border) {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: '16px',
    padding: '16px 20px',
    borderRadius: 'var(--radius-lg)',
    background: bg,
    border: `1px solid ${border}`,
    maxWidth: '1100px',
    margin: '0 auto 16px',
  };
}
function glyph(color) {
  return { fontSize: '1.8rem', lineHeight: 1, color, flexShrink: 0 };
}
function title(color) {
  return { fontWeight: 700, fontSize: '0.95rem', color };
}
const sub = { fontSize: '0.82rem', color: 'var(--text-secondary)', marginTop: '3px', lineHeight: 1.55 };

// Expanded "how to open your port" panel — mirrors the Connections panel's
// disclosure body (small text, secondary color, relaxed line-height), set on a
// tertiary surface so it reads as a distinct inline panel within the gold banner.
const guidePanel = {
  marginTop: '8px',
  fontSize: '0.78rem',
  color: 'var(--text-secondary)',
  lineHeight: 1.6,
  padding: '10px 12px',
  background: 'var(--bg-tertiary)',
  border: '1px solid var(--border)',
  borderRadius: '8px',
};
const guideStep = { marginBottom: '7px' };
