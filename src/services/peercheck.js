/**
 * Peer-assisted reachability checking — the desktop half.
 *
 * Mirrors src/peercheck.rs in the CLI exactly; read the long note there for why
 * this exists. Short version: our probe edge has no outbound IPv6, so it can
 * never confirm the households that most need confirming. Other nodes can. The
 * heartbeat is already running every five minutes, so it carries the request
 * out and the answer back at no extra cost.
 *
 * THE GUARD RAILS ARE THE DESIGN. This asks one machine to connect to another
 * on request. Everything narrow about it is deliberate:
 *
 *   - the address comes from the server, taken from the target's own heartbeat;
 *     a client can never name somebody else's address
 *   - one port, the target's own declared listening port — no ranges
 *   - connect, then close. Nothing sent, nothing read
 *   - private, loopback, link-local, unique-local, multicast and carrier-NAT
 *     ranges are refused HERE as well as at the server, because two independent
 *     checks are the only version of this that stays true after someone edits
 *     one of them
 *   - one check per beat
 */

/**
 * Would we be willing to dial this address? Global unicast only.
 *
 * Refusing the private ranges is the important half: dialling those would mean
 * reaching into the prober's own house, which is exactly the abuse this must
 * never enable.
 */
export function isDialable(ip) {
  const s = String(ip || '').trim();
  if (!s) return false;

  if (s.includes(':')) {
    const low = s.toLowerCase();
    if (low === '::1' || low === '::') return false;
    if (low.startsWith('fe80')) return false;                 // link-local
    if (/^f[cd]/.test(low)) return false;                     // unique-local fc00::/7
    if (low.startsWith('ff')) return false;                   // multicast
    if (low.includes('.')) return false;                      // v4-mapped — judge as v4
    const head = parseInt(low.split(':')[0] || '0', 16);
    return (head & 0xe000) === 0x2000;                        // 2000::/3
  }

  const p = s.split('.').map((n) => Number(n));
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = p;
  if (a === 0 || a === 127 || a >= 224) return false;          // unspecified, loopback, multicast+
  if (a === 10) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 169 && b === 254) return false;                    // link-local
  if (a === 100 && b >= 64 && b <= 127) return false;          // 100.64/10 carrier NAT
  return true;
}

/**
 * Perform one check. Resolves true/false, or null when we declined to dial.
 *
 * "We would not try" and "we tried and nobody answered" are different answers,
 * and reporting the first as the second would mark a reachable node as
 * unreachable — so a refusal is null, never false.
 */
export async function performCheck(ip, port) {
  if (!isDialable(ip) || !port) {
    console.warn('[peercheck] refusing to dial', ip, '— not a public address');
    return null;
  }
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    // The dial happens in Rust: a browser context cannot open a raw TCP
    // connection, and would not be able to tell "refused" from "blocked by the
    // page's own security policy" even if it could.
    const open = await invoke('peer_check_dial', { ip: String(ip), port: Number(port) });
    return open === true;
  } catch (e) {
    // An older native build without the command, or the session is down. Not an
    // answer about the target, so say nothing about it.
    console.warn('[peercheck] could not run the check:', e?.message || e);
    return null;
  }
}

/** Pull a check request out of a heartbeat response, if there is one. */
export function requestFrom(config) {
  const c = config && config.check_peer;
  if (!c || typeof c.ip !== 'string' || !c.port || typeof c.token !== 'string') return null;
  return { ip: c.ip, port: Number(c.port), token: c.token };
}
