#!/usr/bin/env node
/**
 * SermonIndex Community Chat — zero-dependency Node 18+ server.
 *
 * Run behind your reverse proxy so it answers at:
 *   https://app.sermonindex.net/api/chat
 * (any request path is accepted, so /api/chat, /chat or / all work)
 *
 * Protocol (must stay in sync with the app's CommunityPage.jsx):
 *   GET  ?since=<lastId>  → {ok:true, messages:[{id, name, node, text, ts}]}
 *                           messages with id > since, max 100, oldest first.
 *                           `node` is the first 8 chars of the poster's node id.
 *   POST {node_id, name, text}
 *                         → {ok:true, id}
 *                         | {ok:false, error:"banned"|"rate_limited"|"invalid"}
 *
 * Storage: ./chat-data.json (messages capped at the last 2000, bans array).
 *
 * Admin (all via GET):
 *   ?admin_key=KEY&action=ban&node=<node id or 8-char prefix shown in chat>
 *   ?admin_key=KEY&action=unban&node=<same value used to ban>
 *   ?admin_key=KEY&action=delete&id=<message id>
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ADMIN_KEY    = 'CHANGE_ME'; // ← set a long random secret before deploying
const PORT         = Number(process.env.CHAT_PORT) || 8787;
const DATA_FILE    = path.join(path.dirname(fileURLToPath(import.meta.url)), 'chat-data.json');
const MAX_TEXT     = 500;
const MAX_NAME     = 24;
const RATE_MS      = 5000;   // min interval between messages per node
const MAX_FETCH    = 100;    // max messages returned per GET
const MAX_STORE    = 2000;   // messages kept on disk
const MAX_NODE_LEN = 80;
const MAX_BODY     = 16 * 1024;

// ── Storage ──────────────────────────────────────────────────────────────────
let data = { nextId: 1, messages: [], bans: [] };
try {
  const loaded = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  data.messages = Array.isArray(loaded.messages) ? loaded.messages : [];
  data.bans = Array.isArray(loaded.bans) ? loaded.bans : [];
  data.nextId = data.messages.reduce((m, x) => Math.max(m, x.id + 1), loaded.nextId || 1);
} catch { /* first run — start empty */ }

let saveTimer = null;
function save() { // debounced write; low-traffic chat, so this is plenty
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { fs.writeFileSync(DATA_FILE, JSON.stringify(data)); }
    catch (e) { console.error('[chat] save failed:', e.message); }
  }, 250);
}

const lastPost = new Map(); // node_id → last accepted ts (rate limit)

// ── Helpers ──────────────────────────────────────────────────────────────────
// Strip ASCII control chars; optionally keep newlines (for message bodies)
const stripCtl = (s, keepNewlines = false) =>
  String(s).replace(keepNewlines ? /[\u0000-\u0009\u000B-\u001F\u007F]/g : /[\u0000-\u001F\u007F]/g, '');

// Banned if full id matches, or a ban entry is a prefix of it (lets moderators
// ban using the 8-char id shown in the chat UI)
const isBanned = (node) => data.bans.some(b => node === b || node.startsWith(b));

function json(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(JSON.stringify(payload));
}

// ── Server ───────────────────────────────────────────────────────────────────
http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }

  // ── Admin actions ──
  const adminKey = url.searchParams.get('admin_key');
  if (adminKey !== null) {
    if (adminKey !== ADMIN_KEY || ADMIN_KEY === 'CHANGE_ME') return json(res, 403, { ok: false, error: 'invalid' });
    const action = url.searchParams.get('action');
    const node = stripCtl(url.searchParams.get('node') || '').slice(0, MAX_NODE_LEN);
    if (action === 'ban' && node) {
      if (!data.bans.includes(node)) data.bans.push(node);
      save();
      return json(res, 200, { ok: true });
    }
    if (action === 'unban' && node) {
      data.bans = data.bans.filter(b => b !== node);
      save();
      return json(res, 200, { ok: true });
    }
    if (action === 'delete' && url.searchParams.has('id')) {
      const id = Number(url.searchParams.get('id'));
      data.messages = data.messages.filter(m => m.id !== id);
      save();
      return json(res, 200, { ok: true });
    }
    return json(res, 400, { ok: false, error: 'invalid' });
  }

  // ── POST: publish a message ──
  if (req.method === 'POST') {
    let raw = '';
    try {
      for await (const chunk of req) {
        raw += chunk;
        if (raw.length > MAX_BODY) return json(res, 413, { ok: false, error: 'invalid' });
      }
    } catch { return json(res, 400, { ok: false, error: 'invalid' }); }

    let body;
    try { body = JSON.parse(raw); } catch { return json(res, 400, { ok: false, error: 'invalid' }); }
    if (!body || typeof body !== 'object') return json(res, 400, { ok: false, error: 'invalid' });

    const node = stripCtl(String(body.node_id || '').trim()).slice(0, MAX_NODE_LEN);
    const name = stripCtl(String(body.name || '').trim()).slice(0, MAX_NAME);
    const text = stripCtl(String(body.text || ''), true).trim().slice(0, MAX_TEXT);

    if (!node || !name || !text) return json(res, 400, { ok: false, error: 'invalid' });
    if (isBanned(node)) return json(res, 403, { ok: false, error: 'banned' });

    const now = Date.now();
    if (now - (lastPost.get(node) || 0) < RATE_MS) return json(res, 429, { ok: false, error: 'rate_limited' });
    lastPost.set(node, now);

    const msg = { id: data.nextId++, node, name, text, ts: now };
    data.messages.push(msg);
    if (data.messages.length > MAX_STORE) data.messages = data.messages.slice(-MAX_STORE);
    save();
    return json(res, 200, { ok: true, id: msg.id });
  }

  // ── GET: messages newer than ?since ──
  if (req.method === 'GET') {
    const since = Math.max(0, Number(url.searchParams.get('since')) || 0);
    const messages = data.messages
      .filter(m => m.id > since)
      .slice(0, MAX_FETCH)
      .map(m => ({ id: m.id, name: m.name, node: String(m.node).slice(0, 8), text: m.text, ts: m.ts }));
    return json(res, 200, { ok: true, messages });
  }

  json(res, 405, { ok: false, error: 'invalid' });
}).listen(PORT, () => {
  console.log(`[chat] SermonIndex community chat listening on :${PORT} (data: ${DATA_FILE})`);
});
