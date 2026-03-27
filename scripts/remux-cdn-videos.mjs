#!/usr/bin/env node
/**
 * Batch Remux CDN Videos: MKV → Proper MP4
 *
 * The videos on sermonindex2.b-cdn.net are YouTube-sourced files with
 * MKV/Matroska containers served with .mp4 extensions. Safari/WebKit
 * cannot play MKV containers. This script:
 *
 *   1. Lists all video files from the Bunny CDN storage zone
 *   2. Checks each file's magic bytes via Range request (4 bytes, no full download)
 *   3. If MKV: streams download to disk, remuxes to proper MP4 via local ffmpeg
 *   4. Streams the remuxed file back up to Bunny CDN, replacing the original
 *
 * Logging:
 *   - Writes a JSON log to scripts/remux-log.json after every file
 *   - Writes failed filenames to scripts/remux-failures.txt for easy retry
 *   - Use RETRY_FAILURES=1 to re-process only the files in remux-failures.txt
 *   - Skips files already marked remuxed/already_mp4 in the log (safe to restart)
 *
 * Requirements:
 *   - Node.js 18+
 *   - ffmpeg installed locally (brew install ffmpeg)
 *   - Bunny CDN Storage Zone password (FTP & API Access page)
 *
 * Usage:
 *   BUNNY_API_KEY=your-key BUNNY_STORAGE_ZONE=sermonindex2 node scripts/remux-cdn-videos.mjs
 *
 * Optional env vars:
 *   BUNNY_STORAGE_REGION=de   — default: main endpoint, set to de/ny/la/sg/syd for regional
 *   DRY_RUN=1                 — check files without converting
 *   LIMIT=10                  — only process first N files
 *   START_AFTER=filename.mp4  — resume after a specific file
 *   CONCURRENCY=3             — parallel conversions (default: 3)
 *   RETRY_FAILURES=1          — only retry files listed in remux-failures.txt
 *   MAX_RETRIES=3             — retry failed files up to N times (default: 3)
 */

import { execSync, spawn } from 'child_process';
import fs from 'fs';
import { createWriteStream, createReadStream } from 'fs';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Config ───────────────────────────────────────────────────────────────

const API_KEY = process.env.BUNNY_API_KEY;
const STORAGE_ZONE = process.env.BUNNY_STORAGE_ZONE || 'sermonindex-video';
const STORAGE_REGION = process.env.BUNNY_STORAGE_REGION || ''; // empty = main Falkenstein endpoint
const DRY_RUN = process.env.DRY_RUN === '1';
const LIMIT = parseInt(process.env.LIMIT || '0', 10);
const START_AFTER = process.env.START_AFTER || '';
const CONCURRENCY = parseInt(process.env.CONCURRENCY || '3', 10);
const RETRY_FAILURES = process.env.RETRY_FAILURES === '1';
const MAX_RETRIES = parseInt(process.env.MAX_RETRIES || '3', 10);

// ── Log files ────────────────────────────────────────────────────────────

const LOG_FILE = path.join(__dirname, 'remux-log.json');
const FAILURES_FILE = path.join(__dirname, 'remux-failures.txt');

// Load existing log or start fresh
let logData = { started: new Date().toISOString(), files: {}, summary: {} };
if (fs.existsSync(LOG_FILE)) {
  try { logData = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8')); } catch {}
}

// Batch log writes — save at most every 2 seconds to avoid hammering disk
let logDirty = false;
function markLogDirty() { logDirty = true; }
function flushLog() {
  if (logDirty) {
    fs.writeFileSync(LOG_FILE, JSON.stringify(logData, null, 2));
    logDirty = false;
  }
}
const logInterval = setInterval(flushLog, 2000);

function saveLog() {
  markLogDirty();
}

function appendFailure(filename, error) {
  fs.appendFileSync(FAILURES_FILE, `${filename}\t${error}\t${new Date().toISOString()}\n`);
}

function loadFailuresList() {
  if (!fs.existsSync(FAILURES_FILE)) return [];
  const lines = fs.readFileSync(FAILURES_FILE, 'utf8').trim().split('\n').filter(Boolean);
  const names = new Set(lines.map(l => l.split('\t')[0]));
  return [...names];
}

// ── Validation ───────────────────────────────────────────────────────────

if (!API_KEY) {
  console.error('Error: BUNNY_API_KEY environment variable is required');
  console.error('Get your Storage Zone password from: Bunny CDN → Storage → FTP & API Access');
  process.exit(1);
}

try {
  execSync('ffmpeg -version', { stdio: 'pipe' });
} catch {
  console.error('Error: ffmpeg is not installed. Install with: brew install ffmpeg');
  process.exit(1);
}

const STORAGE_HOST = STORAGE_REGION
  ? `https://${STORAGE_REGION}.storage.bunnycdn.com`
  : 'https://storage.bunnycdn.com';

const TEMP_DIR = path.join(os.tmpdir(), 'si-remux');
fs.mkdirSync(TEMP_DIR, { recursive: true });

// ── Bunny CDN API Helpers ────────────────────────────────────────────────

async function listFiles(dir = '/') {
  const url = `${STORAGE_HOST}/${STORAGE_ZONE}${dir}`;
  const res = await fetch(url, {
    headers: { AccessKey: API_KEY },
  });
  if (!res.ok) throw new Error(`List failed: ${res.status} ${await res.text()}`);
  return await res.json();
}

/** Stream download directly to disk — no buffering entire file in RAM */
async function downloadFile(remotePath, localPath) {
  const url = `${STORAGE_HOST}/${STORAGE_ZONE}${remotePath}`;
  const res = await fetch(url, {
    headers: { AccessKey: API_KEY },
  });
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);

  const fileStream = createWriteStream(localPath);
  await pipeline(Readable.fromWeb(res.body), fileStream);

  return fs.statSync(localPath).size;
}

/** Stream upload from disk — no buffering entire file in RAM */
async function uploadFile(remotePath, localPath) {
  const fileSize = fs.statSync(localPath).size;
  const fileStream = createReadStream(localPath);
  const url = `${STORAGE_HOST}/${STORAGE_ZONE}${remotePath}`;

  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      AccessKey: API_KEY,
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(fileSize),
    },
    body: Readable.toWeb(fileStream),
    duplex: 'half',
  });
  if (!res.ok) throw new Error(`Upload failed: ${res.status} ${await res.text()}`);
}

/** Check MKV magic bytes remotely — only fetches 4 bytes */
async function isMKVRemote(remotePath) {
  const url = `${STORAGE_HOST}/${STORAGE_ZONE}${remotePath}`;
  const res = await fetch(url, {
    headers: { AccessKey: API_KEY, Range: 'bytes=0-3' },
  });
  if (!res.ok) throw new Error(`Header check failed: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return buf.length >= 4 && buf[0] === 0x1A && buf[1] === 0x45 && buf[2] === 0xDF && buf[3] === 0xA3;
}

/** Use dry-run log to skip the 4-byte check when we already know the answer */
function knownMKVFromLog(name) {
  const entry = logData.files[name];
  if (!entry) return null; // unknown, must check
  if (entry.status === 'needs_remux') return true;
  if (entry.status === 'already_mp4') return false;
  return null;
}

/** Remux using async spawn for better concurrency (doesn't block the event loop) */
function remuxToMP4(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', [
      '-i', inputPath,
      '-c:v', 'copy',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-movflags', '+faststart',
      '-y',
      outputPath,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error('ffmpeg timeout (15 min)'));
    }, 900000); // 15 min for very large files

    proc.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve(true);
      else reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(-300)}`));
    });

    proc.on('error', err => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

// ── Processing ───────────────────────────────────────────────────────────

async function processFile(file, attempt = 1) {
  const name = file.ObjectName;
  const remotePath = `/${name}`;
  const sizeMB = (file.Length / 1024 / 1024).toFixed(1);
  const retryTag = attempt > 1 ? ` (attempt ${attempt}/${MAX_RETRIES})` : '';

  console.log(`\n📥 ${name} (${sizeMB} MB)${retryTag}`);

  // Skip if already successfully processed in a previous run
  if (logData.files[name]?.status === 'remuxed' || logData.files[name]?.status === 'already_mp4') {
    console.log(`  ⏭️  Already processed — skipping`);
    return { name, status: 'skipped' };
  }

  const inputPath = path.join(TEMP_DIR, `input_${name}`);
  const outputPath = path.join(TEMP_DIR, `output_${name}`);

  try {
    // Check if we already know from a dry run whether this is MKV
    let mkv = knownMKVFromLog(name);
    if (mkv === null) {
      mkv = await isMKVRemote(remotePath);
    }

    if (!mkv) {
      console.log(`  ✅ Already proper MP4 — skipping`);
      logData.files[name] = { status: 'already_mp4', checkedAt: new Date().toISOString() };
      saveLog();
      return { name, status: 'already_mp4' };
    }

    console.log(`  ⚠️  MKV container detected — needs remux`);

    if (DRY_RUN) {
      console.log(`  [DRY RUN] Would remux and re-upload`);
      logData.files[name] = { status: 'needs_remux', sizeMB, checkedAt: new Date().toISOString() };
      saveLog();
      return { name, status: 'needs_remux' };
    }

    // Stream download to disk
    const t0 = Date.now();
    const dlSize = await downloadFile(remotePath, inputPath);
    const dlSec = ((Date.now() - t0) / 1000).toFixed(1);
    const dlSpeed = (dlSize / 1024 / 1024 / (dlSec || 1)).toFixed(1);
    console.log(`  Downloaded: ${(dlSize / 1024 / 1024).toFixed(1)} MB in ${dlSec}s (${dlSpeed} MB/s)`);

    // Remux (async — doesn't block event loop)
    console.log(`  🔄 Remuxing MKV → MP4...`);
    const t1 = Date.now();
    await remuxToMP4(inputPath, outputPath);
    const remuxSec = ((Date.now() - t1) / 1000).toFixed(1);

    const newSize = fs.statSync(outputPath).size;
    const newSizeMB = (newSize / 1024 / 1024).toFixed(1);
    console.log(`  Remuxed: ${sizeMB} MB → ${newSizeMB} MB in ${remuxSec}s`);

    // Delete input immediately to free disk space before upload
    try { fs.unlinkSync(inputPath); } catch {}

    // Stream upload
    const t2 = Date.now();
    console.log(`  📤 Uploading remuxed file...`);
    await uploadFile(remotePath, outputPath);
    const upSec = ((Date.now() - t2) / 1000).toFixed(1);
    console.log(`  ✅ Done — replaced on CDN (upload ${upSec}s)`);

    logData.files[name] = {
      status: 'remuxed',
      originalMB: parseFloat(sizeMB),
      newMB: parseFloat(newSizeMB),
      completedAt: new Date().toISOString(),
    };
    saveLog();

    return { name, status: 'remuxed', originalMB: sizeMB, newMB: newSizeMB };
  } catch (err) {
    console.error(`  ❌ Error: ${err.message}`);

    // Retry logic
    if (attempt < MAX_RETRIES) {
      console.log(`  🔁 Retrying in ${attempt * 5}s...`);
      await new Promise(r => setTimeout(r, attempt * 5000));
      return processFile(file, attempt + 1);
    }

    // All retries exhausted
    const errorMsg = err.message.slice(0, 200);
    logData.files[name] = {
      status: 'error',
      error: errorMsg,
      attempts: attempt,
      failedAt: new Date().toISOString(),
    };
    saveLog();
    appendFailure(name, errorMsg);

    return { name, status: 'error' };
  } finally {
    try { fs.unlinkSync(inputPath); } catch {}
    try { fs.unlinkSync(outputPath); } catch {}
  }
}

// ── Main ─────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== SermonIndex CDN Video Remux ===');
  console.log(`Storage zone: ${STORAGE_ZONE}`);
  console.log(`Storage host: ${STORAGE_HOST}`);
  console.log(`Temp dir: ${TEMP_DIR}`);
  console.log(`Dry run: ${DRY_RUN}`);
  console.log(`Concurrency: ${CONCURRENCY}`);
  console.log(`Max retries: ${MAX_RETRIES}`);
  console.log(`Log file: ${LOG_FILE}`);
  if (LIMIT > 0) console.log(`Limit: ${LIMIT} files`);
  if (START_AFTER) console.log(`Starting after: ${START_AFTER}`);
  if (RETRY_FAILURES) console.log(`Mode: RETRY FAILURES ONLY`);
  console.log('');

  let files;

  if (RETRY_FAILURES) {
    const failedNames = loadFailuresList();
    if (failedNames.length === 0) {
      console.log('No failures to retry! remux-failures.txt is empty or missing.');
      return;
    }
    console.log(`Retrying ${failedNames.length} previously failed files...`);
    console.log('Listing files to get metadata...');
    const allFiles = await listFiles('/');
    const fileMap = new Map(allFiles.map(f => [f.ObjectName, f]));
    files = failedNames.map(name => fileMap.get(name)).filter(Boolean);
    console.log(`Matched ${files.length} files on CDN`);
    fs.writeFileSync(FAILURES_FILE, '');
  } else {
    console.log('Listing files...');
    files = await listFiles('/');
    files = files.filter(f => !f.IsDirectory && f.ObjectName.endsWith('.mp4'));
    console.log(`Found ${files.length} video files`);

    if (START_AFTER) {
      const idx = files.findIndex(f => f.ObjectName === START_AFTER);
      if (idx >= 0) {
        files = files.slice(idx + 1);
        console.log(`Resuming after ${START_AFTER} — ${files.length} remaining`);
      }
    }

    if (LIMIT > 0) {
      files = files.slice(0, LIMIT);
      console.log(`Processing ${files.length} files (limit applied)`);
    }
  }

  const results = { already_mp4: 0, remuxed: 0, needs_remux: 0, error: 0, skipped: 0 };
  const startTime = Date.now();

  const queue = [...files];
  const active = [];
  let processed = 0;

  while (queue.length > 0 || active.length > 0) {
    while (active.length < CONCURRENCY && queue.length > 0) {
      const file = queue.shift();
      const promise = processFile(file).then(result => {
        results[result.status] = (results[result.status] || 0) + 1;
        processed++;
        active.splice(active.indexOf(promise), 1);

        if (processed % 10 === 0) {
          const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
          const rate = (processed / (elapsed || 1)).toFixed(1);
          const eta = ((files.length - processed) / (rate || 1)).toFixed(0);
          console.log(`\n--- Progress: ${processed}/${files.length} | ${elapsed} min | ~${rate} files/min | ETA ~${eta} min ---`);
        }
      }).catch(err => {
        console.error(`  ❌ Error processing ${file.ObjectName}:`, err.message);
        results.error++;
        processed++;
        appendFailure(file.ObjectName, err.message.slice(0, 200));
        active.splice(active.indexOf(promise), 1);
      });
      active.push(promise);
    }
    if (active.length > 0) await Promise.race(active);
  }

  const totalMin = ((Date.now() - startTime) / 1000 / 60).toFixed(1);

  // Final log flush
  logData.summary = {
    lastRun: new Date().toISOString(),
    totalFiles: files.length,
    ...results,
    durationMinutes: parseFloat(totalMin),
  };
  flushLog();
  clearInterval(logInterval);

  console.log('\n=== Summary ===');
  console.log(`Total files:  ${files.length}`);
  console.log(`Already MP4:  ${results.already_mp4}`);
  console.log(`Remuxed:      ${results.remuxed}`);
  console.log(`Skipped:      ${results.skipped} (already done in previous run)`);
  if (results.needs_remux) console.log(`Needs remux:  ${results.needs_remux} (dry run)`);
  if (results.error) console.log(`Errors:       ${results.error} → see ${FAILURES_FILE}`);
  console.log(`Duration:     ${totalMin} min`);
  console.log(`Full log:     ${LOG_FILE}`);

  try { fs.rmdirSync(TEMP_DIR); } catch {}
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
