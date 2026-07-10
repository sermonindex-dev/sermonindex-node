#!/usr/bin/env node
/**
 * SermonIndex Installer Deployer
 * ==============================
 * Uploads built desktop installers to Bunny Storage, one folder per version, so
 * each release is served publicly at:
 *
 *     https://sermonindex1.b-cdn.net/app/releases/<version>/
 *
 * It also writes a small manifest.json and a branded index.html download page in
 * that folder, and keeps a top-level releases.json listing every version.
 *
 * Credentials (same storage zone that backs the sermonindex1 pull zone — the
 * AccessKey is the STORAGE ZONE PASSWORD from Bunny → Storage → your zone →
 * FTP & API Access, NOT your account API key):
 *
 *     export BUNNY_STORAGE_ZONE=<storage zone name>
 *     export BUNNY_STORAGE_KEY=<storage zone password>
 *     # optional, only if your zone is not in the default region:
 *     export BUNNY_STORAGE_HOST=storage.bunnycdn.com
 *
 * Usage:
 *     # after a local mac build (uploads whatever installers exist locally):
 *     node scripts/deploy-installers.mjs --version v0.0.322 --dir src-tauri/target
 *
 *     # in CI, pointed at the downloaded build artifacts:
 *     node scripts/deploy-installers.mjs --version "$TAG" --dir dist-artifacts
 *
 *     # if --version is omitted it is read from package.json (prefixed with "v")
 *     node scripts/deploy-installers.mjs --dir src-tauri/target
 *
 *     --dry-run   show what would upload, change nothing
 *     --no-index  skip updating the global releases.json index
 *
 * Only real installer files are uploaded (.dmg .msi .exe .AppImage .deb .rpm) —
 * their names already encode the architecture so nothing collides. Updater
 * artifacts (.tar.gz/.sig) are NOT touched here; those belong to the auto-updater
 * (latest.json) flow — see UPDATER-SETUP.md.
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, join, basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..');

const args = process.argv.slice(2);
const getArg = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const DRY_RUN = args.includes('--dry-run');
const NO_INDEX = args.includes('--no-index');

const PUBLIC_BASE = 'https://sermonindex1.b-cdn.net';
const REMOTE_ROOT = getArg('remote-root', 'app/releases'); // path inside the storage zone
const SCAN_DIR = getArg('dir', join(REPO, 'src-tauri', 'target'));

const ZONE = process.env.BUNNY_STORAGE_ZONE;
const KEY = process.env.BUNNY_STORAGE_KEY;
const HOST = process.env.BUNNY_STORAGE_HOST || 'storage.bunnycdn.com';

// ── Version ────────────────────────────────────────────────────────────────
function normalizeVersion(v) {
  if (!v) return null;
  v = String(v).trim();
  if (v.startsWith('refs/tags/')) v = v.slice('refs/tags/'.length);
  return v.startsWith('v') ? v : `v${v}`;
}
let VERSION = normalizeVersion(getArg('version', null));
if (!VERSION) {
  try {
    VERSION = normalizeVersion(JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).version);
  } catch { /* ignore */ }
}

if (!VERSION) { console.error('Could not determine version. Pass --version vX.Y.Z'); process.exit(1); }
if (!ZONE || !KEY) {
  console.error('Missing credentials. Set BUNNY_STORAGE_ZONE and BUNNY_STORAGE_KEY (see header of this file).');
  process.exit(1);
}

// ── Find installer files ─────────────────────────────────────────────────────
const INSTALLER_EXTS = new Set(['.dmg', '.msi', '.exe', '.appimage', '.deb', '.rpm']);

function walk(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      // Skip .app bundles (macOS app directories) — we ship the .dmg, not the raw .app
      if (e.name.endsWith('.app')) continue;
      walk(full, out);
    } else if (INSTALLER_EXTS.has(extname(e.name).toLowerCase())) {
      out.push(full);
    }
  }
  return out;
}

function platformOf(name) {
  const n = name.toLowerCase();
  if (n.endsWith('.dmg')) {
    if (n.includes('aarch64') || n.includes('arm64')) return { os: 'macOS', label: 'macOS — Apple Silicon (M1–M4)', order: 1 };
    return { os: 'macOS', label: 'macOS — Intel', order: 2 };
  }
  if (n.endsWith('.exe') || n.endsWith('.msi')) return { os: 'Windows', label: 'Windows', order: 3 };
  if (n.endsWith('.appimage')) return { os: 'Linux', label: 'Linux — AppImage (portable)', order: 4 };
  if (n.endsWith('.deb')) return { os: 'Linux', label: 'Linux — Debian/Ubuntu (.deb)', order: 5 };
  if (n.endsWith('.rpm')) return { os: 'Linux', label: 'Linux — Fedora/RHEL (.rpm)', order: 6 };
  return { os: 'Other', label: 'Other', order: 9 };
}

function humanSize(bytes) {
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0, n = bytes;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}

// ── Bunny PUT ────────────────────────────────────────────────────────────────
async function put(remotePath, bytes, contentType = 'application/octet-stream') {
  const url = `https://${HOST}/${ZONE}/${remotePath}`;
  if (DRY_RUN) { console.log(`[dry-run] PUT ${url} (${bytes.length} bytes)`); return; }
  const res = await fetch(url, {
    method: 'PUT',
    headers: { AccessKey: KEY, 'Content-Type': contentType },
    body: bytes,
  });
  if (res.status !== 201) {
    const body = await res.text().catch(() => '');
    throw new Error(`PUT ${remotePath} → HTTP ${res.status} ${body.slice(0, 200)}`);
  }
}

async function getJson(remotePath) {
  // Read an existing file back from the CDN (used to merge releases.json)
  try {
    const res = await fetch(`${PUBLIC_BASE}/${remotePath}?t=${Date.now()}`, { method: 'GET' });
    if (res.status === 200) return await res.json();
  } catch { /* ignore */ }
  return null;
}

// ── index.html download page ─────────────────────────────────────────────────
function buildIndexHtml(version, files) {
  const rows = files.slice().sort((a, b) => a.order - b.order).map((f) => `
      <a class="dl" href="./${encodeURIComponent(f.name)}">
        <span class="plat">${f.label}</span>
        <span class="meta">${f.name} · ${f.size}</span>
        <span class="btn">Download</span>
      </a>`).join('');
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>SermonIndex Node Software ${version}</title>
<style>
  :root { --olive:#5b6236; --olive2:#464b29; --gold:#b8912e; --ink:#2b2b26; --bg:#f4f1e9; --card:#fff; --muted:#7a7768; --border:#e2ddce; }
  * { box-sizing: border-box; }
  body { margin:0; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; background:var(--bg); color:var(--ink); }
  .wrap { max-width:680px; margin:0 auto; padding:48px 20px 64px; }
  .head { text-align:center; margin-bottom:32px; }
  .head h1 { margin:0 0 4px; font-size:1.5rem; color:var(--olive2); }
  .head .ver { color:var(--gold); font-weight:700; }
  .head p { color:var(--muted); font-size:.92rem; margin:8px 0 0; }
  .dl { display:flex; align-items:center; gap:14px; background:var(--card); border:1px solid var(--border); border-radius:12px; padding:16px 18px; margin-bottom:12px; text-decoration:none; color:inherit; transition:border-color .15s, transform .05s; }
  .dl:hover { border-color:var(--gold); }
  .dl:active { transform:translateY(1px); }
  .plat { font-weight:700; font-size:.98rem; flex:0 0 auto; }
  .meta { color:var(--muted); font-size:.78rem; flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .btn { background:var(--olive); color:#fff; border-radius:8px; padding:8px 16px; font-size:.82rem; font-weight:700; flex:0 0 auto; }
  .note { margin-top:28px; background:#fff8e6; border:1px solid #ecdca6; border-radius:10px; padding:14px 16px; font-size:.82rem; line-height:1.55; color:#6b5b23; }
  .note b { color:#4a3f18; }
  .foot { text-align:center; color:var(--muted); font-size:.76rem; margin-top:28px; }
  code { background:#00000010; padding:1px 5px; border-radius:4px; font-size:.9em; }
</style></head>
<body><div class="wrap">
  <div class="head">
    <h1>SermonIndex — Node Software</h1>
    <div class="ver">${version}</div>
    <p>Download the installer for your system.</p>
  </div>
  ${rows}
  <div class="note">
    <b>First launch:</b> because this is an early test build it isn't yet
    code-signed, so your system shows a one-time warning.<br>
    • <b>macOS:</b> right-click the app → Open. If it says "damaged," run once in
    Terminal: <code>xattr -cr "/Applications/SermonIndex Node Software.app"</code><br>
    • <b>Windows:</b> "More info" → "Run anyway".<br>
    • <b>Linux (AppImage):</b> <code>chmod +x</code> then run.
  </div>
  <div class="foot">SermonIndex.net · freely given for the glory of Christ</div>
</div></body></html>`;
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  if (!existsSync(SCAN_DIR)) { console.error(`Scan dir not found: ${SCAN_DIR}`); process.exit(1); }

  // Collect installers, dedupe by basename (keep the first found)
  const found = walk(SCAN_DIR);
  const byName = new Map();
  for (const full of found) {
    const name = basename(full);
    if (!byName.has(name)) byName.set(name, full);
  }
  if (byName.size === 0) {
    console.error(`No installer files (.dmg/.msi/.exe/.AppImage/.deb/.rpm) found under ${SCAN_DIR}.`);
    console.error('Did the build finish? For a local mac build, run "npm run tauri build" first.');
    process.exit(1);
  }

  const files = [];
  for (const [name, full] of byName) {
    const size = statSync(full).size;
    const p = platformOf(name);
    files.push({ name, full, size: humanSize(size), bytes: size, ...p });
  }
  files.sort((a, b) => a.order - b.order);

  console.log(`Version:  ${VERSION}`);
  console.log(`Target:   ${PUBLIC_BASE}/${REMOTE_ROOT}/${VERSION}/`);
  console.log(`Installers found: ${files.length}`);
  for (const f of files) console.log(`  · ${f.label.padEnd(34)} ${f.name} (${f.size})`);
  console.log('');

  // Upload each installer
  let done = 0, failed = 0;
  for (const f of files) {
    try {
      await put(`${REMOTE_ROOT}/${VERSION}/${f.name}`, readFileSync(f.full));
      done++;
      console.log(`  ✓ ${f.name}`);
    } catch (e) {
      failed++;
      console.error(`  [!] ${f.name}: ${e.message}`);
    }
  }

  // manifest.json + index.html for this version
  const manifest = {
    version: VERSION,
    date: new Date().toISOString(),
    files: files.map((f) => ({
      name: f.name, os: f.os, label: f.label, bytes: f.bytes, size: f.size,
      url: `${PUBLIC_BASE}/${REMOTE_ROOT}/${VERSION}/${f.name}`,
    })),
  };
  try {
    await put(`${REMOTE_ROOT}/${VERSION}/manifest.json`, Buffer.from(JSON.stringify(manifest, null, 2)), 'application/json');
    await put(`${REMOTE_ROOT}/${VERSION}/index.html`, Buffer.from(buildIndexHtml(VERSION, files)), 'text/html; charset=utf-8');
    console.log('  ✓ manifest.json + index.html');
  } catch (e) {
    console.error(`  [!] manifest/index: ${e.message}`);
  }

  // Global releases.json index (best-effort merge)
  if (!NO_INDEX) {
    try {
      const idx = (await getJson(`${REMOTE_ROOT}/releases.json`)) || { releases: [] };
      idx.releases = (idx.releases || []).filter((r) => r.version !== VERSION);
      idx.releases.unshift({
        version: VERSION,
        date: manifest.date,
        url: `${PUBLIC_BASE}/${REMOTE_ROOT}/${VERSION}/`,
        files: manifest.files.map((f) => ({ name: f.name, os: f.os, url: f.url })),
      });
      idx.updated = manifest.date;
      await put(`${REMOTE_ROOT}/releases.json`, Buffer.from(JSON.stringify(idx, null, 2)), 'application/json');
      console.log('  ✓ releases.json index updated');
      if (!DRY_RUN) console.log('    (purge releases.json in the Bunny dashboard so the CDN serves the fresh list)');
    } catch (e) {
      console.error(`  [!] releases.json: ${e.message}`);
    }
  }

  console.log(`\nDone: ${done} uploaded, ${failed} failed.`);
  console.log(`\nShare this page with testers:`);
  console.log(`   ${PUBLIC_BASE}/${REMOTE_ROOT}/${VERSION}/index.html`);
  console.log(`\nDirect links:`);
  for (const f of files) console.log(`   ${f.os.padEnd(8)} ${PUBLIC_BASE}/${REMOTE_ROOT}/${VERSION}/${encodeURIComponent(f.name)}`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
