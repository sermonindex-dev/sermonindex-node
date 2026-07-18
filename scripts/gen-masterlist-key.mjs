#!/usr/bin/env node
/**
 * SermonIndex Master-List Signing Keypair Generator
 * =================================================
 * Generates the ed25519 keypair used to sign `master-list.json`.
 *
 *   PRIVATE key -> scripts/masterlist.key   (PKCS#8 PEM, gitignored, KEEP OFFLINE)
 *   PUBLIC  key -> printed to stdout as base64 of the raw 32 bytes; paste it into
 *                  MASTER_LIST_PUBKEY_B64 in src-tauri/src/lib.rs
 *
 * Usage:
 *   node scripts/gen-masterlist-key.mjs            # refuses to overwrite an existing key
 *   node scripts/gen-masterlist-key.mjs --force    # overwrite (ROTATION — read SECURITY.md first)
 *
 * Rotating the key invalidates every previously published signature. The new
 * master-list.json.sig must be uploaded BEFORE shipping a build carrying the new
 * public key (verification fails closed). See SECURITY.md.
 */

import { generateKeyPairSync } from 'node:crypto';
import { writeFileSync, existsSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const KEY_PATH = join(__dirname, 'masterlist.key');
const FORCE = process.argv.slice(2).includes('--force');

if (existsSync(KEY_PATH) && !FORCE) {
  console.error(`Refusing to overwrite an existing key: ${KEY_PATH}`);
  console.error('If you really intend to ROTATE the signing key, re-run with --force');
  console.error('and read the key-rotation section of SECURITY.md first — every');
  console.error('previously published signature becomes invalid.');
  process.exit(1);
}

const { publicKey, privateKey } = generateKeyPairSync('ed25519');

// Private key: PKCS#8 PEM, owner-read-only.
const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
writeFileSync(KEY_PATH, privPem, { mode: 0o600 });
try { chmodSync(KEY_PATH, 0o600); } catch { /* non-POSIX filesystem — best effort */ }

// Public key: DER SPKI for ed25519 is a fixed 44-byte structure whose last 32
// bytes are the raw key. That raw form is what ed25519-dalek expects.
const spki = publicKey.export({ type: 'spki', format: 'der' });
const raw = spki.subarray(spki.length - 32);
const pubB64 = raw.toString('base64');

console.log('');
console.log('Ed25519 master-list signing keypair generated.');
console.log('');
console.log(`  Private key: ${KEY_PATH}`);
console.log('               (gitignored via "*.key" — NEVER commit it. Back it up offline.)');
console.log('');
console.log('  Public key (base64, raw 32 bytes):');
console.log('');
console.log(`    ${pubB64}`);
console.log('');
console.log('NEXT STEPS');
console.log('  1. Paste the public key into src-tauri/src/lib.rs:');
console.log('');
console.log(`       const MASTER_LIST_PUBKEY_B64: &str = "${pubB64}";`);
console.log('');
console.log('  2. Sign the master list:   node scripts/sign-master-list.mjs');
console.log('  3. Upload it (json + .sig): node scripts/upload-canonical-torrents.mjs');
console.log('  4. ONLY THEN build/ship the app. Verification fails closed: a build that');
console.log('     ships before the .sig is live will ignore the master list entirely.');
console.log('');
