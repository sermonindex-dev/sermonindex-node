import React, { useState, useEffect, useRef, useCallback } from 'react';
import { getNodeId } from '../services/heartbeat.js';
import { getLastRead, setLastRead } from '../services/chatNotify.js';
import { CHAT_API } from '../services/constants.js';

const POLL_MS = 10000;          // normal poll interval
const POLL_MS_OFFLINE = 30000;  // slower poll while server unreachable
const MAX_KEPT = 500;           // messages kept in memory

const iconChat = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
  </svg>
);

function loadSavedName() {
  try { return localStorage.getItem('si-chat-name') || ''; } catch { return ''; }
}

function nodeShort() {
  try { return String(getNodeId()).slice(0, 8); } catch { return 'node'; }
}

function fmtTime(ts) {
  const d = new Date(ts);
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString()
    ? time
    : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`;
}

// Stable per-user name color derived from the node id — consistent across sessions.
// Mid-tone saturated hues chosen to stay legible on both the light (#F1F1E8) and
// dark (#262620) bubble backgrounds this app themes between.
const NAME_COLORS = ['#cc4b37', '#2f80c4', '#3a9b6e', '#9b59b6', '#c77d17', '#17a2a2', '#c0559e', '#5566c9', '#7a8c2e', '#b5642e'];
function userColor(node) {
  const s = String(node || '');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return NAME_COLORS[h % NAME_COLORS.length];
}

// Module-level cache: remounting the page shows last-known messages instantly
let _msgCache = [];

export default function CommunityPage() {
  const [messages, setMessagesRaw] = useState(_msgCache);
  const [loadedOnce, setLoadedOnce] = useState(_msgCache.length > 0);
  const setMessages = (v) => setMessagesRaw((prev) => {
    const next = typeof v === 'function' ? v(prev) : v;
    _msgCache = next;
    return next;
  });
  const [savedName, setSavedName] = useState(loadSavedName);
  const [nameDraft, setNameDraft] = useState('');
  const [editingName, setEditingName] = useState(false);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [offline, setOffline] = useState(false);
  const [notice, setNotice] = useState(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const listRef = useRef(null);
  const lastIdRef = useRef(_msgCache.reduce((m, x) => Math.max(m, x.id), 0));

  // Fetch messages newer than the highest id we've seen; dedupe by id.
  // A "full" fetch (since=0) REPLACES the list — this is how moderator
  // deletions disappear from screens that are already open.
  const fetchNew = useCallback(async (full = false) => {
    const since = full ? 0 : lastIdRef.current;
    const res = await fetch(`${CHAT_API}?since=${since}`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data.ok || !Array.isArray(data.messages)) throw new Error('bad payload');
    if (full) {
      lastIdRef.current = data.messages.reduce((m, x) => Math.max(m, x.id), 0);
      setMessages(data.messages.slice(-MAX_KEPT));
      return;
    }
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
    let count = 0;
    const poll = async () => {
      let ok = false;
      // Every 6th poll (~1 min) is a full re-sync so deletions propagate
      try { await fetchNew(count % 6 === 0); ok = true; setLoadedOnce(true); } catch {}
      count += 1;
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

  // Everything on screen counts as read — persist the highest id and tell
  // the app shell so the sidebar unread badge clears (see services/chatNotify.js)
  useEffect(() => {
    if (!messages.length) return;
    const maxId = messages.reduce((m, x) => Math.max(m, x.id), 0);
    if (maxId > getLastRead()) {
      setLastRead(maxId);
      window.dispatchEvent(new CustomEvent('si-chat-read'));
    }
  }, [messages]);

  const handleListScroll = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    setAutoScroll(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
  }, []);

  // Name is set once (with a small "change" escape hatch for typos)
  const saveName = () => {
    const clean = nameDraft.trim().slice(0, 24);
    if (!clean) return;
    setSavedName(clean);
    setEditingName(false);
    try { localStorage.setItem('si-chat-name', clean); } catch {}
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
        body: JSON.stringify({ node_id: getNodeId(), name: savedName || 'Node-' + nodeShort().slice(-4), text: text.slice(0, 500) }),
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
  }, [draft, sending, savedName, fetchNew]);

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  const muted = { color: 'var(--text-muted)', fontSize: '0.7rem' };

  return (
    /* 1100px matches .connections-layout / .page-header-wide, so Community is
       the same width as Your Stats, Settings, Connections and the rest. */
    <div style={{ maxWidth: 1100, margin: '0 auto' }}>
      <div className="page-header">
        <h2 style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <span style={{ display: 'inline-flex', color: 'var(--gold-text)' }}>{iconChat}</span> Community
        </h2>
        <p>Fellowship with others keeping the SermonIndex Node network alive</p>
      </div>

      {/* Identity — set once, shown as  #nodeid · Name  */}
      {(!savedName || editingName) ? (
        <div className="seed-card" style={{ padding: '14px 16px', marginBottom: '14px' }}>
          <div style={{ fontWeight: 600, fontSize: '0.9rem', marginBottom: '4px' }}>Choose your display name</div>
          <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginBottom: '10px' }}>
            A first name is perfect. It appears next to your node ID, like{' '}
            <span style={{ fontFamily: 'monospace' }}>#{nodeShort()}</span> · <span style={{ color: 'var(--gold-text)', fontWeight: 700 }}>{nameDraft.trim() || 'Greg'}</span>.
            You set this once.
          </div>
          <div style={{ display: 'flex', gap: '10px' }}>
            <input
              type="text"
              autoFocus
              placeholder="Your first name"
              value={nameDraft}
              maxLength={24}
              onChange={(e) => setNameDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') saveName(); }}
              style={{ maxWidth: 240 }}
            />
            <button className="btn btn-gold" onClick={saveName} disabled={!nameDraft.trim()} style={{ opacity: nameDraft.trim() ? 1 : 0.6 }}>
              Save name
            </button>
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '14px', fontSize: '0.82rem' }}>
          <span style={{ color: 'var(--text-muted)' }}>Chatting as</span>
          <span style={{ fontFamily: 'monospace', color: 'var(--text-muted)' }}>#{nodeShort()}</span>
          <span style={{ color: 'var(--gold-text)', fontWeight: 700 }}>· {savedName}</span>
          <button
            onClick={() => { setNameDraft(savedName); setEditingName(true); }}
            style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: '0.72rem', cursor: 'pointer', textDecoration: 'underline', fontFamily: 'var(--font)' }}
          >
            change
          </button>
        </div>
      )}

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
              style={{ overflowY: 'auto', height: '62vh', minHeight: 480, display: 'flex', flexDirection: 'column', gap: '12px' }}
            >
              {messages.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '36px 12px', color: 'var(--text-muted)', fontSize: '0.85rem' }}>
                  {loadedOnce ? 'No messages yet — be the first to say hello.' : 'Loading messages…'}
                </div>
              ) : messages.map((m) => {
                // Chat bubble: prominent colored name on top, small muted #node id
                // beneath it, then the message. Own messages align right (gold bubble);
                // moderator messages get a verified badge and a soft-yellow "forum" bubble.
                const isMine = String(m.node) === nodeShort();
                const isMod = m.is_moderator === true;
                let bubbleBg, bubbleBorder, nameColor, idColor, textColor;
                if (isMod) {
                  bubbleBg = '#fdf6d8'; bubbleBorder = '#e4d08a';
                  nameColor = '#8a6a12'; idColor = 'rgba(60,50,20,0.65)'; textColor = '#3a3320';
                } else if (isMine) {
                  bubbleBg = 'var(--gold-dim)'; bubbleBorder = 'var(--border)';
                  nameColor = 'var(--gold-text)'; idColor = 'var(--text-muted)'; textColor = 'var(--text-primary)';
                } else {
                  bubbleBg = 'var(--bg-tertiary)'; bubbleBorder = 'var(--border)';
                  nameColor = userColor(m.node); idColor = 'var(--text-muted)'; textColor = 'var(--text-primary)';
                }
                return (
                  <div key={m.id} style={{ display: 'flex', flexDirection: 'column', alignItems: isMine ? 'flex-end' : 'flex-start' }}>
                    <div style={{ maxWidth: '80%', minWidth: 0, padding: '8px 12px 9px', borderRadius: 'var(--radius)', background: bubbleBg, border: `1px solid ${bubbleBorder}` }}>
                      {/* Sender name — prominent, inside the bubble; a verified badge marks moderators */}
                      <div style={{ display: 'flex', alignItems: 'baseline', gap: '10px' }}>
                        <span style={{ fontWeight: 700, fontSize: '0.95rem', color: nameColor, lineHeight: 1.25, wordBreak: 'break-word' }}>
                          {m.name}
                          {isMod && (
                            <span title="Verified moderator" aria-label="Verified moderator" style={{ display: 'inline-flex', verticalAlign: 'middle', marginLeft: 5, position: 'relative', top: '-1px' }}>
                              <svg width="14" height="14" viewBox="0 0 24 24" role="img" aria-hidden="true">
                                <circle cx="12" cy="12" r="10" style={{ fill: 'var(--gold, #D4AF37)' }} />
                                <path d="M7.5 12.5 L10.6 15.5 L16.5 8.7" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
                              </svg>
                            </span>
                          )}
                        </span>
                        <span style={{ marginLeft: 'auto', color: idColor, opacity: 0.8, fontSize: '0.68rem', flexShrink: 0 }}>
                          {fmtTime(m.ts)}
                        </span>
                      </div>
                      {/* Node id — small, muted, secondary line under the name */}
                      <div title={`node ${m.node}`} style={{ fontFamily: 'monospace', fontSize: '0.66rem', color: idColor, marginTop: '1px', marginBottom: '5px' }}>
                        #{m.node}
                      </div>
                      <div style={{ whiteSpace: 'pre-wrap', fontSize: '0.9rem', color: textColor, lineHeight: 1.5, wordBreak: 'break-word' }}>
                        {m.text}
                      </div>
                    </div>
                  </div>
                );
              })}
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
          disabled={sending || !savedName}
          placeholder={savedName ? 'Write a message… (Enter to send, Shift+Enter for a new line)' : 'Set your display name above to join the conversation'}
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
