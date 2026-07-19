/**
 * SermonIndex Network Services — Bunny Edge Script
 * =================================================
 * Two tiny endpoints for the seed-node backbone, in one paste-in script:
 *
 *   POST /probe   { port, ip?, ipv6? }
 *     → { ok:true, open:boolean, ip, port, open_v6:boolean, ipv6, v6_probe }
 *     Opens a raw TCP connection back to the caller's public IP:port to test
 *     whether their BitTorrent port is reachable from the internet. Uses
 *     Deno.connect (supported by Bunny Edge Scripting). `ip` may be supplied in
 *     the body (the app already knows its public IP from geolocation); otherwise
 *     the client IP from the request headers is used.
 *
 *     `ipv6` (optional, string or array, max 3) holds the caller's own global
 *     IPv6 address(es), discovered locally by the app's `local_ipv6` Tauri
 *     command. Each is dialled on the SAME port. This matters because the node
 *     binds dual-stack [::]:42800: a customer of a CGNAT provider (Starlink,
 *     T-Mobile Home Internet, most mobile broadband) can be permanently
 *     IPv4-unreachable and perfectly IPv6-reachable at the same time, and the
 *     old single boolean reported that person as simply "unreachable", which
 *     was wrong. The IPv4 `open` field is UNCHANGED and stays authoritative for
 *     older clients and the seed directory.
 *
 * ┌─ UNVERIFIED UNTIL DEPLOYED ────────────────────────────────────────────────┐
 * │ We have NOT confirmed that Bunny's edge runtime has outbound IPv6          │
 * │ connectivity at all. If it does not, `open_v6` can never be true and the   │
 * │ whole IPv6 signal is useless. So the code never fails silently: it         │
 * │ distinguishes "we really dialled and nobody answered" from "we could not   │
 * │ even attempt an IPv6 connection", and reports that in `v6_probe`:          │
 * │                                                                            │
 * │   "ok"          — an IPv6 TCP connect was genuinely attempted. `open_v6`   │
 * │                   is then a real measurement (true = connected).           │
 * │   "unsupported" — the runtime refused to make an IPv6 socket at all        │
 * │                   (EAFNOSUPPORT / "address family not supported" /         │
 * │                   ENETUNREACH "network is unreachable"). `open_v6:false`   │
 * │                   here means NOTHING about the caller — do not show it.    │
 * │   "error"       — an unexpected throw (bad literal form, runtime bug).     │
 * │   "invalid"     — the client sent ipv6 values, all failed validation.      │
 * │   "none"        — the client sent no ipv6 field (old clients). Backward    │
 * │                   compatible: the response is otherwise identical to       │
 * │                   before, plus open_v6:false / ipv6:null.                  │
 * │                                                                            │
 * │ VERIFY AFTER DEPLOY, from a machine with real IPv6 and the node running:   │
 * │   # 1. does the edge have IPv6 egress at all? Dial a host that is          │
 * │   #    guaranteed to be up on TCP 53. Expect v6_probe:"ok", open_v6:true.  │
 * │   curl -sX POST '<host>/probe' -H 'content-type: application/json' \       │
 * │     -d '{"port":53,"ip":"8.8.8.8","ipv6":"2001:4860:4860::8888"}'          │
 * │   # v6_probe:"unsupported" ⇒ Bunny edge has NO IPv6 egress. Stop here and  │
 * │   #   hide the IPv6 state in the app rather than reporting false.          │
 * │   # 2. your own node (get the address from the app's local_ipv6 command):  │
 * │   curl -sX POST '<host>/probe' -H 'content-type: application/json' \       │
 * │     -d '{"port":42800,"ipv6":["<your:global:v6>"]}'                        │
 * │   # 3. SSRF guard — every one of these must come back v6_probe:"invalid":  │
 * │   curl -sX POST '<host>/probe' -H 'content-type: application/json' \       │
 * │     -d '{"port":42800,"ipv6":["::1","fe80::1","fc00::1","::ffff:127.0.0.1"]}' │
 * └────────────────────────────────────────────────────────────────────────────┘
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

// ── IPv6 dial-back ──────────────────────────────────────────────────────────
// SSRF NOTE: /probe connects to an address the CALLER chose. That is the whole
// point (it's a dial-back test), but it means this endpoint can be pointed at
// anything, so every target is parsed and range-checked HERE, server-side. We
// never trust the client to have filtered its own addresses. Only globally
// routable unicast IPv6 is dialled: loopback, link-local, site-local,
// unique-local, IPv4-mapped, multicast and documentation space are all refused,
// which keeps the edge from being used to reach its own neighbours.

const IPV6_MAX = 3; // most hosts have 1–2 global addresses; 3 is generous

/**
 * Parse an IPv6 literal into 16 bytes, or null if it isn't one.
 * Accepts optional surrounding brackets and an embedded IPv4 tail
 * (::ffff:127.0.0.1). Rejects zone ids (%eth0) outright — a scoped address is
 * link-local by definition and could never be a valid dial-back target.
 */
function parseIpv6(input) {
  if (typeof input !== 'string') return null;
  let s = input.trim();
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  if (!s || s.length > 45 || s.includes('%')) return null;
  if (!s.includes(':') || !/^[0-9A-Fa-f:.]+$/.test(s)) return null;

  // Fold an embedded IPv4 tail into two hex groups so the rest of the parser
  // only ever deals with 16-bit groups. "::ffff:127.0.0.1" → "::ffff:7f00:1".
  const lastColon = s.lastIndexOf(':');
  const tail = s.slice(lastColon + 1);
  if (tail.includes('.')) {
    const m = tail.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (!m) return null;
    const oct = m.slice(1).map(Number);
    if (oct.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    const g1 = ((oct[0] << 8) | oct[1]).toString(16);
    const g2 = ((oct[2] << 8) | oct[3]).toString(16);
    s = `${s.slice(0, lastColon + 1)}${g1}:${g2}`;
  }

  const halves = s.split('::');
  if (halves.length > 2) return null;                   // only one "::" allowed
  const groupsOf = (part) =>
    part === '' ? [] : part.split(':').map((g) => (/^[0-9A-Fa-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));

  const head = groupsOf(halves[0]);
  const rest = halves.length === 2 ? groupsOf(halves[1]) : [];
  if (head.concat(rest).some((n) => !Number.isInteger(n))) return null;

  let groups;
  if (halves.length === 2) {
    const fill = 8 - head.length - rest.length;
    if (fill < 1) return null;                          // "::" must elide ≥1 group
    groups = head.concat(new Array(fill).fill(0), rest);
  } else {
    if (head.length !== 8) return null;                 // no "::" → must be full
    groups = head;
  }

  const b = new Uint8Array(16);
  for (let i = 0; i < 8; i++) { b[i * 2] = groups[i] >> 8; b[i * 2 + 1] = groups[i] & 0xff; }
  return b;
}

/**
 * Is this address one the public internet could really dial? Mirrors
 * `is_globally_routable_v6` in src-tauri/src/lib.rs — keep the two in step.
 * The bit arithmetic is spelled out there in full; the short version:
 *   ff00::/8    multicast          → first byte 0xff
 *   fe80::/10   link-local         → top 10 bits (mask 0xffc0) == 0xfe80
 *   fec0::/10   site-local (dead)  → top 10 bits == 0xfec0
 *   fc00::/7    unique-local       → top 7 bits (mask 0xfe) == 0xfc
 *   ::ffff:0:0/96 IPv4-mapped      → 10 zero bytes then 0xff 0xff
 *   ::/96       incl. :: and ::1   → first 12 bytes all zero
 *   2001:db8::/32 documentation
 */
function isGloballyRoutableV6(b) {
  if (!b || b.length !== 16) return false;
  const s0 = (b[0] << 8) | b[1];
  const s1 = (b[2] << 8) | b[3];
  if (b[0] === 0xff) return false;
  if ((s0 & 0xffc0) === 0xfe80) return false;
  if ((s0 & 0xffc0) === 0xfec0) return false;
  if ((b[0] & 0xfe) === 0xfc) return false;
  let zero10 = true;
  for (let i = 0; i < 10; i++) if (b[i] !== 0) { zero10 = false; break; }
  if (zero10 && b[10] === 0xff && b[11] === 0xff) return false;
  if (zero10 && b[10] === 0 && b[11] === 0) return false;
  if (s0 === 0x2001 && s1 === 0x0db8) return false;
  return true;
}

/** Client-supplied ipv6 field → a de-duplicated list of safe, dialable targets. */
function sanitizeIpv6List(v) {
  const raw = Array.isArray(v) ? v : (typeof v === 'string' ? [v] : []);
  const out = [];
  for (const item of raw.slice(0, IPV6_MAX)) {
    if (typeof item !== 'string') continue;
    const bytes = parseIpv6(item);
    if (!bytes || !isGloballyRoutableV6(bytes)) continue;    // SSRF guard
    const norm = item.trim().replace(/^\[/, '').replace(/\]$/, '');
    if (!out.includes(norm)) out.push(norm);
  }
  return out;
}

// "We could not even try" vs "we tried and nobody answered". Getting this wrong
// is the difference between an honest report and quietly telling every user on
// Starlink that they're unreachable when it was our edge that had no IPv6.
const V6_CANT_ATTEMPT_RE =
  /not\s*supported|unsupported|eafnosupport|eprotonosupport|address\s*family|network\s*is\s*unreachable|enetunreach|protocol\s*not\s*available/i;
const V6_ANSWERED_RE = /refused|econnrefused|reset|econnreset|timed?\s*out|timeout|host\s*is\s*unreachable|ehostunreach/i;

/**
 * Dial each candidate IPv6 address on `port`. Same try/catch shape and the same
 * CONNECT_MS budget as isReachable().
 *
 * IPv6 LITERAL FORM: runtimes disagree about whether `hostname` should be the
 * bare literal ("2001:db8::1") or bracketed ("[2001:db8::1]"). Deno's own
 * resolve_addr brackets the hostname itself before parsing, so bare is the
 * correct form there and a pre-bracketed value would become "[[…]]" and fail to
 * parse — which would look exactly like "unreachable". We could not test the
 * Bunny runtime directly, so we try BARE FIRST and fall back to BRACKETED, and
 * only when the failure looks like a parse/format problem rather than a real
 * network answer. Getting no answer never triggers a retry in the other form.
 *
 * @returns {{ open_v6:boolean, ipv6:string|null, v6_probe:string }}
 */
async function probeIpv6(list, port) {
  if (!list.length) return { open_v6: false, ipv6: null, v6_probe: 'none' };
  let answered = false;    // a real TCP answer (refused/timeout) → we DID dial
  let cantAttempt = false; // socket could not be created / no route at all
  let errored = false;     // unexpected throw

  for (const ip of list) {
    for (const hostname of [ip, `[${ip}]`]) {
      let conn = null;
      try {
        conn = await Promise.race([
          Deno.connect({ hostname, port, transport: 'tcp' }),
          new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), CONNECT_MS)),
        ]);
        return { open_v6: true, ipv6: ip, v6_probe: 'ok' };
      } catch (e) {
        const msg = String((e && (e.message || e.name)) || e);
        if (V6_ANSWERED_RE.test(msg)) { answered = true; break; }        // dialled, closed
        if (V6_CANT_ATTEMPT_RE.test(msg)) { cantAttempt = true; continue; } // try other form
        errored = true;                                                  // likely a format issue
      } finally {
        try { if (conn) conn.close(); } catch {}
      }
    }
  }

  // "answered" wins: if ANY address gave us a real network response the edge
  // clearly can speak IPv6, so open_v6:false is a genuine measurement.
  const v6_probe = answered ? 'ok' : cantAttempt ? 'unsupported' : errored ? 'error' : 'ok';
  return { open_v6: false, ipv6: null, v6_probe };
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

      // IPv4 path is untouched: same call, same `open` field, same meaning.
      const open = await isReachable(ip, port);

      // IPv6 dial-back. Additive only — a client that sends no `ipv6` field gets
      // v6 = { open_v6:false, ipv6:null, v6_probe:"none" } and an otherwise
      // byte-identical response to the previous version of this script.
      const targets = sanitizeIpv6List(body.ipv6);
      const suppliedCount = Array.isArray(body.ipv6)
        ? body.ipv6.length
        : (typeof body.ipv6 === "string" && body.ipv6 ? 1 : 0);
      const rejectedAll = suppliedCount > 0 && targets.length === 0;
      const v6 = rejectedAll
        ? { open_v6: false, ipv6: null, v6_probe: "invalid" }
        : await probeIpv6(targets, port);

      return json(200, { ok: true, open, ip, port, ...v6 });
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
