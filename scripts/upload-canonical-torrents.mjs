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
// --verify: ignore the local log; HEAD every file's public URL and re-upload
// any that the CDN doesn't actually have. Slower but heals any drift.
const VERIFY = args.includes('--verify');
const PUBLIC_BASE = 'https://sermonindex1.b-cdn.net';
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

  // Walk shard subfolders (torrents/<xx>/<id>.torrent). Flat legacy files at
  // the root are rejected — regenerate with the current (sharded) generator.
  const files = []; // relative paths like "6H/6Hr0UUXmARn8H0bk.torrent"
  let legacyFlat = 0;
  for (const entry of readdirSync(torrentsDir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      for (const f of readdirSync(join(torrentsDir, entry.name))) {
        if (f.endsWith('.torrent')) files.push(`${entry.name}/${f}`);
      }
    } else if (entry.name.endsWith('.torrent')) {
      legacyFlat++;
    }
  }
  if (legacyFlat > 0) {
    console.error(`Found ${legacyFlat} un-sharded .torrent files at the root of ${torrentsDir}.`);
    console.error('These are from an old generator run — delete canonical-output/ and regenerate.');
    process.exit(1);
  }
  let queue;
  if (VERIFY) {
    console.log(`VERIFY mode: checking all ${files.length} public URLs against the CDN...`);
    const missing = [];
    let checked = 0, qi = 0;
    async function checker() {
      while (qi < files.length) {
        const f = files[qi++];
        try {
          const c = new AbortController();
          const t = setTimeout(() => c.abort(), 8000);
          const res = await fetch(`${PUBLIC_BASE}/${REMOTE_DIR}/${f}?verify=${Date.now()}`, { method: 'HEAD', signal: c.signal });
          clearTimeout(t);
          if (res.status === 200) uploaded[f] = uploaded[f] || Date.now();
          else missing.push(f);
        } catch {
          missing.push(f); // unreachable — treat as missing, re-upload is harmless
        }
        checked++;
        if (checked % 2000 === 0) console.log(`  verified ${checked}/${files.length} (${missing.length} missing so far)`);
      }
    }
    await Promise.all(Array.from({ length: 24 }, checker));
    for (const f of missing) delete uploaded[f];
    writeFileSync(logPath, JSON.stringify(uploaded, null, 1));
    console.log(`Verification done: ${files.length - missing.length} live, ${missing.length} missing → re-uploading those`);
    queue = missing;
  } else {
    queue = files.filter((f) => !uploaded[f]);
  }
  console.log(`Torrent files: ${files.length} total · confirmed: ${files.length - queue.length} · this run: ${queue.length}`);

  let done = 0, failed = 0;
  const persist = () => writeFileSync(logPath, JSON.stringify(uploaded, null, 1));

  async function worker() {
    while (queue.length > 0) {
      const f = queue.shift();
      try {
        const bytes = readFileSync(join(torrentsDir, f)); // f includes the shard folder
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

  // Master list is always (re)uploaded — it changes every generator run.
  // The detached signature goes up FIRST: verifying clients fail closed, so a
  // window where the .json is new but the .sig is stale/absent means nodes
  // reject the list. Uploading the signature first keeps that window shut.
  const masterPath = join(OUT_DIR, 'master-list.json');
  const sigPath = `${masterPath}.sig`;
  if (existsSync(masterPath)) {
    if (existsSync(sigPath)) {
      try {
        await put(`${REMOTE_DIR}/master-list.json.sig`, readFileSync(sigPath));
        console.log('master-list.json.sig uploaded ✓');
      } catch (e) {
        console.error(`[!] master-list.json.sig: ${e.message}`);
        failed++;
      }
    } else {
      console.warn('[!] No master-list.json.sig found — the app will REJECT this master list.');
      console.warn('    Sign it first: node scripts/sign-master-list.mjs');
    }
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
    console.log(`\nReminder: purge BOTH master-list.json and master-list.json.sig in the Bunny`);
    console.log(`dashboard so the CDN serves the fresh pair (a stale .sig fails verification).`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
