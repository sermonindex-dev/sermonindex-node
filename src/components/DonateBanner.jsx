import React, { useState, useEffect, useCallback } from 'react';

const DISMISS_KEY = 'si-donate-dismissed-at';
const SHOW_DELAY_MS = 3 * 60 * 1000;              // at least 3 minutes after app launch
const DISMISS_TTL_MS = 14 * 24 * 60 * 60 * 1000;  // re-show after 14 days

const DONATE_URL = 'https://www.sermonindex.net/md/donate/';

export default function DonateBanner() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    let dismissedAt = 0;
    try {
      dismissedAt = parseInt(localStorage.getItem(DISMISS_KEY) || '0', 10) || 0;
    } catch {}
    if (dismissedAt && Date.now() - dismissedAt < DISMISS_TTL_MS) return;
    const timer = setTimeout(() => setVisible(true), SHOW_DELAY_MS);
    return () => clearTimeout(timer);
  }, []);

  const dismiss = useCallback(() => {
    try { localStorage.setItem(DISMISS_KEY, String(Date.now())); } catch {}
    setVisible(false);
  }, []);

  const handleDonate = useCallback(async () => {
    try {
      // Lazy-import so a non-Tauri/dev context can't fail at module load (audit M4)
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('open_url', { url: DONATE_URL });
    } catch (e) {
      console.warn('[DonateBanner] open_url failed:', e);
    }
    dismiss();
  }, [dismiss]);

  if (!visible) return null;

  return (
    <div className="donate-banner" role="complementary" aria-label="Support SermonIndex">
      <div className="donate-banner-text">
        <div className="donate-banner-heading">Support SermonIndex</div>
        <p>
          For over two decades, SermonIndex has preserved rare sermons and millions of
          historic Christian resources and Bibles — all completely free. Would you consider
          a gift to help keep this ministry going?
        </p>
      </div>
      <div className="donate-banner-actions">
        <button className="btn-donate" onClick={handleDonate}>Donate</button>
        <button className="btn-dismiss" onClick={dismiss}>Dismiss</button>
      </div>
    </div>
  );
}
