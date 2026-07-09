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

/**
 * Candidate portrait paths for a speaker, mirroring the app's runtime fallbacks
 * (services/catalog.js speakerImageCandidates): the catalog's stored path first,
 * then the name-derived compact and hyphenated slugs. The site's naming is
 * inconsistent (e.g. the catalog may say "ab-simpson.png" while the real file is
 * "absimpson.png"), so trying all forms recovers many that a single URL misses.
 * Returns [{ url, dest }] — each saved to the local path matching its own URL,
 * so the app finds it via the matching candidate.
 */
const EXTS = ['.png', '.jpg', '.jpeg'];

function candidatePaths(name, img) {
  const out = [];
  // For a slug, try each image extension — but ALWAYS save to the `.png` path
  // the app looks for. (The browser detects image type by content, not by the
  // filename, so a JPEG saved as `<slug>.png` still displays fine.)
  const addSlug = (letter, slug) => {
    if (!letter || !slug) return;
    const dest = join(PUBLIC, `images/speakers/${letter}/${slug}.png`);
    for (const ext of EXTS) {
      const url = `${SITE_BASE}/images/speakers/${letter}/${slug}${ext}`;
      if (out.some((c) => c.url === url)) continue;
      out.push({ url, dest });
    }
  };
  // 1. Stored catalog path → its letter + slug (strip any extension).
  if (img && !img.includes(DEFAULT_MARKER)) {
    let pathname = null;
    if (img.startsWith('http')) { try { pathname = new URL(img).pathname; } catch { /* not a URL */ } }
    else pathname = img.startsWith('/') ? img : `/${img}`;
    const m = pathname && pathname.match(/\/images\/speakers\/([^/]+)\/([^/]+?)(?:\.[a-z]+)?$/i);
    if (m) addSlug(m[1], m[2]);
  }
  // 2. Name-derived slugs (compact + hyphenated), like the app's fallbacks.
  const lower = (name || '').toLowerCase();
  const compact = lower.replace(/[^a-z0-9]/g, '');
  const hyphen = lower.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (compact) addSlug(compact[0], compact);
  if (hyphen && hyphen !== compact) addSlug(hyphen[0], hyphen);
  return out;
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

  // One entry per speaker, each with a list of candidate URLs to try in order.
  const seen = new Set();
  const entries = [];
  let defaults = 0;
  for (const [name, img] of speakers) {
    // Skip speakers the catalog marks as having no portrait (default image).
    if (!img || img.includes(DEFAULT_MARKER)) { defaults++; continue; }
    const cands = candidatePaths(name, img);
    if (cands.length === 0) { defaults++; continue; }
    const key = cands[0].dest; // dedup shared/repeat portraits by their primary path
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ name, candidates: cands });
  }

  console.log(`Catalog speakers: ${speakers.length}`);
  console.log(`  real portraits (unique): ${entries.length}`);
  console.log(`  using default (skipped): ${defaults}`);

  if (DRY_RUN) {
    console.log('\n--dry-run — no downloads. Sample (with fallbacks):');
    for (const e of entries.slice(0, 6)) {
      console.log(`  ${e.name}: ${e.candidates.map((c) => c.url).join('  |  ')}`);
    }
    console.log(`\nWould ensure ${entries.length} portraits under public/images/speakers/.`);
    return;
  }

  let downloaded = 0, skipped = 0, failed = 0;
  const failures = [];
  let idx = 0;

  async function worker() {
    while (idx < entries.length) {
      const e = entries[idx++];
      // Already have any candidate on disk? skip.
      if (!FORCE) {
        let have = false;
        for (const c of e.candidates) { if (await exists(c.dest)) { have = true; break; } }
        if (have) { skipped++; continue; }
      }
      // Try each candidate URL until one downloads; save to that candidate's path.
      let ok = false;
      for (const c of e.candidates) {
        try {
          const buf = await fetchWithRetry(c.url);
          await mkdir(dirname(c.dest), { recursive: true });
          await writeFile(c.dest, buf);
          downloaded++; ok = true;
          if (downloaded % 50 === 0) {
            process.stdout.write(`\r  downloaded ${downloaded}, skipped ${skipped}, failed ${failed}…   `);
          }
          break;
        } catch { /* try next candidate */ }
      }
      if (!ok) {
        failed++;
        failures.push(`${e.name}  (tried: ${e.candidates.map((c) => c.url.split('/').pop()).join(', ')})`);
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
