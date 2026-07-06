#!/usr/bin/env node
/**
 * Transcode VP9 CDN Videos → H.264 MP4
 *
 * Downloads each video from your Bunny CDN, checks the codec, and if it's
 * VP9/AV1 (not Safari-compatible), transcodes to H.264+AAC and re-uploads.
 * Files already in H.264 are skipped (or optionally re-uploaded if audio
 * needs fixing).
 *
 * This preserves the ORIGINAL quality from your CDN — no YouTube re-download
 * needed, no quality surprises, no missing videos.
 *
 * Requirements:
 *   - Node.js 18+
 *   - ffmpeg installed (brew install ffmpeg)
 *   - Bunny CDN Storage Zone password
 *
 * Usage:
 *   BUNNY_API_KEY=your-key BUNNY_STORAGE_ZONE=sermonindex2 node scripts/transcode-cdn-videos.mjs
 *
 * Optional env vars:
 *   BUNNY_STORAGE_REGION=de    — regional endpoint (default: main/Falkenstein)
 *   DRY_RUN=1                  — probe codecs without transcoding or uploading
 *   LIMIT=10                   — only process first N files
 *   START_AFTER=filename.mp4   — resume after a specific file
 *   CONCURRENCY=1              — parallel transcodes (default: 1, transcoding is CPU-heavy)
 *   RETRY_FAILURES=1           — only retry files from transcode-failures.txt
 *   SKIP_UPLOAD=1              — transcode locally but don't upload
 *   FORCE_ALL=1                — re-transcode even files already marked done
 */

import { execSync, spawnSync } from 'child_process';
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
const STORAGE_REGION = process.env.BUNNY_STORAGE_REGION || '';
const DRY_RUN = process.env.DRY_RUN === '1';
const LIMIT = parseInt(process.env.LIMIT || '0', 10);
const START_AFTER = process.env.START_AFTER || '';
const CONCURRENCY = parseInt(process.env.CONCURRENCY || '1', 10);
const RETRY_FAILURES = process.env.RETRY_FAILURES === '1';
const SKIP_UPLOAD = process.env.SKIP_UPLOAD === '1';
const FORCE_ALL = process.env.FORCE_ALL === '1';

// ── Log files ────────────────────────────────────────────────────────────

const LOG_FILE = path.join(__dirname, 'transcode-log.json');
const FAILURES_FILE = path.join(__dirname, 'transcode-failures.txt');
const VP9_LOG_FILE = path.join(__dirname, 'transcode-vp9-list.txt');

let logData = { started: new Date().toISOString(), files: {}, summary: {} };
if (fs.existsSync(LOG_FILE)) {
  try { logData = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8')); } catch {}
}

let logDirty = false;
function markLogDirty() { logDirty = true; }
function flushLog() {
  if (logDirty) {
    fs.writeFileSync(LOG_FILE, JSON.stringify(logData, null, 2));
    logDirty = false;
  }
}
const logInterval = setInterval(flushLog, 2000);
function saveLog() { markLogDirty(); }

function appendFailure(filename, error) {
  fs.appendFileSync(FAILURES_FILE, `${filename}\t${error}\t${new Date().toISOString()}\n`);
}

function loadFailuresList() {
  if (!fs.existsSync(FAILURES_FILE)) return [];
  const lines = fs.readFileSync(FAILURES_FILE, 'utf8').trim().split('\n').filter(Boolean);
  return [...new Set(lines.map(l => l.split('\t')[0]))];
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

const TEMP_DIR = path.join(os.tmpdir(), 'si-transcode');
fs.mkdirSync(TEMP_DIR, { recursive: true });

// Detect hardware encoder once at startup
let HW_ENCODER = null;
try {
  const encoders = execSync('ffmpeg -hide_banner -encoders 2>&1', { encoding: 'utf8' });
  if (encoders.includes('h264_videotoolbox')) {
    HW_ENCODER = 'h264_videotoolbox';
    console.log('✅ Hardware encoder detected: Apple VideoToolbox');
  }
} catch {}
if (!HW_ENCODER) {
  console.log('ℹ️  No hardware encoder — using libx264 (software)');
}

// ── Bunny CDN Helpers ────────────────────────────────────────────────────

async function listAllFiles() {
  const url = `${STORAGE_HOST}/${STORAGE_ZONE}/`;
  const res = await fetch(url, { headers: { AccessKey: API_KEY } });
  if (!res.ok) throw new Error(`CDN list failed: ${res.status} ${await res.text()}`);
  const allFiles = await res.json();
  return allFiles
    .filter(f => !f.IsDirectory && f.ObjectName?.endsWith('.mp4'))
    .map(f => ({
      name: f.ObjectName,
      sizeMB: parseFloat((f.Length / 1048576).toFixed(1)),
    }));
}

async function downloadFile(remoteName, localPath) {
  const url = `${STORAGE_HOST}/${STORAGE_ZONE}/${remoteName}`;
  const res = await fetch(url, { headers: { AccessKey: API_KEY } });
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);
  const fileStream = createWriteStream(localPath);
  await pipeline(Readable.fromWeb(res.body), fileStream);
  return fs.statSync(localPath).size;
}

async function uploadFile(remoteName, localPath) {
  const fileSize = fs.statSync(localPath).size;
  const fileStream = createReadStream(localPath);
  const url = `${STORAGE_HOST}/${STORAGE_ZONE}/${remoteName}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      AccessKey: API_KEY,
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(fileSize),
    },
    body: fileStream,
    duplex: 'half',
  });
  if (!res.ok) throw new Error(`Upload failed: ${res.status} ${await res.text()}`);
  return fileSize;
}

// ── Probe & Transcode ────────────────────────────────────────────────────

function probeFile(filePath) {
  try {
    const result = execSync(
      `ffprobe -v error -show_entries stream=codec_name,codec_type,width,height -show_entries format=duration -of json "${filePath}"`,
      { encoding: 'utf8', timeout: 30000 }
    );
    const data = JSON.parse(result);
    const vs = data.streams?.find(s => s.codec_type === 'video');
    const as = data.streams?.find(s => s.codec_type === 'audio');
    return {
      videoCodec: vs?.codec_name || 'unknown',
      audioCodec: as?.codec_name || 'unknown',
      width: vs?.width || 0,
      height: vs?.height || 0,
      duration: Math.round(parseFloat(data.format?.duration || '0')),
    };
  } catch {
    return null;
  }
}

function runFfmpeg(args, timeoutMs = 7200000) {
  // Use spawnSync instead of execSync to avoid pipe-buffer issues that cause
  // incomplete MP4 files (moov atom not written) on long encodes.
  // stdio: 'ignore' stdout (progress lines), capture stderr for diagnostics.
  const result = spawnSync('ffmpeg', args, {
    stdio: ['ignore', 'ignore', 'pipe'],
    timeout: timeoutMs,
    maxBuffer: 50 * 1024 * 1024, // 50 MB stderr buffer
  });
  return {
    exitCode: result.status,
    stderr: result.stderr?.toString?.() || '',
    error: result.error, // timeout or spawn failure
  };
}

function transcodeToH264(inputPath, outputPath, info) {
  // Error-resilient input flags for VP9-in-MP4 containers that may have
  // timestamp issues, missing keyframes, or truncated streams from remux
  const inputFlags = [
    '-err_detect', 'ignore_err',
    '-fflags', '+genpts+discardcorrupt+igndts',
    '-analyzeduration', '100M',
    '-probesize', '100M',
  ];

  // Two-step approach:
  // 1) Transcode WITHOUT -movflags +faststart (faststart fails on VP9 files with corruption)
  // 2) Apply faststart via a quick copy-remux pass
  const tempRaw = outputPath.replace('.mp4', '.raw.mp4');

  // Helper: validate that an output file is usable H.264
  function validateOutput(filePath) {
    if (!fs.existsSync(filePath)) return false;
    const outSize = fs.statSync(filePath).size;
    if (outSize < 100000) return false;
    const outInfo = probeFile(filePath);
    return outInfo && outInfo.videoCodec === 'h264' && outInfo.duration > 30;
  }

  let transcodeSuccess = false;

  // Try hardware encoder first, fall back to software if it fails
  // Quality-preserving: use CRF-like quality targeting, NOT fixed bitrate.
  // VP9→H.264 at similar quality = expect ~30-50% larger file (H.264 is less efficient).
  // VideoToolbox: -q:v ranges 1-100 (lower = higher quality). ~50-55 ≈ CRF 20 (very good).
  // libx264: CRF 18 = visually lossless, CRF 20 = excellent, CRF 23 = good.
  if (HW_ENCODER === 'h264_videotoolbox') {
    const args = [
      ...inputFlags,
      '-i', inputPath,
      '-map', '0:v:0', '-map', '0:a:0?',
      '-c:v', 'h264_videotoolbox', '-q:v', '50', '-allow_sw', '1',
      '-c:a', 'aac', '-b:a', '128k',
      '-max_muxing_queue_size', '1024',
      '-y', tempRaw,
    ];
    const result = runFfmpeg(args);

    if (result.error) {
      console.log(`  ⚠️  VideoToolbox spawn/timeout error: ${result.error.message}`);
    } else if (validateOutput(tempRaw)) {
      if (result.exitCode !== 0) {
        const outMB = (fs.statSync(tempRaw).size / 1048576).toFixed(1);
        console.log(`  ⚠️  VideoToolbox exit ${result.exitCode} but output valid (${outMB} MB) — accepting`);
      }
      transcodeSuccess = true;
    } else {
      console.log(`  ⚠️  VideoToolbox failed (exit ${result.exitCode}), falling back to libx264`);
      if (fs.existsSync(tempRaw)) try { fs.unlinkSync(tempRaw); } catch {}
    }
  }

  // Software fallback
  if (!transcodeSuccess) {
    const args = [
      ...inputFlags,
      '-i', inputPath,
      '-map', '0:v:0', '-map', '0:a:0?',
      '-c:v', 'libx264', '-preset', 'slow', '-crf', '18',
      '-c:a', 'aac', '-b:a', '128k',
      '-max_muxing_queue_size', '1024',
      '-y', tempRaw,
    ];
    const result = runFfmpeg(args);

    if (result.error) {
      throw new Error(`ffmpeg spawn/timeout error: ${result.error.message}`);
    }

    if (validateOutput(tempRaw)) {
      if (result.exitCode !== 0) {
        const outMB = (fs.statSync(tempRaw).size / 1048576).toFixed(1);
        console.log(`  ⚠️  libx264 exit ${result.exitCode} but output valid (${outMB} MB) — accepting`);
      }
      transcodeSuccess = true;
    } else {
      const errTail = result.stderr.slice(-300);
      if (fs.existsSync(tempRaw)) try { fs.unlinkSync(tempRaw); } catch {}
      throw new Error(`Transcode failed (exit ${result.exitCode}): ${errTail}`);
    }
  }

  // Step 2: Apply faststart via quick copy-remux (moves moov atom to front for streaming)
  const fsResult = runFfmpeg(['-i', tempRaw, '-c', 'copy', '-movflags', '+faststart', '-y', outputPath], 300000);
  if (fsResult.exitCode === 0 && fs.existsSync(outputPath)) {
    // Clean up intermediate raw file
    if (fs.existsSync(tempRaw)) try { fs.unlinkSync(tempRaw); } catch {}
  } else {
    // If faststart remux fails, just use the raw file — it's still valid H.264
    console.log(`  ⚠️  Faststart remux failed — using file without faststart (still playable)`);
    fs.renameSync(tempRaw, outputPath);
  }
}

function fixAudioOnly(inputPath, outputPath) {
  // Video copy, just re-encode audio to AAC — two-step for faststart safety
  const tempRaw = outputPath.replace('.mp4', '.raw.mp4');
  const cmd = `ffmpeg -i "${inputPath}" -c:v copy -c:a aac -b:a 128k -y "${tempRaw}"`;
  execSync(cmd, { stdio: 'pipe', timeout: 600000 });
  try {
    execSync(`ffmpeg -i "${tempRaw}" -c copy -movflags +faststart -y "${outputPath}"`, { stdio: 'pipe', timeout: 300000 });
    if (fs.existsSync(tempRaw)) try { fs.unlinkSync(tempRaw); } catch {}
  } catch {
    fs.renameSync(tempRaw, outputPath);
  }
}

// ── Build Queue ──────────────────────────────────────────────────────────

async function buildQueue() {
  let queue;

  if (RETRY_FAILURES) {
    const failures = loadFailuresList();
    console.log(`Retrying ${failures.length} previously failed files`);
    queue = failures.map(name => ({ name, sizeMB: 0 }));
  } else {
    console.log(`Fetching file list from CDN...`);
    queue = await listAllFiles();
    console.log(`Found ${queue.length} MP4 files on CDN`);
  }

  // Skip already-completed files (unless FORCE_ALL)
  if (!FORCE_ALL) {
    const before = queue.length;
    queue = queue.filter(f => {
      const entry = logData.files[f.name];
      return !(entry?.status === 'transcoded' || entry?.status === 'already_ok');
    });
    const skipped = before - queue.length;
    if (skipped > 0) console.log(`Skipping ${skipped} already-processed files`);
  }

  if (START_AFTER) {
    const idx = queue.findIndex(f => f.name === START_AFTER);
    if (idx >= 0) {
      queue = queue.slice(idx + 1);
      console.log(`Resuming after ${START_AFTER}, ${queue.length} remaining`);
    }
  }

  if (LIMIT > 0) {
    queue = queue.slice(0, LIMIT);
    console.log(`Limited to ${queue.length} files`);
  }

  return queue;
}

// ── Process Single File ──────────────────────────────────────────────────

async function processFile(file, index, total) {
  const t0 = Date.now();
  const { name, sizeMB: cdnSizeMB } = file;
  const inputPath = path.join(TEMP_DIR, `in_${name}`);
  const outputPath = path.join(TEMP_DIR, `out_${name}`);

  console.log(`\n[${index + 1}/${total}] ${name} (${cdnSizeMB} MB)`);

  try {
    // Step 1: Download from CDN
    console.log(`  📥 Downloading from CDN...`);
    const dlStart = Date.now();
    await downloadFile(name, inputPath);
    const dlSec = ((Date.now() - dlStart) / 1000).toFixed(1);
    const dlMB = (fs.statSync(inputPath).size / 1048576).toFixed(1);
    console.log(`  📦 Downloaded: ${dlMB} MB in ${dlSec}s`);

    // Step 2: Probe codec
    const info = probeFile(inputPath);
    if (!info) throw new Error('ffprobe failed — corrupted file?');

    const { videoCodec, audioCodec, width, height, duration } = info;
    const resolution = `${width}x${height}`;
    console.log(`  📋 ${videoCodec} | ${audioCodec} | ${resolution} | ${Math.round(duration / 60)}min`);

    const needsVideoTranscode = videoCodec !== 'h264';
    const needsAudioFix = audioCodec !== 'aac' && audioCodec !== 'unknown';
    const needsWork = needsVideoTranscode || needsAudioFix;

    if (DRY_RUN) {
      const tag = needsVideoTranscode ? `⚠️  VP9→H.264 needed` :
                  needsAudioFix ? `⚠️  Audio ${audioCodec}→AAC needed` :
                  `✅ Already H.264+AAC`;
      console.log(`  ${tag} [DRY RUN]`);
      logData.files[name] = {
        status: needsWork ? 'needs_transcode' : 'already_ok',
        videoCodec, audioCodec, resolution, duration,
        checkedAt: new Date().toISOString(),
      };
      saveLog();
      // Clean up
      if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
      return { name, status: needsWork ? 'needs_transcode' : 'already_ok', needsVideoTranscode };
    }

    if (!needsWork) {
      console.log(`  ✅ Already H.264+AAC — skipping`);
      logData.files[name] = {
        status: 'already_ok',
        videoCodec, audioCodec, resolution, duration,
        checkedAt: new Date().toISOString(),
      };
      saveLog();
      if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
      return { name, status: 'already_ok' };
    }

    // Step 3: Transcode
    const txStart = Date.now();
    if (needsVideoTranscode) {
      const encoder = HW_ENCODER || 'libx264';
      console.log(`  🔧 Transcoding ${videoCodec}→h264 (${encoder}) + AAC...`);
      fs.appendFileSync(VP9_LOG_FILE,
        `${name}\t${videoCodec}\t${audioCodec}\t${resolution}\t${duration}s\t${cdnSizeMB}MB\t${new Date().toISOString()}\n`
      );
      transcodeToH264(inputPath, outputPath, info);
    } else {
      console.log(`  🔧 Fixing audio: ${audioCodec}→AAC (video: copy)...`);
      fixAudioOnly(inputPath, outputPath);
    }
    const txSec = ((Date.now() - txStart) / 1000).toFixed(1);
    const outMB = (fs.statSync(outputPath).size / 1048576).toFixed(1);
    console.log(`  🔄 Transcoded: ${dlMB} MB → ${outMB} MB in ${txSec}s`);

    // Step 4: Upload
    if (!SKIP_UPLOAD) {
      console.log(`  📤 Uploading ${outMB} MB to CDN...`);
      const ulStart = Date.now();
      await uploadFile(name, outputPath);
      const ulSec = ((Date.now() - ulStart) / 1000).toFixed(1);
      console.log(`  ✅ Uploaded in ${ulSec}s`);
    } else {
      console.log(`  ⏭️  Skipping upload (SKIP_UPLOAD=1)`);
    }

    // Cleanup
    if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);

    const totalSec = ((Date.now() - t0) / 1000).toFixed(1);
    logData.files[name] = {
      status: 'transcoded',
      originalCodec: videoCodec,
      originalAudio: audioCodec,
      newSizeMB: parseFloat(outMB),
      oldSizeMB: cdnSizeMB,
      resolution, duration,
      transcodeSec: parseFloat(txSec),
      totalSec: parseFloat(totalSec),
      completedAt: new Date().toISOString(),
    };
    saveLog();

    console.log(`  🎬 Done in ${totalSec}s`);
    return { name, status: 'transcoded', sizeMB: parseFloat(outMB), needsVideoTranscode };

  } catch (err) {
    // Extract ffmpeg stderr from execSync errors for better diagnostics
    const stderr = err.stderr?.toString?.()?.slice(-300) || '';
    const errMsg = stderr || err.message.slice(0, 500);
    console.error(`  ❌ Error: ${errMsg.slice(0, 300)}`);
    logData.files[name] = {
      status: 'error',
      error: errMsg.slice(0, 500),
      failedAt: new Date().toISOString(),
    };
    saveLog();
    appendFailure(name, errMsg.slice(0, 200));

    // Cleanup (including possible intermediate .raw.mp4 files)
    const rawPath = outputPath.replace('.mp4', '.raw.mp4');
    for (const p of [inputPath, outputPath, rawPath]) {
      if (fs.existsSync(p)) try { fs.unlinkSync(p); } catch {}
    }
    return { name, status: 'error' };
  }
}

// ── Main ─────────────────────────────────────────────────────────────────

async function main() {
  console.log('╔════════════════════════════════════════════════════╗');
  console.log('║  SermonIndex — Transcode CDN Videos VP9 → H.264   ║');
  console.log('╚════════════════════════════════════════════════════╝');
  console.log();
  console.log(`Storage zone:  ${STORAGE_ZONE}`);
  console.log(`Encoder:       ${HW_ENCODER || 'libx264 (software)'}`);
  console.log(`Concurrency:   ${CONCURRENCY}`);
  console.log(`Temp dir:      ${TEMP_DIR}`);
  if (DRY_RUN) console.log(`Mode:          DRY RUN (probe only)`);
  if (SKIP_UPLOAD) console.log(`Mode:          SKIP UPLOAD`);
  console.log();

  const queue = await buildQueue();

  if (queue.length === 0) {
    console.log('Nothing to process!');
    clearInterval(logInterval);
    return;
  }

  console.log(`\nProcessing ${queue.length} files (concurrency: ${CONCURRENCY})...\n`);

  const results = { transcoded: 0, already_ok: 0, needs_transcode: 0, error: 0 };
  let totalOutMB = 0;
  let vp9Count = 0;
  const t0 = Date.now();

  let cursor = 0;
  async function worker() {
    while (cursor < queue.length) {
      const idx = cursor++;
      const file = queue[idx];
      const result = await processFile(file, idx, queue.length);
      results[result.status] = (results[result.status] || 0) + 1;
      if (result.sizeMB) totalOutMB += result.sizeMB;
      if (result.needsVideoTranscode) vp9Count++;
    }
  }

  const workers = [];
  for (let i = 0; i < Math.min(CONCURRENCY, queue.length); i++) {
    workers.push(worker());
  }
  await Promise.all(workers);

  flushLog();
  clearInterval(logInterval);

  const totalMin = ((Date.now() - t0) / 60000).toFixed(1);

  console.log();
  console.log('════════════════════════════════════════════════════');
  console.log('  SUMMARY');
  console.log('════════════════════════════════════════════════════');
  console.log(`  Transcoded (VP9→H.264):  ${results.transcoded}`);
  console.log(`  Already H.264+AAC:       ${results.already_ok}`);
  console.log(`  VP9/AV1 found:           ${vp9Count}`);
  if (results.needs_transcode) console.log(`  Needs transcode (dry):   ${results.needs_transcode}`);
  console.log(`  Errors:                  ${results.error}`);
  console.log(`  Total output:            ${(totalOutMB / 1024).toFixed(1)} GB`);
  console.log(`  Duration:                ${totalMin} min`);
  console.log();
  console.log(`  Log:       ${LOG_FILE}`);
  if (vp9Count > 0) console.log(`  VP9 list:  ${VP9_LOG_FILE}`);
  if (results.error) console.log(`  Failures:  ${FAILURES_FILE}`);
  console.log('════════════════════════════════════════════════════');

  logData.summary = {
    ...results, vp9Count,
    totalOutGB: parseFloat((totalOutMB / 1024).toFixed(2)),
    durationMin: parseFloat(totalMin),
    finishedAt: new Date().toISOString(),
  };
  fs.writeFileSync(LOG_FILE, JSON.stringify(logData, null, 2));
}

main().catch(err => {
  console.error('Fatal error:', err);
  flushLog();
  clearInterval(logInterval);
  process.exit(1);
});
