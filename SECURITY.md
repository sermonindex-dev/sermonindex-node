# Security & Dependency Maintenance

Tracks the security posture of the SermonIndex node app and how to keep its
dependencies patched (Rust/Cargo + JavaScript/npm).

**Last verified:** `cargo build` and `cargo audit` were run on a maintainer's
machine (rustc updated via `rustup`). Results below reflect that run.

---

## 1. Rust advisories — `cargo audit` status

Baseline was **7 vulnerabilities**. After remediation: **4 remaining**, all in
`quick-xml`, both upstream-blocked (see below). Run `cd src-tauri && cargo audit`
to re-check at any time.

### ✅ Fixed — rustls-webpki (RUSTSEC-2026-0098 / 0099 / 0104)

TLS certificate-validation bugs (a reachable panic in CRL parsing + two
name-constraint acceptance bugs) on our HTTPS connections. Cleared by a patch bump:

```bash
cd src-tauri
cargo update -p rustls-webpki      # 0.103.11 -> 0.103.13
```

### ⚠️ Tracked (upstream-blocked) — quick-xml (RUSTSEC-2026-0194 / 0195)

Two high-severity DoS advisories (memory-exhaustion + quadratic-time XML parsing).
Fix is `quick-xml >= 0.41.0`, which is a **breaking** API change, so it must come
from the parent crates — we can't hand-pin it without breaking the build. There
are two independent copies in the tree:

```
quick-xml 0.37.5  <- librqbit-upnp 1.0.0 <- librqbit 8.1.1     (reachable)
quick-xml 0.38.4  <- plist 1.8.0 <- tauri 2.11.x               (NOT reachable)
```

- **librqbit-upnp path (reachable):** parses UPnP/SSDP XML from devices on the
  **local network** during port-mapping. Real but narrow: a **denial-of-service
  only** (crash / memory spike, not code execution), and it requires a malicious
  UPnP device on the user's own LAN. `cargo update -p librqbit` was tried and does
  **not** yet pull a patched `librqbit-upnp` — blocked until librqbit bumps it.
- **plist path (not reachable):** `plist` is pulled in by Tauri for macOS bundle
  handling and only ever parses the app's **own, trusted** `Info.plist` — not
  attacker-controlled input. It cannot be removed without dropping Tauri, and is a
  non-issue in practice.

**Decision:** accept + monitor. A clean `cargo audit` is not achievable today
regardless of action, because the `plist -> quick-xml` copy is baked into Tauri.
Re-run `cargo update && cargo audit` periodically; when librqbit-upnp and plist
ship `quick-xml >= 0.41`, both clear automatically.

**Optional hardening (removes the reachable copy only):** gate librqbit's UPnP so
that code path isn't built — automatic port-forwarding still works via NAT-PMP/PCP
(already implemented) plus manual forwarding. This clears the 2 librqbit copies
but leaves the 2 (harmless) plist copies. Ask if you want this done.

### Informational warnings (28) — not vulnerabilities

`cargo audit` also lists "unmaintained / unsound / yanked" transitive crates
(the gtk-rs GTK3 bindings, `bincode`, `anyhow`, `rand`, `instant`, etc.). These
are mostly Tauri's own Linux GUI dependencies, are not counted as vulnerabilities,
and need no action.

---

## 2. ✅ Tauri 2.10.3 → 2.11.x (built & verified)

`src-tauri/Cargo.toml`:

```toml
tauri = { version = "2.11.1", features = ["tray-icon"] }   # resolves to 2.11.5
```

`cargo build` completed successfully with this bump, so the backend compiles on
2.11.x. Besides routine fixes, this **closes a Windows/Android IPC-origin
advisory** (an IPC message could be accepted from an unexpected origin on those
platforms).

---

## 3. ✅ Upload-throttle API (built & verified)

Task 93 added a session-level BitTorrent upload rate limit
(`librqbit::limits::LimitsConfig` + `Session.ratelimits.set_upload_bps`) in
`src-tauri/src/torrent_node.rs`, with a `set_upload_limit` Tauri command and a
Settings opt-in control. `cargo build` compiles it cleanly against librqbit 8.1.1.
Remaining check is behavioral (confirm the cap actually limits upload speed in a
running build).

---

## 4. Master-list signing (ed25519)

### Trust model

`master-list.json` is the app's **trust anchor**: it maps every sermon to an
infohash/magnet, and the app only joins swarms that appear in it. Serving it over
HTTPS proves only that it came from the CDN — it does **not** prove SermonIndex
authored it. Anyone able to write to the CDN path (leaked Bunny storage password,
compromised admin DB, malicious insider) could previously inject arbitrary
infohashes and redirect every node to attacker-chosen content.

It is now signed **offline** with an ed25519 key:

- **Detached signature over the RAW BYTES** of `master-list.json`, published
  beside it as `master-list.json.sig` (base64 of the 64-byte signature). Raw
  bytes — not canonicalized JSON — so there is no serialization mismatch to
  exploit. Reformatting the JSON after signing invalidates the signature.
- **Verification happens in Rust** (`verify_master_list` in `src-tauri/src/lib.rs`),
  not WebCrypto: WKWebView's Ed25519 support is unreliable.
- **The public key is compiled into the binary** (`MASTER_LIST_PUBKEY_B64`).
  Changing it requires shipping a new, code-signed build — the CDN cannot change
  who is trusted.
- **Fail closed.** Missing, malformed, or invalid signature → the list is not
  applied and not cached; the app keeps the previously-cached/bundled catalog.
  HTTP downloads are unaffected; only canonical torrent data is withheld.

Scope note: the on-disk `localStorage` cache of an already-verified list is not
re-verified on load. An attacker with local write access to the user's profile
already controls the app, so this is not an additional exposure.

### Where the private key lives

`scripts/masterlist.key` — PKCS#8 PEM, mode `0600`, generated by
`scripts/gen-masterlist-key.mjs`. It is gitignored by the existing `*.key` rule
(confirm with `git check-ignore -v scripts/masterlist.key`).

**It must never be committed, uploaded, or placed in CI.** Signing is a manual,
offline maintainer step. Keep an encrypted offline backup — losing it means every
node stops accepting master-list updates until a new key is generated *and* a new
build carrying the new public key is shipped to everyone.

### Publishing / re-signing

```bash
node scripts/generate-canonical-torrents.mjs   # auto-signs at the end if the key exists
node scripts/sign-master-list.mjs              # or re-sign without regenerating torrents
node scripts/upload-canonical-torrents.mjs     # uploads the .sig first, then the .json
# then purge BOTH master-list.json and master-list.json.sig on the Bunny pull zone
```

The uploader pushes the signature **before** the JSON, so there is never a window
where a new JSON is live against a stale signature.

### 🚨 REQUIRED deploy ordering

Verification fails closed, so:

> **The signed `master-list.json` + `master-list.json.sig` MUST be live on the CDN
> BEFORE (or at the same moment as) shipping any build with verification enabled.**

Ship a verifying build first and upgraded nodes will reject the master list
entirely — they fall back to the bundled catalog, so HTTP downloads keep working,
but all canonical torrent data (magnets, infohashes, verified sizes) is ignored
until the signature is published and those nodes re-pull.

Correct order, every time:

1. `node scripts/gen-masterlist-key.mjs` (once; `--force` only to rotate)
2. Paste the printed public key into `MASTER_LIST_PUBKEY_B64` in `src-tauri/src/lib.rs`
3. `node scripts/sign-master-list.mjs`
4. `node scripts/upload-canonical-torrents.mjs`, then purge the CDN
5. Verify live: `curl -sI https://sermonindex1.b-cdn.net/torrents/master-list.json.sig`
6. **Only now** build and release the app

### Key rotation

Rotation invalidates every published signature, so it is the same ordering
problem twice over:

1. `node scripts/gen-masterlist-key.mjs --force` (back up the old key first)
2. Paste the new public key into `MASTER_LIST_PUBKEY_B64`
3. Re-sign and upload `master-list.json.sig`, purge the CDN
4. Ship the new build

Between steps 3 and 4, **old builds break** — they carry the old public key and
will reject the newly signed list. There is no dual-key grace period today; if
rotation ever becomes urgent (key compromise), accept that old nodes fall back to
the bundled catalog until they auto-update, and consider pairing it with a forced
update push. Adding a second accepted key to the Rust constant ahead of time is
the clean way to make future rotations seamless.

---

## 5. JavaScript — npm advisories

`npm run audit:js` reports **build-time dev-tooling** advisories only
(`esbuild`/`vite` dev-server request-leak, `postcss` stringify XSS). None of these
ship in the packaged desktop app.

```bash
npm install
npm run audit:js
npm audit fix          # safe, non-breaking (clears postcss, etc.)
# do NOT run: npm audit fix --force   (drags vite 5 -> 8, a breaking upgrade,
#                                       to fix a local dev-server-only issue)
```

The residual `esbuild`/`vite` advisory is dev-server-only and safe to defer until
a deliberate Vite major upgrade.

---

## 6. Lint & tests

`package.json` has non-breaking `lint`, `test`, `audit:js`, `audit:rust` scripts
plus a minimal, dependency-free `eslint.config.mjs`. Opt in when ready:

```bash
npm i -D eslint   # then: npm run lint
npm i -D vitest   # then add *.test.js and: npm test
```

---

## Quick maintenance checklist

| Area            | Command(s)                                             | Status |
| --------------- | ------------------------------------------------------ | ------ |
| Rust advisories | `cd src-tauri && cargo update && cargo audit`          | ✅ run — rustls-webpki fixed; quick-xml tracked (upstream) |
| Tauri bump      | `cd src-tauri && cargo build`                          | ✅ builds on 2.11.5 |
| Upload throttle | (in Rust; verify behavior in a running build)          | ✅ compiles |
| Master-list key | `git check-ignore -v scripts/masterlist.key`            | must be ignored; pubkey pasted into `MASTER_LIST_PUBKEY_B64` |
| JS advisories   | `npm install && npm run audit:js && npm audit fix`     | dev-only; safe fixes pending |
| JS lint / tests | `npm i -D eslint vitest && npm run lint && npm test`   | opt-in |
