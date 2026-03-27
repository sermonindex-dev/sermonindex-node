/**
 * SermonIndex Tauri Store Service
 *
 * Bridge between the web frontend and Tauri's Rust backend.
 * Provides persistent storage for catalog, download state, and settings.
 *
 * When running in a browser (dev mode), falls back to localStorage.
 * When running in Tauri, uses the Rust file system commands.
 */

// Detect if we're running inside Tauri
const isTauri = () => {
  return typeof window !== 'undefined' && window.__TAURI_INTERNALS__;
};

/**
 * Invoke a Tauri command (or fall back to localStorage)
 */
async function invoke(cmd, args = {}) {
  if (isTauri()) {
    const { invoke: tauriInvoke } = await import('@tauri-apps/api/core');
    return tauriInvoke(cmd, args);
  }
  return null;
}

// ─── Catalog ────────────────────────────────────────────────────────────────

export async function saveCatalog(catalog) {
  const data = JSON.stringify(catalog);
  if (isTauri()) {
    return invoke('save_catalog', { data });
  }
  localStorage.setItem('si_catalog', data);
}

export async function loadCatalog() {
  if (isTauri()) {
    const data = await invoke('load_catalog');
    return data ? JSON.parse(data) : [];
  }
  const data = localStorage.getItem('si_catalog');
  return data ? JSON.parse(data) : [];
}

// ─── Download State ─────────────────────────────────────────────────────────

export async function saveDownloadState(state) {
  const data = JSON.stringify(state);
  if (isTauri()) {
    return invoke('save_download_state', { data });
  }
  localStorage.setItem('si_download_state', data);
}

export async function loadDownloadState() {
  if (isTauri()) {
    const data = await invoke('load_download_state');
    return data ? JSON.parse(data) : {};
  }
  const data = localStorage.getItem('si_download_state');
  return data ? JSON.parse(data) : {};
}

// ─── Settings ───────────────────────────────────────────────────────────────

export async function saveSettings(settings) {
  const data = JSON.stringify(settings);
  if (isTauri()) {
    return invoke('save_settings', { data });
  }
  localStorage.setItem('si_settings', data);
}

export async function loadSettings() {
  if (isTauri()) {
    const data = await invoke('load_settings');
    return data ? JSON.parse(data) : {};
  }
  const data = localStorage.getItem('si_settings');
  return data ? JSON.parse(data) : {};
}

// ─── Storage Info ───────────────────────────────────────────────────────────

export async function getStoragePath() {
  if (isTauri()) {
    return invoke('get_storage_path');
  }
  return null; // Not applicable in browser
}

export async function getStorageUsage() {
  if (isTauri()) {
    return invoke('get_storage_usage');
  }
  return { bytes: 0, formatted: '0 B', file_count: 0 };
}

export async function getAppVersion() {
  if (isTauri()) {
    return invoke('get_app_version');
  }
  return '1.0.0-web';
}

export { isTauri };
