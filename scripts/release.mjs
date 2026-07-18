#!/usr/bin/env node
/**
 * SermonIndex Node Software — one-command LOCAL release
 * =====================================================
 * Automates the whole local publish flow so you never paste credentials by hand.
 * It reads secrets from scripts/release.secrets.json (GITIGNORED — copy from
 * release.secrets.example.json and fill in), then runs, in order:
 *
 *   1. cargo build                (Rust preflight)
 *   2. npm run tauri build        (signed — key + password injected from secrets)
 *   3. publish-update.mjs         → sermonindex4  (the new/auto-update manifest)
 *   4. publish-update.mjs         → sermonindex1  (one-time migration mirror, so
 *                                    pre-endpoint-switch installs still update)
 *   5. deploy-installers.mjs      → sermonindex4  (per-version download page)
 *   6. Purge the Bunny CDN        (auto if "bunnyApiKey" set, else prints the URLs)
 *
 * Usage:
 *   node scripts/release.mjs --notes "What changed"     # local MAC-ONLY quick push
 *   node scripts/release.mjs --all-platforms            # tag + push → CI builds/publishes ALL platforms
 *   node scripts/release.mjs --notes "..." --mode silent
 *   node scripts/release.mjs --notes "..." --mode force   # EMERGENCY break-glass: auto-applies to every running node
 *   node scripts/release.mjs --skip-build     # publish an already-built bundle
 *   node scripts/release.mjs --no-mirror      # skip the sermonindex1 mirror
 *   node scripts/release.mjs --no-installers  # skip the download-page upload
 *   node scripts/release.mjs --dry-run        # show every step, upload nothing
 *
 * NOTE: a local Mac build only produces the macOS artifact, so this publishes a
 * Mac-only update + download page. For ALL platforms (Windows/Linux/Intel), push
 * a git tag instead — CI builds + signs all four and runs steps 3–5 for you:
 *     git tag v<version> && git push origin v<version>
 */

import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..');
const args = process.argv.slice(2);
const has = (f) => args.includes(`--${f}`);
const getArg = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const DRY = has('dry-run');

// ── Secrets (gitignored) ─────────────────────────────────────────────────────
const SECRETS_PATH = join(__dirname, 'release.secrets.json');
if (!existsSync(SECRETS_PATH)) {
  console.error(`\n✗ Missing ${SECRETS_PATH}`);
  console.error('  Copy scripts/release.secrets.example.json → scripts/release.secrets.json and fill it in.');
  console.error('  (It is gitignored — Bunny storage passwords must never be committed.)');
  process.exit(1);
}
let secrets;
try { secrets = JSON.parse(readFileSync(SECRETS_PATH, 'utf8')); }
catch (e) { console.error(`✗ Could not parse ${SECRETS_PATH}: ${e.message}`); process.exit(1); }

const z4 = secrets.zones?.sermonindex4;
const z1 = secrets.zones?.sermonindex1;
if (!z4?.key) { console.error('✗ secrets.zones.sermonindex4.key is required.'); process.exit(1); }

const expandTilde = (p) => (p && p.startsWith('~')) ? join(homedir(), p.slice(1)) : p;
const version = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).version;
const notes = getArg('notes', `SermonIndex Node Software v${version}`);
// Delivery mode passed straight through to publish-update.mjs (which validates
// it): 'prompt' (default), 'silent', or 'force'. 'force' is the break-glass
// emergency lever — it makes the release auto-install + relaunch on every
// running node in the network with no user action. Not gated here, so it's not
// rejected before it reaches publish-update.
const mode = getArg('mode', 'prompt');

// ── Helpers ──────────────────────────────────────────────────────────────────
function run(cmd, argv, extraEnv = {}, cwd = REPO) {
  console.log(`\n$ ${cmd} ${argv.join(' ')}`);
  if (DRY) { console.log('  [dry-run] skipped'); return; }
  const r = spawnSync(cmd, argv, { cwd, stdio: 'inherit', env: { ...process.env, ...extraEnv } });
  if (r.status !== 0) { console.error(`\n✗ Step failed (exit ${r.status}): ${cmd} ${argv.join(' ')}`); process.exit(r.status || 1); }
}
function publishUpdate(zoneName, zone, extraArgs = []) {
  run('node', ['scripts/publish-update.mjs', '--mode', mode, '--notes', notes, ...(DRY ? ['--dry-run'] : []), ...extraArgs], {
    BUNNY_STORAGE_ZONE: zoneName,
    BUNNY_STORAGE_KEY: zone.key,
    BUNNY_CDN_BASE: zone.base,
    BUNNY_API_KEY: secrets.bunnyApiKey || '',   // lets publish-update self-purge the tarball + latest.json
  });
}

// ── All-platform release ─────────────────────────────────────────────────────
// A Mac can't build Windows/Linux, so cross-platform builds must run in CI. This
// path just tags + pushes; GitHub Actions then builds + signs macOS (arm+intel),
// Windows and Linux and runs publish-update + deploy-installers for all four.
if (has('all-platforms') || has('ci')) {
  const tag = `v${version}`;
  console.log(`\n=== All-platform release → tagging ${tag} to trigger CI ===`);
  if (!DRY) {
    const st = spawnSync('git', ['status', '--porcelain'], { cwd: REPO, encoding: 'utf8' });
    if (st.stdout && st.stdout.trim()) {
      console.error('\n✗ Uncommitted changes present. CI builds the PUSHED commit, so commit + push first:');
      console.error(`    git add -A && git commit -m "Release v${version}" && git push`);
      process.exit(1);
    }
  }
  run('git', ['tag', tag], {}, REPO);
  run('git', ['push', 'origin', tag], {}, REPO);
  console.log(`\n✓ Pushed ${tag}. GitHub Actions is now building + signing macOS (Apple Silicon + Intel), Windows,`);
  console.log('  and Linux, then publishing the multi-platform auto-update + download pages to sermonindex4.');
  console.log('  Watch it under the repo\'s Actions tab — or track it live here:  node scripts/watch-release.mjs');
  console.log('  Requires repo secrets set in GitHub: TAURI_SIGNING_PRIVATE_KEY (+ _PASSWORD), BUNNY_STORAGE_ZONE, BUNNY_STORAGE_KEY.');
  console.log('  CI publishes to sermonindex4 only; for the one-time sermonindex1 migration mirror, afterward run:');
  console.log('    node scripts/release.mjs --skip-build --no-installers');
  if (has('watch')) {
    console.log('\n=== Watching the build (it runs on GitHub — Ctrl-C stops watching only, not the build) ===');
    run('node', ['scripts/watch-release.mjs']);
  }
  process.exit(0);
}

console.log(`\n=== Releasing SermonIndex Node Software v${version}  (mode=${mode}${DRY ? ', DRY-RUN' : ''}) ===`);

// 1 + 2. Build (signed) unless skipping
if (!has('skip-build')) {
  run('cargo', ['build'], {}, join(REPO, 'src-tauri'));
  const keyPath = expandTilde(secrets.signing?.keyPath || '~/.tauri/sermonindex.key');
  if (!existsSync(keyPath)) { console.error(`✗ Signing key not found at ${keyPath} (set secrets.signing.keyPath).`); process.exit(1); }
  run('npm', ['run', 'tauri', 'build'], {
    TAURI_SIGNING_PRIVATE_KEY: readFileSync(keyPath, 'utf8'),
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: secrets.signing?.password || '',
  });
} else {
  console.log('\n(skip-build: publishing the existing bundle)');
}

// 3. Auto-update manifest → primary zone (sermonindex4)
publishUpdate('sermonindex4', z4);

// 4. One-time migration mirror → legacy zone (sermonindex1)
if (!has('no-mirror') && z1?.key) {
  console.log('\n(mirroring to sermonindex1 so pre-migration installs still update)');
  publishUpdate('sermonindex1', z1, ['--public-base', z1.base]);
}

// 5. Per-version download page → primary zone
if (!has('no-installers')) {
  run('node', ['scripts/deploy-installers.mjs', ...(DRY ? ['--dry-run'] : [])], {
    BUNNY_STORAGE_ZONE: 'sermonindex4',
    BUNNY_STORAGE_KEY: z4.key,
    BUNNY_CDN_BASE: z4.base,
  });
}

// 6. Purge CDN
const purgeUrls = [
  `${z4.base}/app/latest.json`,
  `${z4.base}/app/releases/releases.json`,
  `${z4.base}/app/download/`,
];
if (!has('no-mirror') && z1?.key) purgeUrls.push(`${z1.base}/app/latest.json`);

if (secrets.bunnyApiKey && !DRY) {
  console.log('\n=== Purging CDN ===');
  for (const u of purgeUrls) {
    try {
      const res = await fetch(`https://api.bunny.net/purge?url=${encodeURIComponent(u)}&async=false`, {
        method: 'POST', headers: { AccessKey: secrets.bunnyApiKey },
      });
      console.log(`  ${res.ok ? '✓' : '✗ HTTP ' + res.status} purge ${u}`);
    } catch (e) { console.log(`  ✗ purge ${u}: ${e.message}`); }
  }
} else {
  console.log('\n⚠  PURGE these on Bunny (or add "bunnyApiKey" to release.secrets.json to auto-purge):');
  purgeUrls.forEach((u) => console.log(`   ${u}`));
  console.log('   …plus the artifact/tarball URLs printed by publish-update above.');
}

console.log(`\n✓ Release v${version} published.`);
console.log('\n  Share these URLs (post on the forum / site):');
console.log(`   • This version:      ${z4.base}/app/releases/v${version}/`);
console.log(`   • Latest (permanent):${z4.base}/app/download/`);
console.log(`   • All releases:      ${z4.base}/app/releases/`);
console.log('\n  Test: on an OLD Apple-Silicon build, quit + reopen → the update prompt should appear.');
console.log(`  All platforms: node scripts/release.mjs --all-platforms  (tags + pushes → CI builds Windows/Linux/Intel too).`);
