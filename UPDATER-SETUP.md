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

The updater compares against `"version"` in `src-tauri/tauri.conf.json`
(currently `1.1.0`). **Bump it for every release** (keep `package.json` in
sync for sanity). Clients only install versions greater than their own.

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
  "version": "1.1.0",
  "notes": "What changed in this release.",
  "pub_date": "2026-07-07T12:00:00Z",
  "platforms": {
    "darwin-aarch64": {
      "signature": "<paste the full CONTENTS of the .app.tar.gz.sig file>",
      "url": "https://sermonindex1.b-cdn.net/app/SermonIndex.app.tar.gz"
    }
  }
}
```

- `version` must exactly match the tauri.conf.json version you built.
- `signature` is the **contents** of the `.sig` file, not a path/URL.
- Add more platform keys later as you ship them: `darwin-x86_64`,
  `windows-x86_64`, `linux-x86_64`.

## 6. Every release: upload to the Bunny storage zone `/app/` folder

Upload into the storage zone behind `sermonindex1.b-cdn.net`:

- the `.app.tar.gz` — renamed to `SermonIndex.app.tar.gz` so it matches the
  `url` in `latest.json` (or adjust the url instead)
- `latest.json`

Then **purge the CDN cache** for `/app/latest.json` (and the tarball) in the
Bunny dashboard — otherwise clients keep seeing the cached old version.

## 7. Verify

Run the previous version of the app with the console/log open: on startup it
logs `[Updater] Update available: vX.Y.Z — downloading...`, installs, and the
banner shows "Update installed — takes effect next launch." Relaunch → new
version.

## Notes

- Updates install on next launch by design; the app never restarts itself
  mid-session (users may be seeding).
- Dev builds (`npm run tauri dev`) never check for updates.
- A build made with the placeholder pubkey still works fine — the update
  check just no-ops until steps 1–2 are done.
