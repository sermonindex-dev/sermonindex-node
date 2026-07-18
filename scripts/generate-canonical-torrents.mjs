#!/usr/bin/env node
/**
 * SermonIndex Canonical Torrent Generator
 * =======================================
 * Streams every sermon file from the CDN/Archive.org (nothing stored locally),
 * hashes it into a canonical .torrent, and writes the MASTER LIST — the
 * authoritative table of sermon → infohash/size/magnet that the app and
 * website trust. Only swarms whose fingerprint appears in this list are
 * ever joined by the app, which makes injecting false content impossible.
 *
 * Output (in --out, default ./canonical-output):
 *   torrents/<sermonId>.torrent   — canonical torrent (with CDN webseeds)
 *   master-list.json              — the master list
 *   master-list.json.sig          — detached ed25519 signature over its raw bytes
 *                                   (written only if scripts/masterlist.key exists)
 *
 * The master list is RESUMABLE: re-running skips already-processed sermons,
 * so interruptions (or nightly runs for new sermons) are fine.
 *
 * Usage:
 *   node scripts/generate-canonical-torrents.mjs --limit 12        # dry test
 *   node scripts/generate-canonical-torrents.mjs                   # full run
 *   node scripts/generate-canonical-torrents.mjs --only <sermonId>
 *   node scripts/generate-canonical-torrents.mjs --concurrency 6
 *
 * Requires Node 18+ (built-in fetch). No npm dependencies.
 *
 * After running: upload torrents/ and master-list.json to the CDN, e.g.
 *   https://sermonindex1.b-cdn.net/torrents/<id>.torrent
 *   https://sermonindex1.b-cdn.net/torrents/master-list.json
 * The app auto-detects the master list at that URL (see catalog.js).
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { signMasterList } from './sign-master-list.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Config ─────────────────────────────────────────────────────────────────

const PIECE_LENGTH = 2 * 1024 * 1024; // 2 MiB — matches the app's librqbit default

const TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.demonii.com:1337/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://exodus.desync.com:6969/announce',
];

const CDN_AUDIO_BASE = 'https://sermonindex1.b-cdn.net';
const CDN_VIDEO_BASE = 'https://sermonindex2.b-cdn.net';
const ARCHIVE_BASE = 'https://archive.org/download';

// Where the .torrent files will live once uploaded (used in the master list)
const TORRENT_PUBLIC_BASE = 'https://sermonindex1.b-cdn.net/torrents';

// Bunny caps objects per folder (10k) AND merges folder names case-
// insensitively on write while serving case-sensitively — so shard names must
// contain no letter-case information at all. We use the first two hex chars
// of md5(sermonId): 256 lowercase-hex folders, ~130 files each.
// DO NOT change this scheme once published — URLs live in the master list.
function shardOf(id) {
  return createHash('md5').update(id).digest('hex').slice(0, 2);
}

// ─── CLI args ───────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const getArg = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const LIMIT = parseInt(getArg('limit', '0'), 10);
const ONLY = getArg('only', null);
const OUT_DIR = getArg('out', join(__dirname, '..', 'canonical-output'));
const CONCURRENCY = Math.max(1, parseInt(getArg('concurrency', '4'), 10));

// ─── Bencode (minimal, spec-exact) ──────────────────────────────────────────

function bencode(value) {
  if (Buffer.isBuffer(value)) {
    return Buffer.concat([Buffer.from(`${value.length}:`), value]);
  }
  if (typeof value === 'string') {
    const b = Buffer.from(value, 'utf8');
    return Buffer.concat([Buffer.from(`${b.length}:`), b]);
  }
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) throw new Error('bencode: non-integer number');
    return Buffer.from(`i${value}e`);
  }
  if (Array.isArray(value)) {
    return Buffer.concat([Buffer.from('l'), ...value.map(bencode), Buffer.from('e')]);
  }
  if (typeof value === 'object' && value !== null) {
    // Keys MUST be sorted by raw bytes for a canonical encoding
    const keys = Object.keys(value).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    const parts = [Buffer.from('d')];
    for (const k of keys) {
      if (value[k] === undefined || value[k] === null) continue;
      parts.push(bencode(k), bencode(value[k]));
    }
    parts.push(Buffer.from('e'));
    return Buffer.concat(parts);
  }
  throw new Error(`bencode: unsupported type ${typeof value}`);
}

// ─── Catalog loading (compact format from the app) ─────────────────────────

function loadCatalog() {
  const raw = JSON.parse(readFileSync(join(__dirname, '..', 'src', 'data', 'catalog.json'), 'utf8'));
  const { s: speakers, c: compact } = raw;
  return compact.map((e) => {
    const [id, title, spkIdx, , , , sizeKB, archiveCode, cdnCode, type] = e;
    const isVideo = type === 1;
    const ext = isVideo ? 'mp4' : 'mp3';
    const cdnUrl = cdnCode
      ? (isVideo && cdnCode.length === 11 && !cdnCode.includes('/')
          ? `${CDN_VIDEO_BASE}/${cdnCode}.mp4`
          : `${CDN_AUDIO_BASE}/${cdnCode}`)
      : '';
    const archiveUrl = archiveCode
      ? `${ARCHIVE_BASE}/SERMONINDEX_${archiveCode}/${archiveCode}.${ext}`
      : '';
    return {
      id,
      title,
      speaker: speakers[spkIdx]?.[0] || 'Unknown',
      filename: `${id}.${ext}`, // MUST match the app's download filename
      expectedSize: sizeKB * 1024,
      sources: [cdnUrl, archiveUrl].filter(Boolean),
    };
  });
}

// ─── Streaming hash of one file ─────────────────────────────────────────────

async function hashFromUrl(url, onProgress) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} for ${url}`);
  // Integrity guard 1: never fingerprint an HTML error page
  const ctype = (res.headers.get('content-type') || '').toLowerCase();
  if (ctype.includes('text/html')) throw new Error(`got HTML (error page?) for ${url}`);
  const expectedLen = parseInt(res.headers.get('content-length') || '0', 10);

  const pieces = [];
  let pieceHash = createHash('sha1');
  let pieceFill = 0;
  let total = 0;

  for await (const chunk of res.body) {
    let buf = Buffer.from(chunk);
    total += buf.length;
    while (buf.length > 0) {
      const take = Math.min(buf.length, PIECE_LENGTH - pieceFill);
      pieceHash.update(buf.subarray(0, take));
      pieceFill += take;
      buf = buf.subarray(take);
      if (pieceFill === PIECE_LENGTH) {
        pieces.push(pieceHash.digest());
        pieceHash = createHash('sha1');
        pieceFill = 0;
      }
    }
    if (onProgress) onProgress(total);
  }
  if (pieceFill > 0) pieces.push(pieceHash.digest());
  if (total === 0) throw new Error(`empty file at ${url}`);
  // Integrity guard 2: detect truncated streams
  if (expectedLen > 0 && total !== expectedLen) {
    throw new Error(`truncated stream for ${url}: got ${total} of ${expectedLen} bytes`);
  }
  return { pieces: Buffer.concat(pieces), length: total };
}

// ─── Torrent + magnet construction ──────────────────────────────────────────

function buildTorrent(entry, hashed, hashedUrl) {
  const info = {
    length: hashed.length,
    name: entry.filename,
    'piece length': PIECE_LENGTH,
    pieces: hashed.pieces,
  };
  const infoHash = createHash('sha1').update(bencode(info)).digest('hex');
  const torrent = {
    announce: TRACKERS[0],
    'announce-list': TRACKERS.map((t) => [t]),
    comment: `${entry.title} — ${entry.speaker} (SermonIndex.net)`,
    'created by': 'SermonIndex canonical generator',
    'creation date': Math.floor(Date.now() / 1000),
    info,
    // BEP19 webseed — ONLY the URL we actually hashed. The CDN and Archive
    // copies may be different encodings; a webseed must be byte-identical.
    'url-list': [hashedUrl],
  };
  return { bytes: bencode(torrent), infoHash };
}

function buildMagnet(infoHash, name, webseeds) {
  let m = `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(name)}`;
  for (const t of TRACKERS) m += `&tr=${encodeURIComponent(t)}`;
  for (const ws of webseeds) m += `&ws=${encodeURIComponent(ws)}`;
  return m;
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  mkdirSync(join(OUT_DIR, 'torrents'), { recursive: true });
  const masterPath = join(OUT_DIR, 'master-list.json');

  // Resume: load existing master list if present
  let master = { version: 1, generated_at: null, piece_length: PIECE_LENGTH, trackers: TRACKERS, entries: {}, signature: null };
  if (existsSync(masterPath)) {
    master = JSON.parse(readFileSync(masterPath, 'utf8'));
    console.log(`Resuming — ${Object.keys(master.entries).length} entries already done`);
  }

  let catalog = loadCatalog().filter((e) => e.sources.length > 0);
  if (ONLY) catalog = catalog.filter((e) => e.id === ONLY);
  const todo = catalog.filter((e) => !master.entries[e.id]);
  const queue = LIMIT > 0 ? todo.slice(0, LIMIT) : todo;

  console.log(`Catalog: ${catalog.length} sermons · done: ${catalog.length - todo.length} · this run: ${queue.length}`);

  let done = 0, failed = 0;
  const startedAt = Date.now();

  const persist = () => {
    master.generated_at = new Date().toISOString();
    writeFileSync(masterPath, JSON.stringify(master, null, 1));
  };

  async function worker() {
    while (queue.length > 0) {
      const entry = queue.shift();
      const t0 = Date.now();
      let lastErr = null;
      for (const url of entry.sources) {
        try {
          const hashed = await hashFromUrl(url);
          const { bytes, infoHash } = buildTorrent(entry, hashed, url);
          const shard = shardOf(entry.id);
          mkdirSync(join(OUT_DIR, 'torrents', shard), { recursive: true });
          writeFileSync(join(OUT_DIR, 'torrents', shard, `${entry.id}.torrent`), bytes);
          master.entries[entry.id] = {
            name: entry.filename,
            size: hashed.length,
            info_hash: infoHash,
            magnet: buildMagnet(infoHash, entry.filename, [url]),
            torrent_url: `${TORRENT_PUBLIC_BASE}/${shard}/${entry.id}.torrent`,
            webseeds: [url],
          };
          if (entry.expectedSize && Math.abs(hashed.length - entry.expectedSize) > entry.expectedSize * 0.5) {
            console.warn(`  size mismatch ${entry.id}: catalog ${entry.expectedSize}, actual ${hashed.length}`);
          }
          done++;
          const mb = (hashed.length / 1048576).toFixed(1);
          const secs = ((Date.now() - t0) / 1000).toFixed(0);
          console.log(`[${done + failed}/${done + failed + queue.length}] ${entry.id} ✓ ${mb} MB in ${secs}s (${infoHash.slice(0, 12)}…)`);
          lastErr = null;
          break;
        } catch (err) {
          lastErr = err;
        }
      }
      if (lastErr) {
        failed++;
        console.error(`[!] ${entry.id} FAILED: ${lastErr.message}`);
      }
      if ((done + failed) % 10 === 0) persist(); // checkpoint every 10 files
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  persist();

  // Detached ed25519 signature over the raw bytes we just wrote. Skipped (with a
  // loud warning) if scripts/masterlist.key isn't present — never fatal here.
  try {
    signMasterList(OUT_DIR);
  } catch (e) {
    console.error(`[!] Signing failed: ${e.message}`);
  }

  const mins = ((Date.now() - startedAt) / 60000).toFixed(1);
  console.log(`\nDone: ${done} ok, ${failed} failed, in ${mins} min`);
  console.log(`Master list: ${masterPath} (${Object.keys(master.entries).length} total entries)`);
  console.log(`\nNext steps:`);
  console.log(`  1. Upload ${join(OUT_DIR, 'torrents')}/*.torrent  →  ${TORRENT_PUBLIC_BASE}/`);
  console.log(`  2. Upload master-list.json AND master-list.json.sig → ${TORRENT_PUBLIC_BASE}/`);
  console.log(`     (the app verifies the signature and IGNORES an unsigned/invalid list)`);
  console.log(`  3. The app picks it up automatically; the website can link each magnet.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
