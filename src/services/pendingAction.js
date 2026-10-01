/**
 * A request from the app menu that a page should carry out once it is showing.
 *
 * WHY. Three menu items — Check for Updates…, Verify Library… and Re-test
 * Reachability — switched to the right page and then fired a window event that
 * nothing listened for. The page opened and did nothing; the menu item looked
 * broken because it was. An event alone can't work anyway: it fires during the
 * same click that switches pages, before the page it is meant for has mounted.
 *
 * So the request is remembered here until the page takes it. A page that is
 * already open hears about it through the 'si-action' event; a page that is
 * just mounting takes it on mount. Either way it runs exactly once.
 */
let pending = null;

export function requestAction(name) {
  pending = name;
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('si-action', { detail: name }));
  }
}

/** True once, if `name` is the outstanding request — and clears it. */
export function takeAction(name) {
  if (pending !== name) return false;
  pending = null;
  return true;
}

/** Subscribe a page to a named request. Returns the unsubscribe function. */
export function onAction(name, fn) {
  if (takeAction(name)) fn();
  const h = (e) => { if (e.detail === name && takeAction(name)) fn(); };
  window.addEventListener('si-action', h);
  return () => window.removeEventListener('si-action', h);
}
