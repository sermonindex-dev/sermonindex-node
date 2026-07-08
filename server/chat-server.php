<?php
/**
 * SermonIndex Community Chat — single-file endpoint (PHP 7.4+ / 8.x, SQLite via PDO).
 *
 * Deploy so it answers at:  https://app.sermonindex.net/api/chat
 * (e.g. place as api/chat/index.php, or rewrite /api/chat → this file)
 *
 * Protocol (must stay in sync with the app's CommunityPage.jsx):
 *   GET  ?since=<lastId>  → {ok:true, messages:[{id, name, node, text, ts}]}
 *                           messages with id > since, max 100, oldest first.
 *                           `node` is the first 8 chars of the poster's node id.
 *   POST {node_id, name, text}
 *                         → {ok:true, id}
 *                         | {ok:false, error:"banned"|"rate_limited"|"invalid"}
 *
 * Server rules: text ≤ 500 chars, name ≤ 24 chars, control chars stripped,
 * 1 message per 5 s per node_id, ban list by node_id.
 *
 * Admin (all via GET, e.g. with curl):
 *   ?admin_key=KEY&action=ban&node=<node id or 8-char prefix shown in chat>
 *   ?admin_key=KEY&action=unban&node=<same value used to ban>
 *   ?admin_key=KEY&action=delete&id=<message id>
 */

const ADMIN_KEY    = 'CHANGE_ME';              // ← set a long random secret before deploying
const DB_PATH      = __DIR__ . '/chat.db';     // SQLite file, created on first request
const MAX_TEXT     = 500;
const MAX_NAME     = 24;
const RATE_MS      = 5000;                     // min interval between messages per node
const MAX_FETCH    = 100;                      // max messages returned per GET
const MAX_NODE_LEN = 80;                       // sanity cap on node_id length

// ── CORS + JSON headers (the Tauri app runs from a custom origin) ────────────
header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(204);
    exit;
}

function respond(array $payload, int $status = 200): void {
    http_response_code($status);
    echo json_encode($payload);
    exit;
}

// Strip ASCII control chars; optionally keep newlines (for message bodies)
function strip_ctl(string $s, bool $keep_newlines = false): string {
    $pattern = $keep_newlines ? '/[\x00-\x09\x0B-\x1F\x7F]/u' : '/[\x00-\x1F\x7F]/u';
    return preg_replace($pattern, '', $s) ?? '';
}

function cut(string $s, int $max): string {
    return function_exists('mb_substr') ? mb_substr($s, 0, $max) : substr($s, 0, $max);
}

// ── Database ─────────────────────────────────────────────────────────────────
try {
    $db = new PDO('sqlite:' . DB_PATH);
    $db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    $db->exec('CREATE TABLE IF NOT EXISTS messages (
        id   INTEGER PRIMARY KEY AUTOINCREMENT,
        node TEXT,
        name TEXT,
        text TEXT,
        ts   INTEGER
    )');
    $db->exec('CREATE TABLE IF NOT EXISTS bans (node TEXT PRIMARY KEY)');
} catch (Exception $e) {
    respond(['ok' => false, 'error' => 'invalid'], 500);
}

// A node is banned if its full id is banned, or a banned entry is a prefix of
// it (lets moderators ban using the 8-char id shown in the chat UI).
function is_banned(PDO $db, string $node): bool {
    $q = $db->prepare("SELECT 1 FROM bans WHERE node = ? OR ? LIKE (node || '%') LIMIT 1");
    $q->execute([$node, $node]);
    return (bool) $q->fetchColumn();
}

// ── Admin actions ────────────────────────────────────────────────────────────
if (isset($_GET['admin_key'])) {
    if (!hash_equals(ADMIN_KEY, (string) $_GET['admin_key']) || ADMIN_KEY === 'CHANGE_ME') {
        respond(['ok' => false, 'error' => 'invalid'], 403);
    }
    $action = $_GET['action'] ?? '';
    if ($action === 'ban' && !empty($_GET['node'])) {
        $q = $db->prepare('INSERT OR IGNORE INTO bans (node) VALUES (?)');
        $q->execute([cut(strip_ctl((string) $_GET['node']), MAX_NODE_LEN)]);
        respond(['ok' => true]);
    }
    if ($action === 'unban' && !empty($_GET['node'])) {
        $q = $db->prepare('DELETE FROM bans WHERE node = ?');
        $q->execute([cut(strip_ctl((string) $_GET['node']), MAX_NODE_LEN)]);
        respond(['ok' => true]);
    }
    if ($action === 'delete' && isset($_GET['id'])) {
        $q = $db->prepare('DELETE FROM messages WHERE id = ?');
        $q->execute([(int) $_GET['id']]);
        respond(['ok' => true]);
    }
    respond(['ok' => false, 'error' => 'invalid'], 400);
}

// ── POST: publish a message ──────────────────────────────────────────────────
if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $body = json_decode(file_get_contents('php://input'), true);
    if (!is_array($body)) respond(['ok' => false, 'error' => 'invalid'], 400);

    $node = cut(strip_ctl(trim((string) ($body['node_id'] ?? ''))), MAX_NODE_LEN);
    $name = cut(strip_ctl(trim((string) ($body['name'] ?? ''))), MAX_NAME);
    $text = cut(trim(strip_ctl((string) ($body['text'] ?? ''), true)), MAX_TEXT);

    if ($node === '' || $name === '' || $text === '') {
        respond(['ok' => false, 'error' => 'invalid'], 400);
    }
    if (is_banned($db, $node)) {
        respond(['ok' => false, 'error' => 'banned'], 403);
    }

    // Rate limit: 1 message per RATE_MS per node
    $now = (int) round(microtime(true) * 1000);
    $q = $db->prepare('SELECT MAX(ts) FROM messages WHERE node = ?');
    $q->execute([$node]);
    $last = (int) $q->fetchColumn();
    if ($last && ($now - $last) < RATE_MS) {
        respond(['ok' => false, 'error' => 'rate_limited'], 429);
    }

    $q = $db->prepare('INSERT INTO messages (node, name, text, ts) VALUES (?, ?, ?, ?)');
    $q->execute([$node, $name, $text, $now]);
    respond(['ok' => true, 'id' => (int) $db->lastInsertId()]);
}

// ── GET: messages newer than ?since ─────────────────────────────────────────
$since = isset($_GET['since']) ? max(0, (int) $_GET['since']) : 0;
$q = $db->prepare('SELECT id, node, name, text, ts FROM messages WHERE id > ? ORDER BY id ASC LIMIT ' . MAX_FETCH);
$q->execute([$since]);

$messages = [];
foreach ($q->fetchAll(PDO::FETCH_ASSOC) as $row) {
    $messages[] = [
        'id'   => (int) $row['id'],
        'name' => $row['name'],
        'node' => substr((string) $row['node'], 0, 8),  // never expose the full node id
        'text' => $row['text'],
        'ts'   => (int) $row['ts'],
    ];
}
respond(['ok' => true, 'messages' => $messages]);
