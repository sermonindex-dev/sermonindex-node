import React from 'react';

/**
 * CgnatNotice — the honest explanation for someone whose port can't be opened
 * because their internet provider shares one address between many customers
 * (carrier-grade NAT: Starlink, T-Mobile Home Internet, most mobile broadband).
 *
 * WHY: those users can never port-forward, no matter what they change. Telling
 * them to "turn on UPnP or forward TCP 42800" sends them on an errand that
 * cannot succeed and leaves them feeling their setup is broken. It isn't.
 *
 * WHAT'S TRUE (and what this copy is careful not to overstate): a node that
 * can't accept incoming connections still dials OUT to peers it finds through
 * DHT and trackers, and uploads to them — including for sermons it has already
 * finished. So these nodes genuinely contribute. What they can't do is be
 * *discovered*; they do the discovering. Two nodes that both have closed ports
 * can never pair up, which is why open-port nodes still matter.
 *
 * Props:
 *   detected {boolean} — true only when we actually observed a 100.64.0.0/10
 *                        address. When false the copy is worded as a
 *                        possibility ("if you're on…"), never as a diagnosis,
 *                        because the probe usually can't see a CGNAT address.
 *   v6Firewalled {boolean} — this machine HAS a global IPv6 address, and the
 *                        probe genuinely dialled it and got nothing. That is a
 *                        real, specific diagnosis: the traffic reached the
 *                        router and the router dropped it. The fix is an
 *                        inbound-IPv6 firewall rule, NOT port forwarding — so
 *                        we say that, and we say plainly that many routers
 *                        (stock Starlink included) don't expose the setting.
 *   style    {object}   — optional container style overrides
 */
export default function CgnatNotice({ detected = false, v6Firewalled = false, style }) {
  return (
    <div style={{ ...panel, ...style }}>
      <div style={heading}>
        {detected
          ? 'Your internet provider shares one address between many homes'
          : "This may not be something you can fix — and that's okay"}
      </div>

      <p style={para}>
        {detected
          ? "We can see that your connection sits behind your provider's shared network (often called CGNAT). "
          : "If you're on Starlink, T-Mobile Home Internet, or any mobile or satellite broadband, your provider "
            + 'almost certainly shares a single internet address between many customers. '}
        On a connection like that, opening a port is impossible — there is no setting on your router, and no
        phone call to support, that will change it. You haven&rsquo;t done anything wrong, and there is nothing
        for you to fix.
      </p>

      <p style={para}>
        <strong style={{ color: 'var(--text-primary)' }}>Your node still helps, every day.</strong> It reaches
        out and connects to other nodes by itself, and it uploads sermons to every one it reaches — including
        sermons you finished downloading long ago. You&rsquo;re still carrying real weight for the archive.
      </p>

      {v6Firewalled && (
        <p style={para}>
          <strong style={{ color: 'var(--text-primary)' }}>One thing we did notice.</strong> Your computer does
          have a modern (IPv6) internet address, and we tried to connect to it — your router turned us away.
          That&rsquo;s a firewall rule, not a broken setup, and it&rsquo;s how most routers ship. If yours has a
          setting like <em>Allow incoming IPv6</em> or an <em>IPv6 firewall</em> you can open, allowing incoming
          traffic to this computer would let people connect to you directly. Plenty of routers &mdash; the
          standard Starlink one included &mdash; simply don&rsquo;t offer it, and if yours doesn&rsquo;t,
          there&rsquo;s nothing further to try. Note this is a different setting from port forwarding; port
          forwarding won&rsquo;t help here.
        </p>
      )}

      <p style={{ ...para, marginBottom: 0, color: 'var(--text-muted)' }}>
        The one thing you can&rsquo;t do is be found first — you do the finding. That&rsquo;s why nodes with an
        open port still matter: they act as meeting points for everyone else. If you ever move to a connection
        that allows port forwarding, the steps here will work then.
      </p>
    </div>
  );
}

// Neutral, calm surface — deliberately NOT the orange/gold warning treatment.
// Nothing is wrong here, so nothing should look like an alarm.
const panel = {
  marginTop: '10px',
  padding: '12px 14px',
  borderRadius: '8px',
  background: 'var(--bg-tertiary)',
  border: '1px solid var(--border)',
  borderLeft: '3px solid var(--seed-blue)',
  fontSize: '0.78rem',
  color: 'var(--text-secondary)',
  lineHeight: 1.6,
};
const heading = {
  fontWeight: 700,
  fontSize: '0.82rem',
  color: 'var(--seed-blue)',
  marginBottom: '6px',
};
const para = { margin: '0 0 8px' };
