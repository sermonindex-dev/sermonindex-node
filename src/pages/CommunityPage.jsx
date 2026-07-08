import React, { useState, useEffect, useRef, useCallback } from 'react';
import { getNodeId } from '../services/heartbeat.js';

const CHAT_API = 'https://app.sermonindex.net/api/chat';
const POLL_MS = 10000;          // normal poll interval
const POLL_MS_OFFLINE = 30000;  // slower poll while server unreachable
const MAX_KEPT = 500;           // messages kept in memory

const iconChat = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
  </svg>
);

function defaultName() {
  try {
    const saved = localStorage.getItem('si-chat-name');
    if (saved) return saved;
  } catch {}
  return 'Node-' + getNodeId().slice(-4);
}

function fmtTime(ts) {
  const d = new Date(ts);
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString()
    ? time
    : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`;
}

export default function CommunityPage() {
  const [messages, setMessages] = useState([]);
  const [name, setName] = useState(defaultName);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [offline, setOffline] = useState(false);
  const [notice, setNotice] = useState(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const listRef = useRef(null);
  const lastIdRef = useRef(0);

  // Fetch messages newer than the highest id we've seen; dedupe by id
  const fetchNew = useCallback(async () => {
    const res = await fetch(`${CHAT_API}?since=${lastIdRef.current}`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data.ok || !Array.isArray(data.messages)) throw new Error('bad payload');
    if (data.messages.length) {
      lastIdRef.current = data.messages.reduce((m, x) => Math.max(m, x.id), lastIdRef.current);
      setMessages(prev => {
        const seen = new Set(prev.map(m => m.id));
        const add = data.messages.filter(m => !seen.has(m.id));
        return add.length ? [...prev, ...add].slice(-MAX_KEPT) : prev;
      });
    }
  }, []);

  // Poll while mounted — 10s normally, 30s while the server is unreachable
  useEffect(() => {
    let cancelled = false;
    let timer = null;
    const poll = async () => {
      let ok = false;
      try { await fetchNew(); ok = true; } catch {}
      if (cancelled) return;
      setOffline(!ok);
      timer = setTimeout(poll, ok ? POLL_MS : POLL_MS_OFFLINE);
    };
    poll();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [fetchNew]);

  // Auto-scroll to bottom on new messages unless the user scrolled up
  useEffect(() => {
    if (autoScroll && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [messages, autoScroll]);

  const handleListScroll = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    setAutoScroll(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
  }, []);

  const handleNameChange = (v) => {
    const trimmed = v.slice(0, 24);
    setName(trimmed);
    try { localStorage.setItem('si-chat-name', trimmed); } catch {}
  };

  const send = useCallback(async () => {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    setNotice(null);
    try {
      const res = await fetch(CHAT_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ node_id: getNodeId(), name: name.trim() || defaultName(), text: text.slice(0, 500) }),
      });
      const data = await res.json().catch(() => ({}));
      if (data.ok) {
        setDraft('');
        setAutoScroll(true);
        fetchNew().catch(() => {});
      } else if (data.error === 'banned') {
        setNotice('Your node has been muted by a moderator.');
      } else if (data.error === 'rate_limited') {
        setNotice('Slow down a little — one message every few seconds.');
      } else {
        setNotice('Message could not be sent — try again.');
      }
    } catch {
      setNotice('Message could not be sent — the chat server may be offline.');
    } finally {
      setSending(false);
    }
  }, [draft, sending, name, fetchNew]);

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  const muted = { color: 'var(--text-muted)', fontSize: '0.7rem' };

  return (
    <div style={{ maxWidth: 720, margin: '0 auto' }}>
      <div className="page-header">
        <h2 style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <span style={{ display: 'inline-flex', color: 'var(--gold-text)' }}>{iconChat}</span> Community
        </h2>
        <p>Fellowship with other nodes keeping the vault alive</p>
      </div>

      {/* Display name */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '14px' }}>
        <label style={{ fontSize: '0.8rem', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>Display name</label>
        <input
          type="text"
          value={name}
          maxLength={24}
          onChange={(e) => handleNameChange(e.target.value)}
          style={{ maxWidth: 220 }}
        />
      </div>

      {/* Message list */}
      <div className="seed-card" style={{ padding: '16px', display: 'flex', flexDirection: 'column' }}>
        {offline && messages.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '36px 12px', color: 'var(--text-muted)', fontSize: '0.85rem', lineHeight: 1.6 }}>
            Community chat isn't online yet — check back soon.
          </div>
        ) : (
          <>
            {offline && (
              <div style={{ ...muted, fontStyle: 'italic', marginBottom: '8px' }}>Reconnecting to chat…</div>
            )}
            <div
              ref={listRef}
              onScroll={handleListScroll}
              style={{ overflowY: 'auto', minHeight: 240, maxHeight: '46vh', display: 'flex', flexDirection: 'column', gap: '12px' }}
            >
              {messages.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '36px 12px', color: 'var(--text-muted)', fontSize: '0.85rem' }}>
                  No messages yet — be the first to say hello.
                </div>
              ) : messages.map((m) => (
                <div key={m.id}>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap' }}>
                    <span style={{ color: 'var(--gold-text)', fontWeight: 700, fontSize: '0.82rem' }}>{m.name}</span>
                    <span title="node id" style={{ ...muted, fontFamily: 'monospace' }}>{m.node}</span>
                    <span style={muted}>{fmtTime(m.ts)}</span>
                  </div>
                  <div style={{ whiteSpace: 'pre-wrap', fontSize: '0.85rem', color: 'var(--text-primary)', lineHeight: 1.5, marginTop: '2px', wordBreak: 'break-word' }}>
                    {m.text}
                  </div>
                </div>
              ))}
            </div>
            {!autoScroll && messages.length > 0 && (
              <button
                onClick={() => {
                  setAutoScroll(true);
                  if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
                }}
                style={{ marginTop: '8px', fontSize: '0.7rem', color: 'var(--gold-text)', background: 'var(--gold-dim)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '4px 10px', cursor: 'pointer', alignSelf: 'center', fontFamily: 'var(--font)' }}
              >
                Jump to latest ↓
              </button>
            )}
          </>
        )}
      </div>

      {/* House rules */}
      <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', margin: '4px 2px 8px' }}>
        Be kind. This chat is for encouragement and coordination around preserving these sermons.
      </div>

      {/* Composer */}
      <div style={{ display: 'flex', gap: '10px', alignItems: 'flex-end' }}>
        <textarea
          rows={2}
          value={draft}
          maxLength={500}
          disabled={sending}
          placeholder="Write a message… (Enter to send, Shift+Enter for a new line)"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleKeyDown}
          style={{
            flex: 1, resize: 'none', padding: '10px 14px', background: 'var(--bg-tertiary)',
            border: '1px solid var(--border)', borderRadius: 'var(--radius)', color: 'var(--text-primary)',
            fontSize: '0.85rem', fontFamily: 'var(--font)', outline: 'none', lineHeight: 1.4,
          }}
        />
        <button className="btn btn-gold" onClick={send} disabled={sending || !draft.trim()} style={{ opacity: sending || !draft.trim() ? 0.6 : 1 }}>
          {sending ? 'Sending…' : 'Send'}
        </button>
      </div>

      {notice && (
        <div style={{ fontSize: '0.78rem', color: 'var(--orange)', marginTop: '8px' }}>{notice}</div>
      )}

      {/* Scripture touch */}
      <div style={{ textAlign: 'center', margin: '28px 0 12px', color: 'var(--text-muted)', fontSize: '0.78rem', fontStyle: 'italic' }}>
        "Let your speech always be with grace" — Colossians 4:6
      </div>
    </div>
  );
}
