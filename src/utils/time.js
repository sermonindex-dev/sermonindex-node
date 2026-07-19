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
