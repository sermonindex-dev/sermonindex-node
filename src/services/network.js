/**
 * SermonIndex Network Services — client wrapper.
 *
 * Talks to the Bunny Edge Script in server/network-edge-script.js:
 *   POST /probe  { port }           → { ok, open, ip, port }
 *   POST /seeds  { node_id, port, scope } → { ok, reachable }
 *   GET  /seeds                     → { ok, seeds:[...] }
 *
 * After deploying that script, replace NETWORK_API below with its bunny.run
 * hostname (same as we did for the community chat).
 */

// Deployed network Edge Script (see server/network-edge-script.js).
export const NETWORK_API = 'https://app-endpoints-gkb5p.bunny.run';

const isConfigured = () => !NETWORK_API.includes('REPLACE-WITH');

/**
 * Ask the server to TCP-connect back to our public IP:port.
 * Returns { open:boolean, ip, port } or null if the service isn't reachable
 * (caller should fall back to canyouseeme.org).
 */
export async function probeReachability(port) {
  if (!isConfigured() || !port) return null;
  try {
    const res = await fetch(`${NETWORK_API}/probe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ port }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data && data.ok ? { open: !!data.open, ip: data.ip, port: data.port } : null;
  } catch {
    return null;
  }
}

/** Register/refresh this node in the seed-backbone directory. Fire-and-forget. */
export async function registerSeed(nodeId, port, scope) {
  if (!isConfigured() || !nodeId || !port) return null;
  try {
    const res = await fetch(`${NETWORK_API}/seeds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ node_id: nodeId, port, scope: scope === 'full' ? 'full' : 'audio' }),
      signal: AbortSignal.timeout(15000),
    });
    const data = await res.json().catch(() => null);
    return data && data.ok ? data : null;
  } catch {
    return null;
  }
}

/**
 * Is this node approved for Seed Node access? Checks the backend allowlist
 * (an admin enables a node by its id). Returns false on any error.
 */
export async function checkSeedAccess(nodeId) {
  if (!isConfigured() || !nodeId) return false;
  try {
    const res = await fetch(`${NETWORK_API}/seed-access?node=${encodeURIComponent(nodeId)}`, {
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return false;
    const data = await res.json();
    return !!(data && data.ok && data.enabled);
  } catch {
    return false;
  }
}

/**
 * Submit a seed-access request with an email so the admin can enable this node.
 * Returns the server response ({ requested, enabled }) or null on failure.
 */
export async function requestSeedAccess(nodeId, email) {
  if (!isConfigured() || !nodeId) return null;
  try {
    const res = await fetch(`${NETWORK_API}/seed-access`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'request', node_id: nodeId, email: email || '' }),
      signal: AbortSignal.timeout(10000),
    });
    const data = await res.json().catch(() => null);
    return data && data.ok ? data : null;
  } catch {
    return null;
  }
}

/** Fetch the currently-active backbone seed nodes. Returns [] on any error. */
export async function fetchSeeds() {
  if (!isConfigured()) return [];
  try {
    const res = await fetch(`${NETWORK_API}/seeds`, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return [];
    const data = await res.json();
    return data && data.ok && Array.isArray(data.seeds) ? data.seeds : [];
  } catch {
    return [];
  }
}
