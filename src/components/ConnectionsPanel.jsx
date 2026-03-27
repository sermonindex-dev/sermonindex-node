import React, { useState, useEffect, useRef, useCallback } from 'react';

// Tiny "Copied!" tooltip state hook
function useCopiedTooltip(timeout = 1500) {
  const [show, setShow] = useState(false);
  const fire = useCallback(() => { setShow(true); setTimeout(() => setShow(false), timeout); }, [timeout]);
  return [show, fire];
}

/**
 * ConnectionsPanel — Real-time IPFS connectivity dashboard
 *
 * Two-column layout on wide screens:
 * LEFT:  Network Health, Connection Layers (all 9), Active Peers
 * RIGHT: Live Logs (newest at bottom, auto-scroll), Actions
 *
 * Bottom of left column aligns with bottom of right column.
 */

// All connection layers — every protocol the native node supports
const LAYERS = [
  {
    id: 'tcp',
    label: 'TCP',
    desc: 'Primary transport — gateways connect to you over TCP',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M5 12h14" /><path d="M12 5l7 7-7 7" />
      </svg>
    ),
  },
  {
    id: 'quic',
    label: 'QUIC',
    desc: 'Modern transport — fast, multiplexed UDP connections',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
      </svg>
    ),
  },
  {
    id: 'websocket',
    label: 'WebSocket',
    desc: 'HTTP-compatible transport — traverses corporate firewalls',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 4l4 4m-4 0l4-4" /><path d="M16 4l4 4m-4 0l4-4" /><line x1="6" y1="8" x2="6" y2="16" /><line x1="18" y1="8" x2="18" y2="16" /><path d="M4 20l4-4m-4 0l4 4" /><path d="M16 20l4-4m-4 0l4 4" />
      </svg>
    ),
  },
  {
    id: 'upnp',
    label: 'UPnP',
    desc: 'Automatic router port forwarding — makes you publicly reachable',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="2" y="6" width="20" height="12" rx="2" /><path d="M12 12h.01" /><path d="M17 12h.01" /><path d="M7 12h.01" />
      </svg>
    ),
  },
  {
    id: 'natpmp',
    label: 'NAT-PMP/PCP',
    desc: 'Alternative port mapping — works on routers without UPnP support',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      </svg>
    ),
  },
  {
    id: 'relay',
    label: 'Circuit Relay',
    desc: 'Relay fallback — publicly reachable via relay when behind NAT',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M9 3H5a2 2 0 00-2 2v4m6-6h10a2 2 0 012 2v4M9 3v18m0 0h10a2 2 0 002-2v-4M9 21H5a2 2 0 01-2-2v-4" />
      </svg>
    ),
  },
  {
    id: 'holepunch',
    label: 'Hole Punch (DCUtR)',
    desc: 'Upgrades relay connections to direct — NAT traversal',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="16 3 21 3 21 8" /><line x1="4" y1="20" x2="21" y2="3" /><polyline points="21 16 21 21 16 21" /><line x1="15" y1="15" x2="21" y2="21" /><line x1="4" y1="4" x2="9" y2="9" />
      </svg>
    ),
  },
  {
    id: 'dht',
    label: 'Kademlia DHT',
    desc: 'Content routing — SERVER mode, full network participant',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10" /><line x1="2" y1="12" x2="22" y2="12" /><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
      </svg>
    ),
  },
  {
    id: 'mdns',
    label: 'mDNS (LAN)',
    desc: 'Zero-config local network discovery — instant on same WiFi/LAN',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M5 12.55a11 11 0 0 1 14.08 0" /><path d="M1.42 9a16 16 0 0 1 21.16 0" /><path d="M8.53 16.11a6 6 0 0 1 6.95 0" /><line x1="12" y1="20" x2="12.01" y2="20" />
      </svg>
    ),
  },
  {
    id: 'rendezvous',
    label: 'Rendezvous',
    desc: 'SermonIndex peer registry — find other sermon nodes quickly',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" />
      </svg>
    ),
  },
];

const STATUS_COLORS = {
  connected: '#4ecb71',
  connecting: '#d4af37',
  disconnected: '#6a8299',
  error: '#e74c3c',
  trying: '#d4af37',
  unsupported: '#6a8299',
  reserved: '#4ecb71',
  listening: '#4ecb71',
  registered: '#4ecb71',
  active: '#4ecb71',
  inactive: '#6a8299',
};

const STATUS_LABELS = {
  connected: 'Connected',
  connecting: 'Connecting...',
  disconnected: 'Disconnected',
  error: 'Error',
  reserved: 'Reserved',
  listening: 'Listening',
  registered: 'Registered',
  active: 'Active',
  inactive: 'Inactive',
  mapped: 'Mapped',
  no_gateway: 'No Gateway',
  non_routable: 'Non-Routable',
  trying: 'Trying...',
  unsupported: 'Unsupported',
};

// Max log entries to keep in memory
const MAX_LOG_ENTRIES = 150;

export default function ConnectionsPanel({ ipfsRunning, onIpfsToggle, ipfsEnabled }) {
  const [diagnostics, setDiagnostics] = useState(null);
  const [layerStatus, setLayerStatus] = useState({
    tcp: 'disconnected', quic: 'disconnected', websocket: 'disconnected',
    upnp: 'disconnected', natpmp: 'inactive', relay: 'inactive', holepunch: 'disconnected',
    dht: 'disconnected', mdns: 'inactive', rendezvous: 'inactive',
  });
  const [verifyState, setVerifyState] = useState('idle');
  const [verifyMessage, setVerifyMessage] = useState('');
  const [verifyLog, setVerifyLog] = useState([]);
  const [connectionLog, setConnectionLog] = useState([]);
  const [isReconnecting, setIsReconnecting] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [copiedShow, fireCopied] = useCopiedTooltip();
  const pollRef = useRef(null);
  const ipfsModRef = useRef(null);
  const logEndRef = useRef(null);
  const logContainerRef = useRef(null);
  const lastEventCountRef = useRef(0);

  // Log helper — newest entries appended at END (bottom), capped
  const addLog = useCallback((msg, type = 'info') => {
    const entry = { time: new Date().toLocaleTimeString(), msg, type };
    setConnectionLog(prev => [...prev, entry].slice(-MAX_LOG_ENTRIES));
  }, []);

  // Auto-scroll to bottom when new logs arrive — scroll the LOG CONTAINER only, not the page
  useEffect(() => {
    if (autoScroll && logContainerRef.current) {
      const el = logContainerRef.current;
      el.scrollTop = el.scrollHeight;
    }
  }, [connectionLog, autoScroll]);

  // Detect if user scrolled away from bottom → pause auto-scroll
  const handleLogScroll = useCallback(() => {
    const el = logContainerRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    setAutoScroll(atBottom);
  }, []);

  // Copy all logs to clipboard
  const handleCopyLogs = useCallback(() => {
    const text = connectionLog.map(e => `${e.time} ${e.msg}`).join('\n');
    navigator.clipboard.writeText(text).then(() => fireCopied()).catch(() => {});
  }, [connectionLog, fireCopied]);

  // Load IPFS module
  const getIpfs = useCallback(async () => {
    if (!ipfsModRef.current) {
      ipfsModRef.current = await import('../services/ipfs.js').catch(() => null);
    }
    return ipfsModRef.current;
  }, []);

  // Analyze connections to determine ALL layer statuses
  const analyzeConnections = useCallback((diag) => {
    if (!diag || !diag.running) {
      setLayerStatus({
        tcp: 'disconnected', quic: 'disconnected', websocket: 'disconnected',
        upnp: 'disconnected', natpmp: 'inactive', relay: 'inactive', holepunch: 'disconnected',
        dht: 'disconnected', mdns: 'inactive', rendezvous: 'inactive',
      });
      return;
    }

    const hasPeers = (diag.peerCount || 0) > 0;
    const listenAddrs = diag.multiaddrs || diag.listen_addresses || [];
    const externalAddrs = diag.externalAddresses || diag.external_addresses || [];
    const upnpStat = diag.upnpStatus || diag.upnp_status || 'unknown';
    const natStat = diag.natStatus || diag.nat_status || 'unknown';
    const relayStat = diag.relayStatus || diag.relay_status || 'inactive';
    const mdnsPeers = diag.mdnsPeers || diag.mdns_peers || 0;
    const rvStatus = diag.rendezvousStatus || diag.rendezvous_status || 'inactive';
    const natpmpStat = diag.natpmpStatus || diag.natpmp_status || 'inactive';

    const hasTcp = listenAddrs.some(a => a.includes('/tcp/') && !a.includes('/ws'));
    const hasQuic = listenAddrs.some(a => a.includes('/quic'));
    const hasWs = listenAddrs.some(a => a.includes('/ws'));
    const hasRelay = listenAddrs.some(a => a.includes('p2p-circuit'));
    const upnpConnected = upnpStat === 'mapped' || externalAddrs.length > 0;
    const upnpFailed = upnpStat === 'no_gateway' || upnpStat === 'non_routable';
    const natpmpConnected = natpmpStat === 'mapped';
    const natpmpFailed = natpmpStat === 'unsupported';
    const isPublic = natStat.toLowerCase().includes('public') || externalAddrs.length > 0;

    setLayerStatus({
      tcp: hasTcp ? 'connected' : (hasPeers ? 'connecting' : 'disconnected'),
      quic: hasQuic ? 'connected' : (hasPeers ? 'connecting' : 'disconnected'),
      websocket: hasWs ? 'listening' : 'connecting',
      upnp: upnpConnected ? 'connected' : (upnpFailed ? 'error' : 'connecting'),
      natpmp: natpmpConnected ? 'mapped' : (natpmpFailed ? 'unsupported' : (natpmpStat === 'trying' ? 'trying' : 'inactive')),
      relay: hasRelay ? 'reserved' : (relayStat === 'reserving' ? 'connecting' : relayStat === 'inactive' ? 'inactive' : relayStat),
      holepunch: isPublic ? 'connected' : (hasRelay ? 'connecting' : (hasPeers ? 'connecting' : 'disconnected')),
      dht: hasPeers ? 'connected' : 'connecting',
      mdns: mdnsPeers > 0 ? 'active' : 'inactive',
      rendezvous: rvStatus === 'registered' ? 'registered' : (rvStatus === 'registering' ? 'connecting' : 'inactive'),
    });
  }, []);

  // Poll diagnostics
  useEffect(() => {
    if (!ipfsRunning) {
      setDiagnostics(null);
      setLayerStatus({
        tcp: 'disconnected', quic: 'disconnected', websocket: 'disconnected',
        upnp: 'disconnected', natpmp: 'inactive', relay: 'inactive', holepunch: 'disconnected',
        dht: 'disconnected', mdns: 'inactive', rendezvous: 'inactive',
      });
      return;
    }

    let prevPeerCount = 0;
    const poll = async () => {
      try {
        const ipfs = await getIpfs();
        if (ipfs && ipfs.getDiagnostics) {
          // If JS thinks node isn't running but Rust says it is, resync
          if (!ipfs.isNodeRunning()) {
            try {
              const { invoke } = await import('@tauri-apps/api/core');
              const isRunning = await invoke('ipfs_is_running');
              if (isRunning) {
                console.log('[Connections] Rust node is running but JS lost sync — re-initializing');
                await ipfs.initNode('sermonindex');
              }
            } catch (e) {
              console.warn('[Connections] Sync check failed:', e.message);
            }
          }
          const diag = await ipfs.getDiagnostics();
          setDiagnostics(diag);
          analyzeConnections(diag);

          // Ingest Rust-side events into the Live Log
          const rustEvents = diag?.recentEvents || [];
          if (rustEvents.length > lastEventCountRef.current) {
            const newEvents = rustEvents.slice(lastEventCountRef.current);
            for (const evt of newEvents) {
              const type = evt.includes('FAILED') || evt.includes('FAIL') || evt.includes('Error')
                ? 'error'
                : evt.includes('Connected') || evt.includes('OK') || evt.includes('confirmed')
                    || evt.includes('Identified') || evt.includes('Reserved') || evt.includes('Registered')
                    || evt.includes('Discovered') || evt.includes('mapped')
                  ? 'success'
                  : evt.includes('Disconnected') || evt.includes('no_gateway') || evt.includes('non_routable')
                      || evt.includes('expired')
                    ? 'warn'
                    : 'info';
              addLog(evt, type);
            }
            lastEventCountRef.current = rustEvents.length;
          }

          // Auto-log peer count changes
          const peers = diag?.peerCount || 0;
          if (peers !== prevPeerCount) {
            if (peers > prevPeerCount) {
              addLog(`Peer count: ${prevPeerCount} → ${peers}`, peers > 0 ? 'success' : 'info');
            } else if (peers < prevPeerCount) {
              addLog(`Peer count: ${prevPeerCount} → ${peers}`, 'warn');
            }
            prevPeerCount = peers;
          }
        }
      } catch (err) {
        console.warn('[Connections] Poll error:', err.message);
      }
    };

    addLog('Polling IPFS node diagnostics...', 'info');
    poll();
    pollRef.current = setInterval(poll, 4000);
    return () => clearInterval(pollRef.current);
  }, [ipfsRunning, getIpfs, analyzeConnections, addLog]);

  // Overall health score
  const healthScore = (() => {
    if (!ipfsRunning || !diagnostics) return 0;
    let score = 0;
    const peerCount = diagnostics.peerCount || 0;
    if (peerCount >= 1) score += 15;
    if (peerCount >= 5) score += 15;
    if (peerCount >= 10) score += 10;
    if (layerStatus.tcp === 'connected') score += 10;
    if (layerStatus.quic === 'connected') score += 10;
    if (layerStatus.websocket === 'listening') score += 5;
    if (layerStatus.upnp === 'connected') score += 10;
    if (layerStatus.natpmp === 'mapped') score += 10;
    if (layerStatus.relay === 'reserved') score += 10;
    if (layerStatus.dht === 'connected') score += 10;
    if (layerStatus.mdns === 'active') score += 5;
    if (layerStatus.rendezvous === 'registered') score += 5;
    if (layerStatus.holepunch === 'connected') score += 5;
    return Math.min(100, score);
  })();

  const healthLabel = healthScore >= 80 ? 'Excellent' : healthScore >= 50 ? 'Good' : healthScore >= 20 ? 'Fair' : 'Offline';
  const healthColor = healthScore >= 80 ? '#4ecb71' : healthScore >= 50 ? '#d4af37' : healthScore >= 20 ? '#e67e22' : '#6a8299';

  // Reconnect handler
  const handleReconnect = useCallback(async () => {
    setIsReconnecting(true);
    addLog('Reconnecting IPFS node...', 'warn');
    try {
      const ipfs = await getIpfs();
      if (ipfs) {
        addLog('Stopping node...');
        await ipfs.stopNode();
        addLog('Node stopped — waiting for port release...');
        // Give the OS time to release port 4001 after the old node stops
        await new Promise(r => setTimeout(r, 2000));
        addLog('Restarting node...');
        await ipfs.initNode('sermonindex');
        addLog('Node restarted successfully', 'success');
      }
    } catch (err) {
      addLog(`Reconnect failed: ${err.message}`, 'error');
      // Try to recover — if initNode failed, the node might still be running in Rust
      // but _running is false in JS. Check Rust directly.
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const isRunning = await invoke('ipfs_is_running');
        if (isRunning) {
          const ipfs = await getIpfs();
          if (ipfs && !ipfs.isNodeRunning()) {
            // Rust says running but JS doesn't know — fix the JS state
            addLog('Node is actually running in Rust — resynchronizing...', 'info');
            // Force _running = true by calling initNode which will get "already_running"
            await ipfs.initNode('sermonindex');
            addLog('Resynchronized with running node', 'success');
          }
        }
      } catch (recoveryErr) {
        addLog(`Recovery also failed: ${recoveryErr.message}`, 'error');
      }
    }
    setIsReconnecting(false);
  }, [getIpfs, addLog]);

  // Self-verification
  const handleVerify = useCallback(async () => {
    setVerifyState('running');
    setVerifyLog([]);
    const log = (msg, type = 'info') => {
      setVerifyLog(prev => [...prev, { msg, type }]);
      addLog(msg, type);
    };

    try {
      const ipfs = await getIpfs();
      if (!ipfs || !ipfs.isNodeRunning()) {
        log('IPFS node is not running', 'error');
        setVerifyState('fail');
        setVerifyMessage('Node is not running. Enable IPFS first.');
        return;
      }

      const diag = await ipfs.getDiagnostics();
      const peers = diag?.peerCount || 0;
      const isNative = diag?.protocol === 'native-libp2p';
      const natStatus = diag?.natStatus || 'unknown';
      const upnpStatus = diag?.upnpStatus || 'unknown';
      const relayStatus = diag?.relayStatus || 'inactive';
      const externalAddrs = diag?.externalAddresses || [];

      log(`Node type: ${isNative ? 'Native Rust (TCP+QUIC+WS)' : 'Browser (Helia)'}`, isNative ? 'success' : 'info');
      log(`Connected to ${peers} peers`);

      if (isNative) {
        const natpmpStatus = diag?.natpmpStatus || diag?.natpmp_status || 'inactive';
        log(`NAT: ${natStatus} | UPnP: ${upnpStatus} | NAT-PMP: ${natpmpStatus} | Relay: ${relayStatus}`);
        if (externalAddrs.length > 0) {
          log(`External addresses: ${externalAddrs.join(', ')}`, 'success');
        }
      }

      if (peers < 2) {
        log('Low peer count — content may take longer to propagate', 'warn');
      }

      log('Pinning test content...');
      const testContent = `SermonIndex Verification - ${new Date().toISOString()} - ${Math.random().toString(36).slice(2)}`;
      const encoder = new TextEncoder();
      const bytes = encoder.encode(testContent);
      const cid = await ipfs.addFile(bytes, null);
      log(`Pinned: ${cid}`, 'success');

      log('Announcing to DHT...');
      try {
        const result = await ipfs.debugProvide(cid);
        if (result.success) {
          log(`DHT provider record published`, 'success');
        } else {
          log(`DHT announce: ${result.error}`, 'warn');
        }
      } catch (err) {
        log(`DHT announce error: ${err.message}`, 'warn');
      }

      log('Waiting 15s for DHT propagation...');
      await new Promise(r => setTimeout(r, 15000));

      const gateways = [
        { name: 'ipfs.io', url: `https://ipfs.io/ipfs/${cid}` },
        { name: 'dweb.link', url: `https://dweb.link/ipfs/${cid}` },
        { name: 'cloudflare-ipfs', url: `https://cloudflare-ipfs.com/ipfs/${cid}` },
      ];

      let gatewaySuccess = false;
      for (const gw of gateways) {
        log(`Checking ${gw.name}...`);
        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 30000);
          const resp = await fetch(gw.url, { signal: controller.signal, headers: { Accept: 'text/plain' } });
          clearTimeout(timeout);

          if (resp.ok) {
            const text = await resp.text();
            if (text === testContent) {
              log(`${gw.name}: Content verified — your node is publicly reachable!`, 'success');
              gatewaySuccess = true;
              setVerifyState('success');
              setVerifyMessage(`Content is publicly accessible via ${gw.name}! Your node is working as a full IPFS peer.`);
              break;
            } else {
              log(`${gw.name}: Got response but content mismatch`, 'warn');
            }
          } else {
            log(`${gw.name}: HTTP ${resp.status}`, 'warn');
          }
        } catch (e) {
          log(`${gw.name}: ${e.name === 'AbortError' ? 'Timeout (30s)' : e.message}`, 'warn');
        }
      }

      if (!gatewaySuccess) {
        if (isNative && peers > 5) {
          log('Gateways could not reach your node yet — DHT propagation may take a few minutes', 'warn');
          setVerifyState('fail');
          setVerifyMessage('DHT propagation in progress. Your node is TCP-dialable — gateways should find it shortly.');
        } else if (peers > 0) {
          log('Peers connected but gateways cannot reach your node yet', 'warn');
          if (relayStatus !== 'reserved' && upnpStatus !== 'mapped' && externalAddrs.length === 0) {
            log('No public reachability yet — relay or UPnP needed for gateway access', 'info');
          }
          setVerifyState('fail');
          setVerifyMessage('Node connected to peers but not yet reachable by gateways.');
        } else {
          setVerifyState('fail');
          setVerifyMessage('No peers connected. Content stored locally but not shared yet.');
        }
      }
    } catch (err) {
      log(`Verification error: ${err.message}`, 'error');
      setVerifyState('fail');
      setVerifyMessage(`Verification failed: ${err.message}`);
    }
  }, [getIpfs, addLog]);

  // Render — two-column layout with aligned bottoms
  return (
    <div className="connections-layout">
      {/* ── LEFT COLUMN: Health + Layers + Active Peers ── */}
      <div className="connections-left">
        {/* Health overview */}
        <div className="seed-card">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
            <h3 style={{ margin: 0 }}>Network Health</h3>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <div style={{
                width: 10, height: 10, borderRadius: '50%',
                background: healthColor,
                boxShadow: healthScore > 0 ? `0 0 8px ${healthColor}` : 'none',
              }} />
              <span style={{ color: healthColor, fontWeight: 600, fontSize: '0.85rem' }}>{healthLabel}</span>
            </div>
          </div>

          {/* Health bar */}
          <div style={{
            height: 6, borderRadius: 3,
            background: 'var(--border)',
            overflow: 'hidden',
            marginBottom: '12px',
          }}>
            <div style={{
              height: '100%', borderRadius: 3,
              width: `${healthScore}%`,
              background: `linear-gradient(90deg, ${healthColor}, ${healthColor}dd)`,
              transition: 'width 0.5s ease',
            }} />
          </div>

          {/* Quick stats */}
          <div style={{ display: 'flex', gap: '24px', flexWrap: 'wrap' }}>
            <div>
              <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Peers</div>
              <div style={{ fontSize: '1.1rem', fontWeight: 700, color: 'var(--gold)' }}>{diagnostics?.peerCount || 0}</div>
            </div>
            <div>
              <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Pinned CIDs</div>
              <div style={{ fontSize: '1.1rem', fontWeight: 700, color: 'var(--text-primary)' }}>{diagnostics?.pinnedCount || diagnostics?.pinnedCids?.length || 0}</div>
            </div>
            <div>
              <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Uptime</div>
              <div style={{ fontSize: '1.1rem', fontWeight: 700, color: 'var(--text-primary)' }}>
                {diagnostics?.uptime ? formatUptime(diagnostics.uptime) : '—'}
              </div>
            </div>
            <div>
              <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>LAN Peers</div>
              <div style={{ fontSize: '1.1rem', fontWeight: 700, color: diagnostics?.mdnsPeers > 0 ? '#4ecb71' : 'var(--text-primary)' }}>
                {diagnostics?.mdnsPeers || 0}
              </div>
            </div>
          </div>

          {/* Native node extras — with word-wrap fix for long addresses */}
          {diagnostics?.protocol === 'native-libp2p' && (
            <div style={{ marginTop: '12px', padding: '10px 12px', background: 'rgba(78, 203, 113, 0.06)', borderRadius: '8px', border: '1px solid rgba(78, 203, 113, 0.15)', overflow: 'hidden' }}>
              <div style={{ fontSize: '0.7rem', color: '#4ecb71', fontWeight: 600, marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                Native Node — TCP + QUIC + WebSocket
              </div>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', display: 'flex', flexWrap: 'wrap', gap: '12px' }}>
                <span>NAT: <strong style={{ color: 'var(--text-primary)' }}>{diagnostics?.natStatus || 'detecting...'}</strong></span>
                <span>UPnP: <strong style={{ color: diagnostics?.upnpStatus === 'mapped' ? '#4ecb71' : 'var(--text-primary)' }}>{diagnostics?.upnpStatus || 'detecting...'}</strong></span>
                <span>NAT-PMP: <strong style={{ color: (diagnostics?.natpmpStatus || diagnostics?.natpmp_status) === 'mapped' ? '#4ecb71' : 'var(--text-primary)' }}>{diagnostics?.natpmpStatus || diagnostics?.natpmp_status || 'inactive'}</strong></span>
                <span>Relay: <strong style={{ color: diagnostics?.relayStatus === 'reserved' ? '#4ecb71' : 'var(--text-primary)' }}>{diagnostics?.relayStatus || 'inactive'}</strong></span>
              </div>
              {(diagnostics?.externalAddresses || []).length > 0 && (
                <div style={{ marginTop: '6px', fontSize: '0.72rem', color: '#4ecb71' }}>
                  <span>Public: </span>
                  <strong style={{ wordBreak: 'break-all', overflowWrap: 'anywhere' }}>
                    {diagnostics.externalAddresses[0]}
                  </strong>
                </div>
              )}
              <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)', marginTop: '6px' }}>
                <span>Peer ID: <span style={{ fontFamily: 'monospace', wordBreak: 'break-all', overflowWrap: 'anywhere' }}>{diagnostics?.peerId || '—'}</span></span>
              </div>
            </div>
          )}
        </div>

        {/* Transport layers — ALL 9 */}
        <div className="seed-card">
          <h3>Connection Layers</h3>
          <p style={{ marginBottom: '8px', fontSize: '0.78rem', color: 'var(--text-muted)' }}>
            Multi-layer connectivity for maximum reachability. Each layer is tried automatically.
          </p>

          {LAYERS.map((layer, i) => {
            const status = layerStatus[layer.id];
            const color = STATUS_COLORS[status] || '#6a8299';
            const label = STATUS_LABELS[status] || status;
            // "Active" = actually carrying traffic or providing a service right now
            const isActive = ['connected', 'reserved', 'listening', 'registered', 'active', 'mapped'].includes(status);
            return (
              <div key={layer.id}
                className="settings-row"
                style={{
                  ...(i === LAYERS.length - 1 ? { border: 'none' } : {}),
                  // Highlight active layers with a subtle background
                  ...(isActive ? {
                    background: 'rgba(78, 203, 113, 0.04)',
                    borderRadius: '6px',
                    marginLeft: '-8px',
                    marginRight: '-8px',
                    paddingLeft: '8px',
                    paddingRight: '8px',
                  } : {
                    opacity: 0.55,
                  }),
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flex: 1, minWidth: 0 }}>
                  <div style={{
                    width: 32, height: 32, borderRadius: '8px',
                    background: 'rgba(140, 180, 213, 0.1)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    flexShrink: 0,
                    color: isActive ? 'var(--text-secondary)' : 'var(--text-muted)',
                  }}>
                    {layer.icon}
                  </div>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 500, fontSize: '0.85rem' }}>{layer.label}</div>
                    <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>{layer.desc}</div>
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
                  <div style={{
                    width: 8, height: 8, borderRadius: '50%',
                    background: color,
                    boxShadow: isActive ? `0 0 6px ${color}` : 'none',
                  }} />
                  <span style={{
                    fontSize: '0.76rem', fontWeight: 500,
                    color: color,
                    minWidth: '90px',
                  }}>
                    {label}
                  </span>
                </div>
              </div>
            );
          })}
        </div>

        {/* Active Connections */}
        <div className="seed-card">
          <h3>Active Peers ({diagnostics?.connections?.length || 0})</h3>
          {diagnostics?.connections?.length > 0 ? (
            <div style={{
              maxHeight: '200px',
              overflowY: 'auto',
              background: 'var(--bg-primary)',
              borderRadius: '8px',
              padding: '8px 12px',
            }}>
              {diagnostics.connections.map((conn, i) => (
                <div key={i} style={{
                  fontSize: '0.72rem',
                  fontFamily: 'monospace',
                  color: 'var(--text-muted)',
                  lineHeight: 1.8,
                  borderBottom: i < diagnostics.connections.length - 1 ? '1px solid var(--border)' : 'none',
                  paddingBottom: '4px',
                  marginBottom: '4px',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <div style={{
                      width: 6, height: 6, borderRadius: '50%',
                      background: '#4ecb71',
                      flexShrink: 0,
                    }} />
                    <span style={{ color: 'var(--text-secondary)', fontWeight: 500 }}>
                      {conn.remotePeer.slice(0, 16)}...
                    </span>
                    <span style={{
                      fontSize: '0.65rem',
                      padding: '1px 6px',
                      borderRadius: '4px',
                      background: conn.direction === 'inbound' ? 'rgba(78,203,113,0.15)' : 'rgba(212,175,55,0.15)',
                      color: conn.direction === 'inbound' ? '#4ecb71' : '#d4af37',
                    }}>
                      {conn.direction === 'inbound' ? '← in' : '→ out'}
                    </span>
                  </div>
                  {conn.remoteAddr && (
                    <div style={{ paddingLeft: '12px', color: 'var(--text-muted)', fontSize: '0.68rem' }}>
                      {conn.remoteAddr.length > 60 ? conn.remoteAddr.slice(0, 60) + '...' : conn.remoteAddr}
                    </div>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', fontStyle: 'italic' }}>
              No active connections yet
            </div>
          )}
        </div>
      </div>

      {/* ── RIGHT COLUMN: Logs + Actions ── */}
      <div className="connections-right">
        {/* Live Log — newest at bottom, auto-scrolls */}
        <div className="seed-card" style={{ display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
            <h3 style={{ margin: 0 }}>Live Log</h3>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>
                {connectionLog.length}/{MAX_LOG_ENTRIES}
              </span>
              {connectionLog.length > 0 && (
                <>
                  <span style={{ position: 'relative', display: 'inline-block' }}>
                    <button
                      onClick={handleCopyLogs}
                      style={{
                        fontSize: '0.68rem', color: 'var(--text-muted)', background: 'none',
                        border: '1px solid var(--border)', borderRadius: '4px', padding: '2px 8px',
                        cursor: 'pointer',
                      }}
                      title="Copy all logs to clipboard"
                    >
                      Copy
                    </button>
                    {copiedShow && (
                      <span style={{
                        position: 'absolute', bottom: '110%', left: '50%', transform: 'translateX(-50%)',
                        background: '#2d7ff9', color: '#fff', fontSize: '0.65rem', fontWeight: 600,
                        padding: '3px 10px', borderRadius: '4px', whiteSpace: 'nowrap',
                        pointerEvents: 'none', zIndex: 10,
                        boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
                      }}>
                        Copied!
                      </span>
                    )}
                  </span>
                  <button
                    onClick={() => { setConnectionLog([]); lastEventCountRef.current = 0; }}
                    style={{
                      fontSize: '0.68rem', color: 'var(--text-muted)', background: 'none',
                      border: '1px solid var(--border)', borderRadius: '4px', padding: '2px 8px',
                      cursor: 'pointer',
                    }}
                  >
                    Clear
                  </button>
                </>
              )}
            </div>
          </div>
          <div
            className="connections-log-container"
            ref={logContainerRef}
            onScroll={handleLogScroll}
          >
            {connectionLog.length === 0 ? (
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', fontStyle: 'italic', padding: '12px' }}>
                Waiting for events...
              </div>
            ) : connectionLog.map((entry, i) => (
              <div key={i} style={{
                fontSize: '0.72rem',
                fontFamily: 'monospace',
                lineHeight: 1.7,
                padding: '1px 0',
                color: entry.type === 'error' ? '#e74c3c' : entry.type === 'success' ? '#4ecb71' : entry.type === 'warn' ? '#e67e22' : 'var(--text-muted)',
              }}>
                <span style={{ color: 'var(--border-light)', marginRight: '8px' }}>{entry.time}</span>
                {entry.msg}
              </div>
            ))}
            <div ref={logEndRef} />
          </div>
          {!autoScroll && connectionLog.length > 0 && (
            <button
              onClick={() => {
                setAutoScroll(true);
                if (logContainerRef.current) {
                  logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
                }
              }}
              style={{
                marginTop: '6px', fontSize: '0.7rem', color: 'var(--gold)', background: 'rgba(212,175,55,0.08)',
                border: '1px solid rgba(212,175,55,0.2)', borderRadius: '4px', padding: '3px 10px',
                cursor: 'pointer', alignSelf: 'center',
              }}
            >
              Jump to latest
            </button>
          )}
        </div>

        {/* Actions */}
        <div className="seed-card">
          <h3>Actions</h3>

          {/* Reconnect */}
          <div className="settings-row">
            <div>
              <div style={{ fontWeight: 500, fontSize: '0.85rem' }}>Reconnect Node</div>
              <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                Restart the IPFS node and re-establish connections
              </div>
            </div>
            <button
              className="btn btn-outline"
              style={{ fontSize: '0.78rem', padding: '5px 14px', whiteSpace: 'nowrap' }}
              onClick={handleReconnect}
              disabled={isReconnecting || !ipfsRunning}
            >
              {isReconnecting ? (
                <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <span className="conn-spinner" />
                  Reconnecting...
                </span>
              ) : 'Reconnect'}
            </button>
          </div>

          {/* Re-provide all pins */}
          <div className="settings-row">
            <div>
              <div style={{ fontWeight: 500, fontSize: '0.85rem' }}>Re-announce Content</div>
              <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                Republish all pinned sermons to the DHT
              </div>
            </div>
            <button
              className="btn btn-outline"
              style={{ fontSize: '0.78rem', padding: '5px 14px', whiteSpace: 'nowrap' }}
              onClick={async () => {
                addLog('Re-announcing all pinned content...');
                try {
                  const ipfs = await getIpfs();
                  if (ipfs) {
                    const pins = await ipfs.listPinned();
                    for (const cid of pins) {
                      await ipfs.debugProvide(cid);
                      addLog(`Announced: ${cid.slice(0, 20)}...`, 'success');
                    }
                    addLog(`Re-announced ${pins.length} CIDs`, 'success');
                  }
                } catch (err) {
                  addLog(`Re-announce failed: ${err.message}`, 'error');
                }
              }}
              disabled={!ipfsRunning}
            >
              Re-announce
            </button>
          </div>

          {/* Self-verify */}
          <div className="settings-row" style={{ border: 'none' }}>
            <div>
              <div style={{ fontWeight: 500, fontSize: '0.85rem' }}>Self-Verification Test</div>
              <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                Pin a test file and verify via public gateways
              </div>
            </div>
            <button
              className={`btn ${verifyState === 'success' ? 'btn-gold' : 'btn-outline'}`}
              style={{ fontSize: '0.78rem', padding: '5px 14px', whiteSpace: 'nowrap' }}
              onClick={handleVerify}
              disabled={verifyState === 'running' || !ipfsRunning}
            >
              {verifyState === 'running' ? (
                <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <span className="conn-spinner" />
                  Verifying...
                </span>
              ) : verifyState === 'success' ? 'Passed' : verifyState === 'fail' ? 'Retry Test' : 'Run Test'}
            </button>
          </div>

          {/* Verify result */}
          {verifyState !== 'idle' && verifyMessage && (
            <div style={{
              padding: '8px 12px',
              borderRadius: '6px',
              fontSize: '0.78rem',
              fontWeight: 500,
              background: verifyState === 'success' ? 'rgba(78,203,113,0.08)' : 'rgba(230,126,34,0.08)',
              color: verifyState === 'success' ? '#4ecb71' : '#e67e22',
              border: `1px solid ${verifyState === 'success' ? 'rgba(78,203,113,0.2)' : 'rgba(230,126,34,0.2)'}`,
            }}>
              {verifyMessage}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function formatUptime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${seconds}s`;
}
