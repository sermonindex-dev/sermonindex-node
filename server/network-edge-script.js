/**
 * SermonIndex Network Services — Bunny Edge Script
 * =================================================
 * Two tiny endpoints for the seed-node backbone, in one paste-in script:
 *
 *   POST /probe   { port, ip? }
 *     → { ok:true, open:boolean, ip, port }
 *     Opens a raw TCP connection back to the caller's public IP:port to test
 *     whether their BitTorrent port is reachable from the internet. Uses
 *     Deno.connect (supported by Bunny Edge Scripting). `ip` may be supplied in
 *     the body (the app already knows its public IP from geolocation); otherwise
 *     the client IP from the request headers is used.
 *
 *   POST /seeds   { node_id, port, scope }        (scope: "audio" | "full")
 *     → { ok:true }   registers/updates this node in the seed directory,
 *                     recording its public IP, port, scope, reachability, time.
 *   GET  /seeds
 *     → { ok:true, seeds:[ { node, ip, port, scope, reachable, ago_secs } ] }
 *                     the currently-active reachable-backbone nodes (seen < 2h).
 *
 * Seeds are stored as ONE JSON file in Bunny Storage (network/seeds.json).
 *
 * PRIVACY NOTE: a seed node's IP:port is inherently public — any BitTorrent
 * peer it serves already sees it. Only nodes that opt into seed mode register.
 *
 * DEPLOY (Bunny dashboard, ~3 min):
 *  1. Edge Scripting → Add script → Standalone → paste this whole file.
 *  2. Environment Variables (secrets):
 *       STORAGE_ZONE  = your storage zone name (same one the chat uses)
 *       STORAGE_KEY   = that storage zone's password (FTP & API Access)
 *       STORAGE_HOST  = storage.bunnycdn.com   (or your region host)
 *  3. Publish → copy the script's hostname (e.g. si-network-xxxx.bunny.run).
 *  4. Send me that hostname; I'll bake it into the app (probe + seed directory).
 *     (No DNS/Edge-Rule needed — the app calls the bunny.run URL directly,
 *      exactly like the community chat.)
 *
 *  Test after deploy:
 *    curl -X POST '<host>/probe' -H 'content-type: application/json' -d '{"port":42800,"ip":"1.2.3.4"}'
 *    curl '<host>/seeds'   →   {"ok":true,"seeds":[]}
 */

import * as BunnySDK from "https://esm.sh/@bunny.net/edgescript-sdk@0.11.2";

const env = (k, d = "") =>
  (typeof process !== "undefined" && process.env && process.env[k]) ||
  (typeof Deno !== "undefined" && Deno.env.get(k)) || d;

const STORAGE_ZONE = env("STORAGE_ZONE");
const STORAGE_KEY  = env("STORAGE_KEY");
const STORAGE_HOST = env("STORAGE_HOST", "storage.bunnycdn.com");
const ADMIN_KEY    = env("ADMIN_KEY", "CHANGE_ME"); // for enabling seed access
const SEEDS_URL    = `https://${STORAGE_HOST}/${STORAGE_ZONE}/network/seeds.json`;
const ACCESS_URL   = `https://${STORAGE_HOST}/${STORAGE_ZONE}/network/seed-access.json`;

const STALE_MS      = 2 * 60 * 60 * 1000; // seed considered active if seen < 2h
const CONNECT_MS    = 5000;               // TCP probe timeout
const PORT_MIN = 1, PORT_MAX = 65535;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Cache-Control": "no-store",
};
const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...CORS } });

// ── Client public IP from headers (Bunny forwards it) ───────────────────────
function clientIp(request) {
  const h = request.headers;
  const xff = h.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  return h.get("x-real-ip") || h.get("cdn-clientip") || h.get("x-client-ip") || "";
}

const validIp = (ip) => /^(\d{1,3}\.){3}\d{1,3}$/.test(ip) || /:/.test(ip); // IPv4 or IPv6
const validPort = (p) => Number.isInteger(p) && p >= PORT_MIN && p <= PORT_MAX;

// ── Raw TCP reachability test ───────────────────────────────────────────────
async function isReachable(ip, port) {
  let conn = null;
  try {
    conn = await Promise.race([
      Deno.connect({ hostname: ip, port, transport: "tcp" }),
      new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), CONNECT_MS)),
    ]);
    return true; // TCP handshake succeeded → port is open/reachable
  } catch {
    return false; // refused / timeout / unreachable
  } finally {
    try { if (conn) conn.close(); } catch {}
  }
}

// ── Seed directory storage (single JSON file) ───────────────────────────────
async function loadSeeds() {
  try {
    const res = await fetch(SEEDS_URL, { headers: { AccessKey: STORAGE_KEY } });
    if (res.status === 404) return {};
    if (!res.ok) return {};
    const data = await res.json().catch(() => null);
    return data && typeof data === "object" && data.nodes ? data.nodes : {};
  } catch { return {}; }
}
async function saveSeeds(nodes) {
  await fetch(SEEDS_URL, {
    method: "PUT",
    headers: { AccessKey: STORAGE_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ nodes }),
  });
}

// Seed-access allowlist: { enabled: { "<nodeId>": {added,email} }, requests: {...} }
async function loadAccess() {
  try {
    const res = await fetch(ACCESS_URL, { headers: { AccessKey: STORAGE_KEY } });
    if (!res.ok) return { enabled: {}, requests: {} };
    const data = await res.json().catch(() => null);
    return data && typeof data === "object"
      ? { enabled: data.enabled || {}, requests: data.requests || {} }
      : { enabled: {}, requests: {} };
  } catch { return { enabled: {}, requests: {} }; }
}
async function saveAccess(a) {
  await fetch(ACCESS_URL, {
    method: "PUT",
    headers: { AccessKey: STORAGE_KEY, "Content-Type": "application/json" },
    body: JSON.stringify(a),
  });
}
const cleanNode = (s) => String(s || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);

BunnySDK.net.http.serve(async (request) => {
  try {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, ""); // strip trailing slash

    // ── /probe ───────────────────────────────────────────────────────────
    if (path.endsWith("/probe")) {
      if (request.method !== "POST") return json(405, { ok: false, error: "use POST" });
      const body = await request.json().catch(() => ({}));
      const port = parseInt(body.port, 10);
      const ip = (body.ip && validIp(String(body.ip))) ? String(body.ip) : clientIp(request);
      if (!validIp(ip) || !validPort(port)) return json(400, { ok: false, error: "bad ip/port" });
      const open = await isReachable(ip, port);
      return json(200, { ok: true, open, ip, port });
    }

    // ── /seeds ───────────────────────────────────────────────────────────
    if (path.endsWith("/seeds")) {
      const now = Date.now();

      if (request.method === "GET") {
        const nodes = await loadSeeds();
        // A backbone seed only counts if it is BOTH recently seen AND actually
        // reachable from the internet. A node with a closed port (reachable:false)
        // can still leech/seed as a leaf, but it is not part of the reliable
        // backbone, so it must not appear in this directory or the menu count.
        const seeds = Object.values(nodes)
          .filter((n) => n.reachable && now - (n.last_seen || 0) < STALE_MS)
          .map((n) => ({
            node: String(n.node || "").slice(0, 8),
            ip: n.ip, port: n.port, scope: n.scope,
            reachable: !!n.reachable,
            ago_secs: Math.round((now - (n.last_seen || now)) / 1000),
          }));
        return json(200, { ok: true, seeds });
      }

      if (request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        const nodeId = String(body.node_id || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
        const port = parseInt(body.port, 10);
        const scope = body.scope === "full" ? "full" : "audio";
        const ip = (body.ip && validIp(String(body.ip))) ? String(body.ip) : clientIp(request);
        if (!nodeId || !validIp(ip) || !validPort(port)) return json(400, { ok: false, error: "bad fields" });

        const reachable = await isReachable(ip, port);
        const nodes = await loadSeeds();
        nodes[nodeId] = { node: nodeId.slice(0, 8), ip, port, scope, reachable, last_seen: now };
        // Prune stale entries so the file stays small.
        for (const k of Object.keys(nodes)) {
          if (now - (nodes[k].last_seen || 0) > STALE_MS) delete nodes[k];
        }
        await saveSeeds(nodes);
        return json(200, { ok: true, reachable });
      }

      return json(405, { ok: false, error: "use GET or POST" });
    }

    // ── /seed-access ──────────────────────────────────────────────────────
    // Backend allowlist that gates the app's Seed Node page (replaces the old
    // password). A node is identified by its node id (e.g. "si-2098a…").
    //
    //   GET  /seed-access?node=<id>              → { enabled: bool }   (public)
    //   POST /seed-access {action:'request', node_id, email}          (public)
    //   POST /seed-access?admin_key=KEY&action=enable|disable&node=<id> (admin)
    //   GET  /seed-access?admin_key=KEY&list=1   → { enabled, requests, serving }
    if (path.endsWith("/seed-access")) {
      const adminKey = url.searchParams.get("admin_key");
      const isAdmin = adminKey && ADMIN_KEY !== "CHANGE_ME" && adminKey === ADMIN_KEY;

      if (request.method === "GET") {
        // Admin dashboard listing (enabled nodes + pending requests + who's serving)
        if (url.searchParams.get("list")) {
          if (!isAdmin) return json(403, { ok: false, error: "forbidden" });
          const access = await loadAccess();
          const nodes = await loadSeeds();
          const now = Date.now();
          const serving = {};
          for (const [id, n] of Object.entries(nodes)) {
            serving[n.node || id.slice(0, 8)] = {
              reachable: !!n.reachable,
              scope: n.scope,
              ago_secs: Math.round((now - (n.last_seen || now)) / 1000),
            };
          }
          return json(200, { ok: true, enabled: access.enabled, requests: access.requests, serving });
        }
        // Public: is this node enabled?
        const node = cleanNode(url.searchParams.get("node"));
        if (!node) return json(400, { ok: false, error: "missing node" });
        const access = await loadAccess();
        return json(200, { ok: true, enabled: !!access.enabled[node] });
      }

      if (request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        const action = url.searchParams.get("action") || body.action;
        const node = cleanNode(body.node_id || body.node || url.searchParams.get("node"));

        // Admin: enable / disable a node
        if (action === "enable" || action === "disable") {
          if (!isAdmin) return json(403, { ok: false, error: "forbidden" });
          if (!node) return json(400, { ok: false, error: "missing node" });
          const access = await loadAccess();
          if (action === "enable") {
            access.enabled[node] = { added: Date.now(), email: access.requests[node]?.email || "" };
          } else {
            delete access.enabled[node];
          }
          delete access.requests[node]; // clear any pending request either way
          await saveAccess(access);
          return json(200, { ok: true, enabled: Object.keys(access.enabled) });
        }

        // Public: submit an access request with an email
        if (action === "request") {
          if (!node) return json(400, { ok: false, error: "missing node" });
          const email = String(body.email || "").replace(/[ -]/g, "").trim().slice(0, 120);
          const access = await loadAccess();
          if (!access.enabled[node]) {
            access.requests[node] = { email, at: Date.now(), ip: clientIp(request) };
            await saveAccess(access);
          }
          return json(200, { ok: true, requested: true, enabled: !!access.enabled[node] });
        }

        return json(400, { ok: false, error: "bad action" });
      }

      return json(405, { ok: false, error: "use GET or POST" });
    }

    return json(404, { ok: false, error: "unknown endpoint" });
  } catch (e) {
    return json(500, { ok: false, error: "server_error" });
  }
});
