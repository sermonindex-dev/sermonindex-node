#!/usr/bin/env node
/**
 * SermonIndex Master-List Signer
 * ==============================
 * Produces a DETACHED ed25519 signature over the RAW BYTES of master-list.json
 * and writes it next to the file as `master-list.json.sig` (base64, single line).
 *
 * Raw-bytes (not canonicalized-JSON) signing is deliberate: the app verifies the
 * exact bytes it received off the CDN, so there is no JSON canonicalization
 * mismatch to exploit. Do NOT reformat/re-serialize master-list.json after
 * signing — any byte change invalidates the signature.
 *
 * Usage:
 *   node scripts/sign-master-list.mjs
 *   node scripts/sign-master-list.mjs --out canonical-output
 *   node scripts/sign-master-list.mjs --key /path/to/masterlist.key
 *
 * Requires scripts/masterlist.key (see gen-masterlist-key.mjs). Exits non-zero
 * if the key is missing, so it's safe to chain in a release script.
 */

import { createPrivateKey, sign as edSign } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const getArg = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};

const OUT_DIR = getArg('out', join(__dirname, '..', 'canonical-output'));
const KEY_PATH = getArg('key', join(__dirname, 'masterlist.key'));

/**
 * Sign `<dir>/master-list.json` -> `<dir>/master-list.json.sig`.
 * Returns the base64 signature, or null when signing was skipped (missing key
 * or missing master list). Never throws for the "not configured yet" cases so
 * the torrent generator can call it without risking a crash mid-run.
 */
export function signMasterList(outDir = OUT_DIR, keyPath = KEY_PATH) {
  const masterPath = join(outDir, 'master-list.json');
  const sigPath = `${masterPath}.sig`;

  if (!existsSync(masterPath)) {
    console.warn(`[sign] No master-list.json at ${masterPath} — nothing to sign.`);
    return null;
  }
  if (!existsSync(keyPath)) {
    console.warn('');
    console.warn('[sign] ⚠  SIGNING KEY MISSING — master-list.json is NOT signed.');
    console.warn(`[sign]    Expected: ${keyPath}`);
    console.warn('[sign]    Generate one with: node scripts/gen-masterlist-key.mjs');
    console.warn('[sign]    Nodes running a verifying build will REJECT an unsigned list.');
    console.warn('');
    return null;
  }

  const bytes = readFileSync(masterPath); // raw bytes — exactly what the CDN serves
  const key = createPrivateKey(readFileSync(keyPath));
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new Error(`Key at ${keyPath} is ${key.asymmetricKeyType}, expected ed25519`);
  }
  // ed25519 signs the message directly — algorithm arg must be null.
  const sigB64 = edSign(null, bytes, key).toString('base64');
  writeFileSync(sigPath, `${sigB64}\n`);

  console.log(`[sign] master-list.json signed (${bytes.length} bytes) → ${sigPath}`);
  return sigB64;
}

// Direct invocation (not when imported by the generator)
if (process.argv[1] && process.argv[1].endsWith('sign-master-list.mjs')) {
  const sig = signMasterList();
  if (!sig) process.exit(1);
  console.log('[sign] Remember to upload BOTH master-list.json and master-list.json.sig,');
  console.log('[sign] then purge them on the CDN.');
}
