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

## 4. JavaScript — npm advisories

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

## 5. Lint & tests

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
| JS advisories   | `npm install && npm run audit:js && npm audit fix`     | dev-only; safe fixes pending |
| JS lint / tests | `npm i -D eslint vitest && npm run lint && npm test`   | opt-in |
