import React, { useEffect, useRef, useState } from 'react';
import { ConditionsBody } from '../data/conditions.jsx';

// Seed glyph — same mark used across the app's branding.
const seedMark = (
  <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 2C7 6 5 10 5 14a7 7 0 0 0 14 0c0-4-2-8-7-12z" />
    <path d="M12 22V9" />
    <path d="M12 13c-1.6-.5-2.8-1.7-3.3-3.3" />
    <path d="M12 11c1.5-.5 2.6-1.6 3.1-3.1" />
  </svg>
);

/**
 * Conditions / copying-permissions modal.
 *
 * mode="agree"  → first-launch gate. Blocking; the Agree button unlocks only
 *                 after the reader scrolls to the bottom. Calls onAgree().
 * mode="view"   → read-only, opened from the About page. Has a Close button.
 */
export default function ConditionsModal({ mode = 'agree', onAgree, onClose }) {
  const scrollRef = useRef(null);
  const [atBottom, setAtBottom] = useState(false);

  const isAgree = mode === 'agree';

  // If the content is short enough not to scroll, treat it as already read.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (el.scrollHeight <= el.clientHeight + 4) setAtBottom(true);
  }, []);

  const handleScroll = (e) => {
    const el = e.target;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 24) setAtBottom(true);
  };

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 10000,
        background: 'rgba(0,0,0,0.62)', backdropFilter: 'blur(2px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px',
      }}
      onClick={!isAgree ? onClose : undefined}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%', maxWidth: '640px', maxHeight: '86vh',
          background: 'var(--bg-secondary)', border: '1px solid var(--border)',
          borderRadius: '14px', boxShadow: '0 24px 60px rgba(0,0,0,0.45)',
          display: 'flex', flexDirection: 'column', overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: '12px',
          padding: '18px 22px', borderBottom: '1px solid var(--border)',
          color: 'var(--gold-text)', flexShrink: 0,
        }}>
          <span style={{ display: 'flex' }}>{seedMark}</span>
          <div>
            <div style={{ fontSize: '1.02rem', fontWeight: 700, color: 'var(--text-primary)' }}>
              SermonIndex — Node Software
            </div>
            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
              Copying Permissions &amp; Conditions
            </div>
          </div>
        </div>

        {/* Scrollable body */}
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          style={{ padding: '18px 22px', overflowY: 'auto', flex: 1 }}
        >
          <ConditionsBody />
        </div>

        {/* Footer */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          gap: '14px', padding: '14px 22px', borderTop: '1px solid var(--border)',
          background: 'var(--bg-primary)', flexShrink: 0,
        }}>
          {isAgree ? (
            <>
              <span style={{ fontSize: '0.76rem', color: 'var(--text-muted)' }}>
                {atBottom
                  ? 'By continuing you agree to these conditions.'
                  : 'Please scroll to the end to continue.'}
              </span>
              <button
                className="btn btn-gold"
                disabled={!atBottom}
                onClick={onAgree}
                style={{
                  whiteSpace: 'nowrap',
                  opacity: atBottom ? 1 : 0.45,
                  cursor: atBottom ? 'pointer' : 'not-allowed',
                }}
              >
                I Have Read &amp; Agree
              </button>
            </>
          ) : (
            <>
              <span style={{ fontSize: '0.76rem', color: 'var(--text-muted)' }}>
                sermonindex.net · Copying Permissions
              </span>
              <button className="btn btn-gold" onClick={onClose} style={{ whiteSpace: 'nowrap' }}>
                Close
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
