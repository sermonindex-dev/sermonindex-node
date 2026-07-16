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
| `BUNNY_STORAGE_ZONE` | Your Bunny **storage zone name** (the one behind `sermonindex4.b-cdn.net`) |
| `BUNNY_STORAGE_KEY` | That storage zone's **password** (Bunny → Storage → your zone → FTP & API Access → Password) |
| `BUNNY_STORAGE_HOST` | *(optional)* only if your zone isn't in the default region, e.g. `la.storage.bunnycdn.com` |

To copy the key contents on your Mac:

```bash
cat ~/.tauri/sermonindex.key | pbcopy   # now paste into the secret
```

> The first two are required or the build fails at the "signing updater" step
> (`createUpdaterArtifacts` is on). The `BUNNY_*` secrets let CI publish the
> finished installers to your CDN automatically (next section). `BUNNY_STORAGE_KEY`
> is the **storage zone password**, not your Bunny account API key.

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

### 4. Share the download page

When the builds finish, a final CI job (`publish-to-bunny`) collects every
installer and uploads them to your CDN in a per-version folder, with a ready-made
download page. Just send testers this one link:

```
https://sermonindex4.b-cdn.net/app/releases/v0.0.322/index.html
```

That page auto-lists the right installer for each OS and includes the first-launch
bypass instructions. It's a **public CDN URL** — testers need no GitHub account and
nothing to install to reach it.

The folder also contains each file directly, plus a `manifest.json`:

| OS | File |
|---|---|
| macOS (Apple Silicon) | `..._aarch64.dmg` |
| macOS (Intel) | `..._x64.dmg` |
| Windows | `..._x64-setup.exe` (also an `.msi`) |
| Linux | `..._amd64.AppImage` (also a `.deb`) |

Every version you tag becomes its own folder (`.../app/releases/v0.0.323/`, etc.),
and `.../app/releases/releases.json` lists them all. Old versions stay available.

> A **draft GitHub Release** with the same files is also created (Releases tab) as
> a backup, but you normally won't need it — the Bunny page is the thing to share.

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

Then push that local build to the same Bunny folder (Mac files only, since that's
all a Mac can build) with the deploy script:

```bash
export BUNNY_STORAGE_ZONE="your-zone"
export BUNNY_STORAGE_KEY="your-storage-zone-password"
node scripts/deploy-installers.mjs --version v0.0.322 --dir src-tauri/target
```

The script scans the build output, uploads the installers to
`app/releases/v0.0.322/`, rebuilds `index.html` + `manifest.json`, and prints the
public links. Add `--dry-run` to preview without uploading. (This is the same
script CI runs — CI just points it at all four platforms' output at once.)

---

## Pushing an auto-update to testers (optional, later)

Once testers are running a build, you don't have to re-send installers for every
fix. The app checks `https://sermonindex4.b-cdn.net/app/latest.json` on launch. To
push an update, run `scripts/publish-update.mjs` — it uploads the signed updater
artifacts and writes the multi-platform `latest.json`. Full steps are in
**UPDATER-SETUP.md**. For the first round of testing, sending installers directly
is simplest.

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
