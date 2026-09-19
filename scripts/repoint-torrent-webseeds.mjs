#!/usr/bin/env node
/**
 * repoint-torrent-webseeds.mjs
 * ============================
 * Rewrites the webseed list of every existing .torrent so Archive.org is tried
 * first and the CDN is the fallback — WITHOUT re-downloading or re-hashing a
 * single file.
 *
 *   node scripts/repoint-torrent-webseeds.mjs            # dry run, changes nothing
 *   node scripts/repoint-torrent-webseeds.mjs --apply    # write the changes
 *
 * WHY THIS AND NOT A REGENERATION
 * -------------------------------
 * generate-canonical-torrents.mjs streams every file to hash it. Re-running it
 * for 33,085 sermons would pull the entire library through the network again —
 * the exact cost we are trying to remove. But a torrent's info_hash is computed
 * from the `info` dictionary alone, and `url-list` (the webseed list, BEP19)
 * sits outside it. So the webseeds can be swapped with the fingerprint left
 * untouched: every existing swarm keeps working, nobody re-downloads anything,
 * and the master list stays valid.
 *
 * This script proves that rather than assuming it — it recomputes the info_hash
 * after re-encoding and refuses to write the file if it changed.
 *
 * WHAT IT TOUCHES
 * ---------------
 *   canonical-output/torrents/<shard>/<id>.torrent   url-list only
 *   canonical-output/master-list.json                webseeds + magnet ws=
 *   canonical-output/upload-log.json                 renamed, so the uploader
 *                                                    re-sends the rewritten files
 *
 * The master list is backed up and re-signed. Sermons with no Archive copy keep
 * the CDN as their only webseed and are left alone.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, existsSync, renameSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const getArg = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const OUT_DIR = getArg('out', join(__dirname, '..', 'canonical-output'));

const CDN_AUDIO_BASE = 'https://sermonindex1.b-cdn.net';
const CDN_VIDEO_BASE = 'https://sermonindex2.b-cdn.net';
const ARCHIVE_BASE   = 'https://archive.org/download';

const shardOf = (id) => createHash('md5').update(id).digest('hex').slice(0, 2);

// ─── bencode / bdecode ──────────────────────────────────────────────────────
function bencode(v) {
  if (Buffer.isBuffer(v)) return Buffer.concat([Buffer.from(`${v.length}:`), v]);
  if (typeof v === 'string') { const b = Buffer.from(v, 'utf8'); return Buffer.concat([Buffer.from(`${b.length}:`), b]); }
  if (typeof v === 'number') { if (!Number.isInteger(v)) throw new Error('non-integer'); return Buffer.from(`i${v}e`); }
  if (Array.isArray(v)) return Buffer.concat([Buffer.from('l'), ...v.map(bencode), Buffer.from('e')]);
  if (typeof v === 'object' && v !== null) {
    const keys = Object.keys(v).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    const parts = [Buffer.from('d')];
    for (const k of keys) { if (v[k] === undefined || v[k] === null) continue; parts.push(bencode(k), bencode(v[k])); }
    parts.push(Buffer.from('e'));
    return Buffer.concat(parts);
  }
  throw new Error(`bencode: unsupported ${typeof v}`);
}

// Byte strings come back as Buffers so binary `pieces` survives a round trip
// untouched. Dictionary keys are decoded as utf8, which is all bencode allows.
function bdecode(buf, i = 0) {
  const c = buf[i];
  if (c === 0x69) { // i...e
    const e = buf.indexOf(0x65, i);
    return [parseInt(buf.slice(i + 1, e).toString(), 10), e + 1];
  }
  if (c === 0x6c) { // l...e
    const out = []; i++;
    while (buf[i] !== 0x65) { const [v, ni] = bdecode(buf, i); out.push(v); i = ni; }
    return [out, i + 1];
  }
  if (c === 0x64) { // d...e
    const out = {}; i++;
    while (buf[i] !== 0x65) {
      const [k, ni] = bdecode(buf, i);
      const [v, nj] = bdecode(buf, ni);
      out[Buffer.isBuffer(k) ? k.toString('utf8') : String(k)] = v;
      i = nj;
    }
    return [out, i + 1];
  }
  const colon = buf.indexOf(0x3a, i);
  const len = parseInt(buf.slice(i, colon).toString(), 10);
  const start = colon + 1;
  return [buf.slice(start, start + len), start + len];
}

const str = (v) => (Buffer.isBuffer(v) ? v.toString('utf8') : v);
const infoHashOf = (t) => createHash('sha1').update(bencode(t.info)).digest('hex');

// ─── where the Archive URLs come from ───────────────────────────────────────
// NOT catalog.json — that snapshot is from 25 March and knows about zero
// archived videos, so trusting it would leave every video torrent pointing at
// sermonindex2, which is the zone we are trying to get off. The sermon database
// is what ia_mirror.py writes to on each successful upload, so it is the only
// honest answer to "does Archive have this file".
//
// The join key is the CDN URL: the master list already stores it as the current
// webseed, and it is exactly the `audio_url` / `mp4_url` column value.
function archiveByCdnUrl() {
  const db = [
    join(__dirname, '..', '..', 'sermonindex-development', 'scripts', 'sermon-database', 'sermon_db.sqlite'),
    join(__dirname, '..', '..', 'sermon_db.sqlite'),
  ].find(existsSync);
  if (!db) throw new Error('sermon_db.sqlite not found — cannot tell what is on Archive.org');

  const py = `
import sqlite3, json, sys
c = sqlite3.connect('file:' + sys.argv[1] + '?mode=ro', uri=True)
m = {}
for cdn, arc in c.execute("SELECT audio_url, archive_audio_url FROM sermons "
                          "WHERE audio_url != '' AND archive_audio_url != '' "
                          "AND audio_url IS NOT NULL AND archive_audio_url IS NOT NULL"):
    m[cdn] = arc
for cdn, arc in c.execute("SELECT mp4_url, archive_video_url FROM sermons "
                          "WHERE mp4_url != '' AND archive_video_url != '' "
                          "AND mp4_url IS NOT NULL AND archive_video_url IS NOT NULL"):
    m[cdn] = arc
# and the reverse, for torrents that were hashed straight off Archive and so
# never recorded a CDN webseed at all
r = {}
for cdn, arc in list(m.items()):
    r.setdefault(arc, cdn)
json.dump({'fwd': m, 'rev': r}, sys.stdout)
`;
  const out = execFileSync('python3', ['-c', py, db], { maxBuffer: 256 * 1024 * 1024 });
  const raw = JSON.parse(out.toString());
  const fwd = new Map(Object.entries(raw.fwd));
  const rev = new Map(Object.entries(raw.rev));
  console.log(`archive URLs from the database   ${fwd.size.toLocaleString()}`);
  return { fwd, rev };
}

function remagnet(magnet, seeds) {
  const base = magnet.split('&').filter((p) => !p.startsWith('ws=')).join('&');
  return base + seeds.map((s) => `&ws=${encodeURIComponent(s)}`).join('');
}

// ─── run ────────────────────────────────────────────────────────────────────
const masterPath = join(OUT_DIR, 'master-list.json');
const master = JSON.parse(readFileSync(masterPath, 'utf8'));
const entries = master.entries;
const { fwd: archiveOf, rev: cdnOf } = archiveByCdnUrl();

let changed = 0, already = 0, cdnOnly = 0, noTorrent = 0, noCatalog = 0, archiveOnly = 0;
const mismatch = [];
const writes = [];

for (const [id, entry] of Object.entries(entries)) {
  const p = join(OUT_DIR, 'torrents', shardOf(id), `${id}.torrent`);
  if (!existsSync(p)) { noTorrent++; continue; }

  const buf = readFileSync(p);
  const [t] = bdecode(buf);

  // What does this torrent point at today? Some were hashed straight off
  // Archive and carry no CDN webseed at all — for those, look the CDN copy up
  // by the Archive URL rather than reusing it as its own fallback, which would
  // list the same address twice and leave nothing to fall back TO.
  const current0 = (t['url-list'] || []).map(str);
  let cdn = current0.find((u) => u.includes('b-cdn.net')) || '';
  let arc = current0.find((u) => u.includes('archive.org')) || '';
  if (cdn && archiveOf.has(cdn)) arc = archiveOf.get(cdn);
  if (!cdn && arc && cdnOf.has(arc)) {
    // Only a real Bunny URL counts as a fallback. 186 rows hold an
    // http://archive.org link in the database's audio_url column — the field
    // meant for OUR copy — so this lookup can hand back Archive again. Listing
    // the same file twice over two schemes is not a fallback, it is noise.
    const maybe = cdnOf.get(arc);
    if (maybe && maybe.includes('b-cdn.net')) cdn = maybe;
  }
  if (!cdn && !arc) {
    const only = current0[0] || '';
    if (!only) { noCatalog++; continue; }
    cdn = only;
  }
  // Same rule applied to whatever was already in the torrent.
  if (cdn && !cdn.includes('b-cdn.net') && arc) cdn = '';
  const want = [...new Set([arc, cdn].filter(Boolean))];
  if (!arc) cdnOnly++;
  if (want.length === 1 && arc) archiveOnly++;

  const before = infoHashOf(t);
  if (before !== entry.info_hash) { mismatch.push(`${id}: on disk ${before}, master list ${entry.info_hash}`); continue; }

  const current = (t['url-list'] || []).map(str);
  if (current.length === want.length && current.every((u, i) => u === want[i])) { already++; continue; }

  t['url-list'] = want;
  const out = bencode(t);

  // The whole safety argument in one line: re-encode, re-hash, refuse on drift.
  const after = createHash('sha1').update(bencode(bdecode(out)[0].info)).digest('hex');
  if (after !== before) { mismatch.push(`${id}: info_hash would change ${before} -> ${after}`); continue; }

  writes.push([p, out]);
  entry.webseeds = want;
  if (entry.magnet) entry.magnet = remagnet(entry.magnet, want);
  changed++;
}

console.log(`master list entries      ${Object.keys(entries).length.toLocaleString()}`);
console.log(`to rewrite               ${changed.toLocaleString()}`);
console.log(`already archive-first    ${already.toLocaleString()}`);
console.log(`CDN only (not mirrored)  ${cdnOnly.toLocaleString()}`);
console.log(`Archive only (no CDN)    ${archiveOnly.toLocaleString()}`);
if (noTorrent) console.log(`no .torrent on disk      ${noTorrent.toLocaleString()}`);
if (noCatalog) console.log(`no usable webseed        ${noCatalog.toLocaleString()}`);
if (mismatch.length) {
  console.log(`\nSKIPPED — hash mismatch  ${mismatch.length}`);
  for (const m of mismatch.slice(0, 10)) console.log(`   ${m}`);
  if (mismatch.length > 10) console.log(`   ... and ${mismatch.length - 10} more`);
}

if (!APPLY) {
  console.log('\nDry run. Nothing written. Re-run with --apply.');
  process.exit(0);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);
writeFileSync(masterPath + `.bak-webseeds-${stamp}`, readFileSync(masterPath));
for (const [p, out] of writes) writeFileSync(p, out);
writeFileSync(masterPath, JSON.stringify(master, null, 2));
console.log(`\nwrote ${writes.length.toLocaleString()} torrents and master-list.json`);
console.log(`backup: master-list.json.bak-webseeds-${stamp}`);

// Drop ONLY the rewritten files from the uploader's resume log, so the next
// upload re-sends those and leaves the rest alone. Setting the whole log aside
// works too, but re-uploads all 33,085 to correct a handful.
const log = join(OUT_DIR, 'upload-log.json');
if (existsSync(log)) {
  try {
    const seen = JSON.parse(readFileSync(log, 'utf8'));
    writeFileSync(log + `.bak-webseeds-${stamp}`, JSON.stringify(seen));
    // The log is keyed by the path inside the remote torrents/ folder — but
    // 20,219 of those keys carry an UPPERCASE shard, because macOS is
    // case-insensitive and readdirSync reports whatever case the folder was
    // created with. Match on lowercase or the uppercase ones are silently
    // missed and their files stay stale on the CDN.
    const index = new Map(Object.keys(seen).map((k) => [k.toLowerCase(), k]));
    let dropped = 0;
    for (const [p] of writes) {
      const key = p.split(/[\\/]/).slice(-2).join('/').toLowerCase();
      const actual = index.get(key);
      if (actual !== undefined) { delete seen[actual]; dropped++; }
    }
    writeFileSync(log, JSON.stringify(seen));
    console.log(`upload-log.json: ${dropped.toLocaleString()} entries dropped, ` +
                `${Object.keys(seen).length.toLocaleString()} left alone`);
  } catch (e) {
    renameSync(log, log + `.bak-webseeds-${stamp}`);
    console.log('upload-log.json set aside (could not edit it in place)');
  }
}

try {
  const { signMasterList } = await import('./sign-master-list.mjs');
  signMasterList(OUT_DIR);
  console.log('master list re-signed');
} catch (e) {
  console.log(`\ncould not re-sign automatically (${String(e.message).slice(0, 80)})`);
  console.log('run:  node scripts/sign-master-list.mjs');
}
