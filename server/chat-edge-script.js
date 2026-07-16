/**
 * SermonIndex Community Chat — Bunny Edge Script (no servers, no Docker)
 * ======================================================================
 * Stores the chat as ONE JSON file in your existing Bunny Storage zone
 * (chat/chat.json). Keeps the last 200 messages; GET returns at most 100.
 * Perfect for a low-traffic community room.
 *
 * DEPLOY (5 minutes, all in the Bunny dashboard):
 *  1. Edge Scripting → Add script → type "Standalone" → paste this whole file.
 *  2. In the script's Environment Variables, add these (as secrets):
 *       STORAGE_ZONE  = your storage zone name (the one behind sermonindex1)
 *       STORAGE_KEY   = that storage zone's password (FTP & API Access)
 *       ADMIN_KEY     = a long random secret you invent (moderation key)
 *       STORAGE_HOST  = storage.bunnycdn.com   (or your region host, e.g. ny.storage.bunnycdn.com)
 *  3. Publish. Bunny gives the script a hostname like  si-chat.b-cdn.net.
 *  4. CDN → pull zone for app.sermonindex.net → Edge Rules → new rule:
 *       IF Request URL matches:  star + /api/chat + star   (wildcards on both ends)
 *       THEN Override Origin URL → https://<your-script-hostname>
 *       AND  Bypass Cache
 *  5. Test:  curl 'https://app.sermonindex.net/api/chat?since=0'
 *            → {"ok":true,"messages":[]}
 *
 * MODERATION (from any terminal, using your ADMIN_KEY):
 *   ban:    curl 'https://app.sermonindex.net/api/chat?admin_key=KEY&action=ban&node=a1b2c3d4'
 *   unban:  curl 'https://app.sermonindex.net/api/chat?admin_key=KEY&action=unban&node=a1b2c3d4'
 *   delete: curl 'https://app.sermonindex.net/api/chat?admin_key=KEY&action=delete&id=42'
 *   (node may be the 8-char id shown in the chat, or a full node id)
 *
 * NOTE on concurrency: two people posting in the exact same instant could
 * lose one message (read-modify-write on a single file). At this room's
 * expected traffic that's acceptable; the app retries gracefully.
 */

import * as BunnySDK from "https://esm.sh/@bunny.net/edgescript-sdk@0.11.2";

const env = (k, d = "") =>
  (typeof process !== "undefined" && process.env && process.env[k]) ||
  (typeof Deno !== "undefined" && Deno.env.get(k)) || d;

const STORAGE_ZONE = env("STORAGE_ZONE");
const STORAGE_KEY  = env("STORAGE_KEY");
const ADMIN_KEY    = env("ADMIN_KEY", "CHANGE_ME");
const STORAGE_HOST = env("STORAGE_HOST", "storage.bunnycdn.com");

const FILE_URL   = `https://${STORAGE_HOST}/${STORAGE_ZONE}/chat/chat.json`;
const KEEP       = 200;   // messages kept in the file
const RETURN_MAX = 100;   // messages returned per GET
const RATE_MS    = 5000;  // one message per node per 5s
const EMPTY = { seq: 0, messages: [], bans: [], last_post: {} };

// Community moderators — the node-admin dashboard stores a `moderator_ids` list
// (short node IDs like "si-2098a") in its config. We read it from the public
// config endpoint, cache it ~60s, and flag matching messages with is_moderator.
const CONFIG_URL = "https://app.sermonindex.net/api/config";
const MOD_TTL_MS = 60_000;                 // refresh the moderator list at most every ~60s
let _modCache = { ids: [], ts: 0 };        // { ids: normalized short-id list, ts: last fetch }

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Cache-Control": "no-store",
};

const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });

async function loadState() {
  const res = await fetch(FILE_URL, { headers: { AccessKey: STORAGE_KEY } });
  if (res.status === 404) return { ...EMPTY };
  if (!res.ok) throw new Error(`storage read ${res.status}`);
  const data = await res.json().catch(() => null);
  return data && Array.isArray(data.messages) ? data : { ...EMPTY };
}

async function saveState(state) {
  const res = await fetch(FILE_URL, {
    method: "PUT",
    headers: { AccessKey: STORAGE_KEY, "Content-Type": "application/json" },
    body: JSON.stringify(state),
  });
  if (res.status !== 201) throw new Error(`storage write ${res.status}`);
}

const clean = (s, max) =>
  String(s || "").replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "").trim().slice(0, max);

const isBanned = (state, nodeId) =>
  state.bans.some((b) => nodeId === b || nodeId.startsWith(b));

// Normalize a node id for moderator comparison: strip a leading '#', lowercase.
const normId = (s) => String(s || "").replace(/^#+/, "").trim().toLowerCase();

// Fetch + cache (~60s) the moderator id list from the node-admin config. On any
// failure keep the last-known list and just reset the timer (never blocks chat).
async function getModeratorIds() {
  const now = Date.now();
  if (now - _modCache.ts < MOD_TTL_MS) return _modCache.ids;
  try {
    const res = await fetch(CONFIG_URL, { signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      const data = await res.json().catch(() => null);
      const raw = data && data.config && typeof data.config.moderator_ids === "string" ? data.config.moderator_ids : "";
      _modCache = { ids: raw.split(/[\s,]+/).map(normId).filter(Boolean), ts: now };
    } else {
      _modCache.ts = now; // keep last-known ids; back off until the next window
    }
  } catch {
    _modCache.ts = now;   // network error — keep last-known ids, retry next window
  }
  return _modCache.ids;
}

// A message's short node id counts as a moderator if it matches a listed id
// exactly, or a listed (full) id begins with the message's 8-char short id.
const isModerator = (mods, node) => {
  const n = normId(node);
  return !!n && mods.some((e) => n === e || e.startsWith(n));
};

BunnySDK.net.http.serve(async (request) => {
  try {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    // ── Admin actions ────────────────────────────────────────────────
    const adminKey = url.searchParams.get("admin_key");
    if (adminKey) {
      if (ADMIN_KEY === "CHANGE_ME" || adminKey !== ADMIN_KEY)
        return json(403, { ok: false, error: "invalid" });
      const state = await loadState();
      const action = url.searchParams.get("action");
      const node = clean(url.searchParams.get("node"), 64);
      if (action === "ban" && node) {
        if (!state.bans.includes(node)) state.bans.push(node);
      } else if (action === "unban" && node) {
        state.bans = state.bans.filter((b) => b !== node);
      } else if (action === "delete") {
        const id = parseInt(url.searchParams.get("id"), 10);
        state.messages = state.messages.filter((m) => m.id !== id);
      } else {
        return json(400, { ok: false, error: "invalid" });
      }
      await saveState(state);
      return json(200, { ok: true, bans: state.bans });
    }

    // ── GET: messages newer than ?since ─────────────────────────────
    if (request.method === "GET") {
      const since = parseInt(url.searchParams.get("since") || "0", 10) || 0;
      const [state, mods] = await Promise.all([loadState(), getModeratorIds()]);
      const messages = state.messages
        .filter((m) => m.id > since)
        .slice(-RETURN_MAX)
        .map((m) => ({ id: m.id, name: m.name, node: m.node, text: m.text, ts: m.ts, is_moderator: isModerator(mods, m.node) }));
      return json(200, { ok: true, messages });
    }

    // ── POST: new message ────────────────────────────────────────────
    if (request.method === "POST") {
      const body = await request.json().catch(() => null);
      if (!body) return json(400, { ok: false, error: "invalid" });
      const nodeId = clean(body.node_id, 64);
      const name = clean(body.name, 24);
      const text = clean(body.text, 500);
      if (!nodeId || !name || !text) return json(400, { ok: false, error: "invalid" });

      const state = await loadState();
      if (isBanned(state, nodeId)) return json(403, { ok: false, error: "banned" });

      const now = Date.now();
      const last = state.last_post[nodeId] || 0;
      if (now - last < RATE_MS) return json(429, { ok: false, error: "rate_limited" });

      state.seq += 1;
      state.messages.push({ id: state.seq, node: nodeId.slice(0, 8), name, text, ts: now });
      if (state.messages.length > KEEP) state.messages = state.messages.slice(-KEEP);
      state.last_post[nodeId] = now;
      // prune the rate-limit map so the file never grows unbounded
      for (const k of Object.keys(state.last_post)) {
        if (now - state.last_post[k] > 3600_000) delete state.last_post[k];
      }

      await saveState(state);
      return json(200, { ok: true, id: state.seq });
    }

    return json(405, { ok: false, error: "invalid" });
  } catch (e) {
    return json(500, { ok: false, error: "server_error" });
  }
});
