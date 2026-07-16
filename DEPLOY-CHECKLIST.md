# Deploy & Verify Checklist

Covers everything changed in this round. Two independent parts:
**A) edge scripts** (server-side, instant) and **B) the node app** (via the
auto-updater = a new signed release). Do A first — it's low-risk and much of the
visible change lands immediately.

---

## PART A — Edge scripts (Bunny) — instant, no app release

Redeploy each updated edge script with your usual Bunny Edge Scripting deploy,
then **purge the Bunny cache** for that host. All changes are additive; nodes stay
online through it.

- [ ] **app.sermonindex.net** — `si-app-edge-script.ts`
  (geo `region`, Chat Moderators setting, content-source dropdown + ipfs→BitTorrent
  migration, `master_list_version` + "Force all nodes to refresh" button)
- [ ] **forums.sermonindex.net** — `forum-edge-script.ts` (node-admin restyle + `SameSite=Lax` login fix)
- [ ] **analytics.sermonindex.net** — `analytics-edge-script.ts` (`SameSite=Lax` login fix)
- [ ] **newsletter.sermonindex.net** — `newsletter-edge-script.ts` (`SameSite=Lax` login fix)
- [ ] Purge cache for each host after deploying.

**Verify A (in the node-admin dashboard):**
- [ ] Login works on all four consoles (the `SameSite=Lax` fix).
- [ ] `/admin/config`: content source is a dropdown — **CDN / Peer-to-peer (BitTorrent) / Hybrid**; the old "ipfs-primary / ipfs-only" text is gone.
- [ ] `/admin/config`: a **Chat Moderators** box exists — paste your node id (e.g. `si-2098a`), Save.
- [ ] Master-list **"Force all nodes to refresh"** button present.
- [ ] Nodes list shows full country names (e.g. "Abbotsford, Canada"). *Region (BC) fills in once nodes run the new app build.*
- [ ] Nodes still show **Online** (heartbeats unaffected).
- [ ] Community chat: a moderator's messages show a ★ and a yellow background.

---

## PART B — Node app — new signed release via the updater

New installs auto-update from `https://sermonindex4.b-cdn.net/app/latest.json`
(the endpoint moved here from `sermonindex1`; for the FIRST release after the
switch, also publish once to the old zone — see the "Endpoint migration" note in
`UPDATER-SETUP.md` §6). The version MUST increase or the updater won't offer it.

1. [ ] **Bump the version** (both files, keep them equal): `src-tauri/tauri.conf.json`
       and `package.json` — `0.0.322` → e.g. `0.0.323`.
2. [ ] **Rust preflight** (already done once, re-run after the bump):
       `cd src-tauri && cargo build` — must succeed.
3. [ ] **Build signed installers** with the signing key present (per `UPDATER-SETUP.md`
       — the `TAURI_SIGNING_PRIVATE_KEY` / password env, using `~/.tauri/sermonindex.key`):
       `npm run tauri build`. Confirm each installer has a matching `.sig`.
4. [ ] **Upload the installers + download page**: `node scripts/deploy-installers.mjs`
       (per `TEST-BUILDS.md`) — uploads the `.dmg/.exe/.AppImage` and the per-version
       `manifest.json`/`index.html`. It does **not** write `latest.json`.
5. [ ] **Publish the auto-update manifest**: `node scripts/publish-update.mjs`
       (per `UPDATER-SETUP.md`) — uploads the signed updater artifacts and writes the
       multi-platform `latest.json`. (CI runs both automatically on a `v*` tag.)
6. [ ] **Purge** the Bunny cache for `latest.json` (and the artifact/installer paths)
       so the updater sees the new version immediately.

**Verify B — test the update on ONE machine running the OLD version first:**
- [ ] It detects the update and installs, then relaunches on the new version.
- [ ] **Re-consent:** on launch it re-shows the conditions (the privacy version was
      bumped); until you Accept, P2P / heartbeat / geolocation / port-forwarding stay OFF.
- [ ] After Accept: node comes Online; node-admin now shows **City, Region, Country**.
- [ ] **Chat:** names are prominent with the `#si-xxxx` id small underneath; your own
      messages align right; moderators show ★ + yellow.
- [ ] **Throttle:** Settings → toggle "Limit upload speed", set a KB/s value; confirm
      BitTorrent upload is actually capped and the setting survives a restart.
- [ ] **Storage cap:** set a low Storage Limit and confirm a new download is blocked
      with the limit message.
- [ ] **Background mode OFF:** closing the window quits (doesn't stay in the tray).
- [ ] **Master-list cache:** relaunch — it should NOT re-download the master list;
      then click "Force all nodes to refresh" in node-admin and confirm the node
      re-pulls within ~5 min (its next heartbeat).
- [ ] Only after the single-machine test passes, let it roll out to everyone.

---

## Notes / gotchas
- **Order:** Part A can go now. Part B needs the version bump + signing; the updater
  ignores a build whose version isn't higher than what's installed.
- **Re-consent is expected** for existing users this release (accurate new privacy
  disclosure) — combined with the consent gate, their node holds all networking
  until they re-accept. Worth a heads-up in the chat/announcement.
- **Master-list caching** only benefits nodes on the new build; older builds keep
  re-downloading until they update, but ignore the new `master_list_version` harmlessly.
- **Security:** `SECURITY.md` tracks the residual `quick-xml` advisories (upstream-blocked,
  low real-world risk). `npm audit fix` (not `--force`) clears the safe JS dev-tooling ones.
- **Rollback:** keep the previous installers + `latest.json` so you can re-point the
  manifest to the prior version if a release misbehaves.
