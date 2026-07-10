# Deploying Test Installers

How to build installers for **macOS, Windows, and Linux** and hand them to a few
testers. Your repo already has a GitHub Actions workflow
(`.github/workflows/build.yml`) that builds all four targets in the cloud, so you
do **not** need a Windows or Linux machine.

> Why the cloud: Tauri can't cross-compile. A Mac can only produce a macOS
> installer, Windows only Windows, etc. GitHub Actions runs one machine per OS and
> builds them all in parallel.

---

## One-time setup (do this once)

The build signs the auto-updater artifacts with your minisign key, so CI needs that
key as a secret. On GitHub:

**Repo → Settings → Secrets and variables → Actions → New repository secret**

Add:

| Secret name | Value |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | The contents of `~/.tauri/sermonindex.key` (the whole file) |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | The password you set on the key (leave blank if you set none) |

To copy the key contents on your Mac:

```bash
cat ~/.tauri/sermonindex.key | pbcopy   # now paste into the secret
```

> Without these, the build fails at the "signing updater" step because
> `createUpdaterArtifacts` is on in `tauri.conf.json`.

These installers are **not** Apple/Windows code-signed (that's a separate, paid
step — see the last section). Testers will see a one-time "unverified developer"
warning and bypass it as shown below. That's normal and fine for a few trusted
testers.

---

## Each time you want to ship a test build

### 1. Bump the version

Keep these three in sync (currently `0.0.321`):

- `package.json` → `"version"`
- `src-tauri/tauri.conf.json` → `"version"`
- `src-tauri/Cargo.toml` → `version`

For example bump all three to `0.0.322`. (Ask me and I'll bump them for you.)

### 2. Commit and tag

The workflow triggers on any tag starting with `v`:

```bash
git add -A
git commit -m "Test build v0.0.322"
git push

git tag v0.0.322
git push origin v0.0.322
```

### 3. Watch it build

GitHub → **Actions** tab → the "Build & Release" run. ~10–20 min for all four
platforms. Green check = done.

### 4. Get the installers

The workflow creates a **draft Release** with every installer attached:

GitHub → **Releases** → the `v0.0.322` draft → download the files, or hand them to
testers.

You'll find:

| OS | File to send | Notes |
|---|---|---|
| macOS (Apple Silicon) | `..._aarch64.dmg` | M1/M2/M3/M4 Macs |
| macOS (Intel) | `..._x64.dmg` | Older Intel Macs |
| Windows | `..._x64-setup.exe` | The friendly NSIS installer (also an `.msi` if preferred) |
| Linux | `..._amd64.AppImage` | Runs on most distros, no install (also a `.deb`) |

> **Private repo note:** your testers probably don't have access to this GitHub
> repo, and private-repo release assets require a login to download. So download
> the files yourself and send them directly (Dropbox, Google Drive, WeTransfer,
> etc.). Don't just send the Releases link — they won't be able to open it.

---

## What your testers do

### macOS

1. Open the `.dmg`, drag **SermonIndex Node Software** to Applications.
2. First launch: **right-click the app → Open → Open**.
3. If macOS says the app **"is damaged and can't be opened"** (common on Apple
   Silicon for unsigned apps), have them run this once in Terminal:

   ```bash
   xattr -cr "/Applications/SermonIndex Node Software.app"
   ```

   Then open it normally. (This just clears the "downloaded from the internet"
   quarantine flag — it isn't actually damaged.)

### Windows

1. Run `..._x64-setup.exe`.
2. SmartScreen shows **"Windows protected your PC"** → click **More info** →
   **Run anyway**.

### Linux

```bash
chmod +x "SermonIndex Node Software_0.0.322_amd64.AppImage"
./"SermonIndex Node Software_0.0.322_amd64.AppImage"
```

(If it complains about FUSE on newer Ubuntu: `sudo apt install libfuse2`. Or use
the `.deb`: `sudo apt install ./SermonIndex*.deb`.)

---

## Faster local Mac-only builds (optional)

While iterating, you can build just the Mac installer on your machine without CI:

```bash
export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/sermonindex.key)"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="your-key-password"   # or "" if none
npm run tauri build
```

Output: `src-tauri/target/release/bundle/dmg/*.dmg` (built for your Mac's
architecture, arm64). For an Intel build add `-- --target x86_64-apple-darwin`
(after `rustup target add x86_64-apple-darwin`).

---

## Pushing an auto-update to testers (optional, later)

Once testers are running a build, you don't have to re-send installers for every
fix. The app checks `https://sermonindex1.b-cdn.net/app/latest.json` on launch. To
push an update, upload the new build's updater artifacts and a new `latest.json` to
Bunny. Full steps are in **UPDATER-SETUP.md**. For the first round of testing,
sending installers directly is simplest.

---

## Upgrade path: no-warning installs (later)

To remove the Gatekeeper/SmartScreen warnings entirely (worth it for wider or
non-technical testers):

- **macOS** — an Apple Developer ID ($99/yr). Add `APPLE_CERTIFICATE`,
  `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`,
  `APPLE_PASSWORD` (app-specific password) and `APPLE_TEAM_ID` as GitHub secrets;
  `tauri-action` then signs **and notarizes** automatically.
- **Windows** — a code-signing certificate (OV/EV from a CA). Tauri supports it via
  the bundle's `windows.certificateThumbprint` / signing config.

Ask me when you're ready and I'll wire either one into the workflow.
