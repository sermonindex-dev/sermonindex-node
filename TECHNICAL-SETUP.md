# SermonIndex Node Software — Technical Setup & Reference

A technical guide for building, running, and operating the Node Software, setting
up a reachable seed node, and (for maintainers) the server-side infrastructure.

- **App:** SermonIndex Node Software `v1.1.0` — identifier `net.sermonindex.desktop`
- **Stack:** Tauri 2 (Rust backend) · React 19 + Vite 5 (frontend) · librqbit 8 (BitTorrent engine)
- **Platforms:** macOS, Windows, Linux (x86-64 and ARM64)

> Secrets (seed-node password, moderation keys, storage keys, signing key) are
> **not** printed here — they're provided out-of-band. Placeholders are marked
> `<LIKE_THIS>`.

---

## Table of contents

1. Architecture overview
2. Build from source
3. Runtime data layout
4. Networking & firewall (ports, DHT, trackers)
5. Seed node setup
6. Making a node reachable (router / port forwarding)
7. Headless / Raspberry Pi node
8. The trust system (canonical torrents & master list)
9. Maintainer: server-side (Bunny CDN + Edge Scripts)
10. Maintainer: signed auto-updates
11. Maintainer: catalog & torrent pipeline
12. Troubleshooting

---

## 1. Architecture overview

The app is a Tauri desktop shell. The **frontend** (React/Vite) handles UI and
orchestration; the **Rust backend** exposes commands over Tauri IPC and runs an
embedded BitTorrent node.

```
┌──────────────────────────── Tauri app ────────────────────────────┐
│  React/Vite frontend                                               │
│    ├─ downloadManager.js   HTTP download (CDN/Archive) → seed       │
│    ├─ catalog.js           master-list trust + disk reconciliation │
│    ├─ torrent.js           thin wrapper over Rust IPC              │
│    └─ network.js           reachability probe + seed directory     │
│                        ▲ Tauri IPC (invoke)                        │
│  Rust backend (lib.rs)  │                                          │
│    ├─ file commands  save/create/append/list/delete/export (shard) │
│    ├─ torrent_node.rs  librqbit session (DHT + trackers + UPnP)    │
│    ├─ fetch_text / download_speaker_image (native HTTP, CORS-free) │
│    └─ storage override, settings, updater, single-instance         │
└────────────────────────────────────────────────────────────────────┘
```

Key design choices:

- **HTTP is the guaranteed download path** (Bunny CDN / Archive.org). Once a file
  is on disk it is seeded over BitTorrent, so the swarm grows without ever being
  the *only* way to get a file.
- **No librqbit list persistence.** The downloads folder is the single source of
  truth; on start the app reseeds exactly what's on disk. (Persistence previously
  re-downloaded deleted files from webseeds.)
- **Single instance enforced** — a second launch focuses the existing window.

---

## 2. Build from source

### Prerequisites

- **Node.js 18+** and npm
- **Rust** (stable) via [rustup](https://rustup.rs) — provides `cargo`
- Platform toolchain:
  - **macOS:** `xcode-select --install`
  - **Windows:** Microsoft C++ Build Tools + WebView2 runtime (preinstalled on Win 11)
  - **Linux (Debian/Ubuntu):**
    ```bash
    sudo apt update && sudo apt install -y \
      build-essential curl wget file libssl-dev \
      libwebkit2gtk-4.1-dev librsvg2-dev \
      libayatana-appindicator3-dev libxdo-dev
    ```

### Install & run

```bash
npm install                 # JS deps
npm run fetch-images        # bundle ~923 speaker portraits into public/ (see §12)
npm run tauri dev           # dev build with hot reload
```

First `tauri dev` compiles the Rust crate and can take several minutes; later
runs are incremental.

### Release build

```bash
npm run fetch-images        # ensure portraits are bundled BEFORE building
npm run tauri build
```

Bundles are written to `src-tauri/target/release/bundle/` (`.dmg`/`.app` on macOS,
`.msi`/`.exe` on Windows, `.deb`/`.AppImage` on Linux). Signed updater artifacts
are produced when `createUpdaterArtifacts` is on (see §10).

---

## 3. Runtime data layout

All app state lives under **`~/.sermonindex/`**:

```
~/.sermonindex/
├── downloads/                 # default download root (overridable, see below)
│   ├── ar/aRkmxYLtHA4H8-9Y.mp3   # sharded: <2-char>/<id>.<ext>
│   ├── 8z/8zu4tCtL4HUIzsC0.mp3
│   └── speaker-images/           # right-click "Download image" saves here
├── torrents/                  # .torrent files generated for locally-seeded files
├── torrent-session/           # librqbit DHT cache
├── settings.json              # includes "storage_dir" override
├── catalog.json               # cached catalog
└── download-state.json        # per-sermon state cache
```

### Storage sharding

New downloads are written to `downloads/<shard>/<id>.<ext>`, where `<shard>` is
the first two alphanumeric characters of the sermon id. This keeps any single
folder to a few thousand files — important on exFAT/FAT32 external drives (FAT32
caps ~65 k files/folder). **Sharding is local-only**: a single-file torrent's
name is the basename, so the folder never changes the infohash. Reads resolve
either the sharded path or a legacy flat path, so old layouts keep working.

### Relocating storage (external drive)

Set the download folder in **My Downloads → Change…** or the **Seed Node**
setup. This calls `set_storage_dir`, persists `storage_dir` in `settings.json`,
and every `downloads_dir()` caller (downloads, seeding, listing) honors it on the
next operation. Existing files are left in place; only new downloads follow.

---

## 4. Networking & firewall

| Property | Value |
|---|---|
| BitTorrent listen ports | **TCP/UDP 42800–42839** (`42800..42840`) |
| Port mapping | UPnP + NAT-PMP (automatic) |
| Peer discovery | Mainline DHT + public trackers |
| Trackers | opentrackr.org:1337, open.demonii.com:1337, tracker.torrent.eu.org:451, exodus.desync.com:6969 (all UDP) |

**Outbound hosts** the app contacts (CSP `connect-src`) — allow these on locked-down networks:

```
https://*.sermonindex.net        analytics catalog, speaker images
https://*.b-cdn.net              Bunny CDN (audio/video/torrents/updates)
https://*.archive.org            Archive.org fallback
https://community-chat-z71kj.bunny.run   community chat
https://app-endpoints-gkb5p.bunny.run    reachability probe + seed directory
https://ipapi.co / https://ipwho.is / http://ip-api.com   public-IP/geo lookup
```

librqbit binds the first free port in the range. For a reachable node, forward
**TCP 42800** at minimum (ideally the whole 42800–42839 range) — see §6.

---

## 5. Seed node setup

A seed node holds a large portion — or all — of the library and serves it 24/7.

1. **Unlock** the Seed Node page (password provided out-of-band: `<SEED_PASSWORD>`).
2. **Choose scope:**
   - **Audio only** — full mp3 library, ~**400 GB**
   - **Full** — audio + video, ~**2.4 TB** (~2 TB is video)
3. **Set the storage folder to your dedicated drive first** (so the bulk download
   lands there, sharded — §3).
4. **Run the scope-filtered bulk download.** It only fetches what's missing, so it
   resumes safely across restarts. Full-library runs can take days.
5. **Become reachable** (§6) so you count as backbone.

**Verified Seed Node** = ≥ **95 %** of the chosen scope present on disk **and**
the node is reachable from the internet. Progress is computed from an actual disk
scan (`list_downloaded_files`, shard-aware), not download history.

---

## 6. Making a node reachable (router / port forwarding)

Only one end of a BitTorrent connection needs to be reachable. A "closed" node
still uploads to reachable peers — but **reachable seed nodes are the backbone**.

### Automatic

The app attempts UPnP / NAT-PMP on start. Check the **Connections** page:
`Good`/`Excellent` = reachable; `Fair` = running but unreachable.

### Manual port forward

If your router/ISP blocks automatic mapping:

1. Give the seed machine a **static LAN IP** (DHCP reservation in the router).
2. Log into the router (often `http://192.168.1.1`).
3. Under **Port Forwarding / Virtual Servers / NAT**, forward:
   - **TCP 42800 → `<machine-LAN-IP>`** (minimum), or the full **42800–42839** range.
4. Save and restart the app.

### Verify reachability

The server probe opens a TCP connection back to you:

```bash
curl -X POST 'https://app-endpoints-gkb5p.bunny.run/probe' \
  -H 'content-type: application/json' \
  -d '{"port":42800,"ip":"<YOUR_PUBLIC_IP>"}'
# → {"ok":true,"open":true,"ip":"…","port":42800}
```

### Notes

- **CGNAT** (common on cellular/some fiber ISPs) makes inbound impossible — you'll
  need a real public IP, an ISP "bridge" mode, or a VPS/VPN with port forwarding.
- **Dynamic WAN IP:** use a free Dynamic DNS provider for a stable hostname.
- Forward **TCP** (BitTorrent peer traffic here is TCP); UDP DHT works outbound
  regardless.

---

## 7. Headless / Raspberry Pi node

A **Raspberry Pi 4/5 (4 GB+), 64-bit OS**, with an external USB/NVMe drive is an
ideal always-on node (very low power draw).

- Build the **Linux ARM64** bundle on the Pi (install the Linux prerequisites in
  §2, then `npm run tauri build`), or run `npm run tauri dev` on Pi OS Desktop.
- Mount the external drive and point `storage_dir` at it.
- Forward the port (§6) and enable autostart (the app registers with
  `tauri-plugin-autostart`) so it relaunches on boot.
- Keep the OS/webkit packages updated for security.

---

## 8. The trust system (canonical torrents & master list)

To guarantee no tampered content can enter the network:

- **Master list:** `https://sermonindex1.b-cdn.net/torrents/master-list.json`
  — versioned, signed, `entries` keyed by sermon id → `{ info_hash, torrent_url, magnet }`.
- **Canonical .torrent:** 2 MiB pieces, stored hex-sharded by `md5(id)[:2]` at
  `torrents/<shard>/<id>.torrent`. Contains a **BEP19 webseed** pointing at the
  exact hashed CDN URL (byte-identical, so webseed verification passes).
- **Trust rule:** after an HTTP download, the app adds the *canonical* torrent for
  that id. librqbit hash-checks the file against the official fingerprint and
  joins the **one** canonical swarm. Because hashing is deterministic (same
  filename + piece size), even a legacy self-seed lands in the same swarm.

The app fetches the master list via the native `fetch_text` command (the CDN sends
no CORS headers for JSON, so a browser `fetch` would fail).

---

## 9. Maintainer: server-side (Bunny CDN + Edge Scripts)

Everything server-side runs on Bunny — **no origin servers, no Docker.**

### Storage zone (`sermonindex1`) layout

```
/torrents/master-list.json         signed master list
/torrents/<shard>/<id>.torrent     canonical torrents (hex-sharded)
/app/latest.json + artifacts       updater feed (see §10)
/chat/chat.json                    community chat store
/network/seeds.json                seed-node directory
```

### Community chat — `server/chat-edge-script.js`

Deployed as a Standalone Edge Script → `community-chat-z71kj.bunny.run`.

Environment variables (secrets):

```
STORAGE_ZONE = <zone name>
STORAGE_KEY  = <storage zone password>
ADMIN_KEY    = <long random moderation key>
STORAGE_HOST = storage.bunnycdn.com     # or your region host
```

Behavior: single JSON file, keeps last 200 messages, 5 s/node rate limit, GET
returns ≤100. Moderation via `?admin_key=<ADMIN_KEY>&action=ban|unban|delete`.

### Reachability + seed directory — `server/network-edge-script.js`

Deployed → `app-endpoints-gkb5p.bunny.run`. Env: `STORAGE_ZONE`, `STORAGE_KEY`,
`STORAGE_HOST`.

- `POST /probe {port, ip?}` — raw TCP connect-back via `Deno.connect` → `{open}`.
- `POST /seeds {node_id, port, scope}` — registers/refreshes a node (records IP,
  port, scope, reachability, timestamp).
- `GET /seeds` — returns **reachable** nodes seen in the last 2 h.

Deploy: Edge Scripting → Add script → Standalone → paste file → set env vars →
Publish. The app calls the `*.bunny.run` hostnames directly (no DNS/Edge-Rule
needed).

---

## 10. Maintainer: signed auto-updates

- **Feed:** `https://sermonindex1.b-cdn.net/app/latest.json`
- **Public key:** embedded in `tauri.conf.json → plugins.updater.pubkey` (minisign).
- **Private key:** `~/.tauri/sermonindex.key` — **must stay OUT of the repo**
  (`.gitignore` blocks `*.key` / `*.key.pub`). Keep an offline backup; losing it
  means no client can verify future updates.

Release flow:

1. Bump `version` in **both** `src-tauri/tauri.conf.json` and `package.json`.
2. `npm run tauri build` (with `TAURI_SIGNING_PRIVATE_KEY` / password set) →
   produces platform bundles + `.sig` signatures.
3. Upload the bundles and an updated `latest.json` (version, notes, per-platform
   URL + signature) to Bunny `/app/`.
4. Clients check the feed on launch and apply signed updates.

See `UPDATER-SETUP.md` for the full checklist.

---

## 11. Maintainer: catalog & torrent pipeline

Scripts under `scripts/`:

- **`generate-canonical-torrents.mjs`** — hashes each source file → `.torrent`
  (2 MiB pieces, hex-sharded) + `master-list.json`; webseed = the exact hashed URL.
- **`upload-canonical-torrents.mjs`** (`--verify`) — uploads the sharded output to
  Bunny Storage; `--verify` re-checks what's live.
- **`reshard-hex.mjs` / `shard-canonical-output.mjs`** — migrate a flat torrents
  folder into the `md5[:2]` shard layout (Bunny caps 10 k files/folder; sharding
  yields 256 folders of ~130 files).
- **`fetch-speaker-images.mjs`** (`npm run fetch-images`) — mirrors speaker
  portraits into `public/images/speakers/` so they ship in the app.

Catalog source: `https://analytics.sermonindex.net/api/catalog`. Media bases:
`sermonindex1.b-cdn.net` (audio), `sermonindex2.b-cdn.net` (video),
`archive.org/download/SERMONINDEX_<code>` (fallback).

---

## 12. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Node shows **Offline / Fair** | Port not reachable — forward TCP 42800 (§6); confirm no second instance; check for CGNAT. |
| **"No data loading"** | Master list/catalog fetch failed. It's fetched natively (CORS-free) with retries; check outbound access to `*.b-cdn.net` and `analytics.sermonindex.net`. |
| **Downloads don't appear** but files are on disk | State is reconciled from disk on start; listing is shard-aware. Reopen My Downloads. Files are named `<id>.<ext>` by design (torrent identity). |
| **Deleted sermons come back** | Fixed: no librqbit persistence; the app reseeds only what's on disk. If seen, ensure you're on ≥ current build. |
| **Broken/lagging speaker images** | Run `npm run fetch-images`. Its failure list = speakers whose catalog image path 404s on the site (data mismatch), which fall back to the bundled silhouette. |
| **Seed % not reaching Verified** | Need ≥95 % of the chosen scope on disk **and** reachability. Check the drive has the full scope and the port is open. |
| **Folder picker / dialog does nothing** | Requires `dialog:default` in `src-tauri/capabilities/default.json` (already set) — rebuild after changing capabilities. |
| **Two windows / weird torrent state** | Single-instance guard blocks duplicates; fully quit stray instances and relaunch. |

---

*Questions or contributions: reply on the SermonIndex forums. For sensitive
values (seed password, moderation/storage/signing keys), contact a maintainer.*
