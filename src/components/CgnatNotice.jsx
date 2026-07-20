import React from 'react';

/**
 * CgnatNotice — the honest explanation for someone whose port can't be opened
 * because their internet provider shares one address between many customers
 * (carrier-grade NAT: Starlink, T-Mobile Home Internet, most mobile broadband).
 *
 * WHY: those users can't port-forward on the PROVIDER'S OWN router, no matter
 * what they change there. Telling them to "turn on UPnP or forward TCP 42800"
 * on that box sends them on an errand that cannot succeed and leaves them
 * feeling their setup is broken. It isn't.
 *
 * BUT there IS a real route through, and this copy now offers it instead of
 * ending on "nothing for you to fix": on Starlink and most satellite/mobile
 * providers you can put the provider's unit into bypass/bridge mode and run
 * your OWN router behind it, after which the port-forwarding steps below apply
 * normally. It is a bigger step — it usually means buying a router, and on
 * Starlink bypass mode disables the built-in WiFi and needs a factory reset to
 * undo — so we say all of that plainly, and we say "usually works", never
 * "will work", because it depends on the provider.
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
          : 'Your provider may be sharing one address between many homes'}
      </div>

      <p style={para}>
        {detected
          ? "We can see that your connection sits behind your provider's shared network (often called CGNAT). "
          : "If you're on Starlink, T-Mobile Home Internet, or any mobile or satellite broadband, your provider "
            + 'almost certainly shares a single internet address between many customers. '}
        That address belongs to the provider, not to your home — so on the box <em>they</em> gave you, there is
        no port-forwarding setting that can work, and no phone call to support that will change it. You
        haven&rsquo;t done anything wrong.
      </p>

      <p style={para}>
        <strong style={{ color: 'var(--text-primary)' }}>There is something you can try, though.</strong> On
        Starlink and most satellite and mobile providers, you can add <em>your own</em> router and switch the
        provider&rsquo;s unit into what&rsquo;s usually called <em>bypass</em> (or bridge) mode — it stops trying
        to be the router and simply passes the connection through to yours. Your own router then handles the
        connection, and the port-forwarding steps below apply to it in the normal way. This usually works, though
        it does depend on your provider.
      </p>

      <p style={para}>
        <strong style={{ color: 'var(--text-primary)' }}>Worth knowing before you start:</strong> this is a
        bigger step than changing a setting. It normally means buying a router, and on Starlink specifically,
        turning on bypass mode switches off the WiFi built into the Starlink unit — your new router provides the
        WiFi instead — and undoing it later requires a factory reset. Nothing breaks, but it&rsquo;s a change to
        how your whole home connects, so it&rsquo;s worth choosing deliberately rather than on a whim.
      </p>

      <p style={para}>
        <strong style={{ color: 'var(--text-primary)' }}>And if you&rsquo;d rather not — your node still helps,
        every day.</strong> It reaches out and connects to other nodes by itself, and it uploads sermons to every
        one it reaches — including sermons you finished downloading long ago. You&rsquo;re carrying real weight
        for the archive either way. This is an upgrade, never a repair.
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
        The one thing you can&rsquo;t do today is be found first — you do the finding. That&rsquo;s why nodes with
        an open port still matter: they act as meeting points for everyone else. If you do add your own router
        (or ever move to a connection that allows port forwarding), the steps below are exactly what you&rsquo;ll
        follow — just carry them out on your own router rather than the provider&rsquo;s.
      </p>
    </div>
  );
}

// Neutral, calm surface — deliberately NOT a warning treatment: the background
// stays the plain tertiary one and there is no orange anywhere, because nothing
// is wrong here. The accent is the node map's PEER colour (var(--gold-text) —
// see NODE_COLORS.peer in NetworkPage.jsx), so this panel visually belongs to
// the peer status it explains rather than borrowing the seed colour.
const panel = {
  marginTop: '10px',
  padding: '12px 14px',
  borderRadius: '8px',
  background: 'var(--bg-tertiary)',
  border: '1px solid var(--border)',
  borderLeft: '3px solid var(--gold-text)',
  fontSize: '0.78rem',
  color: 'var(--text-secondary)',
  lineHeight: 1.6,
};
const heading = {
  fontWeight: 700,
  fontSize: '0.82rem',
  color: 'var(--gold-text)',
  marginBottom: '6px',
};
const para = { margin: '0 0 8px' };
