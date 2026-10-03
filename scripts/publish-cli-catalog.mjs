#!/usr/bin/env node
/**
 * Publish the sermon catalogue for the headless node's menu.
 * ==========================================================
 * The CLI's signed master list says what to hold (ids, sizes, hashes) but not
 * who preached it or what it is called. The desktop app bundles that as
 * src/data/torrent-catalog.json; the CLI menu fetches the same bytes from the
 * CDN as `cli-catalog.json`, with a detached ed25519 signature made with the
 * SAME key as the master list — and refuses it if the signature does not
 * verify.
 *
 * Run it after every generator run that changes the library, alongside the
 * master-list upload:
 *
 *   node scripts/publish-cli-catalog.mjs --dry-run   # sign + check, upload nothing
 *   node scripts/publish-cli-catalog.mjs             # sign, check, upload, purge
 *
 * Credentials come from the same places as upload-canonical-torrents.mjs:
 * BUNNY_STORAGE_ZONE / BUNNY_STORAGE_KEY, or scripts/release.secrets.json.
 * The purge uses bunnyApiKey from release.secrets.json if it is there.
 */
import { createPrivateKey, createPublicKey, sign as edSign, verify as edVerify } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DRY = process.argv.includes('--dry-run');
const SRC = join(__dirname, '..', 'src', 'data', 'torrent-catalog.json');
const OUT_DIR = join(__dirname, '..', 'canonical-output');
const KEY_PATH = join(__dirname, 'masterlist.key');
const REMOTE = 'torrents';
// Must equal PUBKEY_B64 in sermonindex-node-cli/src/masterlist.rs — the key
// every node verifies with. Checked below so a wrong key can never publish.
const NODE_PUBKEY_B64 = 'ftEG8YFMh/SgY7kGKz2qGfZgKaLY/k4uvOzRgmJSk7o=';

function die(m) { console.error(`x ${m}`); process.exit(1); }

if (!existsSync(SRC)) die(`no catalogue at ${SRC}`);
if (!existsSync(KEY_PATH)) die(`no signing key at ${KEY_PATH}`);

const bytes = readFileSync(SRC); // raw bytes — exactly what the CDN will serve
let parsed;
try { parsed = JSON.parse(bytes.toString('utf8')); } catch (e) { die(`catalogue is not JSON: ${e.message}`); }
if (!Array.isArray(parsed.s) || !Array.isArray(parsed.c) || parsed.c.length === 0) die('catalogue has no speakers or entries');

const priv = createPrivateKey(readFileSync(KEY_PATH));
if (priv.asymmetricKeyType !== 'ed25519') die(`key is ${priv.asymmetricKeyType}, expected ed25519`);
const pub = createPublicKey(priv);
const rawPub = pub.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
if (rawPub !== NODE_PUBKEY_B64) die(`this key's public half (${rawPub}) is not the one nodes trust — refusing to publish`);

const sig = edSign(null, bytes, priv);
if (!edVerify(null, bytes, pub, sig)) die('signature does not verify — refusing to publish');
const sigB64 = sig.toString('base64');

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, 'cli-catalog.json'), bytes);
writeFileSync(join(OUT_DIR, 'cli-catalog.json.sig'), `${sigB64}\n`);
console.log(`signed: ${parsed.c.length.toLocaleString()} sermons, ${parsed.s.length.toLocaleString()} speakers, ${(bytes.length / 1048576).toFixed(1)} MB`);
console.log(`        canonical-output/cli-catalog.json (+ .sig)`);

if (DRY) { console.log('dry run — nothing uploaded'); process.exit(0); }

function secrets() {
  try {
    const p = join(__dirname, 'release.secrets.json');
    return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {};
  } catch { return {}; }
}
const sec = secrets();
// Always sermonindex1: that is the zone behind https://sermonindex1.b-cdn.net,
// where nodes fetch the catalogue. Deliberately NOT read from
// $BUNNY_STORAGE_ZONE — that is often left exported for another job (the
// API deploy uses sermonindex-api1), and following it uploaded nowhere useful.
const ZONE = process.env.CLI_CATALOG_ZONE || 'sermonindex1';
if (process.env.BUNNY_STORAGE_ZONE && process.env.BUNNY_STORAGE_ZONE !== ZONE) {
  console.log(`  (ignoring BUNNY_STORAGE_ZONE=${process.env.BUNNY_STORAGE_ZONE} — the catalogue always goes to ${ZONE})`);
}
const HOST = process.env.BUNNY_STORAGE_HOST || 'storage.bunnycdn.com';

// The storage password. Several files in this tree carry one, and they are
// not all current (release.secrets.json's sermonindex1 key answered 401 on
// 2026-10-03). So, like fix-torrent-shards.sh: gather every candidate, drop
// placeholders, and use the first one the storage API actually accepts.
function pyConst(file, name) {
  try {
    const t = readFileSync(join(__dirname, '..', '..', file), 'utf8');
    const m = t.match(new RegExp('^' + name + '\\s*=\\s*[\'"]([^\'"]+)[\'"]', 'm'));
    return m ? m[1] : null;
  } catch { return null; }
}
const candidates = [
  ['$BUNNY_STORAGE_KEY', process.env.BUNNY_STORAGE_KEY],
  ['release.secrets.json', (sec.zones || {})[ZONE]?.key],
  ['upload_mp3_to_cdn.py', pyConst('upload_mp3_to_cdn.py', 'BUNNY_KEY')],
  ['upload_sids_to_cdn.py', pyConst('upload_sids_to_cdn.py', 'STORAGE_KEY')],
].filter(([, k]) => k && !/[<\s]|REDACTED/.test(k));
let KEY = null;
for (const [from, k] of candidates) {
  const r = await fetch(`https://${HOST}/${ZONE}/`, { headers: { AccessKey: k } }).catch(() => null);
  if (r && r.status === 200) {
    KEY = k;
    if (from !== 'release.secrets.json' && from !== '$BUNNY_STORAGE_KEY') {
      console.log(`  (using the ${ZONE} key from ${from} — release.secrets.json's is out of date)`);
    }
    break;
  }
}
if (!KEY) die(`no working storage key for ${ZONE} (tried ${candidates.map(c => c[0]).join(', ') || 'nothing'}). ` +
  `Export it and re-run:  export BUNNY_STORAGE_KEY='...'`);

async function put(name, body) {
  const res = await fetch(`https://${HOST}/${ZONE}/${REMOTE}/${name}`, {
    // A Blob, not the bytes: the storage API answers with a redirect, and
    // fetch hands a byte body over on the first try, so following the redirect
    // failed with "Cannot perform ArrayBuffer.prototype.slice on a detached
    // ArrayBuffer". A Blob can be sent again.
    method: 'PUT', headers: { AccessKey: KEY, 'Content-Type': 'application/octet-stream' },
    body: new Blob([body]),
  });
  if (res.status !== 201) die(`PUT ${name} -> HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`);
  console.log(`ok uploaded ${REMOTE}/${name}`);
}
// Signature second: a node that catches the pair mid-upload sees the old
// signature against new bytes, fails verification, and keeps its cached copy.
await put('cli-catalog.json', bytes);
await put('cli-catalog.json.sig', Buffer.from(`${sigB64}\n`));

const apiKey = process.env.BUNNY_API_KEY || sec.bunnyApiKey;
if (apiKey) {
  for (const f of ['cli-catalog.json', 'cli-catalog.json.sig']) {
    const url = encodeURIComponent(`https://sermonindex1.b-cdn.net/${REMOTE}/${f}`);
    const r = await fetch(`https://api.bunny.net/purge?url=${url}&async=true`, { method: 'POST', headers: { AccessKey: apiKey } });
    console.log(r.ok ? `ok purged ${f}` : `! purge ${f} -> HTTP ${r.status} (purge it in the dashboard)`);
  }
} else {
  console.log('! no bunnyApiKey — purge cli-catalog.json and .sig in the Bunny dashboard');
}

// Read it back the way a node will.
const back = await fetch(`https://sermonindex1.b-cdn.net/${REMOTE}/cli-catalog.json`, { headers: { 'Cache-Control': 'no-cache' } });
const backSig = await fetch(`https://sermonindex1.b-cdn.net/${REMOTE}/cli-catalog.json.sig`, { headers: { 'Cache-Control': 'no-cache' } });
if (back.ok && backSig.ok) {
  const b = Buffer.from(await back.arrayBuffer());
  const s = Buffer.from((await backSig.text()).trim(), 'base64');
  console.log(edVerify(null, b, pub, s) ? 'ok the CDN copy verifies — nodes will accept it' : '! the CDN is still serving an older copy; purge and check again');
} else {
  console.log(`! could not read it back (HTTP ${back.status}/${backSig.status})`);
}
