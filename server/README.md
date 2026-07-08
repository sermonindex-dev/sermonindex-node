# SermonIndex Community Chat — server

The desktop app's **Community** page polls one endpoint:

```
https://app.sermonindex.net/api/chat
```

Pick **one** of the two implementations below (they speak the exact same protocol),
deploy it at that URL, and set the admin key.

## Protocol (the app depends on this exactly)

- `GET {base}?since=<lastId>` →
  `{"ok":true,"messages":[{"id":1,"name":"…","node":"<first 8 chars of node id>","text":"…","ts":1699999999999}]}`
  Returns messages with `id > since`, max 100, oldest first. The app polls with
  `since=0` on first load, then `since=<highest id seen>` **every 10 seconds**
  (it backs off to 30 s while the endpoint is unreachable or returns non-JSON/404).
- `POST {base}` with JSON body `{"node_id":"…","name":"…","text":"…"}` →
  `{"ok":true,"id":123}` or `{"ok":false,"error":"banned"|"rate_limited"|"invalid"}`.

Both servers enforce: text ≤ 500 chars, name ≤ 24 chars, control characters
stripped (newlines kept in message text), 1 message per 5 s per `node_id`, and a
ban list by `node_id`. CORS is wide open (`Access-Control-Allow-Origin: *`) —
required because the Tauri app runs from a custom origin.

## Option A — PHP (`chat-server.php`)

Best if app.sermonindex.net already serves the heartbeat API via PHP.

1. Edit the file and change `ADMIN_KEY` from `CHANGE_ME` to a long random secret
   (admin actions are refused while it is still `CHANGE_ME`).
2. Drop it next to the existing api so it answers at `/api/chat`:
   - simplest: create `api/chat/` and save the file as **`api/chat/index.php`**, or
   - keep the filename and add a rewrite, e.g. nginx:
     `location = /api/chat { rewrite ^ /api/chat-server.php last; }`
     or Apache: `RewriteRule ^api/chat$ /api/chat-server.php [L]`
3. It creates `chat.db` (SQLite) beside itself on first request — the web server
   user needs **write access to that directory** (for the db + its journal files).
   Requires PHP with `pdo_sqlite` (standard on almost every host).
4. Keep `chat.db` out of the web root if you can, or deny direct downloads of `*.db`.

## Option B — Node 18+ (`chat-server.mjs`)

Zero dependencies; stores data in `chat-data.json` beside the file
(messages capped at the last 2000).

1. Edit the file and change `ADMIN_KEY` (same rule: refused while `CHANGE_ME`).
2. Run it (systemd, pm2, whatever you use):
   ```sh
   CHAT_PORT=8787 node chat-server.mjs
   ```
3. Proxy `/api/chat` to it, e.g. nginx:
   ```nginx
   location /api/chat {
       proxy_pass http://127.0.0.1:8787;
   }
   ```
   The server accepts any request path, so no path rewriting is needed.

## Moderation (curl examples)

Ban using the full `node_id`, **or** the short 8-character id shown next to each
message in the app (bans match by prefix):

```sh
BASE="https://app.sermonindex.net/api/chat"
KEY="your-admin-key"

# Mute a node (it gets {"error":"banned"} on every send)
curl "$BASE?admin_key=$KEY&action=ban&node=si-1a2b3c"

# Lift the ban (use the same value you banned with)
curl "$BASE?admin_key=$KEY&action=unban&node=si-1a2b3c"

# Delete a single message by id
curl "$BASE?admin_key=$KEY&action=delete&id=42"
```

Quick smoke test after deploying:

```sh
curl "$BASE?since=0"
curl -X POST "$BASE" -H 'Content-Type: application/json' \
     -d '{"node_id":"si-test1234","name":"Tester","text":"Hello vault"}'
```

## Notes

- The app already whitelists `https://*.sermonindex.net` in its CSP, so no app
  changes are needed when the endpoint goes live — the Community page starts
  working on its next poll.
- Traffic is light: each open Community page is one GET per 10 s.
- GETs only ever return the **first 8 characters** of a node id; full ids never
  leave the server.
