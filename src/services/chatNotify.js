// Community chat unread tracking + notification preferences.
// Powers the unread badge beside "Community" in the sidebar.

// Bunny Edge Script endpoint — keep in sync with CHAT_API in src/pages/CommunityPage.jsx
const CHAT_API = 'https://community-chat-z71kj.bunny.run/';

const LAST_READ_KEY = 'si-chat-last-read'; // highest message id the user has seen
const NOTIFY_KEY = 'si-chat-notify';       // '1' (default) = show unread badge
const SHOW_KEY = 'si-chat-show';           // '1' (default) = show Community page at all

export function getLastRead() {
  try {
    const v = parseInt(localStorage.getItem(LAST_READ_KEY), 10);
    return Number.isFinite(v) && v > 0 ? v : 0;
  } catch {
    return 0;
  }
}

export function setLastRead(id) {
  try {
    const n = Number(id) || 0;
    if (n > getLastRead()) localStorage.setItem(LAST_READ_KEY, String(n));
  } catch {}
}

// How many messages exist beyond the last one the user has read.
// Never throws — returns 0 on any network/payload error.
export async function fetchUnreadCount() {
  try {
    const res = await fetch(`${CHAT_API}?since=${getLastRead()}`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return 0;
    const data = await res.json();
    if (!data.ok || !Array.isArray(data.messages)) return 0;
    return data.messages.length;
  } catch {
    return 0;
  }
}

export function chatPrefs() {
  let notify = true;
  let show = true;
  try {
    notify = localStorage.getItem(NOTIFY_KEY) !== '0';
    show = localStorage.getItem(SHOW_KEY) !== '0';
  } catch {}
  return { notify, show };
}
