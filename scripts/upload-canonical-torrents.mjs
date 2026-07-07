#!/usr/bin/env node
/**
 * SermonIndex Canonical Torrent Uploader
 * ======================================
 * Uploads the output of generate-canonical-torrents.mjs to Bunny Storage,
 * so it's served by the pull zone at https://sermonindex1.b-cdn.net/torrents/.
 *
 * IMPORTANT: this uploads to the STORAGE ZONE that backs the sermonindex1
 * pull zone. The AccessKey is the storage zone's password (Bunny dashboard →
 * Storage → your zone → FTP & API Access → Password), NOT your account API key.
 *
 * Usage:
 *   export BUNNY_STORAGE_ZONE=<storage zone name>
 *   export BUNNY_STORAGE_KEY=<storage zone password>
 *   # optional (if your zone is not in the default region, e.g. la.storage.bunnycdn.com):
 *   export BUNNY_STORAGE_HOST=storage.bunnycdn.com
 *
 *   node scripts/upload-canonical-torrents.mjs                # upload everything new
 *   node scripts/upload-canonical-torrents.mjs --dry-run      # show what would upload
 *   node scripts/upload-canonical-torrents.mjs --force-master # re-upload master-list.json
 *
 * Resumable: keeps upload-log.json inside the output folder and skips files
 * already uploaded. master-list.json is ALWAYS re-uploaded at the end (it
 * changes every generator run).
 *
 * After uploading a new master-list.json, purge it in the Bunny dashboard
 * (Pull zone → Purge) or the CDN may cache the old one for a while.
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const getArg = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const DRY_RUN = args.includes('--dry-run');
const OUT_DIR = getArg('out', join(__dirname, '..', 'canonical-output'));
const REMOTE_DIR = getArg('remote-dir', 'torrents'); // path inside the storage zone
const CONCURRENCY = Math.max(1, parseInt(getArg('concurrency', '8'), 10));

const ZONE = process.env.BUNNY_STORAGE_ZONE;
const KEY = process.env.BUNNY_STORAGE_KEY;
const HOST = process.env.BUNNY_STORAGE_HOST || 'storage.bunnycdn.com';

if (!ZONE || !KEY) {
  console.error('Missing credentials. Set BUNNY_STORAGE_ZONE and BUNNY_STORAGE_KEY (see header of this file).');
  process.exit(1);
}

const logPath = join(OUT_DIR, 'upload-log.json');
let uploaded = {};
if (existsSync(logPath)) uploaded = JSON.parse(readFileSync(logPath, 'utf8'));

async function put(remotePath, bytes) {
  const url = `https://${HOST}/${ZONE}/${remotePath}`;
  if (DRY_RUN) {
    console.log(`[dry-run] PUT ${url} (${bytes.length} bytes)`);
    return;
  }
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      AccessKey: KEY,
      'Content-Type': 'application/octet-stream',
    },
    body: bytes,
  });
  if (res.status !== 201) {
    const body = await res.text().catch(() => '');
    throw new Error(`PUT ${remotePath} → HTTP ${res.status} ${body.slice(0, 200)}`);
  }
}

async function main() {
  const torrentsDir = join(OUT_DIR, 'torrents');
  if (!existsSync(torrentsDir)) {
    console.error(`No output at ${torrentsDir} — run generate-canonical-torrents.mjs first.`);
    process.exit(1);
  }

  const files = readdirSync(torrentsDir).filter((f) => f.endsWith('.torrent'));
  const queue = files.filter((f) => !uploaded[f]);
  console.log(`Torrent files: ${files.length} total · already uploaded: ${files.length - queue.length} · this run: ${queue.length}`);

  let done = 0, failed = 0;
  const persist = () => writeFileSync(logPath, JSON.stringify(uploaded, null, 1));

  async function worker() {
    while (queue.length > 0) {
      const f = queue.shift();
      try {
        const bytes = readFileSync(join(torrentsDir, f));
        await put(`${REMOTE_DIR}/${f}`, bytes);
        uploaded[f] = Date.now();
        done++;
        if (done % 50 === 0) {
          persist();
          console.log(`  ${done}/${done + queue.length} uploaded...`);
        }
      } catch (e) {
        failed++;
        console.error(`[!] ${f}: ${e.message}`);
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  persist();

  // Master list is always (re)uploaded — it changes every generator run
  const masterPath = join(OUT_DIR, 'master-list.json');
  if (existsSync(masterPath)) {
    try {
      await put(`${REMOTE_DIR}/master-list.json`, readFileSync(masterPath));
      console.log('master-list.json uploaded ✓');
    } catch (e) {
      console.error(`[!] master-list.json: ${e.message}`);
      failed++;
    }
  }

  console.log(`\nDone: ${done} torrents uploaded, ${failed} failed.`);
  console.log(`Public URLs: https://sermonindex1.b-cdn.net/${REMOTE_DIR}/<id>.torrent`);
  console.log(`Master list: https://sermonindex1.b-cdn.net/${REMOTE_DIR}/master-list.json`);
  if (!DRY_RUN) {
    console.log(`\nReminder: purge master-list.json in the Bunny dashboard so the CDN serves the fresh copy.`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
