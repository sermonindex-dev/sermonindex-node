# Proposed changes for 0.0.330 — audit outcomes

Written 19 July 2026, after a full read-through of the app at v0.0.329.

Every item below is marked **Confirmed** (I can point at the exact lines that make it
true) or **Suspected** (reasoning is sound but it needs to be measured in a running
app before we act). Nothing here was verified by running the software.

---

## The one-line summary

The app's promise is "these sermons are safe because volunteers hold copies." Right
now the app cannot tell a volunteer whether the copies they hold are intact — and in
several failure modes it will confidently report files it does not actually have.

That is the thing to fix. Most of Part 1 below is a single connected problem wearing
three different hats.

---

# Part 1 — Verify & Repair Library

## 1.1 A failed disk write is treated as a successful download
**Confirmed.** `downloadManager.js:93-96` catches every write error and returns `null`.
The caller at `:382-391` logs a warning and falls through; `:439-445` sets the state to
`COMPLETE` regardless. `App.jsx:820-832` then records `bytesDownloaded` — the count
received over the network — rather than what actually landed on disk.

So if the disk is full, an external drive is unplugged, or a folder loses write
permission, every download "succeeds". The library count climbs, coverage climbs, the
Seed Node page reports progress, and the heartbeat sends all of it to the dashboard,
while nothing is being written. A volunteer could run for days believing they are
preserving files they do not have.

The low-disk guard does not catch this: it is a 2 GB floor polled every 60 s
(`App.jsx:876-894`), and it does not run at all on Windows (see 2.1).

**Fix.** Make `saveFileToDisk` throw rather than return null, and treat a save failure
as a download failure. Have the Rust save command re-stat the file after writing and
return the real byte length. Record *that* in `markDownloaded`.

## 1.2 Nothing ever verifies a file's contents — the integrity code is unreachable
**Confirmed.** Three pieces that were clearly meant to work together, and don't:

- `catalog.js:349` stores `verifiedSize` from the signed master list for every sermon.
  Grepping all of `src/`: **it is never read anywhere.**
- `incomplete` is read in eight places (`catalog.js:576,728,765`,
  `DownloadsPage.jsx:116,228,301,311,317`) and drives an "Incomplete" badge, a
  Re-download button, and export filtering. The only write in the codebase is
  `delete downloadState[id].incomplete` (`catalog.js:221`). **Nothing ever sets it
  true**, so the badge can never appear and `incompleteFiles` is permanently 0.
- Orphan adoption (`catalog.js:235-249`) marks any matching file on disk as downloaded
  on the basis of **existence alone** — no size check, no hash.

The only real check in the whole download path is a `Content-Length` comparison inside
a single fetch (`downloadManager.js:662`). It doesn't survive a restart, doesn't catch
a truncated write, and doesn't run when the header is absent.

**Fix.** In `revalidateDownloads`, compare on-disk size against `verifiedSize` where
the master list has one; on mismatch set `incomplete = true`. That one change lights up
the entire existing UI — badge, Re-download, export filter, seed-progress exclusion —
all of which is already built and waiting for a signal that never comes.

## 1.3 Startup re-seeding uses self-made torrents, not the canonical ones
**Confirmed.** Because torrent persistence is deliberately off (`torrent_node.rs:179`,
correctly reasoned), `reseedExisting` runs at every launch and calls `seedDownloaded`
for each file (`downloadManager.js:257-273`), which hashes local bytes to derive an
infohash (`torrent_node.rs:352-380`). Compare the first-download path
(`downloadManager.js:151-162`), which correctly prefers the canonical torrent so
librqbit hash-checks against the official fingerprint.

Two consequences. If a file is wrong by even one byte, the derived infohash differs, so
the node joins a swarm of one, stops contributing to the real swarm for that sermon,
and reports the wrong infohash upward — all silently. Separately, every launch re-reads
and re-hashes the entire library. **Suspected:** for a full seed node that is roughly
437 GB of sequential disk read at every start, which would plausibly explain nodes
appearing sluggish or absent after a restart. Worth measuring.

**Fix.** Make `reseedExisting` use the same trust rule as the download path: prefer the
canonical `torrentUrl`/`magnet`, fall back to `seedDownloaded` only when there is no
canonical entry. This improves three things at once — it verifies every file against
the official hash on launch, it **repairs damage automatically** (the canonical magnets
carry `&ws=` CDN webseeds, confirmed in `master-list.json`), and it guarantees the node
is actually in the swarm it claims to be in.

## 1.4 The user-facing feature
With 1.1–1.3 in place, a "Verify & Repair Library" action becomes mostly free: a fast
size sweep (seconds), an optional thorough hash pass, an honest per-file status, and
automatic repair of anything damaged.

**Size:** medium. **Risk:** low — it mostly connects existing parts.

---

# Part 2 — Also proposed for 0.0.330

## 2.1 The Windows low-disk guard has never run
**Confirmed.** `lib.rs:1026-1034` runs `df -k` with **no `#[cfg]` guard**, unlike every
other platform-dependent command in the file, which all branch correctly. There is no
`df` on Windows, so it always errors. Two effects: the disk-full protection is inert
(`App.jsx:884` swallows the error), and the Seed Node setup wizard dead-ends showing
the raw Rust error string to the user (`SeedNodePage.jsx:265-268`).

Given Windows is likely the largest volunteer platform, this is a large impact for a
small fix. **Fix:** a `#[cfg(windows)]` branch, and fail *open* in the UI — "couldn't
check free space, continuing" beats a hard stop. **Size:** small. Requires Rust.

## 2.2 Single download failures are completely invisible
**Confirmed.** Neither `LibraryPage.jsx` nor `DownloadsPage.jsx` renders
`DL_STATE.ERROR`; `App.jsx:1300` catches and logs to console. A user clicks Download,
and nothing visible ever happens. The genuinely well-written storage-cap message at
`downloadManager.js:329` is thrown into that same silent catch, so nobody reads it.

For a non-technical volunteer this reads as "the app doesn't work," and the likely
outcome is a quiet uninstall. **Fix:** per-sermon error state with a Retry button, plus
a persistent "N files failed" summary. **Size:** small.

## 2.3 Privacy disclosure omits the two facts that matter for P2P
**Confirmed.** `conditions.jsx:115-144` is careful and clearly written in good faith,
but it is written about *server* telemetry. It says the node is "not tied to your
identity" without mentioning that in BitTorrent your IP address is visible to every
peer you connect to and is published to four public trackers (`torrent_node.rs:40-45`)
and the mainline DHT. It also doesn't mention that your IP goes to two third-party
geolocation services (`heartbeat.js:130,145`).

**Fix:** two sentences. Adding them makes the whole document more credible, not less.
**Size:** small.

## 2.4 File writes are not atomic
**Confirmed.** `lib.rs:199-217` writes straight to the final path. A force-quit mid-write
leaves a truncated file under the real filename, which `check_file_exists` then reports
as present — and which 1.2's orphan adoption would happily mark complete.
**Fix:** write to `<name>.part`, `fs::rename` on completion. **Size:** small. Rust.

---

# Part 3 — Everything else found, not yet proposed

Confirmed unless noted. Roughly in priority order.

**Data integrity**
- `heartbeat.js:364` — removing a torrent drops the session upload sum below the last
  reading, which the "session restarted" branch treats as a restart and re-adds the
  whole running total. Inflates network Data Transferred every time a user deletes a
  sermon.
- `App.jsx:1334-1356` — Re-download deletes the file *before* fetching. If the fetch
  fails the user has strictly less than before. (Currently unreachable, since the
  button can never render — it goes live the moment 1.2 lands.)
- `catalog.js:552-563` — `fetchCatalogUpdate` pushes raw API objects into the catalog
  with no shape validation and without `expandSermon`.

**Resilience**
- **Suspected, needs measuring:** `master-list.json` is 22.7 MB and is cached via
  `localStorage.setItem` (`catalog.js:320`). WebView2 and WebKitGTK enforce roughly a
  5 MB per-origin quota. If that write throws, it is swallowed at `:322` and every node
  re-downloads 22.7 MB on every launch — the exact thing the caching work was meant to
  prevent. Same quota pressure may silently reset the lifetime upload counter, which
  has no disk backup.
- `lib.rs:901-910` — `sanitize_name` ends with `String::truncate(120)`, which **panics**
  if byte 120 isn't a UTF-8 boundary. Reachable from export with non-ASCII titles.
- `downloadManager.js:771-780` — `cancel()` doesn't abort the fetch or decrement the
  active count. Currently harmless because **nothing ever calls it** — i.e. there is no
  way to cancel an in-flight download.
- `downloadManager.js:638-643` — throttling measures against a `startTime` that is never
  reset across retries, so after a backoff the limiter is bypassed for a burst.
- `heartbeat.js:506` — `stopHeartbeat` awaits a fetch from `beforeunload`, which won't
  reliably complete. Should use `sendBeacon`.
- `heartbeat.js:120` — geo is cached for the process lifetime; a laptop that moves keeps
  reporting its old city forever.
- `App.jsx:876` — spawns a `df` subprocess every 60 s for the life of the process.
- `downloadManager.js:308-338` — storage-cap check is read-then-act with two concurrent
  downloads, so both can pass it.

**Correctness / UX**
- `App.jsx:1255-1260` — pressing play silently starts a full background download to
  disk. Nothing in the UI says browsing consumes storage.
- `downloadManager.js:610-676` — the file is buffered whole, copied into a second
  full-size array, then base64-encoded. Peak heap ≈ 2× file size. Fine for an MP3;
  **suspected** to matter for large video on low-RAM machines, and Raspberry Pi seed
  nodes are in the docs.
- `App.jsx:1465` — the `<audio>` element sits outside the ErrorBoundary, whose only
  recovery re-renders the state that just crashed.

**Fixed already, in the 0.0.330 working tree**
- Heartbeat reported `reachable` from IPv4 only, so an IPv6-reachable node showed green
  in-app while the dashboard filed it as unreachable.
- `fetch_text`'s allowlist was missing `sermonindex4.b-cdn.net`, which
  `updater.js:56` calls — meaning the emergency network-wide **force-update lever could
  never read its mode and was non-functional**.

---

# Checked and found sound

Worth recording, so it's clear what has been looked at:

- **Path traversal.** `leaf()` reduces every caller-supplied filename to its final
  component and all file commands route through it. I tried to construct an escape and
  could not.
- **Secret hygiene.** `release.secrets.json` is gitignored and untracked; only the
  template is committed. No key-shaped literals in tracked files.
- **Tauri capabilities.** Minimal and appropriate — no fs or shell plugin; privileged
  operations are hand-written commands, which is the right shape. CSP is tight.
- **Master-list ed25519 verification.** Correctly constructed — raw-bytes signing,
  `verify_strict`, compiled-in pubkey, genuine fail-closed including the no-Tauri path.
  The strongest part of the security story.
- **Bandwidth unit maths.** No 8× error; labels and conversions agree throughout.
- **Seed-window / timezone maths.** Midnight-crossing handled correctly, and it fails
  open, which is the right default.
- **IPv6 and CGNAT range checks.** Masks verified by hand; correct and appropriately
  conservative on bad input.
- **Sharded vs legacy-flat path fallback.** Consistent across read, write, delete, seed
  and prune. No split-brain.
- **Download retry/backoff.** Jittered, honours Retry-After and non-retryable statuses,
  resumes via Range. Genuinely well built.
- **Self-healing watchdog.** Capped, consent-gated, resets on success, has a cooldown.
  It cannot thrash, and it correctly re-applies the upload cap after a heal.
