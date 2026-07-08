/**
 * SermonIndex Auto-Updater Service
 *
 * Checks the CDN endpoint (configured in src-tauri/tauri.conf.json under
 * plugins.updater) for a signed release, downloads and installs it, then
 * announces via the 'si-update-ready' window event. The installed update
 * takes effect on the NEXT launch — we never restart underneath the user
 * (they may be seeding torrents or mid-download).
 *
 * Fail-safe by design: this function NEVER throws.
 *   - In dev builds it does nothing (import.meta.env.DEV).
 *   - While the pubkey placeholder in tauri.conf.json hasn't been replaced
 *     with a real `tauri signer` public key, the plugin errors out and we
 *     swallow it — the app just keeps running the current version.
 *   - Offline / endpoint missing / bad signature: same, silently skipped.
 *
 * See UPDATER-SETUP.md at the repo root for the release/signing workflow.
 */

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

    console.log(`[Updater] Update available: v${update.version} — downloading...`);
    await update.downloadAndInstall();
    console.log('[Updater] Update installed — takes effect next launch');

    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('si-update-ready', {
        detail: { version: update.version },
      }));
    }
  } catch (e) {
    // Placeholder pubkey, offline, latest.json not uploaded yet, plugin not
    // registered… all non-fatal — the current version keeps running.
    console.warn('[Updater] Update check skipped:', e?.message || e);
  }
}
