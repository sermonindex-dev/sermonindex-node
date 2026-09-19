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

// Credentials: the environment wins, and release.secrets.json is the fallback
// — the same file release.mjs and the console already read, so there is no
// second copy of a key anywhere and no long shell incantation to remember.
// Worth having because this script exits on a missing key AFTER the generator
// has spent hours hashing, which is the worst possible moment to find out.
function fromSecrets() {
  try {
    const p = join(__dirname, 'release.secrets.json');
    if (!existsSync(p)) return {};
    const d = JSON.parse(readFileSync(p, 'utf8'));
    const zones = d.zones || {};
    const name = process.env.BUNNY_STORAGE_ZONE || 'sermonindex1';
    const z = zones[name] || {};
    return { zone: z.key ? name : null, key: z.key || null };
  } catch (e) {
    console.warn(`[!] could not read release.secrets.json: ${e.message}`);
    return {};
  }
}

const secrets = (process.env.BUNNY_STORAGE_ZONE && process.env.BUNNY_STORAGE_KEY)
  ? {} : fromSecrets();
const ZONE = process.env.BUNNY_STORAGE_ZONE || secrets.zone;
const KEY = process.env.BUNNY_STORAGE_KEY || secrets.key;
const HOST = process.env.BUNNY_STORAGE_HOST || 'storage.bunnycdn.com';

if (!ZONE || !KEY) {
  console.error('Missing credentials. Either export BUNNY_STORAGE_ZONE and');
  console.error('BUNNY_STORAGE_KEY, or put the key in scripts/release.secrets.json');
  console.error('under zones.<zone>.key (see the header of this file).');
  process.exit(1);
}
console.log(`Zone: ${ZONE} (key from ${process.env.BUNNY_STORAGE_KEY ? 'the environment' : 'release.secrets.json'})`);

const logPath = join(OUT_DIR, 'upload-log.json');
let uploaded = {};
if (existsSync(logPath)) uploaded = JSON.parse(readFileSync(logPath, 'utf8'));

// Bunny serves URLs case-sensitively, and the desktop app asks for the shard in
// LOWERCASE (md5(sermonId).slice(0,2) is lowercase hex). But macOS is
// case-insensitive AND case-preserving: when reshard-hex.mjs created "0a" it
// matched the pre-existing "0A" folder from the old ID-prefix scheme and kept
// the UPPERCASE name. readdirSync then reports "0A", and we used to upload to
// torrents/0A/... — so every shard containing a letter (156 of 256, ~61% of the
// library) 404'd for the app, which then re-hashed the whole media file instead.
// Normalise the shard on the way out so the remote path is always lowercase,
// whatever the local filesystem calls the folder.
const toRemote = (f) => {
  const i = f.indexOf('/');
  return i < 0 ? f : f.slice(0, i).toLowerCase() + f.slice(i);
};

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
          const res = await fetch(`${PUBLIC_BASE}/${REMOTE_DIR}/${toRemote(f)}?verify=${Date.now()}`, { method: 'HEAD', signal: c.signal });
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
  // Remote paths this run PUT, so the end of the run can prove they are
  // reachable. On 13 Sep 2026 the console inherited BUNNY_STORAGE_ZONE for a
  // different zone: 6,850 PUTs answered 201, the log recorded success, and
  // nothing was published. Checking the files THIS run sent is proportional —
  // one sermon costs one HEAD — and would have caught that immediately.
  const sent = [];
  // A dry run must leave no trace. It used to write the log anyway: put()
  // returned early, then the worker recorded uploaded[f] and persist() saved
  // it — so after a --dry-run the script believed the file was published, and
  // the REAL run skipped it. The master list would then advertise a
  // torrent_url that 404s, which is the quietest possible way to break a
  // torrent. Nothing is written unless something was actually uploaded.
  const persist = () => {
    if (DRY_RUN) return;
    writeFileSync(logPath, JSON.stringify(uploaded, null, 1));
  };

  async function worker() {
    while (queue.length > 0) {
      const f = queue.shift();
      try {
        const bytes = readFileSync(join(torrentsDir, f)); // f includes the shard folder
        await put(`${REMOTE_DIR}/${toRemote(f)}`, bytes);
        if (!DRY_RUN) { uploaded[f] = Date.now(); sent.push(toRemote(f)); }
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
        console.log(`master-list.json.sig ${DRY_RUN ? 'would be uploaded' : 'uploaded ✓'}`);
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
      console.log(`master-list.json ${DRY_RUN ? 'would be uploaded' : 'uploaded ✓'}`);
    } catch (e) {
      console.error(`[!] master-list.json: ${e.message}`);
      failed++;
    }
  }

  // Prove the bytes are reachable on the public zone before saying "uploaded".
  // A freshly written path was never cached, so the edge misses and asks the
  // origin — no purge needed for this to be truthful.
  let unreachable = [];
  if (!DRY_RUN && sent.length > 0) {
    console.log(`\nChecking all ${sent.length} file(s) this run sent are live on ${PUBLIC_BASE}...`);
    let qi = 0;
    async function prover() {
      while (qi < sent.length) {
        const rp = sent[qi++];
        try {
          const c = new AbortController();
          const t = setTimeout(() => c.abort(), 15000);
          const res = await fetch(`${PUBLIC_BASE}/${REMOTE_DIR}/${rp}?prove=${Date.now()}`,
                                  { method: 'HEAD', signal: c.signal });
          clearTimeout(t);
          if (res.status !== 200) unreachable.push(`${rp} -> HTTP ${res.status}`);
        } catch (e) {
          unreachable.push(`${rp} -> ${e.name}`);
        }
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, prover));
    if (unreachable.length === 0) {
      console.log(`  all ${sent.length} reachable \u2713`);
    } else {
      console.error(`\n[!] ${unreachable.length} of ${sent.length} file(s) answered 201 on upload but are NOT on ${PUBLIC_BASE}:`);
      for (const u of unreachable.slice(0, 10)) console.error(`      ${u}`);
      if (unreachable.length > 10) console.error(`      ... and ${unreachable.length - 10} more`);
      console.error('    The PUTs went somewhere this pull zone does not read.');
      console.error('    Check the "Zone:" line at the top of this step.');
    }
  }

  console.log(`\nDone: ${done} torrents ${DRY_RUN ? 'would be uploaded' : 'uploaded'}, ${failed} failed.`);
  if (DRY_RUN) console.log('(dry run — nothing was uploaded and the log was not touched)');
  console.log(`Public URLs: https://sermonindex1.b-cdn.net/${REMOTE_DIR}/<id>.torrent`);
  console.log(`Master list: https://sermonindex1.b-cdn.net/${REMOTE_DIR}/master-list.json`);
  if (!DRY_RUN) {
    console.log(`\nReminder: purge BOTH master-list.json and master-list.json.sig in the Bunny`);
    console.log(`dashboard so the CDN serves the fresh pair (a stale .sig fails verification).`);
  }
  if (failed > 0 || unreachable.length > 0) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exit(1); });
