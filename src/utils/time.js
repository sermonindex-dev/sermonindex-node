// ── Shared time-display helpers ───────────────────────────────────────────────
// Times are STORED/persisted as "HH:MM" (24-hour) everywhere; the 12-hour form is
// display only. This lives in one place so the Settings dropdowns, the Settings
// summary line and the Dashboard seeding indicator can never drift apart.

// "23:00" → "11:00 PM". Returns the input unchanged when it isn't HH:MM.
export function to12h(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''));
  if (!m) return String(hhmm || '');
  const h24 = Number(m[1]) % 24;
  const suffix = h24 < 12 ? 'AM' : 'PM';
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${m[2]} ${suffix}`;
}

// Epoch-ms → a plain, human relative age: "just now", "3 days ago".
// Used by the reachability card, whose saved result never expires — so the age
// is the ONLY signal telling the user how stale the reading is. Deliberately
// coarse (no "2 days, 4 hours"): nobody needs that precision, and a short line
// reads better under a button. Returns '' for a missing/unusable timestamp so
// callers can simply skip rendering.
export function timeAgo(ts) {
  const t = Number(ts);
  if (!Number.isFinite(t) || t <= 0) return '';
  const secs = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (secs < 45) return 'just now';
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'} ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return plural(Math.max(1, mins), 'minute');
  const hours = Math.floor(mins / 60);
  if (hours < 24) return plural(hours, 'hour');
  const days = Math.floor(hours / 24);
  if (days < 30) return plural(days, 'day');
  const months = Math.floor(days / 30);
  if (months < 12) return plural(months, 'month');
  return plural(Math.floor(months / 12), 'year');
}
