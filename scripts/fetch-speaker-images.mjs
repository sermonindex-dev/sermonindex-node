#!/usr/bin/env node
/**
 * Fetch speaker portraits into public/ so they ship INSIDE the app.
 * =================================================================
 * The app has ~947 speakers with a real portrait on sermonindex.net and ~420
 * with none (those use the bundled default). Fetching remote portraits at
 * runtime causes first-view lag. This script mirrors every real portrait into
 *   public/images/speakers/<letter>/<slug>.png
 * so the webview serves them locally (instant, offline, never broken). The app
 * (speakerImageCandidates) tries the local path first and only falls back to the
 * CDN for portraits that weren't fetched (e.g. speakers added since last run).
 *
 * USAGE:
 *   node scripts/fetch-speaker-images.mjs           # download everything missing
 *   node scripts/fetch-speaker-images.mjs --dry-run # show what WOULD be fetched
 *   node scripts/fetch-speaker-images.mjs --force    # re-download even if present
 *
 * Re-run after the catalog changes (new speakers) and before building a release.
 * Safe to run repeatedly — existing files are skipped unless --force.
 */

import { readFile, mkdir, writeFile, access } from 'node:fs/promises';
import { constants as FS } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const CATALOG = join(ROOT, 'src', 'data', 'catalog.json');
const PUBLIC = join(ROOT, 'public');

const SITE_BASE = 'https://www.sermonindex.net';
const DEFAULT_MARKER = 'default-si-speaker';

const CONCURRENCY = 12;      // parallel downloads
const TIMEOUT_MS = 20000;    // per-request timeout
const RETRIES = 2;           // extra attempts on failure

const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has('--dry-run');
const FORCE = args.has('--force');

/** Map a catalog image value to { url, dest, localPath } or null if it's a default. */
function planFor(img) {
  if (!img || img.includes(DEFAULT_MARKER)) return null;
  let pathname, url;
  if (img.startsWith('http')) {
    try {
      const u = new URL(img);
      pathname = u.pathname;      // e.g. /images/speakers/a/x.png
      url = img;
    } catch {
      return null;
    }
  } else {
    pathname = img.startsWith('/') ? img : `/${img}`;
    url = `${SITE_BASE}${pathname}`;
  }
  // Only mirror actual speaker portraits.
  if (!pathname.includes('/images/speakers/')) return null;
  const dest = join(PUBLIC, pathname.replace(/^\//, ''));
  return { url, dest, localPath: pathname };
}

async function exists(p) {
  try { await access(p, FS.F_OK); return true; } catch { return false; }
}

async function fetchWithRetry(url) {
  let lastErr;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
      const res = await fetch(url, { signal: ctrl.signal, redirect: 'follow' });
      clearTimeout(t);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 100) throw new Error(`suspiciously small (${buf.length}B)`);
      return buf;
    } catch (e) {
      lastErr = e;
      if (attempt < RETRIES) await new Promise(r => setTimeout(r, 400 * (attempt + 1)));
    }
  }
  throw lastErr;
}

async function main() {
  const raw = await readFile(CATALOG, 'utf8');
  const catalog = JSON.parse(raw);
  const speakers = catalog.s || [];

  // Build a de-duplicated plan (some portraits are shared / repeated).
  const seen = new Set();
  const plans = [];
  let defaults = 0;
  for (const [, img] of speakers) {
    const plan = planFor(img);
    if (!plan) { defaults++; continue; }
    if (seen.has(plan.dest)) continue;
    seen.add(plan.dest);
    plans.push(plan);
  }

  console.log(`Catalog speakers: ${speakers.length}`);
  console.log(`  real portraits (unique): ${plans.length}`);
  console.log(`  using default (skipped): ${defaults}`);

  if (DRY_RUN) {
    console.log('\n--dry-run — no downloads. Sample of planned files:');
    for (const p of plans.slice(0, 8)) console.log(`  ${p.url}\n    -> ${p.dest}`);
    console.log(`\nWould ensure ${plans.length} portraits under public/images/speakers/.`);
    return;
  }

  let downloaded = 0, skipped = 0, failed = 0;
  const failures = [];
  let idx = 0;

  async function worker() {
    while (idx < plans.length) {
      const p = plans[idx++];
      if (!FORCE && await exists(p.dest)) { skipped++; continue; }
      try {
        const buf = await fetchWithRetry(p.url);
        await mkdir(dirname(p.dest), { recursive: true });
        await writeFile(p.dest, buf);
        downloaded++;
        if (downloaded % 50 === 0) {
          process.stdout.write(`\r  downloaded ${downloaded}, skipped ${skipped}, failed ${failed}…   `);
        }
      } catch (e) {
        failed++;
        failures.push(`${p.url}  (${e.message})`);
      }
    }
  }

  console.log(`\nFetching into ${PUBLIC}/images/speakers/ (concurrency ${CONCURRENCY})…`);
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  console.log(`\n\nDone. downloaded ${downloaded}, skipped ${skipped} (already present), failed ${failed}.`);
  if (failures.length) {
    console.log('\nFailures (these will fall back to the CDN at runtime):');
    for (const f of failures.slice(0, 40)) console.log('  ' + f);
    if (failures.length > 40) console.log(`  …and ${failures.length - 40} more`);
  }
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
