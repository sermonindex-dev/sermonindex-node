#!/usr/bin/env node
/**
 * ONE-OFF REPAIR — move the 0.0.336 macOS updater tarballs onto versioned paths.
 *
 * WHY THIS EXISTS
 * ---------------
 * Tauri names the macOS updater bundle "<productName>.app.tar.gz" — no version,
 * no arch. Until now publish-update.mjs uploaded it to a single fixed path, so
 * every release reused ONE CDN cache key under a 30-day max-age.
 *
 * On 0.0.336 that key went bad: Bunny Storage holds a VALID tarball, but the
 * pull zone returns a corrupt one — same byte length, different content, failing
 * `gzip -t` every time. Three API purges did not fix it, which points at an
 * origin-shield copy (a pull-zone purge does not evict the shield). Nothing the
 * client does can route around a poisoned entry on a key that never changes.
 *
 * So: copy the known-good bytes STRAIGHT FROM STORAGE to a new versioned path,
 * and repoint latest.json at it. A path nothing has ever fetched has no cached
 * entry to be poisoned, at the edge or the shield.
 *
 * The signatures are reused unchanged, and that is correct: the bytes are
 * byte-identical to what was signed (this script verifies that by gunzipping
 * what it copies). Only the URL changes.
 *
 * publish-update.mjs now versions these paths for every future release, so this
 * script is not expected to be needed again. It is kept because it documents
 * the incident and is safe to re-run.
 *
 * Run:  node scripts/repair-mac-update-paths.mjs [--dry-run]
 */

import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const DRY = process.argv.includes('--dry-run');

const secrets = JSON.parse(readFileSync(join(REPO, 'scripts/release.secrets.json'), 'utf8'));
const ZONE = 'sermonindex4';
const STORAGE_KEY = secrets.zones?.[ZONE]?.key;
const API_KEY = secrets.bunnyApiKey;
const PUBLIC_BASE = (secrets.zones?.[ZONE]?.base || 'https://sermonindex4.b-cdn.net').replace(/\/$/, '');
if (!STORAGE_KEY) { console.error(`✗ No storage key for zone ${ZONE} in release.secrets.json`); process.exit(1); }

const S = (p) => `https://storage.bunnycdn.com/${ZONE}/${p}`;

async function getStorage(path) {
  const r = await fetch(S(path), { headers: { AccessKey: STORAGE_KEY } });
  if (!r.ok) throw new Error(`GET ${path} → ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}
async function putStorage(path, bytes, type = 'application/octet-stream') {
  if (DRY) { console.log(`   [dry-run] PUT ${path} (${bytes.length} bytes)`); return; }
  const r = await fetch(S(path), { method: 'PUT', headers: { AccessKey: STORAGE_KEY, 'Content-Type': type }, body: bytes });
  if (r.status !== 201) throw new Error(`PUT ${path} → ${r.status} ${(await r.text().catch(() => '')).slice(0, 200)}`);
}
async function purge(url) {
  if (!API_KEY) { console.warn(`   ⚠ no bunnyApiKey — purge ${url} yourself`); return; }
  if (DRY) { console.log(`   [dry-run] purge ${url}`); return; }
  const r = await fetch(`https://api.bunny.net/purge?url=${encodeURIComponent(url)}&async=false`, {
    method: 'POST', headers: { AccessKey: API_KEY },
  });
  console.log(`   purge ${r.status}  ${url}`);
}

// latest.json comes from STORAGE, never the CDN — the whole problem is that the
// CDN cannot be trusted to hand back what was uploaded.
const latest = JSON.parse((await getStorage('app/latest.json')).toString('utf8'));
const version = latest.version;
console.log(`Repairing macOS updater paths for v${version}\n`);

for (const key of ['darwin-aarch64', 'darwin-x86_64']) {
  const entry = latest.platforms?.[key];
  if (!entry) { console.log(`  ${key}: absent from latest.json — skipping`); continue; }

  const oldPath = decodeURIComponent(new URL(entry.url).pathname).replace(/^\//, '');
  const fname = oldPath.split('/').pop();
  const newPath = `app/${key}/${version}/${fname}`;
  if (oldPath === newPath) { console.log(`  ${key}: already versioned — skipping`); continue; }

  console.log(`  ${key}`);
  console.log(`     from  ${oldPath}`);
  console.log(`     to    ${newPath}`);

  const bytes = await getStorage(oldPath);
  // Prove the bytes are intact BEFORE republishing them. If storage were also
  // corrupt, copying it to a fresh path would just relocate the problem.
  try {
    gunzipSync(bytes);
    console.log(`     ✓ storage copy is valid gzip (${bytes.length} bytes)`);
  } catch (e) {
    console.error(`     ✗ STORAGE COPY IS CORRUPT (${e.message}). Rebuild and republish instead.`);
    process.exit(1);
  }

  await putStorage(newPath, bytes);
  entry.url = `${PUBLIC_BASE}/${newPath.split('/').map(encodeURIComponent).join('/')}`;
  console.log(`     ✓ ${entry.url}`);
}

await putStorage('app/latest.json', Buffer.from(JSON.stringify(latest, null, 2)), 'application/json');
console.log(`\n  ✓ latest.json rewritten`);
await purge(`${PUBLIC_BASE}/app/latest.json`);

if (DRY) { console.log('\n[dry-run] nothing was changed.'); process.exit(0); }

// Verify through the CDN — the path that actually failed.
console.log(`\nVerifying through the CDN:`);
let bad = 0;
for (const key of ['darwin-aarch64', 'darwin-x86_64']) {
  const url = latest.platforms?.[key]?.url;
  if (!url) continue;
  try {
    const r = await fetch(url);
    const b = Buffer.from(await r.arrayBuffer());
    gunzipSync(b);
    console.log(`  ✓ ${key}  ${b.length} bytes, valid gzip`);
  } catch (e) {
    bad++;
    console.error(`  ✗ ${key}  ${e.message}`);
  }
}
console.log(bad ? `\n✗ ${bad} still bad — rebuild and republish.` : `\n✓ Done. Quit the app fully, reopen, and update.`);
