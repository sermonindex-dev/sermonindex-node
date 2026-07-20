# 0.0.330 — handover

Written while you were out. **Nothing has been committed, tagged or released** — that
decision is yours.

This covers TWO batches of work: the audit bug-fixes, and then the four remaining
feature opportunities you asked for afterwards.

---

## FIRST: repair your node_modules

I broke your dev server. To validate a build I installed rollup's **Linux** binary into
`node_modules`, which is your Mac's folder shared into my sandbox — npm resolves those
platform binaries for whatever OS it's running on, so it evicted your `darwin-arm64`
one. Nothing tracked in git was affected (`package.json` and `package-lock.json` are
clean, verified), but you need:

```
cd ~/Desktop/si-shell-dev2/sermonindex-app
rm -rf node_modules && npm ci
```

Because of that, I did **not** re-run `npm run build` after the later work. All 38 JS/JSX
files under `src/` parse cleanly (verified read-only with Babel), but the bundler has not
run since the feature batch. Run `npm run build` yourself after `npm ci`.

---

## SECOND: `cargo build`, and be aware how much rides on it

**No Rust in this release has ever been compiled as a full crate.** That is now a
substantial stack:

- atomic `.part` staging + fsync + rename, across every writer
- a Windows `check_disk_space` via `fsutil` (the old one always failed on Windows)
- `finalize_sermon_file` / `abort_sermon_file`
- a passive IPv6 observation walking librqbit's peer tables (torrent_node.rs)
- `stream_sermon_file` / `cancel_sermon_download` — streaming downloads

```
cd ~/Desktop/si-shell-dev2/sermonindex-app/src-tauri && cargo build && cd ..
```

Mitigation, so this isn't pure hope: every non-trivial Rust block was extracted verbatim
into scratch crates and compiled against the real dependency versions. That caught
**three genuine bugs** that would otherwise have failed your build — an undocumented
third parameter on `create_torrent`, `Session::with_torrents` taking `Fn` rather than
`FnMut`, and `&mut dyn FnMut` not being `Send` (which would have broken the streaming
command outright). I also verified by hand that all four new commands are both defined
and registered in `invoke_handler`.

What that does NOT cover: `#[tauri::command]` macro expansion, `AppHandle` injection,
serde round-trips over IPC, and anything Windows-specific at runtime.

---

## The one thing to warn volunteers about

After this update, **some volunteers will see their library count, coverage % and seed
progress go DOWN.**

That is not a regression. It is the first time the app has ever checked whether the
files it claims to hold are actually intact. Previously a failed disk write was recorded
as a success, so those numbers included files that were never written. The new numbers
are the true ones.

I'd say so plainly in the release notes rather than let people discover it and assume
the update broke something. Something like: *"This version can finally check that the
sermons you're hosting are complete and undamaged. If your numbers drop after updating,
that's the app being honest for the first time — use Verify & Repair to fix anything it
finds."*

**Also:** `CONDITIONS_VERSION` was bumped to `2026-07-19` because the privacy text
changed materially. Every existing install will see the agreement modal again on next
launch. That is intended, but it is a visible change you should expect.

---

## What was done

**Integrity — the core of it**

- A failed disk write now fails the download instead of reporting success. This was the
  headline bug: a full disk or unplugged drive produced "successful" downloads of
  nothing, and the library, coverage, seed progress and dashboard all reported files
  that didn't exist.
- File size recorded is now what's actually on disk, not what came off the wire. Those
  two could never disagree before, which is precisely why the above was invisible.
- `verifiedSize` from the signed master list is now actually read. It was stored for
  every sermon and never used anywhere.
- The `incomplete` flag is now set. It was read in 8 places driving a badge, a
  Re-download button, export filtering and seed progress — and nothing in the codebase
  ever set it to true, so none of that UI could ever appear.
- Orphan adoption now verifies size instead of trusting that a file exists.
- Re-seeding at startup uses canonical torrents instead of hashing local bytes. A
  damaged file used to produce a different infohash, so the node silently left the real
  swarm and reported the wrong hash upward. It now hash-checks against the official
  fingerprint and **repairs damage in place** via the CDN webseeds.

**Writes and platform**

- Writes are atomic: stage to `.part`, fsync, rename. A force-quit mid-write can no
  longer leave a truncated file that later reads as complete.
- `check_disk_space` had no platform guard and ran `df`, so it **always failed on
  Windows** — the low-disk protection never ran there, and the Seed Node wizard
  dead-ended on a raw Rust error. Now has a Windows implementation via `fsutil`.
- `sanitize_name` called `String::truncate(120)`, which **panics** if byte 120 isn't a
  UTF-8 boundary — reachable from export with any accented sermon title. Fixed and
  covered by unit tests that demonstrate the original panics.

**Reporting**

- Deleting a sermon used to be misread as a session restart, re-adding the entire
  lifetime upload total. Because the server stores that as a high-water mark, the
  inflation was permanent and fed the public dashboard.
- Shutdown notification now uses `sendBeacon`; the previous `await fetch` from an unload
  handler often never completed, leaving nodes showing online for 15 minutes after quit.
- Geolocation was cached for the life of the process, so a laptop that moved kept
  reporting its old city forever. Now expires after 6 hours.
- The heartbeat reported reachability from IPv4 only, so an IPv6-reachable node showed
  green in-app while the dashboard filed it as unreachable.

**Visible to users**

- Download failures are no longer silent. They previously went to `console.error` and
  nowhere else — a user clicked Download and nothing ever happened. There's now a
  per-sermon error with a plain-language reason and a Retry, plus a summary banner.
  Eight causes are mapped to actionable wording; no raw error strings reach the screen.
- The reachability card says "peer" instead of the invented word "leaf", and uses the
  same gold the node map uses for peers — it was using the map's *seed* colour, so the
  two views contradicted each other.
- The reachability result persists across navigation with a "last tested" age and an
  explicit Re-test.
- The CGNAT notice now offers the real fix (own router + bypass mode) instead of ending
  on "nothing you can do".
- Settings has a "Check for update" button.
- Privacy text now discloses that peers, public trackers and the worldwide peer
  directory can see your IP, and that two third-party services do the geo lookup. The
  claim "not tied to your identity" was softened because it wasn't accurate for a P2P app.
- Master list cache moved off localStorage (22.67 MB measured, against a ~5 MB quota) to
  a file, so nodes should stop re-downloading it every launch.
- Re-download no longer deletes the old file first — a failure used to leave the user
  with less than they started with.
- The audio player sits inside an error boundary that actually remounts on recovery,
  rather than re-rendering the state that just crashed.

**Fixed earlier in the session:** the emergency force-update lever. `fetch_text`'s
allowlist never included `sermonindex4.b-cdn.net`, so the update mode could never be
read and every release silently fell back to "prompt". It has been decorative since you
moved updates to that host.

---

## What I verified, and how

**The riskiest assumption, tested empirically.** The new size check is exact-match, so if
the master list's sizes disagreed with what the CDN actually serves, it would flag every
volunteer's entire library as damaged. I sampled 120 sermons across both audio and
video, fetched real `Content-Length` from the CDN, and compared:

```
checked=120  match=120  mismatch=0  errors=0
```

Zero mismatches. The check is safe.

Also verified by hand: the new Rust commands are registered in `invoke_handler`; the JS
save contract matches the Rust signatures; no code path can complete a download without
either finalizing or aborting; `npm run build` succeeds; lockfiles are unchanged.

**Not verified — needs you or a real machine:**

- `cargo build`. Nothing Rust has been compiled as a full crate.
- Anything Windows-specific. The `fsutil` parsing and the rename-over-existing path are
  unit-tested against synthetic output, never run on Windows.
- That re-seeding hash-checks and resumes rather than re-downloading. This is read from
  librqbit's API contract (`overwrite: true`), not observed.
- The localStorage quota theory itself. The file-cache fix is correct either way, which
  is why I was comfortable making it.
- Every UI change. None of it has been rendered.

---

## The four features (second batch)

**Verify & Repair Library** — a button in Settings. Sweeps every sermon in the download
folder against the signed master list, with live progress, cancellable, non-blocking.
Reports complete / damaged / missing, then repairs via the canonical torrents so only
the damaged *parts* are fetched rather than whole files. It deletes and adopts nothing.
Also added the missing line in Library telling users that pressing play saves the sermon
to disk — that was never disclosed anywhere.

*Known rough edge:* after a repair runs, `incomplete` flags stay set until the next
verification pass, so coverage still counts those files as damaged until the user
re-runs the check. The copy tells them to. Auto-clearing would need the repair path to
report completion back.

**Passive inbound IPv6 detection.** Since Bunny's edge can't make IPv6 connections, this
detects reachability from real traffic instead: if a peer at a global-unicast IPv6
address opened a connection to our listening socket, inbound IPv6 demonstrably works.

The claim is honest because librqbit's `incoming_connections` counter is only ever
incremented from the listening socket — an outbound dial can't be mistaken for inbound.
Only 2000::/3 counts, so a link-local peer on the same LAN can't produce a false green
badge. The verdict is sticky (proof doesn't expire when that peer disconnects) and
persists across restarts. It can prove reachability; it can never prove the negative,
and the UI says so.

**Streaming downloads.** Downloads now go socket → `.part` → fsync → rename entirely in
Rust, one chunk in memory at a time. Removes the ~2× file-size heap peak and the base64
IPC inflation — the thing that made large video risky on Raspberry Pi seed nodes.
Progress, throttling, Range/resume, retry/backoff, source alternation and cancellation
are all preserved; retry deliberately stayed in JS because that logic is well-tested.

**A fallback to the old buffered path is retained and I recommend keeping it for this
release** — it engages automatically if the streaming command is missing. Given none of
this Rust has been compiled, that's the safety valve.

*Behaviour change worth knowing:* there is now a 120s read timeout mid-stream where
previously a stalled socket could hang forever. Better, but a severely throttled link
could in principle trip it.

**Bulk downloads survive a restart.** The queue and failure list persist to
`settings.json` (not localStorage — a full queue is 637 KB measured, and localStorage
already carries the download state; that's the same near-the-quota write that failed
silently for the master list). Checkpointed every 25 files or 60 seconds. On resume it
re-resolves against the catalog, skips what's already downloaded, drops sermons that no
longer exist, and re-queues last run's failures.

Nothing auto-starts — a volunteer who deliberately quit won't have 400 GB resume itself.
And starting a different speaker while a saved list exists now asks first, since one
click could otherwise silently discard a half-finished 437 GB queue.

---

## Suggested next steps

1. `rm -rf node_modules && npm ci` — repair the dev server.
2. `npm run build` — hasn't run since the feature batch.
3. `cargo build` — stop here if it fails and send me the error. This is the big one.
4. `npm run tauri dev` and click through, roughly in risk order:
   - **A large video download.** This exercises the new streaming path — the riskiest
     change. Set a bandwidth limit, then cancel mid-download, then re-download to test
     resume.
   - **Force a failure** (rename the downloads folder mid-download) and check the error
     UI reads like a human wrote it.
   - **Settings → Verify & Repair Library.** Watch progress, try Stop, and see what it
     reports on your own library.
   - **A bulk download**, quit the app part-way, relaunch, and confirm the resume card
     offers to pick up where you left off.
   - Reachability card, Settings → Check for update.
5. Before shipping, note how many files Verify & Repair flags on your own library. My
   120-sermon CDN sample says it should be near zero; your real library is the true test.
   If it flags a lot, tell me before releasing — that would mean the check is wrong, not
   your files.
6. Then bump, commit, release as usual.

Given the size of this release — the whole integrity layer, a rewritten download
pipeline, and five sets of uncompiled Rust — I'd rather you found problems on your own
machine than in the wild. If `cargo build` throws anything, send it over rather than
untangling it yourself; I have the full context on what changed and why.

One thing I deliberately did **not** do: the download-failure summary appears on Library
and My Downloads but not globally. A sidebar count badge would need `App.jsx`, and
`collectFailedDownloads()` is exported with no arguments specifically so that's a
one-line addition. I left it alone rather than add unverified changes to a file that had
just been heavily rewritten.
