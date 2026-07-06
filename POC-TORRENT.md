# BitTorrent Pivot — Proof of Concept

## Why we pivoted from IPFS

The hand-rolled libp2p/IPFS node never connected reliably. The debug log showed
44,742 timeouts, 41,938 connection failures, and 2,804 DHT bootstrap failures —
root causes were a single-bootstrap-peer retry loop, failed NAT traversal on
home routers, and reliance on public IPFS infrastructure that ignores custom nodes.

BitTorrent solves all three with zero infrastructure of our own:

| Problem with IPFS attempt | BitTorrent answer |
|---|---|
| DHT bootstrap failures | Mainline DHT, millions of nodes, built into librqbit |
| NAT traversal failing | UPnP port forwarding + uTP; proven on home routers |
| No one to talk to | Public trackers + DHT; ANY torrent client can join the swarm |
| Availability with zero volunteers | HTTP (Archive.org / Bunny CDN) stays as guaranteed fallback |

The engine is [librqbit](https://github.com/ikatson/rqbit) (v8), embedded
directly in the existing Tauri Rust process. The IPFS code has now been fully
removed (Rust modules, JS services, npm/cargo deps, UI). The pre-removal state
is preserved in the git checkpoint commit "Checkpoint: pre-IPFS-removal state".

## What was added

- `src-tauri/src/torrent_node.rs` — torrent session (DHT, trackers, UPnP, persistence)
- `src-tauri/src/lib.rs` — 9 new Tauri commands (`torrent_*`), state wiring
- `src-tauri/Cargo.toml` — `librqbit`, `url`, `urlencoding`
- `src/services/torrent.js` — JS wrapper + `window.torrentPoc` devtools helpers
- `src/main.jsx` — one import line to register the helpers

Data locations (all under `~/.sermonindex/`):
- `downloads/` — files (shared with the existing HTTP download path, so
  HTTP-downloaded sermons can be seeded in place)
- `torrents/` — generated `.torrent` files (named `<infohash>.torrent`)
- `torrent-session/` — session persistence: seeded torrents auto-resume on restart

## Build

```bash
cd sermonindex-app
npm run tauri dev     # or: npm run tauri build
```

First build will take a while (librqbit + deps). If anything fails to compile,
it will be in `torrent_node.rs` — the API calls match librqbit 8.1.1 docs.

## PoC test: seed on this Mac, download elsewhere

**Node A (this Mac, the app):** open devtools console in the running app:

```js
await torrentPoc.start()
// pick any sermon file already in ~/.sermonindex/downloads:
const r = await torrentPoc.seedDownloaded('SID12345.mp3')
r.magnet   // ← copy this
```

Hashing a large file takes a moment. `torrentPoc.watch()` shows live state —
wait until state is `live` / progress 100%.

**Node B (any other computer — friend's machine, laptop on another network):**
paste the magnet into any of:
- qBittorrent / Transmission ("Add torrent link")
- rqbit CLI: `rqbit download 'magnet:?xt=...'`
- a second install of this app: `await torrentPoc.add('magnet:?xt=...')`

**Success criteria:** Node B finds Node A via DHT/tracker and the file
transfers. Then stop Node A mid-transfer of a second test on a third machine —
Node B should serve it. That's the vault working.

Notes:
- Two nodes on the *same LAN* will connect near-instantly (peer exchange +
  local discovery), but the real test is across different networks.
- If both nodes are behind hostile NATs with UPnP off, connection can fail —
  that's expected BitTorrent behavior; one reachable peer in the swarm fixes it.
- DHT announce takes a minute or two after seeding starts. Trackers are faster.

## What the full pivot looks like (after PoC validates)

1. **Catalog with infohashes** — a script walks the ~11,600 CDN files, generates
   `.torrent` files + magnets for each (or per-speaker bundles), publishes them
   in `catalog.json`. Add `url-list` (webseed, BEP19) entries pointing at the
   CDN so standard clients can always complete downloads even with no seeders.
2. **downloadManager.js** — try swarm first, fall back to HTTP (already works),
   auto-seed every completed download via `torrent_seed_downloaded`.
3. **Seed Node page** — "host X GB" slider → picks torrents to join (rarest
   first, based on heartbeat-server swarm stats), shows upload stats:
   "You've served N GB to M people."
4. **Heartbeat server** — keeps its role as stats dashboard + optionally a
   private tracker for faster peer discovery. (Payload now sends
   `seeded_torrents` / `p2p_status` / `protocol: 'bittorrent'` — the server
   dashboard may need a matching update.)
5. ~~Remove the IPFS modules~~ — DONE (Rust modules, JS services, deps, CSP).
