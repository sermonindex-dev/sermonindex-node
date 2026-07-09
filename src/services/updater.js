/**
 * SermonIndex Auto-Updater Service
 *
 * Checks the CDN endpoint (configured in src-tauri/tauri.conf.json under
 * plugins.updater) for a signed release. Supports TWO delivery modes, chosen by
 * a `mode` field you set in latest.json — so you control per-push whether an
 * update installs silently or prompts the user:
 *
 *   "mode": "silent"  → download + install in the background; applies on the
 *                       NEXT launch (we never yank the app out from under a user
 *                       who may be seeding or mid-download). Fires
 *                       'si-update-ready'.
 *   "mode": "prompt"  → (default) do nothing automatically; fire
 *                       'si-update-available' with an install() callback. The
 *                       UI shows a one-click prompt; clicking it downloads,
 *                       installs, and relaunches immediately (no reinstall).
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

const UPDATE_MANIFEST = 'https://sermonindex1.b-cdn.net/app/latest.json';

/**
 * Read the delivery mode from latest.json ('silent' | 'prompt'). Fetched
 * natively (fetch_text) to bypass CDN CORS. Defaults to 'prompt' on any failure.
 */
async function getUpdateMode() {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const txt = await invoke('fetch_text', { url: UPDATE_MANIFEST });
    const json = JSON.parse(txt);
    return json && json.mode === 'silent' ? 'silent' : 'prompt';
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
    console.log(`[Updater] Update available: v${update.version} (mode=${mode})`);

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
