# Auto-Updater Setup (one-time) & Release Workflow

The app ships with the Tauri v2 updater scaffolded and **dormant**: until the
signing pubkey placeholder in `src-tauri/tauri.conf.json` is replaced, the
update check silently no-ops. Follow these steps once to activate it, then
use the release workflow for every version.

## 1. One-time: install deps and generate the signing keypair

```bash
npm install

npm run tauri signer generate -- -w ~/.tauri/sermonindex.key
```

- You'll be asked for an optional password — if you set one, you must provide
  it at every build (`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`).
- This writes the **private key** to `~/.tauri/sermonindex.key` and prints the
  **public key** (a long base64 string) to the terminal.

**KEEP THE PRIVATE KEY SAFE — offline backup (password manager / encrypted
USB). NEVER commit it. If it is lost you cannot ship updates to existing
installs; if it leaks, anyone can push "updates" to every user.**

## 2. One-time: paste the public key into the app config

In `src-tauri/tauri.conf.json`, replace the placeholder:

```json
"plugins": {
  "updater": {
    "endpoints": ["https://sermonindex1.b-cdn.net/app/latest.json"],
    "pubkey": "PASTE_THE_PRINTED_PUBLIC_KEY_HERE"
  }
}
```

The public key is not a secret — committing it is correct and required.

## 3. Every release: bump the version

Bump the version in **all three** places so they stay in sync (the app shows it
beside "Node Software" and reports it in heartbeats):

- `src-tauri/tauri.conf.json` → `"version"` (what the updater compares against)
- `src-tauri/Cargo.toml` → `version` (what the running app reports via
  `get_app_version`)
- `package.json` → `"version"`

Current value: **`0.0.321`** (shows as `v0.0.321`). Bump the last number each
push (e.g. `0.0.322`). Versions **must be valid semver `x.y.z`** — the updater
only offers a build whose version is greater than the client's, so the numbers
must increase monotonically.

## 4. Every release: build with the signing key in the environment

```bash
export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/sermonindex.key)"
# only if you set a key password:
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="..."

npm run tauri build
```

Because `bundle.createUpdaterArtifacts` is `true`, the build produces (macOS
Apple Silicon example) under `src-tauri/target/release/bundle/macos/`:

- `SermonIndex Node Software.app.tar.gz` — the updater artifact
- `SermonIndex Node Software.app.tar.gz.sig` — its signature (text file)

(The regular `.dmg` in `bundle/dmg/` is still what NEW users download.)

## 5. Every release: write `latest.json`

```json
{
  "version": "0.0.322",
  "mode": "prompt",
  "notes": "What changed in this release.",
  "pub_date": "2026-07-09T12:00:00Z",
  "platforms": {
    "darwin-aarch64": {
      "signature": "<paste the full CONTENTS of the .app.tar.gz.sig file>",
      "url": "https://sermonindex1.b-cdn.net/app/SermonIndex.app.tar.gz"
    }
  }
}
```

- `version` must exactly match the tauri.conf.json version you built.
- **`mode` picks how this update reaches users — set it per push:**
  - `"prompt"` (default) — a small "Update now" card appears bottom-left; one
    click downloads, installs, and **relaunches in place** (no reinstall, and
    `~/.sermonindex` data is kept). Users see and control the change.
  - `"silent"` — the update installs in the background and applies on the user's
    **next launch**, with no interaction. Use this for pushing a fix to everyone
    without prompting.
  - The Tauri updater ignores this extra field; the app reads it separately, so
    it's safe to include. If omitted, the app defaults to `"prompt"`.
- `signature` is the **contents** of the `.sig` file, not a path/URL.
- `notes` is shown in the prompt card — keep it short.
- Add more platform keys as you ship them: `darwin-x86_64`, `windows-x86_64`,
  `linux-x86_64`.

## 6. Every release: upload to the Bunny storage zone `/app/` folder

Upload into the storage zone behind `sermonindex1.b-cdn.net`:

- the `.app.tar.gz` — renamed to `SermonIndex.app.tar.gz` so it matches the
  `url` in `latest.json` (or adjust the url instead)
- `latest.json`

Then **purge the CDN cache** for `/app/latest.json` (and the tarball) in the
Bunny dashboard — otherwise clients keep seeing the cached old version.

## 7. Verify (test a real push)

1. Build and install version **N** (e.g. `0.0.321`) — this is the "old" client.
2. Bump to **N+1** (`0.0.322`) in the three version files, build, and upload the
   new artifact + `latest.json` (with your chosen `mode`); purge the CDN cache.
3. Launch the **old** app with the log open. On startup it logs
   `[Updater] Update available: v0.0.322 (mode=…)`.
   - **`mode: "prompt"`** → a card appears bottom-left ("Update available —
     v0.0.322"). Click **Update now** → it downloads, installs, and relaunches;
     the sidebar then reads `v0.0.322`. Confirm your downloads/settings survived.
   - **`mode: "silent"`** → no prompt; the banner notes it'll apply next launch.
     Quit and relaunch → sidebar reads `v0.0.322`.

Tip: to test without publishing to real users, point the updater `endpoints` at a
staging `latest.json` first.

## Notes

- **Two delivery modes, backend-controlled** via the `mode` field in
  `latest.json` — no client change needed to switch between them.
- `prompt` relaunches in place on click; `silent` applies on next launch. Neither
  requires a reinstall, and neither touches user data in `~/.sermonindex`.
- The app never force-restarts mid-session in silent mode (users may be seeding).
- The version now also shows beside "Node Software" in the sidebar and is sent in
  heartbeats, both sourced from the real `get_app_version` — so bumping the three
  version files is all that's needed.
- Dev builds (`npm run tauri dev`) never check for updates.
- A build made with the placeholder pubkey still works fine — the update check
  just no-ops until steps 1–2 are done.
