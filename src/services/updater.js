/**
 * SermonIndex Auto-Updater Service
 *
 * Checks the CDN endpoint (configured in src-tauri/tauri.conf.json under
 * plugins.updater) for a signed release. Supports THREE delivery modes, chosen
 * by a `mode` field you set in latest.json — so you control per-push whether an
 * update installs silently, prompts the user, or is force-applied:
 *
 *   "mode": "silent"  → download + install in the background; applies on the
 *                       NEXT launch (we never yank the app out from under a user
 *                       who may be seeding or mid-download). Fires
 *                       'si-update-ready'.
 *   "mode": "prompt"  → (default) do nothing automatically; fire
 *                       'si-update-available' with an install() callback. The
 *                       UI shows a one-click prompt; clicking it downloads,
 *                       installs, and relaunches immediately (no reinstall).
 *   "mode": "force"   → BREAK-GLASS emergency lever for the WHOLE node network:
 *                       download + install AND relaunch IMMEDIATELY — no prompt,
 *                       even while the app is running. Combined with the ~6-hourly
 *                       re-check below (startUpdateChecks), a "force" release
 *                       reaches every running node and auto-applies within ~6h.
 *                       Reserve it for critical/security pushes — it interrupts
 *                       users mid-use.
 *
 * The Tauri updater ignores unknown fields in latest.json, so `mode` lives right
 * alongside the standard version/notes/platforms — one file, backend-controlled.
 *
 * Fail-safe by design: this function NEVER throws.
 *   - Dev builds do nothing (import.meta.env.DEV).
 *   - Missing/placeholder pubkey, offline, latest.json not uploaded, bad
 *     signature: all swallowed — the app keeps running the current version.
 *
 * See UPDATER-SETUP.md for the release/signing workflow.
 */

const UPDATE_MANIFEST = 'https://sermonindex4.b-cdn.net/app/latest.json';

// The periodic re-check calls checkForUpdates() repeatedly; only surface/install
// a given version once per run so we don't re-nag (prompt) or re-install (silent).
let _handledVersion = null;
let _timer = null;
let _lastCheck = 0;

/**
 * Read the delivery mode from latest.json ('force' | 'silent' | 'prompt').
 * Fetched natively (fetch_text) to bypass CDN CORS. Defaults to 'prompt' on any
 * failure or unrecognized value.
 */
async function getUpdateMode() {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const txt = await invoke('fetch_text', { url: UPDATE_MANIFEST });
    const json = JSON.parse(txt);
    return json && json.mode === 'force' ? 'force'
      : json && json.mode === 'silent' ? 'silent'
      : 'prompt';
  } catch {
    return 'prompt';
  }
}

export async function checkForUpdates() {
  try {
    // Dev builds are unsigned and unpublished — nothing to check
    if (import.meta.env.DEV) return;

    const { check } = await import('@tauri-apps/plugin-updater');
    const update = await check();
    if (!update) {
      console.log('[Updater] App is up to date');
      return;
    }

    const mode = await getUpdateMode();
    if (_handledVersion === update.version) return; // already surfaced/installed this version this run
    _handledVersion = update.version;
    console.log(`[Updater] Update available: v${update.version} (mode=${mode})`);

    if (mode === 'force') {
      // BREAK-GLASS: install AND relaunch immediately — no prompt, even mid-use.
      // The whole-network emergency lever (critical/security releases only). The
      // _handledVersion guard above ensures this fires once per version per run.
      console.warn('[Updater] FORCED update — installing v' + update.version + ' now');
      await update.downloadAndInstall();
      try {
        const { relaunch } = await import('@tauri-apps/plugin-process');
        await relaunch();
      } catch {
        // Relaunch unavailable — it's still installed; it will apply next launch.
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('si-update-ready', { detail: { version: update.version } }));
        }
      }
      return;
    }

    if (mode === 'silent') {
      // Install now, apply on next launch — non-disruptive.
      await update.downloadAndInstall();
      console.log('[Updater] Installed silently — applies next launch');
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('si-update-ready', {
          detail: { version: update.version, mode },
        }));
      }
      return;
    }

    // mode === 'prompt' — hand the UI an installer it can trigger on click.
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('si-update-available', {
        detail: {
          version: update.version,
          notes: (update.body || '').trim(),
          install: async () => {
            // Download + install, then relaunch immediately — seamless, no
            // reinstall, user data in ~/.sermonindex is untouched.
            await update.downloadAndInstall();
            try {
              const { relaunch } = await import('@tauri-apps/plugin-process');
              await relaunch();
            } catch (e) {
              // If relaunch is unavailable, it's still installed for next launch.
              console.warn('[Updater] relaunch failed, will apply next launch:', e?.message || e);
              window.dispatchEvent(new CustomEvent('si-update-ready', {
                detail: { version: update.version },
              }));
            }
          },
        },
      }));
    }
  } catch (e) {
    // Placeholder pubkey, offline, latest.json not uploaded yet, plugin not
    // registered… all non-fatal — the current version keeps running.
    console.warn('[Updater] Update check skipped:', e?.message || e);
  }
}

/**
 * Kick off update checks: once now, then every `intervalHours`, plus on
 * network-reconnect and when the window regains focus — so a long-running seed
 * node surfaces a new release without a manual relaunch. In "prompt" mode this
 * makes the bottom-left "Update available" banner appear on an already-running
 * app (the check is otherwise launch-only).
 */
export function startUpdateChecks({ intervalHours = 6 } = {}) {
  _lastCheck = Date.now();
  checkForUpdates();
  if (_timer) return; // idempotent — only one interval/listener set
  _timer = setInterval(() => { _lastCheck = Date.now(); checkForUpdates(); }, Math.max(1, intervalHours) * 3600 * 1000);
  if (typeof window !== 'undefined') {
    const maybe = () => {
      const now = Date.now();
      if (now - _lastCheck < 30 * 60 * 1000) return; // debounce focus/online to ≤ every 30 min
      _lastCheck = now;
      checkForUpdates();
    };
    try {
      window.addEventListener('online', maybe);
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') maybe(); });
    } catch { /* non-browser */ }
  }
}
