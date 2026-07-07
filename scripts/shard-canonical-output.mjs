#!/usr/bin/env node
/**
 * One-time migration: shard an existing (flat) canonical-output folder.
 * ---------------------------------------------------------------------
 * If you ran the FULL generator before the 2-char sharding change, your
 * 33k .torrent files sit flat in canonical-output/torrents/ and the
 * master list's torrent_url fields have no shard folder. This script
 * fixes both IN PLACE in seconds — no re-downloading, no re-hashing
 * (the fingerprints/infohashes are untouched and stay valid).
 *
 * It also:
 *  - drops any early-format entries that listed MULTIPLE webseeds
 *    (from the first --limit test runs) so the generator re-makes them
 *  - resets upload-log.json (upload paths changed)
 *
 * Usage:
 *   node scripts/shard-canonical-output.mjs
 *   node scripts/shard-canonical-output.mjs --dry-run
 *
 * Afterwards:
 *   node scripts/generate-canonical-torrents.mjs   # re-does dropped/failed only (fast)
 *   node scripts/upload-canonical-torrents.mjs     # uploads everything sharded
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const getArg = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const OUT_DIR = getArg('out', join(__dirname, '..', 'canonical-output'));

const TORRENT_PUBLIC_BASE = 'https://sermonindex1.b-cdn.net/torrents';

// MUST match generate-canonical-torrents.mjs exactly
function shardOf(id) {
  const clean = (c) => (/^[a-zA-Z0-9]$/.test(c || '') ? c : '_');
  return clean(id[0]) + clean(id[1]);
}

const torrentsDir = join(OUT_DIR, 'torrents');
const masterPath = join(OUT_DIR, 'master-list.json');
if (!existsSync(masterPath)) {
  console.error(`No master list at ${masterPath}`);
  process.exit(1);
}

const master = JSON.parse(readFileSync(masterPath, 'utf8'));
const ids = Object.keys(master.entries);
console.log(`Master list: ${ids.length} entries`);

// 1. Drop early-format entries (multiple webseeds → from pre-fix test runs)
let dropped = 0;
for (const id of ids) {
  const e = master.entries[id];
  if (Array.isArray(e.webseeds) && e.webseeds.length > 1) {
    dropped++;
    if (!DRY) {
      delete master.entries[id];
      for (const p of [join(torrentsDir, `${id}.torrent`), join(torrentsDir, shardOf(id), `${id}.torrent`)]) {
        if (existsSync(p)) rmSync(p);
      }
    }
  }
}
console.log(`${DRY ? '[dry-run] would drop' : 'Dropped'} ${dropped} early-format entries (generator will redo them)`);

// 2. Move flat .torrent files into shard folders
const flat = readdirSync(torrentsDir, { withFileTypes: true })
  .filter((d) => d.isFile() && d.name.endsWith('.torrent'))
  .map((d) => d.name);
let moved = 0;
for (const f of flat) {
  const id = f.replace(/\.torrent$/, '');
  const shard = shardOf(id);
  if (!DRY) {
    mkdirSync(join(torrentsDir, shard), { recursive: true });
    renameSync(join(torrentsDir, f), join(torrentsDir, shard, f));
  }
  moved++;
  if (moved % 5000 === 0) console.log(`  ${moved}/${flat.length} moved...`);
}
console.log(`${DRY ? '[dry-run] would move' : 'Moved'} ${moved} flat .torrent files into shard folders`);

// 3. Rewrite torrent_url for every remaining entry
let rewritten = 0;
for (const [id, e] of Object.entries(master.entries)) {
  const want = `${TORRENT_PUBLIC_BASE}/${shardOf(id)}/${id}.torrent`;
  if (e.torrent_url !== want) {
    if (!DRY) e.torrent_url = want;
    rewritten++;
  }
}
console.log(`${DRY ? '[dry-run] would rewrite' : 'Rewrote'} ${rewritten} torrent_url fields`);

// 4. Reset the upload log — remote paths changed
const logPath = join(OUT_DIR, 'upload-log.json');
if (existsSync(logPath)) {
  if (!DRY) rmSync(logPath);
  console.log(`${DRY ? '[dry-run] would reset' : 'Reset'} upload-log.json (paths changed — everything re-uploads to sharded paths)`);
}

if (!DRY) {
  writeFileSync(masterPath, JSON.stringify(master, null, 1));
  console.log(`\nDone. ${Object.keys(master.entries).length} entries, sharded.`);
  console.log('Next:');
  console.log('  node scripts/generate-canonical-torrents.mjs   # redo dropped + retry failed (fast)');
  console.log('  node scripts/upload-canonical-torrents.mjs     # upload');
} else {
  console.log('\nDry run only — nothing changed.');
}
