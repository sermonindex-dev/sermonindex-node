#!/usr/bin/env node
/**
 * SermonIndex Auto-Update Publisher (multi-platform)
 * ==================================================
 * Pushes the Tauri auto-update to existing installs. It DISCOVERS every SIGNED
 * updater artifact under a build/bundle directory, uploads each to the Bunny
 * `/app/` folder, and writes ONE `latest.json` covering ALL platforms it found —
 * the file the app's updater endpoint points at:
 *
 *     https://sermonindex4.b-cdn.net/app/latest.json
 *     https://sermonindex4.b-cdn.net/app/<artifact files…>
 *
 * This is the piece deploy-installers.mjs deliberately does NOT do (that one only
 * uploads the .dmg/.exe/.AppImage/etc. for brand-new downloads). See UPDATER-SETUP.md.
 *
 * DISCOVERY: recursively finds every `*.sig` under --dir. For each, the artifact
 * is that same path minus `.sig`, and the `.sig` file's CONTENTS are the
 * signature. The Tauri updater platform key is inferred from the artifact's
 * path + filename:
 *
 *     aarch64 / arm64  + .app.tar.gz     → darwin-aarch64
 *     x86_64  / x64    + .app.tar.gz     → darwin-x86_64
 *     .nsis.zip / .msi.zip               → windows-x86_64
 *     .AppImage.tar.gz / .AppImage       → linux-x86_64
 *     (anything else is skipped)
 *
 * macOS updater tarballs are named just "<productName>.app.tar.gz" with NO arch
 * in the filename, so the arch is read from the enclosing path — e.g. the CI
 * artifact folder "SermonIndex-macOS-arm64" or the "aarch64-apple-darwin" target
 * dir. For a plain local single-arch build (no arch anywhere in the path) it
 * falls back to the host architecture this script runs on. The two mac tarballs
 * share the same arch-less basename, so when both are present they are uploaded
 * under app/<platform-key>/<name> to avoid clobbering each other; all other
 * artifacts keep their original (already-unique) filenames at app/<name>.
 *
 * Credentials (same storage zone as deploy-installers.mjs — the STORAGE ZONE
 * PASSWORD from Bunny → Storage → your zone → FTP & API Access):
 *     export BUNNY_STORAGE_ZONE=<storage zone name>
 *     export BUNNY_STORAGE_KEY=<storage zone password>
 *     # optional:
 *     export BUNNY_STORAGE_HOST=storage.bunnycdn.com
 *     export BUNNY_CDN_BASE=https://sermonindex4.b-cdn.net   # public pull-zone base
 *
 * Usage:
 *     # local mac build (default --dir is this Mac's bundle output):
 *     node scripts/publish-update.mjs --mode prompt --notes "What changed"
 *     # CI, pointed at the collected per-platform artifacts:
 *     node scripts/publish-update.mjs --version "$TAG" --dir dist-artifacts --mode prompt
 *     node scripts/publish-update.mjs --dry-run          # discover + show, upload nothing
 *
 *   --dir <path>       where to scan for *.sig updater artifacts
 *                        (default: src-tauri/target/release/bundle/)
 *   --version vX.Y.Z   override (default: read from package.json)
 *   --mode prompt|silent|force   how it reaches users (default: prompt).
 *                        "force" = BREAK-GLASS emergency lever: the update
 *                        auto-installs AND relaunches on every RUNNING node
 *                        (within ~6h of the next re-check), no user action.
 *                        Reserve it for critical/security pushes.
 *   --notes "..."      shown in the prompt card (default: version string)
 *   --public-base URL  public pull-zone base
 *                        (default: BUNNY_CDN_BASE or https://sermonindex4.b-cdn.net)
 *   --dry-run          discover + show, upload nothing
 *
 * After it runs, PURGE the printed /app/ URLs in the Bunny dashboard (or CDN
 * Cache tool) or clients keep seeing the cached old version.
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..');
const args = process.argv.slice(2);
const getArg = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const DRY = args.includes('--dry-run');

const ZONE = process.env.BUNNY_STORAGE_ZONE;
const KEY = process.env.BUNNY_STORAGE_KEY;
const HOST = process.env.BUNNY_STORAGE_HOST || 'storage.bunnycdn.com';

// Public CDN base (the PULL ZONE serving the storage zone). Override with
// --public-base or BUNNY_CDN_BASE (e.g. to re-publish on the legacy zone once
// during the endpoint migration — see UPDATER-SETUP.md).
function normalizeBase(b) {
  b = String(b || '').trim().replace(/\/+$/, '');
  if (!b) return 'https://sermonindex4.b-cdn.net';
  if (!/^https?:\/\//i.test(b)) b = `https://${b}`;
  return b;
}
const PUBLIC_BASE = normalizeBase(getArg('public-base', '') || process.env.BUNNY_CDN_BASE);

const version = String(getArg('version', '') || JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).version).replace(/^v/, '');
const mode = getArg('mode', 'prompt');
const notes = getArg('notes', `SermonIndex Node Software v${version}`);
const SCAN_DIR = getArg('dir', join(REPO, 'src-tauri', 'target', 'release', 'bundle'));

if (!/^\d+\.\d+\.\d+/.test(version)) { console.error(`Bad version "${version}". Pass --version x.y.z`); process.exit(1); }
if (mode !== 'prompt' && mode !== 'silent' && mode !== 'force') { console.error(`--mode must be "prompt", "silent", or "force"`); process.exit(1); }
if (!ZONE || !KEY) { console.error('Missing credentials. Set BUNNY_STORAGE_ZONE and BUNNY_STORAGE_KEY (storage-zone password).'); process.exit(1); }
if (!existsSync(SCAN_DIR)) { console.error(`Scan dir not found: ${SCAN_DIR}`); process.exit(1); }

// ── Discover *.sig updater artifacts ─────────────────────────────────────────
function walkSigs(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name.endsWith('.app')) continue; // don't descend into macOS .app bundles
      walkSigs(full, out);
    } else if (e.name.endsWith('.sig')) {
      out.push(full);
    }
  }
  return out;
}

// Map the host arch to a darwin key — used only as a fallback for a local mac
// build whose arch-less "<productName>.app.tar.gz" sits in a path with no arch.
const HOST_ARCH = process.arch === 'arm64' ? 'darwin-aarch64'
  : (process.arch === 'x64' ? 'darwin-x86_64' : null);

// Infer the Tauri updater platform key. `name` is the artifact basename; `rel`
// is its path relative to the scan dir (so the mac arch can be read from the
// enclosing folder when the tarball name itself carries none).
function inferPlatformKey(name, rel) {
  const n = name.toLowerCase();
  const r = rel.toLowerCase();
  if (n.endsWith('.app.tar.gz')) {
    if (/aarch64|arm64/.test(r)) return 'darwin-aarch64';
    if (/x86_64|x64/.test(r)) return 'darwin-x86_64';
    return HOST_ARCH; // plain local build: no arch in path → use host arch
  }
  if (n.endsWith('.nsis.zip') || n.endsWith('.msi.zip')) return 'windows-x86_64';
  if (n.endsWith('.appimage.tar.gz') || n.endsWith('.appimage')) return 'linux-x86_64';
  return null;
}

const KEY_LABEL = {
  'darwin-aarch64': 'macOS (Apple Silicon)',
  'darwin-x86_64': 'macOS (Intel)',
  'windows-x86_64': 'Windows',
  'linux-x86_64': 'Linux',
};
const ORDER = ['darwin-aarch64', 'darwin-x86_64', 'windows-x86_64', 'linux-x86_64'];

const sigFiles = walkSigs(SCAN_DIR).sort();
const chosen = new Map(); // key → { name, artifactPath, signature, remotePath }
const skipped = [];       // { name, reason }

for (const sigPath of sigFiles) {
  const artifactPath = sigPath.slice(0, -'.sig'.length);
  const name = basename(artifactPath);
  const rel = artifactPath.slice(SCAN_DIR.length); // includes the filename
  const key = inferPlatformKey(name, rel);
  if (!key) { skipped.push({ name, reason: 'not a recognized updater artifact' }); continue; }
  if (!existsSync(artifactPath)) { skipped.push({ name, reason: 'artifact file missing next to .sig' }); continue; }
  const signature = readFileSync(sigPath, 'utf8').trim();
  if (!signature) { skipped.push({ name, reason: 'empty .sig file' }); continue; }

  if (chosen.has(key)) {
    // Two artifacts map to one platform (e.g. Windows .nsis.zip + .msi.zip).
    // Prefer NSIS for Windows; otherwise keep the first and skip the rest.
    const prev = chosen.get(key);
    const incomingNsis = name.toLowerCase().endsWith('.nsis.zip');
    const prevNsis = prev.name.toLowerCase().endsWith('.nsis.zip');
    if (key === 'windows-x86_64' && incomingNsis && !prevNsis) {
      skipped.push({ name: prev.name, reason: `duplicate ${key} (superseded by ${name})` });
    } else {
      skipped.push({ name, reason: `duplicate ${key} (keeping ${prev.name})` });
      continue;
    }
  }
  chosen.set(key, { name, artifactPath, signature });
}

// Resolve remote paths, disambiguating basename collisions (the mac tarballs
// share the arch-less name "<productName>.app.tar.gz"). Colliding names go under
// app/<key>/<name>; unique names stay flat at app/<name>.
// IMPORTANT: strip spaces/odd chars from the remote key. A space in the object
// name ("SermonIndex Node Software.app.tar.gz") gets percent-encoded, and Bunny
// Storage PUT vs the pull zone resolve that encoding inconsistently → the public
// URL 404s and the updater's download fails. A space-free key resolves identically
// both ways. (The reliable older releases used a space-free "SermonIndex.app.tar.gz".)
const safeName = (s) => s.replace(/\s+/g, '-').replace(/[^A-Za-z0-9._-]/g, '');
const nameCounts = new Map();
for (const { name } of chosen.values()) nameCounts.set(name, (nameCounts.get(name) || 0) + 1);
for (const [key, a] of chosen) {
  const fname = safeName(a.name);
  a.remotePath = (nameCounts.get(a.name) > 1) ? `app/${key}/${fname}` : `app/${fname}`;
}

// Percent-encode each path segment (filenames contain spaces) while keeping the
// slashes as separators — so the PUT target and the public URL agree.
const encPath = (p) => p.split('/').map(encodeURIComponent).join('/');

// ── Bunny PUT ────────────────────────────────────────────────────────────────
async function put(remotePath, bytes, contentType = 'application/octet-stream') {
  const url = `https://${HOST}/${ZONE}/${encPath(remotePath)}`;
  if (DRY) { console.log(`[dry-run] PUT ${url} (${bytes.length} bytes)`); return; }
  const res = await fetch(url, { method: 'PUT', headers: { AccessKey: KEY, 'Content-Type': contentType }, body: bytes });
  if (res.status !== 201) {
    const body = await res.text().catch(() => '');
    throw new Error(`PUT ${remotePath} → HTTP ${res.status} ${body.slice(0, 200)}`);
  }
}

async function main() {
  const keys = [...chosen.keys()].sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));

  console.log(`Publishing auto-update  v${version}  (mode=${mode})`);
  console.log(`  scan dir: ${SCAN_DIR}`);
  console.log(`  target:   ${PUBLIC_BASE}/app/`);
  if (skipped.length) {
    console.log(`  skipped ${skipped.length} file(s):`);
    for (const s of skipped) console.log(`     · ${s.name} — ${s.reason}`);
  }

  if (keys.length === 0) {
    console.error(`\n⚠  No signed updater artifacts found under ${SCAN_DIR}.`);
    console.error(`   Build a SIGNED release first (see UPDATER-SETUP.md), or point --dir at the`);
    console.error(`   collected build artifacts. Nothing was published (latest.json left as-is).`);
    process.exit(1);
  }

  console.log(`  platforms (${keys.length}):`);
  for (const k of keys) {
    const a = chosen.get(k);
    console.log(`     · ${k.padEnd(15)} ${(KEY_LABEL[k] || '').padEnd(22)} ←  ${a.name} (${(statSync(a.artifactPath).size / 1e6).toFixed(1)} MB)`);
  }
  console.log('');

  // Upload each artifact and build the platforms map.
  const platforms = {};
  for (const k of keys) {
    const a = chosen.get(k);
    await put(a.remotePath, readFileSync(a.artifactPath));
    console.log(`  ✓ ${a.remotePath}`);
    platforms[k] = { signature: a.signature, url: `${PUBLIC_BASE}/${encPath(a.remotePath)}` };
  }

  const latest = { version, mode, notes, pub_date: new Date().toISOString(), platforms };
  if (DRY) { console.log('\n[dry-run] latest.json:\n' + JSON.stringify(latest, null, 2)); }
  await put('app/latest.json', Buffer.from(JSON.stringify(latest, null, 2)), 'application/json');
  console.log(`  ✓ app/latest.json`);

  // Self-purge the CDN so clients never hit a stale copy — CRITICALLY the tarball
  // URLs, not just latest.json (a cached 404 on the artifact is what fails a
  // download even when latest.json is fresh). Runs when BUNNY_API_KEY is set.
  const apiKey = process.env.BUNNY_API_KEY;
  if (apiKey && !DRY) {
    const toPurge = [`${PUBLIC_BASE}/app/latest.json`, ...keys.map((k) => platforms[k].url)];
    console.log('  purging CDN:');
    for (const u of toPurge) {
      try {
        const r = await fetch(`https://api.bunny.net/purge?url=${encodeURIComponent(u)}&async=false`, { method: 'POST', headers: { AccessKey: apiKey } });
        console.log(`     ${r.ok ? '✓' : '✗ HTTP ' + r.status} ${u}`);
      } catch (e) { console.log(`     ✗ ${u}: ${e.message}`); }
    }
  }

  console.log(`\nIncluded platforms: ${keys.join(', ')}`);
  console.log(`\n⚠  If BUNNY_API_KEY was not set, PURGE these manually or clients keep the old version:`);
  console.log(`     ${PUBLIC_BASE}/app/latest.json`);
  for (const k of keys) console.log(`     ${platforms[k].url}`);

  const missing = ORDER.filter((k) => !keys.includes(k));
  if (missing.length) {
    console.log(`\nNote: no artifact for ${missing.join(', ')} in this run — those platforms`);
    console.log(`won't auto-update until a signed build for them is included in --dir.`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
