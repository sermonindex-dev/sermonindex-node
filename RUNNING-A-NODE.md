# Running a SermonIndex Node — Technical Reference

A hands-on reference for running the Node Software and operating a seed node.
Written for technical users; assumes comfort with a router admin page and a
terminal. (Building from source and server/maintainer setup live in a separate
document.)

- **App:** SermonIndex Node Software `v1.1.0`
- **Every node** downloads sermons and shares them peer-to-peer (BitTorrent).
- **Seed nodes** hold a large portion — or all — of the library and stay online,
  forming the reachable backbone of the network.

---

## 1. How a node behaves

- HTTP (Bunny CDN / Archive.org) is the guaranteed way to **get** a file; once a
  file is on disk the app **seeds** it over BitTorrent (DHT + trackers + UPnP).
- The **downloads folder is the source of truth.** On launch the app reseeds
  exactly what's on disk — delete a file and it's truly gone (no silent
  re-download).
- **One instance only** — launching again focuses the existing window.
- **Leaf vs seed:** even behind a closed router your node still uploads to
  reachable peers. A node that is itself reachable (§5) becomes backbone.

---

## 2. Install & first run

1. Install the app for your OS (`.dmg`/`.app`, `.msi`/`.exe`, or `.AppImage`/`.deb`).
2. Launch it. On first run it fetches the catalog and starts the BitTorrent node.
3. Check the **Connections** page — it shows your listen port, reachability, DHT
   and peer status.

No account or configuration is required to be a normal (leaf) node — just leave it
running.

---

## 3. Where your data lives

All state is under **`~/.sermonindex/`**:

```
~/.sermonindex/
├── downloads/                      # default download root (relocatable)
│   ├── ar/aRkmxYLtHA4H8-9Y.mp3        # sharded: <2-char>/<id>.<ext>
│   └── speaker-images/                # right-click → Download image
├── torrents/                       # .torrent files for locally-seeded media
├── settings.json                   # holds your "storage_dir" override
├── catalog.json / download-state.json
└── torrent-session/                # DHT cache
```

- **Filenames are the sermon id** (`<id>.mp3`/`.mp4`) — that *is* the file's
  torrent identity; don't rename them or seeding breaks. Use **Export** (in My
  Downloads) to get human-named copies in `Desktop/<Speaker>/<Title>.ext`.
- **Sharding:** files auto-sort into 2-character subfolders so no single folder
  holds tens of thousands of files (matters on exFAT/FAT32 external drives). It's
  purely local and never affects the torrent/infohash.

### Relocating storage (e.g. an external drive)

My Downloads → **Change…** (or the Seed Node setup) → pick the drive. This
persists `storage_dir`; **new** downloads go there, existing files stay put. Set
this **before** a big seed download so everything lands on the drive.

---

## 4. Networking & firewall

| Property | Value |
|---|---|
| Listen ports | **TCP/UDP 42800–42839** |
| Port mapping | UPnP + NAT-PMP (auto) |
| Peer discovery | Mainline DHT + public UDP trackers |

If you run a restrictive firewall, allow outbound HTTPS to:

```
*.sermonindex.net · *.b-cdn.net · *.archive.org
community-chat-z71kj.bunny.run · app-endpoints-gkb5p.bunny.run
ipapi.co · ipwho.is · ip-api.com
```

For inbound reachability (seed nodes), forward **TCP 42800** (§5).

---

## 5. Running a seed node

1. **Unlock** the Seed Node page (password provided by a maintainer:
   `<SEED_PASSWORD>`).
2. **Pick scope:**
   - **Audio only** — full mp3 library, ~**400 GB**
   - **Full** — audio + video, ~**2.4 TB** (~2 TB video)
3. **Point storage at your dedicated drive** first (§3).
4. **Start the scope-filtered bulk download.** It fetches only what's missing and
   resumes across restarts, so you can stop/start freely. Full runs take days —
   just leave it going.
5. **Make the node reachable** (§6) so you count as backbone.

**Verified Seed Node** requires **both**:

- ≥ **95 %** of the chosen scope present on disk (measured by an actual disk scan,
  not download history), **and**
- the node is **reachable** from the internet.

The Seed Node page shows your on-disk coverage; the menu badge counts reachable
seed nodes network-wide (your own node isn't counted for you).

---

## 6. Making your node reachable

Check the **Connections** page: `Good`/`Excellent` = reachable, `Fair` = running
but not reachable.

### Automatic (works on many routers)

The app tries UPnP / NAT-PMP on start. If your router allows it, you're done.

### Manual port forward

1. Reserve a **static LAN IP** for the seed machine (DHCP reservation in router).
2. Open the router admin page (often `http://192.168.1.1`).
3. Under **Port Forwarding / Virtual Servers / NAT**, forward
   **TCP 42800 → `<machine-LAN-IP>`** (or the full **42800–42839** range).
4. Save and restart the app.

### Verify from outside

```bash
curl -X POST 'https://app-endpoints-gkb5p.bunny.run/probe' \
  -H 'content-type: application/json' \
  -d '{"port":42800,"ip":"<YOUR_PUBLIC_IP>"}'
# → {"ok":true,"open":true,...}   open:true means reachable
```

### Gotchas

- **CGNAT** (many cellular / some fiber ISPs): inbound is impossible without a
  real public IP — ask the ISP for bridge mode, or tunnel through a VPS/VPN that
  offers port forwarding.
- **Changing WAN IP:** use a free Dynamic DNS hostname.
- Forward **TCP** — peer traffic here is TCP; DHT (UDP) works outbound regardless.
- You don't *need* to forward to help, but reachable nodes are what keep the
  archive alive 24/7.

---

## 7. Always-on / Raspberry Pi

A **Raspberry Pi 4/5 (4 GB+), 64-bit OS**, with an external USB/NVMe drive makes a
great low-power permanent node:

- Run the Linux build, point storage at the external drive, forward the port (§6).
- The app registers autostart, so it relaunches on boot — set it and forget it.
- Keep OS/webview packages patched.

Any always-on machine (mini-PC, NAS that runs desktop Linux, a spare laptop with
the lid-close-sleep disabled) works equally well.

---

## 8. Everyday operation

- **Status at a glance:** Connections page (reachability, peers, port), Seed Node
  page (scope coverage %), sidebar badges (nodes / seeds online).
- **Updates:** the app checks for signed updates on launch and applies them
  automatically.
- **Moving the drive:** quit the app, move the drive, relaunch, and re-point
  `storage_dir` if the mount path changed — it reseeds from disk.
- **Pause/resume** bulk downloads any time; progress is derived from disk, so
  nothing is lost.

---

## 9. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| **Offline / Fair** on Connections | Port not reachable — forward TCP 42800 (§6); confirm no second instance; check for CGNAT. |
| **No data loading** | Catalog/master-list fetch failing — allow outbound to `*.b-cdn.net` and `analytics.sermonindex.net`; it retries automatically. |
| **Downloaded files not in My Downloads** | State is rebuilt from disk on launch; reopen the page. Files are named `<id>.<ext>` by design. |
| **Files reappear after I delete them** | Should not happen on current builds (no torrent persistence; reseed-from-disk). Update if you see it. |
| **Seed % stuck below Verified** | Need ≥95 % of the scope on disk **and** reachability — verify the drive holds the full scope and the port is open. |
| **Speaker images broken/slow** | Cosmetic; the app falls back to a bundled placeholder. Some portraits are missing upstream. |
| **Change-folder button does nothing** | Use a current build; relaunch after changing the storage folder. |

---

*Need the seed-node password or hit something not covered here? Ask on the
SermonIndex forums.*
