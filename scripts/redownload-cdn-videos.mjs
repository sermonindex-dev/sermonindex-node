#!/usr/bin/env node
/**
 * Re-download VP9 videos from YouTube as H.264 MP4
 *
 * The previous remux script copied VP9 video streams into MP4 containers,
 * which Safari/WKWebView/QuickTime cannot play. This script:
 *
 *   1. Reads the list of VP9 YouTube IDs from remux-log.json (status=remuxed)
 *   2. Downloads each video from YouTube in H.264+AAC format via yt-dlp
 *   3. Uploads the fresh H.264 MP4 to Bunny CDN, replacing the VP9 version
 *
 * Requirements:
 *   - Node.js 18+
 *   - yt-dlp installed (brew install yt-dlp)
 *   - ffmpeg installed (brew install ffmpeg) — needed by yt-dlp for muxing
 *   - Bunny CDN Storage Zone password
 *
 * Usage:
 *   BUNNY_API_KEY=your-key node scripts/redownload-cdn-videos.mjs
 *
 * Optional env vars:
 *   BUNNY_STORAGE_ZONE=sermonindex2   — storage zone name (default: sermonindex-video)
 *   BUNNY_STORAGE_REGION=de           — regional endpoint (default: main/Falkenstein)
 *   DRY_RUN=1                         — check YouTube availability without downloading
 *   LIMIT=10                          — only process first N files
 *   START_AFTER=youtubeId             — resume after a specific YouTube ID
 *   CONCURRENCY=2                     — parallel downloads (default: 2, be gentle to YouTube)
 *   RETRY_FAILURES=1                  — only retry files from redownload-failures.txt
 *   SKIP_UPLOAD=1                     — download only, don't upload (for testing)
 *   MAX_RESOLUTION=1080               — max resolution to download (default: 1080)
 */

import { execSync, spawn } from 'child_process';
import fs from 'fs';
import { createReadStream } from 'fs';
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
const CONCURRENCY = parseInt(process.env.CONCURRENCY || '2', 10);
const RETRY_FAILURES = process.env.RETRY_FAILURES === '1';
const SKIP_UPLOAD = process.env.SKIP_UPLOAD === '1';
const MAX_RESOLUTION = parseInt(process.env.MAX_RESOLUTION || '1080', 10);

// ── Log files ────────────────────────────────────────────────────────────

const REMUX_LOG_FILE = path.join(__dirname, 'remux-log.json');
const LOG_FILE = path.join(__dirname, 'redownload-log.json');
const FAILURES_FILE = path.join(__dirname, 'redownload-failures.txt');
const VP9_LOG_FILE = path.join(__dirname, 'redownload-vp9-transcoded.txt'); // spot-check list
const UNAVAILABLE_FILE = path.join(__dirname, 'redownload-unavailable.txt'); // videos gone from YouTube
const DOWNGRADE_FILE = path.join(__dirname, 'redownload-downgraded.txt'); // files that got smaller

// Load remux log for reference (optional — script can work without it)
let remuxLog = { files: {} };
if (fs.existsSync(REMUX_LOG_FILE)) {
  try { remuxLog = JSON.parse(fs.readFileSync(REMUX_LOG_FILE, 'utf8')); } catch {}
}

// CDN file list cache — avoids re-fetching from API on restart
const CDN_FILES_CACHE = path.join(__dirname, 'cdn-video-files.json');

// Load or create redownload log
let logData = { started: new Date().toISOString(), files: {}, summary: {} };
if (fs.existsSync(LOG_FILE)) {
  try { logData = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8')); } catch {}
}

// Batch log writes
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

function appendFailure(youtubeId, error) {
  fs.appendFileSync(FAILURES_FILE, `${youtubeId}\t${error}\t${new Date().toISOString()}\n`);
}

function loadFailuresList() {
  if (!fs.existsSync(FAILURES_FILE)) return [];
  const lines = fs.readFileSync(FAILURES_FILE, 'utf8').trim().split('\n').filter(Boolean);
  const names = new Set(lines.map(l => l.split('\t')[0]));
  return [...names];
}

// ── Validation ───────────────────────────────────────────────────────────

if (!API_KEY && !SKIP_UPLOAD) {
  console.error('Error: BUNNY_API_KEY environment variable is required (or set SKIP_UPLOAD=1)');
  process.exit(1);
}

try {
  execSync('yt-dlp --version', { stdio: 'pipe' });
} catch {
  console.error('Error: yt-dlp is not installed. Install with: brew install yt-dlp');
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

const TEMP_DIR = path.join(os.tmpdir(), 'si-redownload');
fs.mkdirSync(TEMP_DIR, { recursive: true });

// ── Bunny CDN Helpers ────────────────────────────────────────────────────

/** List all files in the Bunny CDN storage zone */
async function listAllCDNFiles() {
  // Check cache first (valid for 1 hour)
  if (fs.existsSync(CDN_FILES_CACHE)) {
    try {
      const cached = JSON.parse(fs.readFileSync(CDN_FILES_CACHE, 'utf8'));
      const age = Date.now() - new Date(cached.fetchedAt).getTime();
      if (age < 3600000) { // 1 hour
        console.log(`Using cached CDN file list (${cached.files.length} files, ${Math.round(age / 60000)} min old)`);
        return cached.files;
      }
    } catch {}
  }

  console.log(`Fetching file list from Bunny CDN storage zone: ${STORAGE_ZONE}...`);
  const url = `${STORAGE_HOST}/${STORAGE_ZONE}/`;
  const res = await fetch(url, {
    headers: { AccessKey: API_KEY },
  });
  if (!res.ok) throw new Error(`CDN list failed: ${res.status} ${await res.text()}`);
  const allFiles = await res.json();

  // Filter to .mp4 files only
  const mp4Files = allFiles
    .filter(f => !f.IsDirectory && f.ObjectName?.endsWith('.mp4'))
    .map(f => ({
      name: f.ObjectName,
      sizeMB: parseFloat((f.Length / 1048576).toFixed(1)),
      youtubeId: f.ObjectName.replace('.mp4', ''),
    }));

  console.log(`Found ${mp4Files.length} MP4 files on CDN (${allFiles.length} total objects)`);

  // Cache the list
  fs.writeFileSync(CDN_FILES_CACHE, JSON.stringify({
    fetchedAt: new Date().toISOString(),
    totalObjects: allFiles.length,
    files: mp4Files,
  }, null, 2));

  return mp4Files;
}

/** Check first 12 bytes of a CDN file to detect VP9 vs H.264 via Range request */
async function probeCodecRemote(filename) {
  // Download first 64KB and probe with ffprobe
  const url = `${STORAGE_HOST}/${STORAGE_ZONE}/${filename}`;
  const tmpProbe = path.join(TEMP_DIR, `probe_${filename}`);

  try {
    const res = await fetch(url, {
      headers: { AccessKey: API_KEY, Range: 'bytes=0-65535' },
    });
    if (!res.ok) return 'unknown';
    const data = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(tmpProbe, data);

    // ffprobe on partial file — may fail but worth trying
    const result = execSync(
      `ffprobe -v error -select_streams v:0 -show_entries stream=codec_name -of csv=p=0 "${tmpProbe}"`,
      { encoding: 'utf8', timeout: 10000 }
    ).trim();
    return result || 'unknown';
  } catch {
    return 'unknown';
  } finally {
    try { fs.unlinkSync(tmpProbe); } catch {}
  }
}

// ── Bunny CDN Upload ─────────────────────────────────────────────────────

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
    body: fileStream,
    duplex: 'half',
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Upload failed: ${res.status} ${text}`);
  }
  return fileSize;
}

// ── YouTube Download ─────────────────────────────────────────────────────

/**
 * Download the BEST quality video from YouTube, regardless of codec.
 *
 * Strategy: grab the highest-quality video + best audio available.
 * If it comes back as VP9/AV1 we'll transcode to H.264 in the next step.
 * This avoids the trap of requesting H.264-only — YouTube only keeps
 * H.264 at low resolutions (360p/480p), so you'd lose quality.
 *
 * Returns the output file path, or throws on failure.
 */
function downloadFromYouTube(youtubeId, outputPath) {
  return new Promise((resolve, reject) => {
    const url = `https://www.youtube.com/watch?v=${youtubeId}`;

    // Download the BEST quality video available, any codec.
    // We'll transcode VP9/AV1 to H.264 in the next step if needed.
    // Priority: highest resolution first, then prefer H.264 if tied.
    const formatStr = `bestvideo[height<=${MAX_RESOLUTION}]+bestaudio/best[height<=${MAX_RESOLUTION}]/best`;

    const args = [
      '-f', formatStr,
      '--merge-output-format', 'mp4',
      // Ensure the output is proper MP4 with faststart
      '--postprocessor-args', 'ffmpeg:-movflags +faststart',
      '--no-playlist',
      // Force overwrite — temp files may exist from previous runs
      '--force-overwrites',
      '-o', outputPath,
      '--retries', '3',
      '--socket-timeout', '30',
      // Print chosen format for debugging
      '--print', 'before_dl:format_id:%(format_id)s vcodec:%(vcodec)s res:%(resolution)s',
      // Don't download subtitles, thumbnails, etc.
      '--no-write-thumbnail',
      '--no-write-subs',
      url,
    ];

    const proc = spawn('yt-dlp', args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => {
      const line = d.toString();
      stdout += line;
      // Print format selection info in realtime
      if (line.includes('format_id:') || line.includes('vcodec:')) {
        process.stdout.write(`  📺 ${line.trim()}\n`);
      }
    });
    proc.stderr.on('data', d => { stderr += d.toString(); });

    // 10 minute timeout per video
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error('yt-dlp timeout (10 min)'));
    }, 600000);

    proc.on('close', code => {
      clearTimeout(timer);
      if (code === 0 && fs.existsSync(outputPath)) {
        resolve(outputPath);
      } else {
        reject(new Error(`yt-dlp exit ${code}: ${stderr.slice(-500)}`));
      }
    });

    proc.on('error', err => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * Check if a YouTube video is available (quick HEAD-like check)
 */
async function checkYouTubeAvailability(youtubeId) {
  try {
    const url = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${youtubeId}&format=json`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Probe the video codec, resolution, and audio codec of a downloaded file.
 * Returns { videoCodec, audioCodec, width, height, duration } or null on failure.
 */
function probeFile(filePath) {
  try {
    const result = execSync(
      `ffprobe -v error -show_entries stream=codec_name,codec_type,width,height -show_entries format=duration -of json "${filePath}"`,
      { encoding: 'utf8', timeout: 15000 }
    );
    const data = JSON.parse(result);
    const videoStream = data.streams?.find(s => s.codec_type === 'video');
    const audioStream = data.streams?.find(s => s.codec_type === 'audio');
    const duration = parseFloat(data.format?.duration || '0');
    return {
      videoCodec: videoStream?.codec_name || 'unknown',
      audioCodec: audioStream?.codec_name || 'unknown',
      width: videoStream?.width || 0,
      height: videoStream?.height || 0,
      duration: Math.round(duration),
    };
  } catch {
    return null;
  }
}

function appendVP9Log(youtubeId, info) {
  const line = `${youtubeId}\t${info.videoCodec}\t${info.width}x${info.height}\t${info.duration}s\t${new Date().toISOString()}\n`;
  fs.appendFileSync(VP9_LOG_FILE, line);
}

// ── Build Work Queue ─────────────────────────────────────────────────────

async function buildQueue() {
  // Queue items are { youtubeId, cdnSizeMB } so we can compare sizes
  let queue = [];

  if (RETRY_FAILURES) {
    const failures = loadFailuresList();
    console.log(`Retrying ${failures.length} previously failed downloads`);
    queue = failures.map(id => ({ youtubeId: id, cdnSizeMB: 0 }));
  } else {
    // Pull ALL files from Bunny CDN storage zone
    const cdnFiles = await listAllCDNFiles();

    // Re-download ALL files — even ones that were already H.264 —
    // to get the best quality YouTube currently offers
    for (const file of cdnFiles) {
      queue.push({ youtubeId: file.youtubeId, cdnSizeMB: file.sizeMB });
    }
    console.log(`Total MP4 files on CDN: ${queue.length}`);
  }

  // Only skip files we've already completed in THIS redownload run
  const before = queue.length;
  queue = queue.filter(item => {
    const entry = logData.files[item.youtubeId];
    if (entry?.status === 'completed') {
      return false;
    }
    return true;
  });
  const skipped = before - queue.length;
  if (skipped > 0) {
    console.log(`Skipping ${skipped} already-completed re-downloads, ${queue.length} remaining`);
  }

  // Apply START_AFTER
  if (START_AFTER) {
    const idx = queue.findIndex(item => item.youtubeId === START_AFTER);
    if (idx >= 0) {
      queue = queue.slice(idx + 1);
      console.log(`Resuming after ${START_AFTER}, ${queue.length} remaining`);
    }
  }

  // Apply LIMIT
  if (LIMIT > 0) {
    queue = queue.slice(0, LIMIT);
    console.log(`Limited to ${queue.length} files`);
  }

  return queue;
}

// ── Process Single Video ─────────────────────────────────────────────────

async function processVideo(youtubeId, cdnSizeMB, index, total) {
  const t0 = Date.now();
  const filename = `${youtubeId}.mp4`;
  const tempPath = path.join(TEMP_DIR, filename);

  console.log(`\n[${index + 1}/${total}] ${youtubeId} (CDN: ${cdnSizeMB} MB)`);

  try {
    // Step 1: Check YouTube availability
    const available = await checkYouTubeAvailability(youtubeId);
    if (!available) {
      console.log(`  ❌ Video unavailable on YouTube — skipping`);
      fs.appendFileSync(UNAVAILABLE_FILE, `${youtubeId}\thttps://www.youtube.com/watch?v=${youtubeId}\t${new Date().toISOString()}\n`);
      logData.files[youtubeId] = {
        status: 'unavailable',
        reason: 'YouTube video not available',
        checkedAt: new Date().toISOString(),
      };
      saveLog();
      return { id: youtubeId, status: 'unavailable' };
    }

    if (DRY_RUN) {
      console.log(`  ✅ Available on YouTube [DRY RUN]`);
      logData.files[youtubeId] = { status: 'available_dry_run', checkedAt: new Date().toISOString() };
      saveLog();
      return { id: youtubeId, status: 'dry_run' };
    }

    // Step 2: Download best quality from YouTube
    console.log(`  📥 Downloading best quality from YouTube...`);
    const dlStart = Date.now();

    // Clean up any previous temp file
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);

    await downloadFromYouTube(youtubeId, tempPath);

    if (!fs.existsSync(tempPath)) {
      throw new Error('Download completed but output file not found');
    }

    const fileSizeMB = (fs.statSync(tempPath).size / 1048576).toFixed(1);
    const dlSec = ((Date.now() - dlStart) / 1000).toFixed(1);
    console.log(`  📦 Downloaded: ${fileSizeMB} MB in ${dlSec}s`);

    // Step 3: Probe codec, resolution, duration
    const probeInfo = probeFile(tempPath);
    const videoCodec = probeInfo?.videoCodec || 'unknown';
    const audioCodec = probeInfo?.audioCodec || 'unknown';
    const resolution = probeInfo ? `${probeInfo.width}x${probeInfo.height}` : '?x?';
    const duration = probeInfo?.duration || 0;
    let wasTranscoded = false;
    let originalCodec = videoCodec;

    console.log(`  📋 Codec: ${videoCodec} | Audio: ${audioCodec} | ${resolution} | ${duration}s`);

    const needsVideoTranscode = videoCodec !== 'h264';
    const needsAudioTranscode = audioCodec !== 'aac';
    const needsTranscode = needsVideoTranscode || needsAudioTranscode;

    if (needsTranscode) {
      const reasons = [];
      if (needsVideoTranscode) reasons.push(`video ${videoCodec}→h264`);
      if (needsAudioTranscode) reasons.push(`audio ${audioCodec}→aac`);
      console.log(`  ⚠️  Needs transcode: ${reasons.join(', ')} (${resolution})`);

      if (needsVideoTranscode) {
        appendVP9Log(youtubeId, probeInfo);
      }
      wasTranscoded = true;

      const transcodedPath = tempPath + '.h264.mp4';
      const txStart = Date.now();

      // Video codec: copy if already H.264, otherwise encode
      // Audio codec: always encode to AAC for Safari/WKWebView compatibility
      let videoArgs, hwLabel;
      if (needsVideoTranscode) {
        // Try hardware-accelerated encoding first (Apple Silicon VideoToolbox)
        try {
          execSync('ffmpeg -hide_banner -encoders 2>&1 | grep h264_videotoolbox', { stdio: 'pipe' });
          videoArgs = '-c:v h264_videotoolbox -q:v 65 -allow_sw 1';
          hwLabel = 'VideoToolbox';
        } catch {
          videoArgs = '-c:v libx264 -preset fast -crf 23';
          hwLabel = 'libx264';
        }
        console.log(`  🔧 Using ${hwLabel} for video`);
      } else {
        videoArgs = '-c:v copy';
        hwLabel = 'copy';
        console.log(`  🔧 Video: copy (already H.264) | Audio: re-encoding to AAC`);
      }

      const transcodeCmd = `ffmpeg -i "${tempPath}" ${videoArgs} -c:a aac -b:a 128k -movflags +faststart -y "${transcodedPath}"`;
      execSync(transcodeCmd, { stdio: 'pipe', timeout: 3600000 }); // 60 min timeout for large files
      const txSec = ((Date.now() - txStart) / 1000).toFixed(1);
      fs.unlinkSync(tempPath);
      fs.renameSync(transcodedPath, tempPath);
      const newSizeMB = (fs.statSync(tempPath).size / 1048576).toFixed(1);
      console.log(`  🔄 Transcoded: ${fileSizeMB} MB → ${newSizeMB} MB in ${txSec}s`);
    } else {
      console.log(`  ✅ H.264+AAC ${resolution} — no transcode needed`);
    }

    // Step 4: Size comparison — warn if new file is much smaller than CDN original
    const finalSize = fs.statSync(tempPath).size;
    const finalSizeMB = parseFloat((finalSize / 1048576).toFixed(1));
    let wasDowngraded = false;

    if (cdnSizeMB > 0 && finalSizeMB < cdnSizeMB * 0.5) {
      // New file is less than 50% of original — likely a quality downgrade
      wasDowngraded = true;
      console.log(`  🚨 DOWNGRADE WARNING: ${finalSizeMB} MB vs CDN ${cdnSizeMB} MB (${Math.round(finalSizeMB / cdnSizeMB * 100)}% of original)`);
      fs.appendFileSync(DOWNGRADE_FILE,
        `${youtubeId}\tcdn:${cdnSizeMB}MB\tnew:${finalSizeMB}MB\t${resolution}\t${videoCodec}\t${duration}s\t${new Date().toISOString()}\n`
      );
    } else if (cdnSizeMB > 0) {
      const pct = Math.round(finalSizeMB / cdnSizeMB * 100);
      console.log(`  📊 Size: ${finalSizeMB} MB vs CDN ${cdnSizeMB} MB (${pct}%)`);
    }

    // Step 5: Upload to Bunny CDN (skip downgraded files — keep the original)
    if (wasDowngraded && !SKIP_UPLOAD) {
      console.log(`  ⏭️  Skipping upload — would downgrade quality. Review in ${path.basename(DOWNGRADE_FILE)}`);
    } else if (!SKIP_UPLOAD) {
      console.log(`  📤 Uploading ${finalSizeMB} MB to CDN...`);
      const ulStart = Date.now();
      await uploadFile(`/${filename}`, tempPath);
      const ulSec = ((Date.now() - ulStart) / 1000).toFixed(1);
      console.log(`  ✅ Uploaded in ${ulSec}s`);
    } else {
      console.log(`  ⏭️  Skipping upload (SKIP_UPLOAD=1)`);
    }

    // Step 6: Clean up temp file
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);

    const totalSec = ((Date.now() - t0) / 1000).toFixed(1);

    logData.files[youtubeId] = {
      status: 'completed',
      sizeMB: finalSizeMB,
      cdnSizeMB,
      codec: 'h264',
      originalCodec,
      wasTranscoded,
      wasDowngraded,
      resolution,
      duration,
      audioCodec,
      downloadSec: parseFloat(dlSec),
      totalSec: parseFloat(totalSec),
      completedAt: new Date().toISOString(),
    };
    saveLog();

    const flag = wasTranscoded ? ` [TRANSCODED from ${originalCodec}]` : '';
    const dgFlag = wasDowngraded ? ' [DOWNGRADED — NOT UPLOADED]' : '';
    console.log(`  🎬 Done in ${totalSec}s — ${resolution} ${finalSizeMB} MB${flag}${dgFlag}`);
    return { id: youtubeId, status: 'completed', sizeMB: finalSizeMB, wasTranscoded, wasDowngraded };

  } catch (err) {
    console.error(`  ❌ Error: ${err.message.slice(0, 200)}`);
    logData.files[youtubeId] = {
      status: 'error',
      error: err.message.slice(0, 500),
      failedAt: new Date().toISOString(),
    };
    saveLog();
    appendFailure(youtubeId, err.message.slice(0, 200));

    // Clean up temp file on error
    if (fs.existsSync(tempPath)) {
      try { fs.unlinkSync(tempPath); } catch {}
    }

    return { id: youtubeId, status: 'error', error: err.message };
  }
}

// ── Main ─────────────────────────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║  SermonIndex — Re-download VP9 Videos as H.264 from YT ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log();
  console.log(`Storage zone:    ${STORAGE_ZONE}`);
  console.log(`Max resolution:  ${MAX_RESOLUTION}p`);
  console.log(`Concurrency:     ${CONCURRENCY}`);
  console.log(`Temp dir:        ${TEMP_DIR}`);
  if (DRY_RUN) console.log(`Mode:            DRY RUN (check availability only)`);
  if (SKIP_UPLOAD) console.log(`Mode:            SKIP UPLOAD (download only)`);
  console.log();

  const queue = await buildQueue();

  if (queue.length === 0) {
    console.log('Nothing to process!');
    clearInterval(logInterval);
    return;
  }

  console.log(`Processing ${queue.length} videos with concurrency ${CONCURRENCY}...`);
  console.log();

  const results = {
    completed: 0, unavailable: 0, error: 0, dry_run: 0,
  };
  let totalMB = 0;
  let transcodedCount = 0;
  let downgradedCount = 0;
  const t0 = Date.now();

  // Process with concurrency limit
  let cursor = 0;
  async function worker() {
    while (cursor < queue.length) {
      const idx = cursor++;
      const item = queue[idx];
      const result = await processVideo(item.youtubeId, item.cdnSizeMB, idx, queue.length);
      results[result.status] = (results[result.status] || 0) + 1;
      if (result.sizeMB) totalMB += result.sizeMB;
      if (result.wasTranscoded) transcodedCount++;
      if (result.wasDowngraded) downgradedCount++;
    }
  }

  const workers = [];
  for (let i = 0; i < Math.min(CONCURRENCY, queue.length); i++) {
    workers.push(worker());
  }
  await Promise.all(workers);

  // Final flush
  flushLog();
  clearInterval(logInterval);

  const totalMin = ((Date.now() - t0) / 60000).toFixed(1);

  console.log();
  console.log('════════════════════════════════════════════════════');
  console.log('  SUMMARY');
  console.log('════════════════════════════════════════════════════');
  console.log(`  Completed (H.264 direct):  ${results.completed - transcodedCount}`);
  console.log(`  Completed (transcoded):    ${transcodedCount}  ← spot-check these!`);
  console.log(`  Downgraded (NOT uploaded): ${downgradedCount}  ← YouTube quality lower than CDN`);
  console.log(`  Unavailable on YouTube:    ${results.unavailable}`);
  console.log(`  Errors:                    ${results.error}`);
  if (results.dry_run) console.log(`  Available (dry run):       ${results.dry_run}`);
  console.log(`  Total data:                ${(totalMB / 1024).toFixed(1)} GB`);
  console.log(`  Duration:                  ${totalMin} min`);
  console.log();
  console.log(`  Log:         ${LOG_FILE}`);
  if (transcodedCount > 0) {
    console.log(`  VP9 list:    ${VP9_LOG_FILE}  ← review these`);
  }
  if (downgradedCount > 0) {
    console.log(`  Downgrades:  ${DOWNGRADE_FILE}  ← kept CDN original`);
  }
  if (results.unavailable) console.log(`  Unavailable: ${UNAVAILABLE_FILE}  ← these need attention`);
  if (results.error) console.log(`  Failures:    ${FAILURES_FILE}`);
  console.log('════════════════════════════════════════════════════');

  // Save summary
  logData.summary = {
    ...results,
    transcoded: transcodedCount,
    downgraded: downgradedCount,
    h264Direct: results.completed - transcodedCount,
    totalGB: parseFloat((totalMB / 1024).toFixed(2)),
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
