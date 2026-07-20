/**
 * nodeStatus — ONE source of truth for "what kind of node am I right now?"
 *
 * There are exactly FOUR states, and they use the SAME vocabulary and the SAME
 * colours as the node map (see NODE_COLORS in pages/NetworkPage.jsx), so that a
 * volunteer who sees themselves on the map reads the same word here:
 *
 *   Offline   — the torrent session isn't running.            var(--text-muted)
 *   Peer      — running, but nobody out there can open a
 *               connection IN to us. Still genuinely useful:
 *               a peer goes out and connects to others, and
 *               uploads to every one of them.                  var(--gold-text)
 *   Node      — running AND reachable from the outside world.  var(--green)
 *   Seed node — reachable exactly like a Node, AND granted
 *               seed access by the admin. BOTH are required.   var(--seed-blue)
 *
 * The "both are required" rule is the whole point: an approved volunteer whose
 * port is shut is a PEER, not a seed node. Being on the allowlist doesn't make
 * anyone reachable.
 *
 * This module exists because the same derivation used to be written out twice
 * (ConnectionsPanel and the App.jsx TopBar) and had already drifted apart — one
 * copy counted IPv6 reachability and the other didn't. Both now call in here.
 */

// Colours are the node map's own tokens, verbatim. No new colours.
export const NODE_STATE_COLOR = {
  seed: 'var(--seed-blue)',
  node: 'var(--green)',
  peer: 'var(--gold-text)',
  offline: 'var(--text-muted)',
};

export const NODE_STATE_LABEL = {
  seed: 'Seed node',
  node: 'Node',
  peer: 'Peer',
  offline: 'Offline',
};

// One warm, plain sentence per state, for non-technical volunteers. The peer
// wording is deliberately not an apology and not a to-do: for a great many
// people (Starlink, mobile broadband, shared networks) it is permanent, and
// they contribute every single day.
export const NODE_STATE_BLURB = {
  offline: 'Your node is not running, so nothing is being shared at the moment.',
  peer: 'Other people cannot connect in to you, so your node goes out and connects to them — and uploads sermons to every peer it reaches. That is real help, every day.',
  node: 'People out on the internet can connect straight to your node, so you are part of the network’s backbone.',
  seed: 'You are an approved seed node and reachable from the internet — a home for the whole library that others can always fall back on.',
};

/**
 * Is anyone able to open a connection TO us? Considers every source of proof we
 * have, and treats them as equal because they are evidence of the same fact:
 *
 *   reach.open      — the probe server dialled our IPv4 port and got in.
 *   reach.open_v6   — the probe server dialled our IPv6 address and got in.
 *   ipv6.v6_inbound_seen — PASSIVE: a real peer out on the internet opened a
 *                     connection to us over a public IPv6 address. This is the
 *                     one that actually fires in practice, because the probe
 *                     server has no IPv6 route of its own.
 *
 * A node reachable ONLY over IPv6 — the normal good outcome on Starlink — is a
 * Node, not a Peer.
 *
 * `v6_egress_seen` is deliberately NOT evidence: dialling out over IPv6 proves
 * only that we can dial out.
 *
 * Unknown (never probed, nothing observed) returns false → the node reads as a
 * Peer. That matches the map, which classifies an unproven node as a peer too
 * (catOf in NetworkPage.jsx), and it keeps us from ever claiming reachability
 * we have not seen.
 *
 * @param {{reach?: object|null, ipv6?: object|null}} sources
 */
export function isReachable({ reach, ipv6 } = {}) {
  if (reach?.open === true) return true;
  if (reach?.open_v6 === true) return true;
  if (ipv6?.v6_inbound_seen === true) return true;
  return false;
}

/**
 * @param {{running: boolean, reachable: boolean, seedGranted: boolean}} input
 * @returns {{key: 'offline'|'peer'|'node'|'seed', label: string, color: string, blurb: string}}
 */
export function deriveNodeState({ running, reachable, seedGranted } = {}) {
  let key = 'offline';
  if (running) {
    if (!reachable) key = 'peer';
    else key = seedGranted ? 'seed' : 'node';
  }
  return {
    key,
    label: NODE_STATE_LABEL[key],
    color: NODE_STATE_COLOR[key],
    blurb: NODE_STATE_BLURB[key],
  };
}

// ── Seed-access mirror ─────────────────────────────────────────────────────
// "Granted seed access" is a BACKEND decision (`/api/seed/access`, checked by
// network.js `checkSeedAccess`). App.jsx and SeedNodePage already ask the
// server; they now also write the last DEFINITIVE answer here so that other
// parts of the UI — notably ConnectionsPanel, which is rendered by a page that
// passes it no props — can read it without a second network call.
//
// Only ever written from a real server answer, never from a default, so a fresh
// launch does not momentarily blank a granted node's status.
const SEED_GRANTED_KEY = 'si-seed-granted';

export function readSeedGranted() {
  try { return localStorage.getItem(SEED_GRANTED_KEY) === '1'; } catch { return false; }
}

export function writeSeedGranted(granted) {
  try { localStorage.setItem(SEED_GRANTED_KEY, granted ? '1' : '0'); } catch {}
}
