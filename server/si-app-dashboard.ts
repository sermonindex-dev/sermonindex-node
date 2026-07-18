/**
 * SermonIndex Node Software — Admin Dashboard + Node API
 * ======================================================
 * ONE self-contained Bunny Edge Script (TypeScript / Deno-style).
 *
 * Responsibilities:
 *   1. Node API — the endpoints the desktop app's heartbeat service calls
 *      (POST /api/node/heartbeat, /api/node/shutdown, /api/node/command-result;
 *       GET /api/node/map, /api/node/stats, /api/config, /api/geo;
 *       and the new /api/seed/access + /api/seed/request).
 *      The response SHAPES here are the app-facing contract and must not change.
 *   2. Admin dashboard — a light, olive+gold themed web UI (Overview, Graph,
 *      Nodes, Config) protected by a single admin key.
 *
 * Storage: BunnyDB (libSQL over the HTTP pipeline API).
 *
 * ALL secrets come from environment variables — nothing is hardcoded:
 *   ADMIN_KEY   single admin login password (the "Key" field on the login page)
 *   DB_URL      BunnyDB libSQL pipeline endpoint
 *   DB_TOKEN    BunnyDB libSQL bearer token
 *
 * The network runs entirely on BitTorrent: the app reports `seeded_torrents`
 * (info hashes), which this script records as shared sermons.
 */

import * as BunnySDK from "https://esm.sh/@bunny.net/edgescript-sdk@0.11.2";

// ─────────────────────────────────────────────────────────────────────────────
// Environment (secrets only — never hardcode a real token or password)
// ─────────────────────────────────────────────────────────────────────────────
const env = (k: string, d = ""): string =>
  (typeof Deno !== "undefined" && Deno.env.get(k)) ||
  (typeof process !== "undefined" && process.env && process.env[k]) ||
  d;

const ADMIN_KEY = env("ADMIN_KEY"); // set as a Bunny env var — never hardcode. Empty = all admin logins rejected (fail-closed).

// When a BunnyDB is linked to an Edge Script, Bunny auto-injects these env vars.
// Prefer them; fall back to DB_TOKEN/DB_URL if you set names manually.
const DB_TOKEN = env("BUNNY_DATABASE_AUTH_TOKEN") || env("DB_TOKEN"); // Bunny auto-injects this when the DB is linked — never hardcode

// The edge script talks to BunnyDB over HTTP (fetch), so the URL must be the
// HTTPS pipeline endpoint — https://<host>/v2/pipeline. Bunny provides the
// connection string as libsql://<host>, which fetch() can't use ("Url scheme
// 'libsql' not supported"). Normalize whatever form is given.
function normalizeDbUrl(raw: string): string {
  let u = (raw || "").trim();
  if (!u) return u;
  if (u.startsWith("libsql://")) u = "https://" + u.slice("libsql://".length);
  else if (u.startsWith("http://")) u = "https://" + u.slice("http://".length);
  else if (!u.startsWith("https://")) u = "https://" + u;
  if (!/\/v2\/pipeline\/?$/.test(u)) u = u.replace(/\/+$/, "") + "/v2/pipeline";
  return u;
}
const DB_URL = normalizeDbUrl(env("BUNNY_DATABASE_URL") || env("DB_URL"));

// ─────────────────────────────────────────────────────────────────────────────
// libSQL data layer (BunnyDB HTTP pipeline)
// ─────────────────────────────────────────────────────────────────────────────

/** Shape a single JS value into a libSQL typed argument. */
function shapeArg(v: any) {
  if (v === null || v === undefined) return { type: "null" };
  if (typeof v === "number") {
    if (isNaN(v)) return { type: "integer", value: "0" };
    if (Number.isInteger(v)) return { type: "integer", value: String(v) };
    return { type: "float", value: v };
  }
  return { type: "text", value: String(v) };
}

/** Execute one SQL statement and return normalised { rows, cols, affected, lastId }. */
async function dbQuery(sql: string, args: any[] = []): Promise<any> {
  const stmt: any = { sql };
  if (args.length) stmt.args = args.map(shapeArg);

  const resp = await fetch(DB_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${DB_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ requests: [{ type: "execute", stmt }, { type: "close" }] }),
  });

  const data = JSON.parse(await resp.text());
  if (data.results && data.results[0]?.type === "ok") {
    const result = data.results[0].response.result;
    // No columns → this was a write (INSERT/UPDATE/DELETE) or an empty read.
    if (!result.cols || !result.cols.length) {
      return { rows: [], affected: result.affected_row_count || 0, lastId: result.last_insert_rowid };
    }
    const cols = result.cols.map((c: any) => c.name);
    const rows = result.rows.map((r: any) => {
      const o: any = {};
      cols.forEach((c: string, i: number) => (o[c] = r[i]?.value ?? null));
      return o;
    });
    return { rows, cols, affected: result.affected_row_count, lastId: result.last_insert_rowid };
  }
  throw new Error(JSON.stringify(data));
}

/**
 * Execute several statements in one round trip.
 * @param statements array of { sql, args }
 * @returns the raw data.results array (each entry is a per-statement result)
 */
async function dbBatch(statements: { sql: string; args?: any[] }[]): Promise<any[]> {
  const requests: any[] = statements.map((s) => {
    const stmt: any = { sql: s.sql };
    if (s.args && s.args.length) stmt.args = s.args.map(shapeArg);
    return { type: "execute", stmt };
  });
  requests.push({ type: "close" });

  const resp = await fetch(DB_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${DB_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ requests }),
  });

  const data = JSON.parse(await resp.text());
  return data.results || [];
}

// ─────────────────────────────────────────────────────────────────────────────
// Schema (lean, BitTorrent-only). Guarded so it runs once per worker.
// ─────────────────────────────────────────────────────────────────────────────
let _tablesCreated = false;

async function ensureTables(): Promise<void> {
  if (_tablesCreated) return;

  const now = new Date().toISOString();

  await dbBatch([
    // Drop legacy peer-pin tables from the old (pre-BitTorrent) schema so they
    // don't linger in the database. Safe/idempotent — IF EXISTS.
    { sql: `DROP TABLE IF EXISTS ipfs_pins` },
    { sql: `DROP TABLE IF EXISTS ipfs_bridge` },
    { sql: `DROP TABLE IF EXISTS node_diagnostics` },
    { sql: `DROP TABLE IF EXISTS content_packs` },
    // Remove a stale leftover config row from the old IPFS build.
    { sql: `DELETE FROM config WHERE key = 'ipfs_enabled'` },
    // Migrate the old IPFS-era content-source setting to the BitTorrent-era values + label.
    { sql: `UPDATE config SET description = 'Where the app pulls sermon content from: cdn (direct download), p2p (BitTorrent), or hybrid (BitTorrent with CDN fallback).' WHERE key = 'source_mode'` },
    { sql: `UPDATE config SET value = 'cdn' WHERE key = 'source_mode' AND value NOT IN ('cdn','p2p','hybrid')` },

    // Nodes — one row per participating node, updated on every heartbeat.
    {
      sql: `CREATE TABLE IF NOT EXISTS nodes (
        node_id TEXT PRIMARY KEY,
        lat REAL DEFAULT 0,
        lon REAL DEFAULT 0,
        city TEXT DEFAULT 'Unknown',
        country TEXT DEFAULT 'XX',
        region TEXT DEFAULT '',
        files_stored INTEGER DEFAULT 0,
        storage_used_bytes INTEGER DEFAULT 0,
        uploaded_bytes INTEGER DEFAULT 0,
        peers_connected INTEGER DEFAULT 0,
        uptime_seconds INTEGER DEFAULT 0,
        library_coverage REAL DEFAULT 0,
        content_mode TEXT DEFAULT 'cdn',
        app_version TEXT DEFAULT '0.0.0',
        node_type TEXT DEFAULT 'user',
        reachable INTEGER DEFAULT 0,
        last_seen TEXT,
        first_seen TEXT,
        total_heartbeats INTEGER DEFAULT 0,
        is_online INTEGER DEFAULT 1
      )`,
    },
    // Shared sermons — full-sync snapshot of what each node currently seeds.
    {
      sql: `CREATE TABLE IF NOT EXISTS shared_sermons (
        sermon_id TEXT,
        node_id TEXT,
        info_hash TEXT,
        title TEXT DEFAULT '',
        speaker TEXT DEFAULT '',
        type TEXT DEFAULT 'audio',
        last_seen TEXT,
        PRIMARY KEY (sermon_id, node_id)
      )`,
    },
    // Time-series of network health, written at most every ~30 min.
    {
      sql: `CREATE TABLE IF NOT EXISTS stats_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        nodes_online INTEGER DEFAULT 0,
        seed_nodes INTEGER DEFAULT 0,
        sermons_shared INTEGER DEFAULT 0,
        total_files INTEGER DEFAULT 0,
        total_storage_bytes INTEGER DEFAULT 0,
        total_uploaded_bytes INTEGER DEFAULT 0,
        countries INTEGER DEFAULT 0
      )`,
    },
    // Seed-access allowlist (the flip switch + request queue).
    {
      sql: `CREATE TABLE IF NOT EXISTS seed_access (
        node_id TEXT PRIMARY KEY,
        enabled INTEGER DEFAULT 0,
        email TEXT DEFAULT '',
        requested_at TEXT,
        enabled_at TEXT
      )`,
    },
    // Remote config — flat key/value delivered to nodes on every heartbeat.
    {
      sql: `CREATE TABLE IF NOT EXISTS config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        description TEXT DEFAULT ''
      )`,
    },
    // Audit trail of notable node events.
    {
      sql: `CREATE TABLE IF NOT EXISTS node_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        node_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        detail TEXT DEFAULT '',
        timestamp TEXT NOT NULL
      )`,
    },
    // Pending admin → node commands, delivered on heartbeat.
    {
      sql: `CREATE TABLE IF NOT EXISTS node_commands (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        node_id TEXT NOT NULL,
        action TEXT NOT NULL,
        params TEXT DEFAULT '{}',
        status TEXT DEFAULT 'pending',
        created_at TEXT NOT NULL,
        picked_up_at TEXT,
        result TEXT DEFAULT '',
        completed_at TEXT
      )`,
    },
    // Admin login sessions.
    {
      sql: `CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY,
        created_at TEXT NOT NULL
      )`,
    },
    // Helpful indexes.
    { sql: `CREATE INDEX IF NOT EXISTS idx_nodes_last_seen ON nodes(last_seen)` },
    { sql: `CREATE INDEX IF NOT EXISTS idx_nodes_online ON nodes(is_online)` },
    { sql: `CREATE INDEX IF NOT EXISTS idx_shared_node ON shared_sermons(node_id)` },
    { sql: `CREATE INDEX IF NOT EXISTS idx_shared_sermon ON shared_sermons(sermon_id)` },
    { sql: `CREATE INDEX IF NOT EXISTS idx_snapshots_ts ON stats_snapshots(ts)` },
    { sql: `CREATE INDEX IF NOT EXISTS idx_events_node ON node_events(node_id)` },
    { sql: `CREATE INDEX IF NOT EXISTS idx_commands_node ON node_commands(node_id, status)` },
    // Default config rows (only inserted the first time).
    {
      sql: `INSERT OR IGNORE INTO config (key, value, updated_at, description) VALUES (?,?,?,?)`,
      args: ["source_mode", "cdn", now, "Where the app pulls sermon content from (cdn | p2p | hybrid)."],
    },
    {
      sql: `INSERT OR IGNORE INTO config (key, value, updated_at, description) VALUES (?,?,?,?)`,
      args: ["announcement", "", now, "Optional banner message shown in the app."],
    },
    {
      sql: `INSERT OR IGNORE INTO config (key, value, updated_at, description) VALUES (?,?,?,?)`,
      args: ["heartbeat_interval", "300", now, "Seconds between node heartbeats."],
    },
    {
      sql: `INSERT OR IGNORE INTO config (key, value, updated_at, description) VALUES (?,?,?,?)`,
      args: ["max_concurrent_downloads", "3", now, "Max simultaneous downloads per node."],
    },
    {
      sql: `INSERT OR IGNORE INTO config (key, value, updated_at, description) VALUES (?,?,?,?)`,
      args: ["min_app_version", "0.0.0", now, "Minimum app version the network expects."],
    },
    {
      sql: `INSERT OR IGNORE INTO config (key, value, updated_at, description) VALUES (?,?,?,?)`,
      args: ["master_list_version", "", now, "Bump to force every node to re-download the canonical master-list.json (set via the Master List refresh button). Empty = nodes keep their cached copy."],
    },
    {
      sql: `INSERT OR IGNORE INTO config (key, value, updated_at, description) VALUES (?,?,?,?)`,
      args: ["moderator_ids", "", now, "Comma/space/newline-separated short node IDs (e.g. si-2098a) shown as moderators in the community chat."],
    },
  ]);

  // The nodes table already exists in production (created by an older script), so
  // the CREATE TABLE above won't add the reachable column to it. Add it best-effort
  // here — ALTER on an already-present column throws, so keep it out of the batch.
  try {
    await dbQuery(`ALTER TABLE nodes ADD COLUMN reachable INTEGER DEFAULT 0`);
  } catch {
    /* column already exists */
  }
  // Same for the newer columns (existing DBs won't have them).
  try { await dbQuery(`ALTER TABLE nodes ADD COLUMN uploaded_bytes INTEGER DEFAULT 0`); } catch { /* exists */ }
  try { await dbQuery(`ALTER TABLE stats_snapshots ADD COLUMN total_uploaded_bytes INTEGER DEFAULT 0`); } catch { /* exists */ }
  // Region/state (e.g. "BC") reported alongside city/country in the heartbeat.
  try { await dbQuery(`ALTER TABLE nodes ADD COLUMN region TEXT DEFAULT ''`); } catch { /* exists */ }

  _tablesCreated = true;
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP helpers
// ─────────────────────────────────────────────────────────────────────────────
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

/** JSON response with CORS + no-store (the app must never cache node data). */
function jsonResponse(data: any, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...CORS, ...extraHeaders },
  });
}

/** Minimal HTML escaper for anything injected into a page. */
function escapeHtml(s: any): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const nowIso = () => new Date().toISOString();

/** Safe integer coercion (defaults on NaN/invalid). */
function toInt(v: any, d = 0): number {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
}
/** Safe float coercion. */
function toNum(v: any, d = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

/** Sanitize a node id to a safe token. */
function cleanNode(s: any): string {
  return String(s || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
}

/**
 * Classify a node row into exactly one of three categories (priority order):
 *   "seed" → approved seed node (node_type === 'seed')
 *   "node" → not a seed AND its BitTorrent port is open (reachable === 1)
 *   "peer" → not a seed AND its port is closed/unknown (reachable !== 1)
 */
function nodeCategory(n: any): "seed" | "node" | "peer" {
  if (n.node_type === "seed") return "seed";
  if (Number(n.reachable) === 1) return "node";
  return "peer";
}

/** Client public IP from Bunny/CDN headers. */
function clientIp(req: Request): string {
  const h = req.headers;
  const xff = h.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  return h.get("cf-connecting-ip") || h.get("x-real-ip") || "";
}

/**
 * Server-side IP geolocation (used when the app couldn't resolve its own
 * location). Best-effort; returns Unknown/XX on any failure.
 */
async function ipGeo(req: Request): Promise<{ city: string; country: string; region: string; lat: number; lon: number }> {
  const cdnCountry = req.headers.get("CDN-RequestCountryCode") || "";
  const ip = clientIp(req);
  const fallback = { city: "Unknown", country: cdnCountry || "XX", region: "", lat: 0, lon: 0 };
  if (!ip) return fallback;
  try {
    const res = await fetch(`https://ipapi.co/${encodeURIComponent(ip)}/json/`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return fallback;
    const d = await res.json();
    return {
      city: d.city || "Unknown",
      country: d.country_code || cdnCountry || "XX",
      region: d.region_code || d.region || "",
      lat: toNum(d.latitude, 0),
      lon: toNum(d.longitude, 0),
    };
  } catch {
    return fallback;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Time helpers for "online in the last N minutes" windows
// ─────────────────────────────────────────────────────────────────────────────
const isoMinutesAgo = (mins: number) => new Date(Date.now() - mins * 60 * 1000).toISOString();

// ─────────────────────────────────────────────────────────────────────────────
// Auth (simplified: one admin key, cookie-backed sessions)
// ─────────────────────────────────────────────────────────────────────────────
const SESSION_COOKIE = "si_app_session";

/** Parse a named cookie from the request. */
function getCookie(req: Request, name: string): string {
  const raw = req.headers.get("cookie") || "";
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return "";
}

/** Is this request an authenticated admin session? */
async function isLoggedIn(req: Request): Promise<boolean> {
  const token = getCookie(req, SESSION_COOKIE);
  if (!token) return false;
  try {
    const { rows } = await dbQuery(`SELECT token FROM sessions WHERE token = ? LIMIT 1`, [token]);
    return rows.length > 0;
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared theme (light, olive + gold — matches the desktop app)
// ─────────────────────────────────────────────────────────────────────────────
const THEME_CSS = `
:root{
  color-scheme:light;
  --bg:#F8F8F2; --card:#ffffff; --tertiary:#F1F1E8; --hover:#EDEDE0; --border:#DEE2E6;
  --text:#242424; --text2:#555; --muted:#888;
  --gold:#D4AF37; --gold-text:#967d1f; --olive:#707035;
  --topbar:#707035; --topbar-text:#F8F8F2;
  --green:#3d8a41; --red:#e74c3c; --orange:#b85c00; --blue:#2d6cb5; --radius:8px;
}
html[data-theme='dark']{
  color-scheme:dark;
  --bg:#1a1a1a; --card:#1e1e1e; --tertiary:#262620; --hover:#30302a; --border:#3a3a3a;
  --text:#e4e4da; --text2:#bbb; --muted:#888;
  --gold:#d4af37; --gold-text:#d4af37; --olive:#908F51;
  --topbar:#2c2c14; --topbar-text:#e4e4da;
  --green:#4caf50; --red:#e74c3c; --orange:#e67e22; --blue:#6ea8fe;
}
*{margin:0;padding:0;box-sizing:border-box;}
body{font-family:Verdana,Geneva,sans-serif;background:var(--bg);color:var(--text);font-size:14px;line-height:1.5;}
a{color:var(--gold-text);text-decoration:none;}
a:hover{text-decoration:underline;}
.topbar{background:var(--topbar);padding:12px 24px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;}
.topbar img{height:26px;display:block;}
.topbar-right{display:flex;gap:16px;align-items:center;}
.nav{display:flex;gap:20px;align-items:center;}
.nav a{color:var(--topbar-text);font-size:0.82rem;text-transform:uppercase;letter-spacing:0.06em;opacity:0.85;}
.nav a:hover{opacity:1;text-decoration:none;}
.nav a.active{color:var(--gold);font-weight:700;opacity:1;}
.theme-toggle{background:transparent;border:1px solid rgba(248,248,242,0.4);color:var(--topbar-text);width:34px;height:34px;border-radius:50%;display:flex;align-items:center;justify-content:center;cursor:pointer;flex-shrink:0;padding:0;}
.theme-toggle:hover{border-color:var(--gold);color:var(--gold);}
.theme-toggle svg{display:block;}
.theme-toggle .icon-sun{display:none;}
html[data-theme='dark'] .theme-toggle .icon-moon{display:none;}
html[data-theme='dark'] .theme-toggle .icon-sun{display:block;}
.main{max-width:1180px;margin:0 auto;padding:24px;}
h1{font-size:1.3rem;color:var(--gold-text);margin-bottom:4px;}
h2{color:var(--gold-text);font-size:1.02rem;margin:28px 0 12px;padding-bottom:8px;border-bottom:1px solid var(--border);}
h3{color:var(--text);font-size:0.92rem;margin:4px 0 10px;}
p.sub{color:var(--text2);font-size:0.82rem;margin-bottom:8px;}
.card{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:18px;margin-top:14px;}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:14px;margin-top:14px;}
.stat{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:16px;}
.stat .n{font-size:1.7rem;font-weight:700;color:var(--olive);}
.stat .l{font-size:0.72rem;color:var(--muted);text-transform:uppercase;letter-spacing:0.06em;margin-top:2px;}
table{border-collapse:collapse;width:100%;}
th{text-align:left;font-size:0.72rem;color:var(--muted);text-transform:uppercase;letter-spacing:0.04em;padding:8px 10px;border-bottom:2px solid var(--border);}
td{padding:9px 10px;border-bottom:1px solid var(--border);font-size:0.82rem;vertical-align:middle;}
tr:hover td{background:var(--hover);}
code,.mono{font-family:'SF Mono',Menlo,Consolas,monospace;font-size:0.78em;background:var(--tertiary);padding:2px 6px;border-radius:4px;color:var(--gold-text);}
.btn{background:var(--gold);color:#242424;border:none;padding:9px 16px;border-radius:var(--radius);cursor:pointer;font-weight:700;font-size:0.8rem;font-family:inherit;}
.btn:hover{box-shadow:0 2px 8px rgba(212,175,55,0.35);}
.btn.green{background:var(--green);color:#fff;}
.btn.red{background:var(--red);color:#fff;}
.btn.ghost{background:transparent;border:1px solid var(--border);color:var(--text2);font-weight:600;}
.btn.ghost:hover{border-color:var(--gold);color:var(--gold-text);box-shadow:none;}
.btn.sm{padding:5px 11px;font-size:0.74rem;}
input,textarea,select{background:var(--card);color:var(--text);border:1px solid var(--border);padding:8px 11px;border-radius:var(--radius);font-size:0.82rem;font-family:inherit;width:100%;}
input:focus,textarea:focus,select:focus{border-color:var(--gold);outline:none;}
label{display:block;font-size:0.74rem;color:var(--text2);margin-bottom:4px;font-weight:600;}
.field{margin-bottom:12px;}
.badge{display:inline-block;padding:2px 9px;border-radius:20px;font-size:0.7em;font-weight:700;letter-spacing:0.02em;}
.b-on{background:rgba(61,138,65,0.15);color:var(--green);}
.b-off{background:rgba(136,136,136,0.15);color:var(--muted);}
.b-seed{background:rgba(212,175,55,0.2);color:var(--gold-text);}
.b-user{background:rgba(112,112,53,0.15);color:var(--olive);}
.b-node{background:rgba(61,138,65,0.15);color:var(--green);}
.b-peer{background:rgba(184,92,0,0.15);color:var(--orange);}
.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center;}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:16px;}
.chart-wrap{position:relative;height:300px;}
.chart-wrap.big{height:340px;}
.muted{color:var(--muted);}
.empty{text-align:center;padding:36px;color:var(--muted);font-size:0.85rem;}
.inline-form{display:inline;}
@media(max-width:720px){.grid2{grid-template-columns:1fr;}}
`;

// Inline snippet placed in every page's <head> so a saved dark preference is
// applied before the body paints (avoids a flash of light). Uses the SAME
// localStorage key ('si-theme') as the desktop app.
const THEME_RESTORE_SCRIPT = `<script>try{if(localStorage.getItem('si-theme')==='dark')document.documentElement.dataset.theme='dark';}catch(e){}</script>`;

// The moon (light-mode) + sun (dark-mode) glyphs, matching the desktop app's
// TopBar exactly. CSS toggles which one is visible via html[data-theme].
const THEME_TOGGLE_BUTTON = `<button type="button" class="theme-toggle" onclick="toggleTheme()" aria-label="Toggle light/dark theme" title="Toggle light/dark theme">
<svg class="icon-moon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
<svg class="icon-sun" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>
</button>`;

// Client-side toggle: flips the data-theme attribute between '' and 'dark' and
// persists to localStorage under the shared 'si-theme' key.
const THEME_TOGGLE_SCRIPT = `<script>function toggleTheme(){var d=document.documentElement,next=d.dataset.theme==='dark'?'':'dark';d.dataset.theme=next;try{localStorage.setItem('si-theme',next||'light');}catch(e){}}</script>`;

/** Build the shared page shell with themed topbar + nav. */
function page(title: string, active: string, bodyHtml: string, extraHead = ""): string {
  const link = (href: string, label: string, key: string) =>
    `<a href="${href}"${active === key ? ' class="active"' : ""}>${label}</a>`;
  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} — SermonIndex Admin</title>
${THEME_RESTORE_SCRIPT}
<style>${THEME_CSS}</style>${extraHead}
</head><body>
<div class="topbar">
  <img src="https://www.sermonindex.net/images/sermon-index-white.png" alt="SermonIndex">
  <div class="topbar-right">
    <div class="nav">
      ${link("/admin", "Overview", "overview")}
      ${link("/admin/graph", "Graph", "graph")}
      ${link("/admin/nodes", "Nodes", "nodes")}
      ${link("/admin/config", "Config", "config")}
      ${link("/logout", "Sign Out", "logout")}
    </div>
    ${THEME_TOGGLE_BUTTON}
  </div>
</div>
<div class="main">${bodyHtml}</div>
${THEME_TOGGLE_SCRIPT}
</body></html>`;
}

/** Simple full-page HTML response. */
function htmlResponse(html: string, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(html, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", ...extraHeaders },
  });
}

/** A minimal themed error page (for admin page handlers). */
function errorPage(message: string): Response {
  return htmlResponse(
    page("Error", "", `<h1>Something went wrong</h1><div class="card"><p class="sub">${escapeHtml(message)}</p><a class="btn ghost" href="/admin">Back to dashboard</a></div>`),
    500,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Formatting helpers for pages
// ─────────────────────────────────────────────────────────────────────────────
function fmtBytes(n: number): string {
  n = Number(n) || 0;
  if (n <= 0) return "0 B";
  const u = ["B", "KB", "MB", "GB", "TB", "PB"];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), u.length - 1);
  return (n / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1) + " " + u[i];
}
function timeAgo(iso: string | null): string {
  if (!iso) return "never";
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (isNaN(s)) return "?";
  if (s < 60) return s + "s ago";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  return Math.floor(s / 86400) + "d ago";
}

/**
 * Human location string: "City, Region, CountryName".
 * The full country name is derived from a 2-letter code via Intl.DisplayNames
 * (falling back to the raw code). Empty parts (e.g. a missing region) are dropped,
 * so "Abbotsford", "BC", "CA" → "Abbotsford, BC, Canada" and "Unknown", "", "XX" → "Unknown, XX".
 */
function fmtLocation(city: any, region: any, country: any): string {
  const cc = String(country ?? "").trim();
  let countryName = cc;
  try {
    if (cc) countryName = new Intl.DisplayNames(["en"], { type: "region" }).of(cc.toUpperCase()) || cc;
  } catch {
    countryName = cc;
  }
  return [String(city ?? "").trim(), String(region ?? "").trim(), countryName].filter(Boolean).join(", ");
}

// ─────────────────────────────────────────────────────────────────────────────
// ============================  NODE API HANDLERS  ============================
// (app-facing contract — response shapes are frozen)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /api/node/heartbeat
 * Upserts the node, records its shared sermons, returns config + commands.
 */
async function handleHeartbeat(req: Request): Promise<Response> {
  await ensureTables();
  const body = await req.json().catch(() => ({}));

  const nodeId = cleanNode(body.node_id);
  if (!nodeId) return jsonResponse({ ok: false, error: "missing node_id" }, 400);

  // Coerce numbers defensively.
  let lat = toNum(body.lat, 0);
  let lon = toNum(body.lon, 0);
  let city = String(body.city || "Unknown");
  let country = String(body.country || "XX");
  let region = String(body.region || "");
  const filesStored = toInt(body.files_stored, 0);
  const storageBytes = toInt(body.storage_used_bytes, 0);
  const uploadedBytes = toInt(body.uploaded_bytes, 0);
  const peers = toInt(body.peers_connected, 0);
  const uptime = toInt(body.uptime_seconds, 0);
  const coverage = toNum(body.library_coverage, 0);
  const contentMode = String(body.content_mode || "cdn");
  const appVersion = String(body.app_version || "0.0.0");
  const nodeType = body.node_type === "seed" ? "seed" : "user";
  // BitTorrent port reachability: true = port open/reachable, false = closed,
  // anything else (null/undefined) = unknown → stored as 0.
  const reachable = body.reachable === true ? 1 : (body.reachable === false ? 0 : 0);

  // If the app couldn't geolocate itself, try a server-side IP lookup. Also
  // backfill the region (province/state) if we still don't have one — reusing a
  // region already resolved for this node so we don't re-query every heartbeat.
  const needCity = (lat === 0 && lon === 0) && (city === "Unknown" || !city);
  let needRegion = !region;
  if (needRegion) {
    try {
      const prev = await dbQuery(`SELECT region FROM nodes WHERE node_id=?`, [nodeId]);
      const prevRegion = String(prev.rows[0]?.region || "");
      if (prevRegion) { region = prevRegion; needRegion = false; }
    } catch { /* no existing row yet */ }
  }
  if (needCity || needRegion) {
    const geo = await ipGeo(req);
    if (needCity) { lat = geo.lat; lon = geo.lon; city = geo.city; country = geo.country; }
    if (needRegion && geo.region) region = geo.region;
  }
  // Always honour the CDN country header if the app didn't send one.
  const cdnCountry = req.headers.get("CDN-RequestCountryCode");
  if ((!country || country === "XX") && cdnCountry) country = cdnCountry;

  const ts = nowIso();

  // Upsert the node row (+1 heartbeat, mark online, refresh last_seen).
  await dbQuery(
    `INSERT INTO nodes
      (node_id, lat, lon, city, country, region, files_stored, storage_used_bytes, uploaded_bytes, peers_connected,
       uptime_seconds, library_coverage, content_mode, app_version, node_type, reachable,
       last_seen, first_seen, total_heartbeats, is_online)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,1)
     ON CONFLICT(node_id) DO UPDATE SET
       lat=excluded.lat, lon=excluded.lon, city=excluded.city, country=excluded.country, region=excluded.region,
       files_stored=excluded.files_stored, storage_used_bytes=excluded.storage_used_bytes,
       uploaded_bytes=MAX(nodes.uploaded_bytes, excluded.uploaded_bytes),
       peers_connected=excluded.peers_connected, uptime_seconds=excluded.uptime_seconds,
       library_coverage=excluded.library_coverage, content_mode=excluded.content_mode,
       app_version=excluded.app_version, node_type=excluded.node_type,
       reachable=excluded.reachable,
       last_seen=excluded.last_seen,
       total_heartbeats=nodes.total_heartbeats+1,
       is_online=1`,
    [nodeId, lat, lon, city, country, region, filesStored, storageBytes, uploadedBytes, peers, uptime, coverage, contentMode, appVersion, nodeType, reachable, ts, ts],
  );

  // Record shared sermons from body.seeded_torrents.
  // Full-sync: wipe this node's rows, then re-insert the current set.
  const seeded = body.seeded_torrents && typeof body.seeded_torrents === "object" ? body.seeded_torrents : {};
  const sermonStmts: { sql: string; args?: any[] }[] = [
    { sql: `DELETE FROM shared_sermons WHERE node_id = ?`, args: [nodeId] },
  ];
  for (const sermonId of Object.keys(seeded)) {
    const t = seeded[sermonId] || {};
    sermonStmts.push({
      sql: `INSERT OR REPLACE INTO shared_sermons
              (sermon_id, node_id, info_hash, title, speaker, type, last_seen)
            VALUES (?,?,?,?,?,?,?)`,
      args: [
        String(sermonId),
        nodeId,
        String(t.info_hash || ""),
        String(t.title || ""),
        String(t.speaker || ""),
        String(t.type || "audio"),
        ts,
      ],
    });
  }
  await dbBatch(sermonStmts);

  // Best-effort time-series snapshot — must NOT block or fail the response.
  maybeWriteSnapshot().catch(() => {});

  // Assemble the response the app expects.
  const [configRows, cmdRows] = await Promise.all([
    dbQuery(`SELECT key, value FROM config`),
    dbQuery(
      `SELECT id, action, params FROM node_commands
        WHERE node_id = ? AND status = 'pending' ORDER BY created_at ASC`,
      [nodeId],
    ),
  ]);

  const config: Record<string, string> = {};
  for (const r of configRows.rows) config[r.key] = r.value;
  // master_list_version travels INSIDE config. Always present as a string so
  // clients can compare it (empty = no forced version; older clients ignore it).
  if (typeof config.master_list_version !== "string") config.master_list_version = "";

  const commands = cmdRows.rows.map((c: any) => ({
    command_id: toInt(c.id, 0),
    id: toInt(c.id, 0),
    action: c.action,
    params: safeParse(c.params, {}),
  }));

  // Mark delivered commands as picked_up (fire-and-forget).
  if (commands.length) {
    const pickTs = nowIso();
    dbBatch(
      commands.map((c: any) => ({
        sql: `UPDATE node_commands SET status='picked_up', picked_up_at=? WHERE id=?`,
        args: [pickTs, c.command_id],
      })),
    ).catch(() => {});
  }

  return jsonResponse({
    ok: true,
    config,
    commands,
  });
}

/** JSON.parse with a fallback. */
function safeParse(s: any, d: any): any {
  try {
    return JSON.parse(s);
  } catch {
    return d;
  }
}

/**
 * Best-effort snapshot writer: adds a stats_snapshots row only if the newest
 * one is older than 30 minutes (or none exists). Never throws to the caller.
 */
async function maybeWriteSnapshot(): Promise<void> {
  try {
    const { rows } = await dbQuery(`SELECT ts FROM stats_snapshots ORDER BY id DESC LIMIT 1`);
    if (rows.length) {
      const ageMs = Date.now() - new Date(rows[0].ts).getTime();
      if (ageMs < 30 * 60 * 1000) return; // too soon
    }

    const online = isoMinutesAgo(15);
    const [onlineRow, seedRow, filesRow, sermonsRow, countryRow, uploadedRow] = await Promise.all([
      dbQuery(`SELECT COUNT(*) c FROM nodes WHERE is_online=1 AND last_seen >= ?`, [online]),
      dbQuery(`SELECT COUNT(*) c FROM nodes WHERE is_online=1 AND last_seen >= ? AND node_type='seed'`, [online]),
      dbQuery(
        `SELECT COALESCE(SUM(files_stored),0) f, COALESCE(SUM(storage_used_bytes),0) s
           FROM nodes WHERE is_online=1 AND last_seen >= ?`,
        [online],
      ),
      dbQuery(
        `SELECT COUNT(DISTINCT s.sermon_id) c
           FROM shared_sermons s JOIN nodes n ON n.node_id = s.node_id
          WHERE n.is_online=1 AND n.last_seen >= ?`,
        [online],
      ),
      dbQuery(`SELECT COUNT(DISTINCT country) c FROM nodes WHERE is_online=1 AND last_seen >= ?`, [online]),
      // Data transferred is cumulative across all nodes (not online-gated).
      dbQuery(`SELECT COALESCE(SUM(uploaded_bytes),0) u FROM nodes`),
    ]);

    await dbQuery(
      `INSERT INTO stats_snapshots
         (ts, nodes_online, seed_nodes, sermons_shared, total_files, total_storage_bytes, total_uploaded_bytes, countries)
       VALUES (?,?,?,?,?,?,?,?)`,
      [
        nowIso(),
        toInt(onlineRow.rows[0]?.c, 0),
        toInt(seedRow.rows[0]?.c, 0),
        toInt(sermonsRow.rows[0]?.c, 0),
        toInt(filesRow.rows[0]?.f, 0),
        toInt(filesRow.rows[0]?.s, 0),
        toInt(uploadedRow.rows[0]?.u, 0),
        toInt(countryRow.rows[0]?.c, 0),
      ],
    );
  } catch {
    // swallow — snapshots are non-critical
  }
}

/** POST /api/node/shutdown → mark offline + log. */
async function handleShutdown(req: Request): Promise<Response> {
  await ensureTables();
  const body = await req.json().catch(() => ({}));
  const nodeId = cleanNode(body.node_id);
  if (!nodeId) return jsonResponse({ ok: false, error: "missing node_id" }, 400);
  const ts = nowIso();
  await dbBatch([
    { sql: `UPDATE nodes SET is_online=0, last_seen=? WHERE node_id=?`, args: [ts, nodeId] },
    {
      sql: `INSERT INTO node_events (node_id, event_type, detail, timestamp) VALUES (?,?,?,?)`,
      args: [nodeId, "shutdown", "", ts],
    },
  ]);
  return jsonResponse({ ok: true });
}

/** GET /api/node/map → nodes seen in the last 15 min. */
async function handleMap(): Promise<Response> {
  await ensureTables();
  const online = isoMinutesAgo(15);
  const { rows } = await dbQuery(
    `SELECT node_id, lat, lon, city, country, region, library_coverage, node_type, reachable,
            files_stored, app_version, content_mode, peers_connected, storage_used_bytes
       FROM nodes WHERE is_online=1 AND last_seen >= ?`,
    [online],
  );
  const nodes = rows.map((r: any) => ({
    id: r.node_id,
    lat: toNum(r.lat, 0),
    lon: toNum(r.lon, 0),
    city: r.city || "Unknown",
    country: r.country || "XX",
    region: r.region || "",
    coverage: toNum(r.library_coverage, 0),
    type: r.node_type || "user",
    files: toInt(r.files_stored, 0),
    version: r.app_version || "0.0.0",
    mode: r.content_mode || "cdn",
    peers: toInt(r.peers_connected, 0),
    storage: toInt(r.storage_used_bytes, 0),
    reachable: Number(r.reachable) || 0,
    category: nodeCategory(r),
  }));
  return jsonResponse({ nodes, count: nodes.length }, 200, { "Cache-Control": "public, max-age=30" });
}

/** GET /api/node/stats → aggregate figures (online + all-time). */
async function handleStats(): Promise<Response> {
  await ensureTables();
  const online = isoMinutesAgo(15);
  const [live, all, since] = await Promise.all([
    dbQuery(
      `SELECT COUNT(*) totalNodes,
              SUM(CASE WHEN node_type='seed' THEN 1 ELSE 0 END) seedNodes,
              SUM(CASE WHEN node_type='seed' THEN 1 ELSE 0 END) seeds,
              SUM(CASE WHEN node_type!='seed' AND reachable=1 THEN 1 ELSE 0 END) openNodes,
              SUM(CASE WHEN node_type!='seed' AND (reachable IS NULL OR reachable=0) THEN 1 ELSE 0 END) peers,
              COALESCE(SUM(files_stored),0) totalFiles,
              COALESCE(SUM(storage_used_bytes),0) totalStorage,
              COALESCE(AVG(library_coverage),0) avgCoverage,
              COUNT(DISTINCT country) countries,
              COALESCE(SUM(peers_connected),0) totalPeers
         FROM nodes WHERE is_online=1 AND last_seen >= ?`,
      [online],
    ),
    dbQuery(`SELECT COUNT(*) totalNodesEver FROM nodes`),
    dbQuery(`SELECT MIN(first_seen) networkSince FROM nodes`),
  ]);
  const r = live.rows[0] || {};
  return jsonResponse({
    totalNodes: toInt(r.totalNodes, 0),
    seedNodes: toInt(r.seedNodes, 0),
    seeds: toInt(r.seeds, 0),
    openNodes: toInt(r.openNodes, 0),
    peers: toInt(r.peers, 0),
    totalFiles: toInt(r.totalFiles, 0),
    totalStorage: toInt(r.totalStorage, 0),
    avgCoverage: Math.round(toNum(r.avgCoverage, 0) * 10) / 10,
    countries: toInt(r.countries, 0),
    totalPeers: toInt(r.totalPeers, 0),
    totalNodesEver: toInt(all.rows[0]?.totalNodesEver, 0),
    networkSince: since.rows[0]?.networkSince || null,
  });
}

/** GET /api/config → flat config object. */
async function handleConfig(): Promise<Response> {
  await ensureTables();
  const { rows } = await dbQuery(`SELECT key, value FROM config`);
  const config: Record<string, string> = {};
  for (const r of rows) config[r.key] = r.value;
  // master_list_version travels INSIDE config; always present as a string.
  if (typeof config.master_list_version !== "string") config.master_list_version = "";
  return jsonResponse({ config });
}

/** GET /api/content-packs → static empty list (feature removed; kept to avoid a 404 for older app builds). */
function handleContentPacks(): Response {
  return jsonResponse({ packs: [] });
}

/** GET /api/geo → server-side IP geolocation. */
async function handleGeo(req: Request): Promise<Response> {
  const geo = await ipGeo(req);
  return jsonResponse(geo);
}

/** POST /api/node/command-result → mark a command completed + log. */
async function handleCommandResult(req: Request): Promise<Response> {
  await ensureTables();
  const body = await req.json().catch(() => ({}));
  const nodeId = cleanNode(body.node_id);
  const commandId = toInt(body.command_id, 0);
  if (!nodeId || !commandId) return jsonResponse({ ok: false, error: "missing fields" }, 400);
  const resultStr = typeof body.result === "string" ? body.result : JSON.stringify(body.result ?? {});
  const ts = nowIso();
  await dbBatch([
    {
      sql: `UPDATE node_commands SET status='completed', result=?, completed_at=? WHERE id=? AND node_id=?`,
      args: [resultStr.slice(0, 8000), ts, commandId, nodeId],
    },
    {
      sql: `INSERT INTO node_events (node_id, event_type, detail, timestamp) VALUES (?,?,?,?)`,
      args: [nodeId, "command_result", resultStr.slice(0, 500), ts],
    },
  ]);
  return jsonResponse({ ok: true });
}

/** GET /api/seed/access?node_id=X → { ok, enabled }. */
async function handleSeedAccessGet(url: URL): Promise<Response> {
  await ensureTables();
  const nodeId = cleanNode(url.searchParams.get("node_id") || url.searchParams.get("node"));
  if (!nodeId) return jsonResponse({ ok: false, error: "missing node_id" }, 400);
  const { rows } = await dbQuery(`SELECT enabled FROM seed_access WHERE node_id = ? LIMIT 1`, [nodeId]);
  const enabled = rows.length > 0 && toInt(rows[0].enabled, 0) === 1;
  return jsonResponse({ ok: true, enabled });
}

/** POST /api/seed/request { node_id, email } → upsert request (stays disabled). */
async function handleSeedRequest(req: Request): Promise<Response> {
  await ensureTables();
  const body = await req.json().catch(() => ({}));
  const nodeId = cleanNode(body.node_id || body.node);
  if (!nodeId) return jsonResponse({ ok: false, error: "missing node_id" }, 400);
  const email = String(body.email || "").trim().slice(0, 160);
  const ts = nowIso();

  // Insert new (enabled stays 0) or just refresh email + requested_at for an
  // existing row without touching its enabled flag.
  await dbQuery(
    `INSERT INTO seed_access (node_id, enabled, email, requested_at)
       VALUES (?, 0, ?, ?)
     ON CONFLICT(node_id) DO UPDATE SET
       email=excluded.email,
       requested_at=excluded.requested_at`,
    [nodeId, email, ts],
  );

  const { rows } = await dbQuery(`SELECT enabled FROM seed_access WHERE node_id = ? LIMIT 1`, [nodeId]);
  const enabled = rows.length > 0 && toInt(rows[0].enabled, 0) === 1;
  return jsonResponse({ ok: true, requested: true, enabled });
}

// ─────────────────────────────────────────────────────────────────────────────
// ==============================  LOGIN / LOGOUT  =============================
// ─────────────────────────────────────────────────────────────────────────────
function loginPage(error = ""): Response {
  const err = error
    ? `<div class="card" style="border-color:var(--red);"><p style="color:var(--red);font-size:0.82rem;">${escapeHtml(error)}</p></div>`
    : "";
  const html = `<!DOCTYPE html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign In — SermonIndex Admin</title>
${THEME_RESTORE_SCRIPT}
<style>${THEME_CSS}
.login-wrap{max-width:380px;margin:8vh auto;padding:24px;}
.brand{background:var(--topbar);border-radius:var(--radius);padding:18px;display:flex;align-items:center;justify-content:center;position:relative;margin-bottom:18px;}
.brand img{height:30px;}
.brand .theme-toggle{position:absolute;right:12px;top:50%;transform:translateY(-50%);}
.remember{display:flex;align-items:center;gap:8px;font-size:0.8rem;color:var(--text2);margin:6px 0 16px;}
.remember input{width:auto;}
</style></head><body>
<div class="login-wrap">
  <div class="brand"><img src="https://www.sermonindex.net/images/sermon-index-white.png" alt="SermonIndex">${THEME_TOGGLE_BUTTON}</div>
  <div class="card">
    <h3 style="color:var(--gold-text);">Node Software Admin</h3>
    ${err}
    <form method="POST" action="/login">
      <div class="field">
        <label for="key">Key</label>
        <input id="key" name="key" type="password" autocomplete="current-password" autofocus required>
      </div>
      <div class="remember">
        <input id="remember" name="remember" type="checkbox" value="1">
        <label for="remember" style="margin:0;">Remember me</label>
      </div>
      <button class="btn" type="submit" style="width:100%;">Sign In</button>
    </form>
  </div>
</div>
${THEME_TOGGLE_SCRIPT}
</body></html>`;
  return htmlResponse(html);
}

async function handleLogin(req: Request): Promise<Response> {
  const form = await req.formData().catch(() => null);
  const key = form ? String(form.get("key") || "") : "";
  const remember = form ? !!form.get("remember") : false;

  if (!ADMIN_KEY || key !== ADMIN_KEY) {
    return loginPage("Incorrect key. Please try again.");
  }

  // Create + persist a session token.
  const token = crypto.randomUUID();
  await ensureTables();
  await dbQuery(`INSERT INTO sessions (token, created_at) VALUES (?, ?)`, [token, nowIso()]);

  const cookieAge = remember ? "; Max-Age=31536000" : "";
  const cookie = `${SESSION_COOKIE}=${token}; Path=/; SameSite=Lax; HttpOnly${cookieAge}`;

  // Set the cookie via header AND re-assert it in inline JS before redirecting,
  // which is the most reliable way to make the browser send it on the next hop.
  const redirectCookie = `${SESSION_COOKIE}=${token}; path=/; SameSite=Lax${remember ? "; max-age=31536000" : ""}`;
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Signing in…</title></head>
<body><script>
  document.cookie = ${JSON.stringify(redirectCookie)};
  location.replace("/admin");
</script>
<noscript><meta http-equiv="refresh" content="0;url=/admin"></noscript>
</body></html>`;
  return htmlResponse(html, 200, { "Set-Cookie": cookie });
}

// Auto-login for the desktop hub: GET /auto?key=... sets the session cookie and
// redirects to /admin (used by the SermonIndex Development app iframe).
async function handleAutoLogin(req: Request): Promise<Response> {
  const key = new URL(req.url).searchParams.get("key") || "";
  if (!ADMIN_KEY || key !== ADMIN_KEY) return loginPage("Incorrect key. Please try again.");
  const token = crypto.randomUUID();
  await ensureTables();
  await dbQuery(`INSERT INTO sessions (token, created_at) VALUES (?, ?)`, [token, nowIso()]);
  const cookie = `${SESSION_COOKIE}=${token}; Path=/; SameSite=Lax; HttpOnly; Max-Age=31536000`;
  const redirectCookie = `${SESSION_COOKIE}=${token}; path=/; SameSite=Lax; max-age=31536000`;
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Signing in…</title></head>
<body><script>document.cookie=${JSON.stringify(redirectCookie)};location.replace("/admin");</script>
<noscript><meta http-equiv="refresh" content="0;url=/admin"></noscript></body></html>`;
  return htmlResponse(html, 200, { "Set-Cookie": cookie });
}

async function handleLogout(req: Request): Promise<Response> {
  const token = getCookie(req, SESSION_COOKIE);
  if (token) {
    try {
      await dbQuery(`DELETE FROM sessions WHERE token = ?`, [token]);
    } catch {}
  }
  const clear = `${SESSION_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`;
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Signed out</title></head>
<body><script>document.cookie=${JSON.stringify(`${SESSION_COOKIE}=; path=/; max-age=0`)};location.replace("/login");</script>
<noscript><meta http-equiv="refresh" content="0;url=/login"></noscript></body></html>`;
  return htmlResponse(html, 200, { "Set-Cookie": clear });
}

// ─────────────────────────────────────────────────────────────────────────────
// ==============================  ADMIN PAGES  ===============================
// ─────────────────────────────────────────────────────────────────────────────

/** Fetch stats_snapshots as arrays for charting (oldest → newest). */
async function loadSnapshots(limit = 200): Promise<any> {
  const { rows } = await dbQuery(
    `SELECT ts, nodes_online, seed_nodes, sermons_shared, total_files, total_storage_bytes, total_uploaded_bytes, countries
       FROM stats_snapshots ORDER BY id DESC LIMIT ?`,
    [limit],
  );
  rows.reverse(); // chronological
  return {
    labels: rows.map((r: any) => new Date(r.ts).toLocaleString()),
    nodesOnline: rows.map((r: any) => toInt(r.nodes_online, 0)),
    seedNodes: rows.map((r: any) => toInt(r.seed_nodes, 0)),
    sermonsShared: rows.map((r: any) => toInt(r.sermons_shared, 0)),
    totalFiles: rows.map((r: any) => toInt(r.total_files, 0)),
    // For the "Data Transferred" chart — cumulative uploaded, in MB for readable axis.
    dataTransferredMB: rows.map((r: any) => Math.round(toInt(r.total_uploaded_bytes, 0) / 1048576)),
    countries: rows.map((r: any) => toInt(r.countries, 0)),
    count: rows.length,
  };
}

/** Reusable stat card. */
function statCard(n: string | number, label: string): string {
  return `<div class="stat"><div class="n">${escapeHtml(String(n))}</div><div class="l">${escapeHtml(label)}</div></div>`;
}

/**
 * Stat card whose number is tinted a category colour (gold seed / green node /
 * orange peer). `color` is a CSS colour string.
 */
function statCardColor(n: string | number, label: string, color: string): string {
  return `<div class="stat"><div class="n" style="color:${escapeHtml(color)};">${escapeHtml(String(n))}</div><div class="l">${escapeHtml(label)}</div></div>`;
}

/** Remote config editor block (shared by /admin and /admin/config). */
function configEditor(rows: any[], compact = false): string {
  const list = rows
    .map(
      (r: any) => `
      <form method="POST" action="/admin/config" class="row" style="margin-bottom:10px;align-items:flex-end;">
        <input type="hidden" name="key" value="${escapeHtml(r.key)}">
        <div style="min-width:170px;"><label>Key</label><code>${escapeHtml(r.key)}</code></div>
        <div style="flex:1;min-width:180px;"><label>Value</label>${
          r.key === "source_mode"
            ? `<select name="value">
                <option value="cdn"${r.value === "cdn" ? " selected" : ""}>CDN — direct download</option>
                <option value="p2p"${r.value === "p2p" ? " selected" : ""}>Peer-to-peer (BitTorrent)</option>
                <option value="hybrid"${r.value === "hybrid" ? " selected" : ""}>Hybrid — BitTorrent + CDN fallback</option>
              </select>`
            : `<input name="value" value="${escapeHtml(r.value)}">`
        }</div>
        ${compact ? "" : `<div style="flex:1;min-width:180px;"><label>Description</label><input name="description" value="${escapeHtml(r.description || "")}"></div>`}
        <button class="btn sm" type="submit">Save</button>
      </form>`,
    )
    .join("");

  const addForm = `
    <form method="POST" action="/admin/config" class="row" style="margin-top:14px;align-items:flex-end;border-top:1px dashed var(--border);padding-top:14px;">
      <div style="min-width:170px;"><label>New key</label><input name="key" placeholder="new_setting" required></div>
      <div style="flex:1;min-width:180px;"><label>Value</label><input name="value" placeholder="value" required></div>
      <div style="flex:1;min-width:180px;"><label>Description</label><input name="description" placeholder="what it does"></div>
      <button class="btn sm" type="submit">Add</button>
    </form>`;

  return `<div class="card">${list || '<div class="empty">No config yet.</div>'}${addForm}</div>`;
}

/** GET /admin — Overview. */
async function pageOverview(): Promise<Response> {
  await ensureTables();
  const online = isoMinutesAgo(15);
  const [stat, ever, sermons, snaps] = await Promise.all([
    dbQuery(
      `SELECT COUNT(*) online,
              SUM(CASE WHEN node_type='seed' THEN 1 ELSE 0 END) seeds,
              SUM(CASE WHEN node_type!='seed' AND reachable=1 THEN 1 ELSE 0 END) openNodes,
              SUM(CASE WHEN node_type!='seed' AND (reachable IS NULL OR reachable=0) THEN 1 ELSE 0 END) peers,
              COUNT(DISTINCT country) countries
         FROM nodes WHERE is_online=1 AND last_seen >= ?`,
      [online],
    ),
    dbQuery(`SELECT COUNT(*) ever FROM nodes`),
    dbQuery(
      `SELECT COUNT(DISTINCT s.sermon_id) c
         FROM shared_sermons s JOIN nodes n ON n.node_id=s.node_id
        WHERE n.is_online=1 AND n.last_seen >= ?`,
      [online],
    ),
    loadSnapshots(200),
  ]);

  const s = stat.rows[0] || {};
  // Three node categories among online nodes: Seed (gold), Node = port open
  // (green), Peer = port closed/unknown (orange).
  const cards =
    statCard(toInt(s.online, 0), "Online Now") +
    statCardColor(toInt(s.seeds, 0), "Seed Nodes", "var(--gold-text)") +
    statCardColor(toInt(s.openNodes, 0), "Nodes · port open", "var(--green)") +
    statCardColor(toInt(s.peers, 0), "Peers · port closed", "var(--orange)") +
    statCard(toInt(s.countries, 0), "Countries") +
    statCard(toInt(ever.rows[0]?.ever, 0), "All-Time Nodes") +
    statCard(toInt(sermons.rows[0]?.c, 0), "Sermons Shared");

  const chartData = JSON.stringify(snaps);

  // NOTE: The remote-config key/value editor and the content-source-mode toggle
  // used to live here too, but they duplicated the dedicated /admin/config page,
  // so they were removed from the Overview. Manage all settings on Config.

  const body = `
    <h1>Overview</h1>
    <p class="sub">Live network health for the SermonIndex node backbone.</p>
    <div class="stats">${cards}</div>

    <h2>Network Activity</h2>
    <div class="card">
      <p class="sub">Nodes online and distinct sermons shared over time (from periodic snapshots).</p>
      <div class="chart-wrap"><canvas id="overviewChart"></canvas></div>
    </div>

    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <script>
      (function(){
        var d = ${chartData};
        if (!d.count) { document.getElementById('overviewChart').parentElement.innerHTML = '<div class="empty">No snapshots yet — data appears as nodes report in.</div>'; return; }
        // Read theme-aware colours so text/grid stay legible in light AND dark.
        var cs = getComputedStyle(document.documentElement);
        var textColor = (cs.getPropertyValue('--text2') || '#555').trim();
        var isDark = document.documentElement.dataset.theme === 'dark';
        var gridColor = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.07)';
        var ctx = document.getElementById('overviewChart').getContext('2d');
        var gGold = ctx.createLinearGradient(0,0,0,300);
        gGold.addColorStop(0,'rgba(212,175,55,0.45)'); gGold.addColorStop(1,'rgba(212,175,55,0.02)');
        var gOlive = ctx.createLinearGradient(0,0,0,300);
        gOlive.addColorStop(0,'rgba(112,112,53,0.35)'); gOlive.addColorStop(1,'rgba(112,112,53,0.02)');
        new Chart(ctx, {
          type:'line',
          data:{ labels:d.labels, datasets:[
            { label:'Nodes online', data:d.nodesOnline, borderColor:'#967d1f', backgroundColor:gGold, fill:true, tension:0.4, pointRadius:0, borderWidth:2 },
            { label:'Sermons shared', data:d.sermonsShared, borderColor:'#707035', backgroundColor:gOlive, fill:true, tension:0.4, pointRadius:0, borderWidth:2 }
          ]},
          options:{ responsive:true, maintainAspectRatio:false,
            plugins:{ legend:{ labels:{ color:textColor, font:{ family:'Verdana' } } } },
            scales:{ x:{ ticks:{ color:textColor, maxTicksLimit:8 }, grid:{ display:false } },
                     y:{ beginAtZero:true, ticks:{ color:textColor }, grid:{ color:gridColor } } } }
        });
      })();
    </script>`;

  return htmlResponse(page("Overview", "overview", body));
}

/** GET /admin/graph — dedicated charts. */
async function pageGraph(): Promise<Response> {
  await ensureTables();
  const online = isoMinutesAgo(15);
  const [snaps, onlineRow, footRow] = await Promise.all([
    loadSnapshots(500),
    // Live count — nodes heartbeating in the last 15 minutes.
    dbQuery(`SELECT COUNT(*) online FROM nodes WHERE is_online=1 AND last_seen >= ?`, [online]),
    // Storage footprint — each node's last-reported figures, across ALL known
    // nodes, so this reflects what's stored on the network and doesn't drop to 0
    // just because a node is momentarily offline.
    dbQuery(`SELECT COALESCE(SUM(files_stored),0) files, COALESCE(SUM(storage_used_bytes),0) storage, COALESCE(SUM(uploaded_bytes),0) uploaded FROM nodes`),
  ]);
  const onlineCount = toInt(onlineRow.rows[0]?.online, 0);
  const foot = footRow.rows[0] || {};
  const latestSermons = snaps.sermonsShared.length ? snaps.sermonsShared[snaps.sermonsShared.length - 1] : 0;

  const cards =
    statCard(onlineCount, "Nodes Online") +
    statCard(latestSermons, "Sermons Shared") +
    statCard(toInt(foot.files, 0), "Files Stored") +
    statCard(fmtBytes(toInt(foot.storage, 0)), "Storage") +
    statCard(fmtBytes(toInt(foot.uploaded, 0)), "Data Transferred");

  const chartData = JSON.stringify(snaps);

  const body = `
    <h1>Graph</h1>
    <p class="sub">Growth of the node network over time. Each point is a periodic snapshot (about every 30 minutes) recorded as nodes send heartbeats.</p>
    <div class="stats">${cards}</div>

    <h2>Nodes Online</h2>
    <div class="card"><div class="chart-wrap big"><canvas id="c1"></canvas></div></div>

    <h2>Sermons Shared</h2>
    <div class="card"><div class="chart-wrap big"><canvas id="c2"></canvas></div></div>

    <h2>Files Stored</h2>
    <div class="card"><div class="chart-wrap big"><canvas id="c3"></canvas></div></div>

    <h2>Data Transferred (MB)</h2>
    <div class="card"><div class="chart-wrap big"><canvas id="c4"></canvas></div></div>

    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <script>
      (function(){
        var d = ${chartData};
        // Theme-aware tick/legend/grid colours (legible in light AND dark).
        var cs = getComputedStyle(document.documentElement);
        var textColor = (cs.getPropertyValue('--text2') || '#555').trim();
        var isDark = document.documentElement.dataset.theme === 'dark';
        var gridColor = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.07)';
        function grad(ctx, rgb){ var g=ctx.createLinearGradient(0,0,0,340);
          g.addColorStop(0, 'rgba('+rgb+',0.4)'); g.addColorStop(1, 'rgba('+rgb+',0.02)'); return g; }
        function mountain(id, label, data, line, rgb){
          var el=document.getElementById(id); if(!el) return;
          if(!d.count){ el.parentElement.innerHTML='<div class="empty">No snapshots yet.</div>'; return; }
          var ctx=el.getContext('2d');
          new Chart(ctx,{ type:'line',
            data:{ labels:d.labels, datasets:[{ label:label, data:data, borderColor:line, backgroundColor:grad(ctx,rgb), fill:true, tension:0.4, pointRadius:0, borderWidth:2 }] },
            options:{ responsive:true, maintainAspectRatio:false,
              plugins:{ legend:{ labels:{ color:textColor, font:{ family:'Verdana' } } } },
              scales:{ x:{ ticks:{ color:textColor, maxTicksLimit:8 }, grid:{ display:false } },
                       y:{ beginAtZero:true, ticks:{ color:textColor }, grid:{ color:gridColor } } } } });
        }
        mountain('c1','Nodes online', d.nodesOnline, '#707035', '112,112,53');
        mountain('c2','Sermons shared', d.sermonsShared, '#967d1f', '212,175,55');
        mountain('c3','Files stored', d.totalFiles, '#3d8a41', '61,138,65');
        mountain('c4','Data transferred (MB)', d.dataTransferredMB, '#2d6cb5', '45,108,181');
      })();
    </script>`;

  return htmlResponse(page("Graph", "graph", body));
}

/** GET /admin/nodes — pending seed requests + full node table with flip switch. */
async function pageNodes(): Promise<Response> {
  await ensureTables();

  const [pending, nodes] = await Promise.all([
    // Pending seed requests: requested but not yet enabled.
    dbQuery(
      `SELECT node_id, email, requested_at FROM seed_access
        WHERE enabled=0 AND requested_at IS NOT NULL ORDER BY requested_at DESC`,
    ),
    // Nodes joined with seed_access flag and a per-node shared-sermon count.
    dbQuery(
      `SELECT n.node_id, n.city, n.country, n.region, n.is_online, n.last_seen, n.node_type, n.reachable,
              n.files_stored, n.library_coverage, n.app_version,
              COALESCE(sa.enabled, 0) AS seed_enabled,
              (SELECT COUNT(*) FROM shared_sermons ss WHERE ss.node_id = n.node_id) AS shared_count
         FROM nodes n
         LEFT JOIN seed_access sa ON sa.node_id = n.node_id
        ORDER BY n.last_seen DESC LIMIT 200`,
    ),
  ]);

  // App-version distribution (additive): count ONLINE nodes grouped by reported
  // app_version so the admin can see the version spread and spot stale installs.
  // Same 15-min online cutoff as the rest of the dashboard.
  const online = isoMinutesAgo(15);
  const versions = await dbQuery(
    `SELECT COALESCE(NULLIF(app_version,''),'unknown') v, COUNT(*) c
       FROM nodes WHERE is_online=1 AND last_seen >= ?
      GROUP BY v ORDER BY c DESC`,
    [online],
  );
  // Numeric-aware version compare (e.g. 0.0.325 > 0.0.99). Non-numeric parts count as 0.
  const cmpVersion = (a: string, b: string): number => {
    const pa = String(a).split(".").map((x) => toInt(x, 0));
    const pb = String(b).split(".").map((x) => toInt(x, 0));
    const len = Math.max(pa.length, pb.length);
    for (let i = 0; i < len; i++) {
      const diff = (pa[i] || 0) - (pb[i] || 0);
      if (diff) return diff;
    }
    return 0;
  };
  // Highest real (non-"unknown") version among online nodes; anything lower is stale.
  let newestVersion = "";
  for (const r of versions.rows) {
    if (r.v && r.v !== "unknown" && (!newestVersion || cmpVersion(r.v, newestVersion) > 0)) {
      newestVersion = String(r.v);
    }
  }
  const versionChips = versions.rows
    .map((r: any) => {
      const v = String(r.v || "unknown");
      const c = toInt(r.c, 0);
      const isUnknown = v === "unknown";
      const isStale = !isUnknown && !!newestVersion && cmpVersion(v, newestVersion) < 0;
      // Newest = green, stale = orange (spot the old ones), unknown = muted.
      const cls = isUnknown ? "b-off" : isStale ? "b-peer" : "b-node";
      const tip = isUnknown ? "version not reported" : isStale ? `older than v${newestVersion}` : "newest version";
      return `<span class="badge ${cls}" title="${escapeHtml(tip)}">${escapeHtml(isUnknown ? v : "v" + v)} · ${c}</span>`;
    })
    .join("");
  const versionsSection = `
    <h2>App Versions <span class="muted" style="font-size:0.7rem;font-weight:400;">(online nodes)</span></h2>
    <div class="card">
      ${
        versions.rows.length
          ? `<div class="row">${versionChips}</div>`
          : '<div class="empty">No online nodes.</div>'
      }
    </div>`;

  // Network Health (additive): a right-now snapshot of how resilient the network
  // is — how many online nodes can actually serve peers (reachable=1), how many
  // seeds are up, average library coverage, and country spread. A network of mostly
  // closed peers is fragile, so reachable% is the headline metric. Same 15-min cutoff.
  const health = await dbQuery(
    `SELECT COUNT(*) online,
            SUM(CASE WHEN reachable=1 THEN 1 ELSE 0 END) reachable,
            SUM(CASE WHEN node_type='seed' THEN 1 ELSE 0 END) seeds,
            COALESCE(AVG(library_coverage),0) avgCoverage,
            COUNT(DISTINCT country) countries
       FROM nodes WHERE is_online=1 AND last_seen >= ?`,
    [online],
  );
  const h = health.rows[0] || {};
  const hOnline = toInt(h.online, 0);
  const hReachable = toInt(h.reachable, 0);
  const hSeeds = toInt(h.seeds, 0);
  const hCoverage = Math.round(toNum(h.avgCoverage, 0));
  const hCountries = toInt(h.countries, 0);
  const reachablePct = hOnline > 0 ? Math.round((hReachable / hOnline) * 100) : 0;
  // Muted at-risk hint when the network looks fragile (few reachable peers or thin coverage).
  const atRisk = hOnline > 0 && (reachablePct < 30 || hCoverage < 25);
  const riskMsg = reachablePct < 30
    ? "Few reachable nodes — network resilience is low"
    : "Low average coverage — content availability is thin";
  const riskChip = atRisk
    ? `<div class="row" style="margin-top:12px;"><span class="badge b-peer">⚠ ${escapeHtml(riskMsg)}</span></div>`
    : "";
  const healthSection = `
    <h2>Network Health <span class="muted" style="font-size:0.7rem;font-weight:400;">(online nodes)</span></h2>
    <div class="card">
      ${
        hOnline > 0
          ? `<div class="stats">
              ${statCardColor(reachablePct + "%", `Reachable · ${hReachable} of ${hOnline} online`, reachablePct < 30 ? "var(--orange)" : "var(--green)")}
              ${statCardColor(hSeeds, "Seeds online", "var(--gold-text)")}
              ${statCard(hCoverage + "%", "Avg coverage")}
              ${statCard(hCountries, "Countries")}
            </div>${riskChip}`
          : '<div class="empty">No online nodes.</div>'
      }
    </div>`;

  // Pending seed requests block.
  const pendingRows = pending.rows
    .map(
      (r: any) => `<tr>
        <td><code>#${escapeHtml(String(r.node_id).slice(0, 8))}</code> <span class="mono muted">${escapeHtml(r.node_id)}</span></td>
        <td>${r.email ? escapeHtml(r.email) : '<span class="muted">—</span>'}</td>
        <td class="muted">${escapeHtml(timeAgo(r.requested_at))}</td>
        <td>
          <form method="POST" action="/admin/seed" class="inline-form">
            <input type="hidden" name="node_id" value="${escapeHtml(r.node_id)}">
            <input type="hidden" name="enable" value="1">
            <button class="btn sm green" type="submit">Enable</button>
          </form>
        </td>
      </tr>`,
    )
    .join("");

  const pendingSection = `
    <h2>Pending Seed Requests</h2>
    <div class="card" style="overflow-x:auto;">
      ${
        pending.rows.length
          ? `<table><thead><tr><th>Node</th><th>Email</th><th>Requested</th><th></th></tr></thead><tbody>${pendingRows}</tbody></table>`
          : '<div class="empty">No pending seed requests.</div>'
      }
    </div>`;

  // Full node table with flip switch.
  const nowMs = Date.now();
  const nodeRows = nodes.rows
    .map((n: any) => {
      const lastMs = n.last_seen ? new Date(n.last_seen).getTime() : 0;
      const isOnline = toInt(n.is_online, 0) === 1 && nowMs - lastMs < 15 * 60 * 1000;
      const seedEnabled = toInt(n.seed_enabled, 0) === 1;
      // Three-way class badge: Seed (gold) / Node = port open (green) /
      // Peer = port closed or unknown (orange).
      const cat = nodeCategory(n);
      const classBadge =
        cat === "seed"
          ? '<span class="badge b-seed">Seed</span>'
          : cat === "node"
            ? '<span class="badge b-node" title="port open">Node</span>'
            : '<span class="badge b-peer" title="port closed">Peer</span>';
      const flip = seedEnabled
        ? `<form method="POST" action="/admin/seed" class="inline-form">
             <input type="hidden" name="node_id" value="${escapeHtml(n.node_id)}">
             <input type="hidden" name="enable" value="0">
             <button class="btn sm red" type="submit">Disable</button>
           </form>`
        : `<form method="POST" action="/admin/seed" class="inline-form">
             <input type="hidden" name="node_id" value="${escapeHtml(n.node_id)}">
             <input type="hidden" name="enable" value="1">
             <button class="btn sm green" type="submit">Enable</button>
           </form>`;
      // Admin → node commands, delivered on the node's next heartbeat. A machine
      // that is fully asleep can't receive these until it wakes; a running node acts on them.
      const cmdBtns = `
        <form method="POST" action="/admin/node-command" class="inline-form" style="display:inline;">
          <input type="hidden" name="node_id" value="${escapeHtml(n.node_id)}">
          <input type="hidden" name="action" value="get_diagnostics">
          <button class="btn sm ghost" type="submit" title="Ping — the node reports back on its next heartbeat">Ping</button>
        </form>
        <form method="POST" action="/admin/node-command" class="inline-form" style="display:inline;">
          <input type="hidden" name="node_id" value="${escapeHtml(n.node_id)}">
          <input type="hidden" name="action" value="reconnect">
          <button class="btn sm ghost" type="submit" title="Re-announce — restart P2P to rediscover peers">Re-announce</button>
        </form>`;
      return `<tr>
        <td><code>#${escapeHtml(String(n.node_id).slice(0, 8))}</code></td>
        <td>${escapeHtml(fmtLocation(n.city, n.region, n.country))}</td>
        <td>${isOnline ? '<span class="badge b-on">online</span>' : '<span class="badge b-off">offline</span>'}</td>
        <td>${n.node_type === "seed" ? '<span class="badge b-seed">seed</span>' : '<span class="badge b-user">user</span>'}</td>
        <td>${classBadge}</td>
        <td>${toInt(n.shared_count, 0)}</td>
        <td>${toInt(n.files_stored, 0)}</td>
        <td>${(Math.round(toNum(n.library_coverage, 0) * 10) / 10)}%</td>
        <td class="mono">${escapeHtml(n.app_version || "0.0.0")}</td>
        <td class="muted">${escapeHtml(timeAgo(n.last_seen))}</td>
        <td>${flip}</td>
        <td style="white-space:nowrap;">${cmdBtns}</td>
      </tr>`;
    })
    .join("");

  const nodesSection = `
    <h2>Nodes <span class="muted" style="font-size:0.7rem;font-weight:400;">(last 200 by last seen)</span></h2>
    <div class="card" style="overflow-x:auto;">
      ${
        nodes.rows.length
          ? `<table><thead><tr>
              <th>Node</th><th>Location</th><th>Status</th><th>Type</th><th>Class</th>
              <th>Sermons</th><th>Files</th><th>Coverage</th><th>Version</th><th>Last seen</th><th>Seed access</th><th>Actions</th>
            </tr></thead><tbody>${nodeRows}</tbody></table>`
          : '<div class="empty">No nodes yet.</div>'
      }
    </div>`;

  const body = `<h1>Nodes</h1><p class="sub">Approve seed access and manage every node that has reported in.</p>${healthSection}${pendingSection}${versionsSection}${nodesSection}`;
  return htmlResponse(page("Nodes", "nodes", body));
}

/** GET /admin/config — full config editor. */
async function pageConfig(): Promise<Response> {
  await ensureTables();
  const { rows } = await dbQuery(`SELECT key, value, description FROM config ORDER BY key`);
  // Master List refresh control — reads the current master_list_version and lets
  // the admin bump it, forcing every node to re-pull the canonical master-list.json.
  const masterListVersion = String((rows.find((r: any) => r.key === "master_list_version") || {}).value || "");
  const masterListCard = `
    <h2>Master List</h2>
    <div class="card" style="margin-bottom:16px;">
      <p class="sub">Force every node to re-download the canonical <code>master-list.json</code>. Nodes cache it locally across launches and only re-pull when this version changes (delivered on the next heartbeat, within ~5&nbsp;min).</p>
      <div class="row" style="align-items:flex-end;">
        <div style="min-width:220px;"><label>Current version</label><code>${escapeHtml(masterListVersion || "(none — nodes use their cached copy)")}</code></div>
        <form method="POST" action="/admin/master-list/refresh" class="inline-form">
          <button class="btn" type="submit">Force all nodes to refresh</button>
        </form>
      </div>
    </div>`;
  // Chat Moderators control — persists the moderator_ids config value. The community
  // chat backend fetches /api/config (cached ~60s) and stars messages from these nodes.
  const moderatorIds = String((rows.find((r: any) => r.key === "moderator_ids") || {}).value || "");
  const moderatorsCard = `
    <h2>Chat Moderators</h2>
    <div class="card" style="margin-bottom:16px;">
      <p class="sub">Short node IDs (like <code>si-2098a</code>) whose messages appear as moderators in the community chat. Separate with commas, spaces, or new lines. Picked up by the chat backend within ~60&nbsp;s.</p>
      <form method="POST" action="/admin/moderators">
        <div class="field">
          <label for="moderator_ids">Moderator node IDs</label>
          <textarea id="moderator_ids" name="moderator_ids" rows="4" placeholder="si-2098a, si-1a2b3">${escapeHtml(moderatorIds)}</textarea>
        </div>
        <button class="btn" type="submit">Save Moderators</button>
      </form>
    </div>`;
  const body = `<h1>Remote Config</h1><p class="sub">Key/value settings delivered to every node on its next heartbeat.</p>${masterListCard}${moderatorsCard}${configEditor(rows, false)}`;
  return htmlResponse(page("Config", "config", body));
}

// ── Admin POST handlers ──────────────────────────────────────────────────────

/** POST /admin/seed — flip a node's seed access on/off. */
async function adminSeedFlip(req: Request): Promise<Response> {
  const form = await req.formData().catch(() => null);
  const nodeId = cleanNode(form ? form.get("node_id") : "");
  const enable = form && String(form.get("enable")) === "1" ? 1 : 0;
  if (!nodeId) return errorPage("Missing node id.");
  const ts = nowIso();

  await dbBatch([
    {
      sql: `INSERT INTO seed_access (node_id, enabled, enabled_at)
              VALUES (?, ?, ?)
            ON CONFLICT(node_id) DO UPDATE SET
              enabled=excluded.enabled,
              enabled_at=CASE WHEN excluded.enabled=1 THEN excluded.enabled_at ELSE seed_access.enabled_at END`,
      args: [nodeId, enable, enable === 1 ? ts : null],
    },
    {
      sql: `INSERT INTO node_events (node_id, event_type, detail, timestamp) VALUES (?,?,?,?)`,
      args: [nodeId, enable === 1 ? "seed_enabled" : "seed_disabled", "", ts],
    },
  ]);

  return redirect("/admin/nodes");
}

/** POST /admin/node-command — queue a command a node runs on its next heartbeat. */
async function adminNodeCommand(req: Request): Promise<Response> {
  const form = await req.formData().catch(() => null);
  const nodeId = cleanNode(form ? form.get("node_id") : "");
  const action = String(form ? form.get("action") || "" : "").slice(0, 40);
  const allowed = ["get_diagnostics", "reconnect", "restart", "get_logs", "reannounce_content"];
  if (!nodeId || !allowed.includes(action)) return errorPage("Invalid node command.");
  const ts = nowIso();
  await dbBatch([
    {
      sql: `INSERT INTO node_commands (node_id, action, params, status, created_at) VALUES (?,?,?,'pending',?)`,
      args: [nodeId, action, "{}", ts],
    },
    {
      sql: `INSERT INTO node_events (node_id, event_type, detail, timestamp) VALUES (?,?,?,?)`,
      args: [nodeId, "command_queued", action, ts],
    },
  ]);
  return redirect("/admin/nodes");
}

/** POST /admin/config — upsert a config key. */
async function adminConfigSave(req: Request): Promise<Response> {
  const form = await req.formData().catch(() => null);
  const key = String(form ? form.get("key") || "" : "").trim().slice(0, 80);
  const value = String(form ? form.get("value") ?? "" : "");
  const description = form && form.get("description") != null ? String(form.get("description")) : null;
  if (!key) return errorPage("Missing config key.");
  const ts = nowIso();

  if (description != null) {
    await dbQuery(
      `INSERT INTO config (key, value, updated_at, description) VALUES (?,?,?,?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at, description=excluded.description`,
      [key, value, ts, description],
    );
  } else {
    await dbQuery(
      `INSERT INTO config (key, value, updated_at, description) VALUES (?,?,?,'')
       ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
      [key, value, ts],
    );
  }
  return redirect("/admin");
}

/**
 * POST /admin/master-list/refresh — bump master_list_version to the current time.
 * Every node picks this up inside its config on the next heartbeat and re-pulls
 * the canonical master-list.json. Additive: reuses the config store + admin-session
 * auth (guarded by the /admin isLoggedIn check in the router, same as other actions).
 */
async function adminMasterListRefresh(_req: Request): Promise<Response> {
  await ensureTables();
  const version = new Date().toISOString();
  await dbQuery(
    `INSERT INTO config (key, value, updated_at, description) VALUES (?,?,?,'')
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
    ["master_list_version", version, version],
  );
  return redirect("/admin/config");
}

/**
 * POST /admin/moderators — persist the community-chat moderator node-id list into
 * the config store under `moderator_ids`. Additive: reuses the config store + the
 * admin-session auth (guarded by the /admin isLoggedIn check in the router, same as
 * the other admin actions). The chat backend fetches /api/config to read this.
 */
async function adminModeratorsSave(req: Request): Promise<Response> {
  await ensureTables();
  const form = await req.formData().catch(() => null);
  const raw = String(form ? form.get("moderator_ids") ?? "" : "");
  // Normalize: split on commas/whitespace/newlines, strip a leading '#', lowercase,
  // drop blanks, dedupe. Stored as a tidy comma-separated list.
  const ids = Array.from(
    new Set(
      raw
        .split(/[\s,]+/)
        .map((s) => s.replace(/^#+/, "").trim().toLowerCase())
        .filter(Boolean),
    ),
  );
  const value = ids.join(", ");
  const ts = nowIso();
  await dbQuery(
    `INSERT INTO config (key, value, updated_at, description) VALUES (?,?,?,?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
    ["moderator_ids", value, ts, "Comma/space/newline-separated short node IDs (e.g. si-2098a) shown as moderators in the community chat."],
  );
  return redirect("/admin/config");
}

/** 302 redirect helper. */
function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { Location: location } });
}

// ─────────────────────────────────────────────────────────────────────────────
// ================================  ROUTER  ==================================
// ─────────────────────────────────────────────────────────────────────────────
BunnySDK.net.http.serve(async (req: Request): Promise<Response> => {
  // CORS preflight.
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  const url = new URL(req.url);
  let path = url.pathname.replace(/\/+$/, ""); // strip trailing slash
  if (path === "") path = "/";
  const method = req.method;

  try {
    // ── App-facing API ──────────────────────────────────────────────────────
    if (path === "/api/node/heartbeat" && method === "POST") return await handleHeartbeat(req);
    if (path === "/api/node/shutdown" && method === "POST") return await handleShutdown(req);
    if (path === "/api/node/command-result" && method === "POST") return await handleCommandResult(req);
    if (path === "/api/node/map" && method === "GET") return await handleMap();
    if (path === "/api/node/stats" && method === "GET") return await handleStats();
    if (path === "/api/config" && method === "GET") return await handleConfig();
    if (path === "/api/content-packs" && method === "GET") return await handleContentPacks();
    if (path === "/api/geo" && method === "GET") return await handleGeo(req);
    if (path === "/api/seed/access" && method === "GET") return await handleSeedAccessGet(url);
    if (path === "/api/seed/request" && method === "POST") return await handleSeedRequest(req);

    // ── Auth ────────────────────────────────────────────────────────────────
    if (path === "/") return redirect("/login");
    if (path === "/auto") return await handleAutoLogin(req);
    if (path === "/login" && method === "GET") return loginPage();
    if (path === "/login" && method === "POST") return await handleLogin(req);
    if (path === "/logout") return await handleLogout(req);

    // ── Admin (all require a session) ─────────────────────────────────────────
    if (path === "/admin" || path.startsWith("/admin/")) {
      if (!(await isLoggedIn(req))) return redirect("/login");

      // GET pages
      if (path === "/admin" && method === "GET") return await pageOverview();
      if (path === "/admin/graph" && method === "GET") return await pageGraph();
      if (path === "/admin/nodes" && method === "GET") return await pageNodes();
      if (path === "/admin/config" && method === "GET") return await pageConfig();

      // POST actions
      if (path === "/admin/seed" && method === "POST") return await adminSeedFlip(req);
      if (path === "/admin/node-command" && method === "POST") return await adminNodeCommand(req);
      if (path === "/admin/config" && method === "POST") return await adminConfigSave(req);
      if (path === "/admin/master-list/refresh" && method === "POST") return await adminMasterListRefresh(req);
      if (path === "/admin/moderators" && method === "POST") return await adminModeratorsSave(req);

      return errorPage("Unknown admin page.");
    }

    // ── Fallthrough ───────────────────────────────────────────────────────────
    // JSON for anything under /api, HTML otherwise.
    if (path.startsWith("/api/")) return jsonResponse({ ok: false, error: "unknown endpoint" }, 404);
    return htmlResponse(page("Not found", "", `<h1>404</h1><p class="sub">Nothing here.</p><a class="btn ghost" href="/login">Go to login</a>`), 404);
  } catch (e) {
    // API errors → JSON 500; page errors → simple HTML 500.
    if (path.startsWith("/api/")) {
      return jsonResponse({ ok: false, error: "server_error" }, 500);
    }
    return errorPage(e instanceof Error ? e.message : "server_error");
  }
});
