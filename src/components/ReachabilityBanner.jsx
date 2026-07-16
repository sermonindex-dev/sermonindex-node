import React, { useState } from 'react';

/**
 * ReachabilityBanner — the user's OWN reachability status, made prominent and
 * honest. Mirrors the network map's seed/node/peer color scheme:
 *
 *   reachable (port open) → NODE  (green)         — a full node serving peers
 *   port closed           → PEER  (yellow / gold) — downloads but can't serve as strongly
 *
 * Honesty rule: this NEVER claims "reachable" unless the probe actually said so.
 * `reachOpen` is the authoritative probe result (true / false / null-unknown);
 * an outbound upload count is deliberately NOT treated as proof of reachability.
 *
 * Props:
 *   running  {boolean}          — the P2P session is up
 *   port     {number|null}      — the node's TCP listening port
 *   reachOpen {boolean|null}    — probe result: true=open, false=closed, null=unknown
 *   testing  {boolean}          — a reachability test is in flight
 *   onTest   {function}         — optional: trigger a (re)test
 */
export default function ReachabilityBanner({ running, port, reachOpen, testing, onTest }) {
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

  // ── Port closed → PEER (yellow / gold), honest + actionable ──
  if (reachOpen === false) {
    return (
      <div style={{ ...box('rgba(212,175,55,0.12)', 'rgba(212,175,55,0.40)'), alignItems: 'flex-start' }}>
        <span style={glyph('var(--gold-text)')}>⚠</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={title('var(--gold-text)')}>
            Port closed — right now you're a <em>peer</em>
          </div>
          <div style={sub}>
            You download and share back to peers you can reach, but you can't serve as strongly as a
            reachable node. Open{' '}
            {port
              ? <>port <strong style={{ color: 'var(--text-primary)' }}>{port}</strong></>
              : <>your node's port</>}{' '}
            on your router to become a reachable <strong>node</strong>.
          </div>

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
