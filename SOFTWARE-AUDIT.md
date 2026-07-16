# SermonIndex Node Software — Full Audit

_Date: 2026-07-09 · Version (declared): 1.1.0_

A full review of the Rust backend, React frontend, and security/release posture,
by three independent deep passes plus cross-checks. Findings are prioritized;
each has a location and a concrete fix.

---

## Executive summary

The software is in **good structural shape and close to release-ready.** The
architecture is coherent, the recent work (sharding, exports, local-first images,
seed-count fixes) is wired consistently, and there are no orphaned IPC calls or
missing commands. The issues below are finalizations, not redesigns — **one is
important** (a hardcoded seed-node password), the rest are version hygiene, a
couple of real bugs, CSP tightening, and dead-code cleanup.

### What's solid (no action needed)

- **IPC integrity:** all 39 Rust commands are registered; every frontend
  `invoke('…')` resolves to a real command. No orphans either direction.
- **Sharding:** `shard_for`/`target_path`/`resolve_path` are used consistently at
  every file read/write site; `delete`, `list`, `remove_missing`, and disk-usage
  all handle both sharded and legacy-flat layouts.
- **Reconcile logic:** conservative and correct — never deletes on a failed
  listing or a 0-byte read; adopts orphan files; survives fd exhaustion.
- **Secrets hygiene (mostly):** no signing key, storage keys, or chat `ADMIN_KEY`
  in the repo or history; `.gitignore` correctly covers `*.key`/`*.key.pub` and
  the fetched portraits. Updater `pubkey` is a real (public, safe-to-commit)
  minisign key.
- **Capabilities:** minimal and correct (`core`, `updater`, `process`, `dialog`).
- **Icons:** complete set present and referenced correctly.
- **Resource hygiene:** listeners, intervals, observers, and audio subscriptions
  all have cleanup; one error boundary wraps the page content.
- **Compilation:** no compile errors found in review (build artifacts postdate the
  last edits at review time). Still run a clean `npm run tauri build` to confirm
  after applying fixes.

---

## CRITICAL

### C1 — Seed-node password is hardcoded and shipped
**`src/pages/SeedNodePage.jsx` (~lines 155–180)**

The offline auth path contains a comment naming the plaintext password
(`seed2026`) next to its SHA-256. It is committed, bundled into `dist/`, and
pushed to GitHub. Worse, the server check it's supposed to defer to
(`https://app.sermonindex.net/api/seed/verify`) **does not exist** in any deployed
edge script — so the code always falls through to the local hardcoded hash. Anyone
who reads the JS (or the repo) can unlock Seed Node mode.

Mitigating context: this gate only hides a UI page; it is not protecting data or
keys. So it's low-severity in impact but should still be fixed properly.

**Fix:**
1. Treat `seed2026` as burned — **rotate it.**
2. Remove the plaintext-naming comment and the hardcoded hash from the client.
3. Either drop the gate entirely (it's obscurity, not security) **or** deploy a
   real `/api/seed/verify` edge script that reads the password from a Bunny env
   var, and keep only that path.
4. Confirm whether the GitHub repo is public; if it ever was, assume the value is
   world-known (rotation covers this).

---

## HIGH

### H1 — Version is actually 1.0.0 at runtime
- `src-tauri/Cargo.toml:3` → `version = "1.0.0"` (this is what `get_app_version()`
  returns, via `env!("CARGO_PKG_VERSION")`).
- `src/services/heartbeat.js:240` → hardcoded `app_version: '1.0.0'`.
- `tauri.conf.json` and `package.json` say `1.1.0`.

So the app reports 1.0.0 everywhere that matters (updater comparisons, node
dashboard). **Fix:** bump `Cargo.toml` to `1.1.0`; change `heartbeat.js` to send
the dynamic `getAppVersion()`; update the `tauriStore.js` web fallback to
`1.1.0-web`. Keep all four in sync on every release.

### H2 — Path handling has no traversal guard (defense-in-depth)
**`lib.rs` — `target_path`/`resolve_path`/`delete_sermon_file` and all filename-taking commands**

`filename` is `join`-ed directly, so a value like `../../x` or an absolute path
would escape `downloads_dir()`. **Not remotely exploitable today** — these
commands are only callable from the app's own bundled frontend (CSP `default-src
'self'`), and filenames come from the catalog, not free user input. But there's no
defense in depth. **Fix:** centrally reject `filename` whose path components
include `..`/root/prefix, or reduce to `Path::file_name()` before joining.

---

## MEDIUM

### M1 — Bulk download clobbers the canonical magnet
**`src/pages/BulkDownloadPage.jsx:91`** calls `markDownloaded(id, 'local-…')`
after each download, which races with App's progress handler that persists the
**real** canonical magnet — and `markDownloaded` overwrites (also dropping
`diskSize`). Result: a good magnet can be downgraded to the local placeholder.
**Fix:** remove line 91 (App's progress handler is the single source of truth), or
make `markDownloaded` merge instead of overwrite. (Root cause shared with the
fire-and-forget seed timing in `downloadManager.js:342–354`.)

### M2 — Heartbeat reports stale mode forever (stale closure)
**`src/App.jsx:160–169`** — `startHeartbeat`'s `getStats` closes over
`contentMode`/`seedUnlocked` at first render, so heartbeats always report
`content_mode:'cdn'` and `node_type:'user'` even after they change. **Fix:** source
these from refs updated by an effect. (Reporting-only; not a crash.)

### M3 — CSP misses the archive.org apex
**`tauri.conf.json:26`** allows `https://*.archive.org` but the code fetches the
bare apex `https://archive.org/download/…`. Wildcards don't match the apex, so the
initial request/redirect is fragile. **Fix:** add `https://archive.org` to
`connect-src` and `media-src`.

### M4 — DonateBanner statically imports Tauri
**`src/components/DonateBanner.jsx:2`** uses a top-level
`import { invoke } from '@tauri-apps/api/core'` (every other file lazy-imports with
a catch). In a non-Tauri context this module load can fail and surface via the
ErrorBoundary. **Fix:** lazy-import inside the handler like the rest of the code.

### M5 — NAT-PMP mutex `.unwrap()` can panic on poison
**`torrent_node.rs` (5 sites)** — `natpmp_status.lock().unwrap()`; a panic in the
NAT-PMP task would poison the lock and then crash `torrent_status`. **Fix:** use
`unwrap_or_else(|e| e.into_inner())` or `if let Ok(...)`.

### M6 — Dead Rust commands
`organize_file` (superseded by the export commands after the auto-hardlink
removal), `export_sermon_file` (superseded by `export_sermon`), and
`get_catalog_path` are all registered but never called. **Fix:** delete them and
their `generate_handler!` lines.

---

## LOW (cleanup / polish)

- **L1** `getInitials` export (`SpeakerAvatar.jsx`) — unused; delete.
- **L2** `getStoragePath` import (`App.jsx:62`) and the unused `tauriStore.js`
  exports — dead; remove.
- **L3** `handleOpenFolder` (`App.jsx:802`) opens `get_storage_path` (default dir)
  instead of `get_storage_dir` (the user's chosen dir). For a seed node with a
  custom folder, "Open Downloads Folder" opens the wrong place. **Fix:** use
  `get_storage_dir`.
- **L4** CSP: `http://ip-api.com` (mixed-content, dead in the packaged app) and
  unused Google Fonts entries — remove both; drop the `ip-api.com` call in
  `heartbeat.js`.
- **L5** Duplicated hardcoded hosts (chat endpoint in two files; port range in two
  UI files) — centralize into a constants module to avoid drift.
- **L6** `nodesOnline` (Node Map badge) includes self while `seedsOnline` excludes
  self — confirm this is intended (likely fine).
- **L7** `list_downloaded_files` descends into `speaker-images/` — harmless now,
  but skip that folder so image names can't ever be mistaken for sermon files.
- **L8** `walk_dir(dir: &PathBuf)` → `&Path`; drop the unused empty
  `torrent-session/` dir creation; consider disabling redirect-following on the two
  allowlisted `reqwest::get` fetches.
- **L9** `chat-server.php` hardcodes `ADMIN_KEY='CHANGE_ME'` with no env fallback
  (the `.mjs`/edge variants read env correctly). Fix or delete the PHP variant.

---

## Finalization checklist

**Blockers (before public release):**
1. Rotate the seed password; remove the hardcoded hash + naming comment; move the
   check server-side or drop it (C1). Confirm repo visibility.
2. Fix versions to 1.1.0 across Cargo.toml + heartbeat + web fallback (H1).

**Recommended before release:**
3. Add `https://archive.org` to CSP; remove `http://ip-api.com` and Google Fonts
   entries (M3, L4).
4. Remove the BulkDownload magnet-clobber (M1).
5. Fix the heartbeat stale-closure (M2).
6. `handleOpenFolder` → `get_storage_dir` (L3).

**Safe cleanup (low risk, do anytime):**
7. Delete dead Rust commands (M6) and unused frontend exports/imports (L1, L2).
8. DonateBanner lazy import (M4); NAT-PMP poison-tolerant locks (M5).
9. Add path-traversal guard (H2).

**Per-build / publish:**
10. `npm run fetch-images` before building.
11. Build signed with the local key (`TAURI_SIGNING_PRIVATE_KEY`); never commit it.
12. Upload artifacts + `latest.json` to Bunny `/app/`; **purge the CDN cache** for
    `latest.json`; add `windows-x86_64` / `linux-x86_64` / `darwin-x86_64` keys to
    `latest.json` if shipping those targets.
13. Clean `npm run tauri build` to confirm compilation after fixes.

---

## Appendix — feature idea: live seeders per sermon card

See chat for the full assessment. Short version: a true per-sermon live seeder
count across all ~33k Browse cards is **heavyweight** (needs mass tracker-scraping
or a central swarm-index service — the local torrent engine only knows peers for
files this node already has). A cheap, honest subset is feasible: show a live peer
count only on **downloaded** sermons (from librqbit stats), where the data already
exists. Recommend deferring the full version or doing the cheap subset.
