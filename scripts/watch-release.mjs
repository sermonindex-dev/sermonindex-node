#!/usr/bin/env node
/**
 * watch-release.mjs — track a release build to completion.
 *
 * Two layers, best-effort:
 *   1. If the GitHub CLI (`gh`) is installed + authenticated, it streams the
 *      live Actions run (per-job: macOS arm/intel, Windows, Linux, publish),
 *      exactly like watching the Actions tab — and detects a failed job.
 *   2. Regardless, it then polls the Bunny CDN's releases.json until THIS
 *      version is published (that's CI's final step), and prints the download
 *      links. This is the definitive "it's live" signal and needs no auth.
 *
 * Usage:
 *   node scripts/watch-release.mjs                 # version from package.json
 *   node scripts/watch-release.mjs v0.0.326        # explicit version
 *   node scripts/watch-release.mjs --no-gh         # skip gh, just poll the CDN
 *
 * Safe to run anytime after you've pushed the tag (even minutes later).
 */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..');
const args = process.argv.slice(2);
const has = (f) => args.includes(`--${f}`);

const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));
const argVer = args.find((a) => /^v?\d+\.\d+\.\d+$/.test(a));
const version = 'v' + String(argVer || pkg.version).replace(/^v/, '');
const CDN = (process.env.BUNNY_CDN_BASE || 'https://sermonindex4.b-cdn.net').replace(/\/+$/, '');
const RELEASES = `${CDN}/app/releases/releases.json`;
const ACTIONS_URL = 'https://github.com/sermonindex-dev/sermonindex-node/actions';
const WANT = ['macOS', 'Windows', 'Linux'];
const POLL_MS = 20_000;
const TIMEOUT_MS = 45 * 60_000;

function ghAvailable() {
  try { return spawnSync('gh', ['--version'], { encoding: 'utf8' }).status === 0; }
  catch { return false; }
}

function ghWatch() {
  console.log('→ Streaming the live GitHub Actions run via `gh`…\n');
  const list = spawnSync('gh', ['run', 'list', '--workflow', 'Build & Release', '-L', '10',
    '--json', 'databaseId,status,headBranch,event,createdAt'], { cwd: REPO, encoding: 'utf8' });
  let id = null;
  try {
    const runs = JSON.parse(list.stdout || '[]');
    // prefer a run tied to this tag, else the newest still-running one, else newest
    const active = new Set(['queued', 'in_progress', 'requested', 'waiting', 'pending']);
    const match = runs.find((r) => r.headBranch === version)
      || runs.find((r) => active.has(r.status))
      || runs[0];
    if (match) id = match.databaseId;
  } catch { /* ignore */ }
  if (!id) { console.log(`  (couldn't locate the run automatically — open ${ACTIONS_URL})\n`); return; }
  // Blocks until the run finishes; inherits stdio so you see per-job progress.
  spawnSync('gh', ['run', 'watch', String(id), '--exit-status'], { cwd: REPO, stdio: 'inherit' });
  console.log('');
}

async function fetchJson(url) {
  try { const r = await fetch(`${url}?t=${Date.now()}`); return r.ok ? await r.json() : null; }
  catch { return null; }
}

async function pollCdn() {
  console.log(`→ Waiting for ${version} to publish to the CDN…  (${RELEASES})`);
  const start = Date.now();
  while (Date.now() - start < TIMEOUT_MS) {
    const j = await fetchJson(RELEASES);
    const rel = j && (j.releases || []).find((r) => r.version === version);
    const el = Date.now() - start;
    const clock = `${Math.floor(el / 60000)}m${String(Math.floor(el / 1000) % 60).padStart(2, '0')}s`;
    if (rel) {
      const oses = [...new Set((rel.files || []).map((f) => f.os))];
      const missing = WANT.filter((w) => !oses.includes(w));
      process.stdout.write('\n');
      console.log(`\n✓ ${version} is LIVE — ${(rel.files || []).length} installers (${oses.join(', ') || 'none'}).`);
      if (missing.length) console.log(`⚠  No installers published for: ${missing.join(', ')} — check that platform's build job at ${ACTIONS_URL}`);
      console.log('\n  Share / download:');
      console.log(`   • Latest download page: ${CDN}/app/download/`);
      console.log(`   • This release:         ${rel.url}`);
      console.log(`   • All releases:         ${CDN}/app/releases/`);
      console.log(`   • Auto-update manifest: ${CDN}/app/latest.json`);
      console.log('\n  Old builds will now see the update prompt on relaunch.');
      return true;
    }
    process.stdout.write(`\r  ${clock} — building… not published yet   `);
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  console.log(`\n\n⚠ Timed out after 45 min without seeing ${version}. Check ${ACTIONS_URL}`);
  return false;
}

(async () => {
  console.log(`\n=== Watching release ${version} ===`);
  if (!has('no-gh') && ghAvailable()) ghWatch();
  else console.log('(GitHub CLI `gh` not found — polling the CDN only. Install gh for live per-job progress.)');
  await pollCdn();
  process.exit(0); // never fail the caller; this is a monitor
})();
