import React, { useState } from 'react';

/**
 * ReachabilityHelp — "how do I let people reach me?", answered for a household.
 *
 * WHO THIS IS FOR
 *
 * Someone who agreed to leave a small computer switched on in a spare room so
 * that sermons survive. They are not a network engineer, they will not read
 * documentation, and the single worst thing this panel can do is send them to
 * their router to change a setting that cannot possibly help.
 *
 * That last point is the whole design. On Starlink, T-Mobile Home Internet and
 * most mobile broadband, inbound IPv4 is impossible — the provider shares one
 * old-style address between many homes, and there is no port to forward, no
 * setting to find, and no amount of trying that will work. The honest thing is
 * to say so plainly and point at the thing that DOES work on exactly those
 * connections: IPv6, which those same providers hand out to every home.
 *
 * So the panel leads with what the machine already knows about itself, in a
 * form that can be copied into a router page, and only then offers steps —
 * clearly separated into "this may help you" and "this cannot".
 */

function Row({ label, value, hint, mono = true }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(String(value));
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch { /* clipboard blocked — the value is on screen and selectable */ }
  };
  if (!value) return null;
  return (
    <div style={rowWrap}>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={rowLabel}>{label}</div>
        <div style={{ ...rowValue, fontFamily: mono ? 'var(--font-mono)' : 'var(--font)' }}>
          {value}
        </div>
        {hint && <div style={rowHint}>{hint}</div>}
      </div>
      <button type="button" className="btn btn-outline" onClick={copy} style={copyBtn}>
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

export default function ReachabilityHelp({
  port,
  publicIpv6 = null,
  localIp = null,
  reachOpen = null,
  v6Confirmed = false,
  cgnat = false,
}) {
  const [open, setOpen] = useState(false);

  // Already reachable — say so and offer nothing. A panel of instructions
  // under a working node is just doubt.
  if (v6Confirmed || reachOpen === true) {
    return (
      <div style={{ ...panel, borderLeftColor: 'var(--green)' }}>
        <div style={{ ...h, color: 'var(--green)' }}>People can already reach you</div>
        <p style={p}>
          Nothing to change. Your node is a place other people connect to, and it is
          serving the library to whoever asks.
        </p>
      </div>
    );
  }

  // The honest read on whether forwarding a port is even possible here. We only
  // claim carrier-NAT when the probe actually SAW a 100.64/10 address — most of
  // the time it does not, so the wording below stays a possibility either way.
  const likelyCgnat = cgnat || (reachOpen === false && !!publicIpv6);

  return (
    <div style={panel}>
      <div style={h}>Letting people reach you</div>
      <p style={p}>
        Your node works either way — it uploads sermons to every peer it connects to.
        This is about becoming a place others can come <em>to</em>, which helps the
        network most. Here is everything your machine knows about itself.
      </p>

      <div style={{ margin: '14px 0 4px' }}>
        <Row
          label="Modern address (IPv6)"
          value={publicIpv6}
          hint="This is the one that works on Starlink and mobile broadband."
        />
        <Row label="Port" value={port} mono />
        <Row
          label="This computer on your home network"
          value={localIp}
          hint="Router pages ask for this when you forward a port."
        />
        {!publicIpv6 && (
          <div style={{ ...rowHint, padding: '10px 0 2px' }}>
            No modern (IPv6) address yet. Many providers give one automatically; if
            yours does not, the older route below is the only option.
          </div>
        )}
      </div>

      {likelyCgnat && (
        <div style={warn}>
          <strong style={{ color: 'var(--text-primary)' }}>Before you open your router:</strong>{' '}
          your connection looks like one where forwarding a port <em>cannot</em> work —
          Starlink, T-Mobile Home Internet and most mobile broadband share a single
          old-style address between many homes, so there is nothing on your router to
          forward. This is not something you have configured wrongly and it is not
          fixable from your end. Those same providers give every home a modern (IPv6)
          address, which is why the first line above matters and the rest may not.
        </div>
      )}

      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        style={disclosure}
      >
        What can I actually try?
        <span style={{ display: 'inline-flex', fontSize: 'var(--text-xs)', transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s ease' }}>▾</span>
      </button>

      {open && (
        <div style={guide}>
          <div style={stepHead}>If you can reach your router's settings</div>
          <ol style={ol}>
            <li style={li}>
              Open <strong style={strong}>http://192.168.0.1</strong> or{' '}
              <strong style={strong}>http://192.168.1.1</strong> in a browser. The
              username and password are usually printed on a sticker on the router.
            </li>
            <li style={li}>
              Look for <strong>Port Forwarding</strong> — often under Advanced, NAT,
              Firewall or Virtual Server.
            </li>
            <li style={li}>
              Forward <strong style={strong}>TCP port {port || 42800}</strong> to{' '}
              <strong style={strong}>{localIp || 'this computer'}</strong>.
            </li>
            {publicIpv6 && (
              <li style={li}>
                If there is an <strong>IPv6 firewall</strong> section, allow incoming
                connections to <strong style={strong}>{publicIpv6}</strong> on port{' '}
                <strong style={strong}>{port || 42800}</strong>. On a shared-address
                connection this is the step that actually works.
              </li>
            )}
            <li style={{ ...li, marginBottom: 0 }}>
              Save, then come back and press Re-test.
            </li>
          </ol>

          <div style={{ ...stepHead, marginTop: 16 }}>Using Starlink?</div>
          <p style={{ ...guideP, marginBottom: 8 }}>
            The Starlink app has no port-forwarding setting, and there is no hidden one —
            it is not offered because the shared address makes it meaningless. Two things
            are true and worth knowing:
          </p>
          <ul style={ul}>
            <li style={li}>
              Starlink <strong>does</strong> give your home a modern (IPv6) address, and
              peers with IPv6 can reach you on it directly. Often this already works and
              nobody has told you.
            </li>
            <li style={{ ...li, marginBottom: 0 }}>
              If you run your own router behind Starlink (Bypass mode), it is{' '}
              <em>your</em> router's IPv6 firewall that decides, and the step above
              applies to it.
            </li>
          </ul>

          <p style={{ ...guideP, marginTop: 16, marginBottom: 0, fontStyle: 'italic' }}>
            And if none of it works: that is genuinely fine, and common. A node that
            only dials out still uploads sermons to every peer it reaches, every day,
            and still holds a complete copy of the library — which is the part that
            makes it survive.
          </p>
        </div>
      )}
    </div>
  );
}

const panel = {
  padding: 'var(--space-5)',
  background: 'var(--bg-secondary)',
  border: '1px solid var(--border)',
  borderLeft: '3px solid var(--gold-text)',
  borderRadius: 'var(--radius-lg)',
  boxShadow: 'var(--face-lit), var(--face-raise)',
};
const h = { fontWeight: 650, fontSize: 'var(--text-lg)', color: 'var(--text-primary)', marginBottom: 'var(--space-2)' };
const p = { fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', lineHeight: 'var(--leading-normal)', margin: 0, maxWidth: '68ch' };
const rowWrap = {
  display: 'flex', alignItems: 'center', gap: 'var(--space-3)',
  padding: '10px 0', borderBottom: '1px solid var(--border)',
};
const rowLabel = { fontSize: 'var(--text-xs)', fontWeight: 700, letterSpacing: 'var(--tracking-label)', textTransform: 'uppercase', color: 'var(--text-muted)' };
const rowValue = { fontSize: 'var(--text-sm)', color: 'var(--text-primary)', wordBreak: 'break-all', marginTop: '2px' };
const rowHint = { fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginTop: '3px' };
const copyBtn = { flexShrink: 0, fontSize: 'var(--text-xs)', padding: '5px 12px' };
const warn = {
  marginTop: 'var(--space-4)', padding: '12px 14px',
  background: 'var(--gold-dim)', border: '1px solid var(--border)',
  borderRadius: 'var(--radius)', fontSize: 'var(--text-sm)',
  color: 'var(--text-secondary)', lineHeight: 'var(--leading-normal)',
};
const disclosure = {
  marginTop: 'var(--space-4)', background: 'none', border: 'none', padding: 0,
  cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '5px',
  color: 'var(--gold-text)', fontWeight: 600, fontSize: 'var(--text-sm)', fontFamily: 'var(--font)',
};
const guide = {
  marginTop: 'var(--space-3)', padding: '14px 16px',
  background: 'var(--bg-tertiary)', border: '1px solid var(--border)',
  borderRadius: 'var(--radius)', fontSize: 'var(--text-sm)',
  color: 'var(--text-secondary)', lineHeight: 'var(--leading-relaxed)',
};
const guideP = { margin: 0, fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' };
const stepHead = { fontWeight: 650, color: 'var(--text-primary)', marginBottom: 6, fontSize: 'var(--text-sm)' };
const ol = { margin: '0 0 0', paddingLeft: 20 };
const ul = { margin: 0, paddingLeft: 20 };
const li = { marginBottom: 8 };
const strong = { color: 'var(--text-primary)' };
