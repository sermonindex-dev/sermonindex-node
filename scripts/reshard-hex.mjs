#!/usr/bin/env node
/**
 * One-time migration #2: case-proof hex sharding.
 * ------------------------------------------------
 * WHY: Bunny Storage merges folder names case-insensitively on upload
 * ("pR/", "PR/", "Pr/" all become one folder) but serves URLs case-
 * sensitively — so ID-prefix shards with mixed case break on the CDN.
 * New scheme: first two hex chars of md5(sermonId) → 256 lowercase-hex
 * folders (00–ff), immune to case handling. No media re-hashing needed.
 *
 * This script, IN PLACE and in seconds:
 *   1. moves every local .torrent into its hex shard folder
 *   2. rewrites every torrent_url in master-list.json
 *   3. resets upload-log.json (remote paths changed)
 *
 * BEFORE re-uploading: delete the old `torrents` folder in the Bunny
 * dashboard (File Manager → torrents → delete). This removes the case-
 * merged ghost folders so the re-upload starts clean.
 *
 * Usage:
 *   node scripts/reshard-hex.mjs [--dry-run]
 * Then:
 *   node scripts/upload-canonical-torrents.mjs --concurrency 16
 *   (purge the pull zone afterwards)
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, renameSync, rmSync, rmdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const getArg = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const OUT_DIR = getArg('out', join(__dirname, '..', 'canonical-output'));

const TORRENT_PUBLIC_BASE = 'https://sermonindex1.b-cdn.net/torrents';

// MUST match generate-canonical-torrents.mjs
const shardOf = (id) => createHash('md5').update(id).digest('hex').slice(0, 2);

const torrentsDir = join(OUT_DIR, 'torrents');
const masterPath = join(OUT_DIR, 'master-list.json');
if (!existsSync(masterPath)) { console.error(`No master list at ${masterPath}`); process.exit(1); }
const master = JSON.parse(readFileSync(masterPath, 'utf8'));

// 1. Move every .torrent (from old case-shards or flat) into hex shards
let moved = 0, already = 0;
const oldDirs = [];
for (const entry of readdirSync(torrentsDir, { withFileTypes: true })) {
  const files = entry.isDirectory()
    ? readdirSync(join(torrentsDir, entry.name)).map((f) => join(entry.name, f))
    : entry.name.endsWith('.torrent') ? [entry.name] : [];
  if (entry.isDirectory()) oldDirs.push(entry.name);
  for (const rel of files) {
    if (!rel.endsWith('.torrent')) continue;
    const id = rel.split('/').pop().replace(/\.torrent$/, '');
    const hex = shardOf(id);
    const dest = join(torrentsDir, hex, `${id}.torrent`);
    const src = join(torrentsDir, rel);
    if (src === dest) { already++; continue; }
    if (!DRY) {
      mkdirSync(join(torrentsDir, hex), { recursive: true });
      renameSync(src, dest);
    }
    moved++;
    if (moved % 5000 === 0) console.log(`  ${moved} moved...`);
  }
}
console.log(`${DRY ? '[dry-run] would move' : 'Moved'} ${moved} files into hex shards (${already} already in place)`);

// Remove now-empty old shard folders
if (!DRY) {
  let cleaned = 0;
  for (const d of oldDirs) {
    try { rmdirSync(join(torrentsDir, d)); cleaned++; } catch { /* not empty (it's a hex shard) — keep */ }
  }
  console.log(`Removed ${cleaned} empty old shard folders`);
}

// 2. Rewrite torrent_url everywhere
let rewritten = 0;
for (const [id, e] of Object.entries(master.entries)) {
  const want = `${TORRENT_PUBLIC_BASE}/${shardOf(id)}/${id}.torrent`;
  if (e.torrent_url !== want) { if (!DRY) e.torrent_url = want; rewritten++; }
}
console.log(`${DRY ? '[dry-run] would rewrite' : 'Rewrote'} ${rewritten} torrent_url fields`);

// 3. Reset upload log
const logPath = join(OUT_DIR, 'upload-log.json');
if (existsSync(logPath)) { if (!DRY) rmSync(logPath); console.log(`${DRY ? '[dry-run] would reset' : 'Reset'} upload-log.json`); }

if (!DRY) {
  writeFileSync(masterPath, JSON.stringify(master, null, 1));
  console.log(`\nDone — ${Object.keys(master.entries).length} entries on hex shards.`);
  console.log('NEXT:');
  console.log('  1. Bunny dashboard → File Manager → DELETE the old `torrents` folder');
  console.log('  2. node scripts/upload-canonical-torrents.mjs --concurrency 16');
  console.log('  3. Purge the pull zone cache');
} else {
  console.log('\nDry run only — nothing changed.');
}
