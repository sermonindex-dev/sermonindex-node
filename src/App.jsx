import React, { useState, useRef, useEffect, useCallback, Component } from 'react';
import Sidebar from './components/Sidebar';
import TopBar from './components/TopBar';
import PlayerBar from './components/PlayerBar';
import DonateBanner from './components/DonateBanner';
import LibraryPage from './pages/LibraryPage';
import DownloadsPage from './pages/DownloadsPage';
import BulkDownloadPage from './pages/BulkDownloadPage';
import SeedNodePage from './pages/SeedNodePage';
import SettingsPage from './pages/SettingsPage';
import ConnectionsPage from './pages/ConnectionsPage';
import NetworkPage from './pages/NetworkPage';
import CommunityPage from './pages/CommunityPage';

// Error boundary to prevent full app crashes
class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }
  componentDidCatch(error, errorInfo) {
    console.error('[App] Uncaught error:', error, errorInfo);
  }
  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: '48px', textAlign: 'center', background: 'var(--bg-primary)', color: 'var(--text-primary)', minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
          <h2 style={{ color: 'var(--gold-text)', marginBottom: '16px' }}>Something went wrong</h2>
          <p style={{ color: 'var(--text-secondary)', marginBottom: '24px', maxWidth: '400px' }}>
            The app encountered an unexpected error. This has been logged.
          </p>
          <p style={{ fontFamily: 'monospace', fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '24px', maxWidth: '500px', wordBreak: 'break-all' }}>
            {this.state.error?.message || 'Unknown error'}
          </p>
          <button
            onClick={() => { this.setState({ hasError: false, error: null }); }}
            style={{ background: '#D4AF37', color: '#2a2a14', border: 'none', padding: '10px 24px', borderRadius: '8px', fontWeight: 700, cursor: 'pointer', fontSize: '0.9rem' }}
          >
            Try Again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
import {
  initCatalog,
  getCatalog,
  searchCatalog,
  getDownloaded,
  getLibraryStats,
  markDownloaded,
  markRemoved,
  revalidateDownloads,
} from './services/catalog.js';
import downloadManager, { DL_STATE, SOURCE_MODE } from './services/downloadManager.js';
import { getStoragePath } from './services/tauriStore.js';
import { startHeartbeat, stopHeartbeat, fetchConfig, loadNodeIdFromDisk } from './services/heartbeat.js';
import { checkForUpdates } from './services/updater.js';
import { fetchUnreadCount, chatPrefs } from './services/chatNotify.js';

export default function App() {
  const [page, setPage] = useState('library');
  const [search, setSearch] = useState('');
  const [catalog, setCatalog] = useState([]);
  const [currentSermon, setCurrentSermon] = useState(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(0.8);
  const [contentMode, setContentMode] = useState('cdn');
  const [nodeOnline, setNodeOnline] = useState(true);
  const [nodeStats, setNodeStats] = useState({
    peersConnected: 0,
    filesShared: 0,
    storageUsed: '0 B',
  });
  const [seedUnlocked, setSeedUnlocked] = useState(false);
  const [downloadStates, setDownloadStates] = useState({});
  const [libraryStats, setLibraryStats] = useState(null);
  const [bandwidthLimit, setBandwidthLimitState] = useState(0);
  const [storageLimit, setStorageLimitState] = useState(0);
  const [backgroundMode, setBackgroundMode] = useState(true);
  const [p2pEnabled, setP2pEnabled] = useState(true);
  const [p2pRunning, setP2pRunning] = useState(false);
  const [videoMini, setVideoMini] = useState(false); // true = mini player, false = could be fullscreen
  const [videoFullscreen, setVideoFullscreen] = useState(false);
  const [videoError, setVideoError] = useState(null); // null or error message string
  const [localStreamUrl, setLocalStreamUrl] = useState(null); // local asset:// URL for downloaded files
  const [announcement, setAnnouncement] = useState('');       // server-pushed banner message
  const [availablePacks, setAvailablePacks] = useState([]);   // content packs from server
  const [settingsTab, setSettingsTab] = useState(null);       // which settings sub-tab to open
  const [networkHealth, setNetworkHealth] = useState({ label: 'Offline', color: 'var(--text-muted)', score: 0 });
  const [unreadChat, setUnreadChat] = useState(0);             // unread community messages (sidebar badge)
  const [chatNotify, setChatNotify] = useState(() => chatPrefs().notify); // show unread badge
  const [chatShow, setChatShow] = useState(() => chatPrefs().show);       // show Community page at all
  const audioRef = useRef(null);
  const videoRef = useRef(null);

  // The active media type: 'audio' or 'video'
  const mediaType = currentSermon?.type === 'video' ? 'video' : 'audio';

  // Initialize catalog and the P2P (BitTorrent) node on mount
  useEffect(() => {
    async function init() {
      // Stage 1: catalog FIRST — the library must load even if anything else fails
      try {
        await initCatalog();
      } catch (e) {
        console.error('[App] initCatalog failed (showing what we have):', e);
      }
      try {
        setCatalog(getCatalog());
        setLibraryStats(getLibraryStats());
      } catch (e) {
        console.error('[App] Catalog state failed:', e);
      }

      // Stage 2: persistent node ID (needed by heartbeat)
      try {
        await loadNodeIdFromDisk();
      } catch (e) {
        console.warn('[App] Node ID load failed (non-critical):', e);
      }

      // Normalize server mode keys to app keys. Legacy server values
      // (e.g. *_PRIMARY / *_ONLY from the pre-BitTorrent era) map onto the
      // new p2p modes so old admin configs keep working.
      const normalizeMode = (m) => {
        const s = String(m || '').toLowerCase();
        let result = 'cdn';
        if (s.startsWith('cdn')) result = 'cdn';
        else if (s.includes('only')) result = 'p2p-only';
        else if (s.includes('primary')) result = 'p2p-primary';
        console.log(`[App] normalizeMode: "${m}" → "${result}"`);
        return result;
      };

      // Fetch config immediately on startup (don't wait for heartbeat)
      try {
        const config = await fetchConfig();
        if (config.source_mode) setContentMode(normalizeMode(config.source_mode));
        if (config.announcement !== undefined) setAnnouncement(config.announcement || '');
      } catch (e) {
        console.warn('[App] Initial config fetch failed:', e.message);
      }

      // Start heartbeat with remote config + content pack callbacks
      // Note: getStats callback is called fresh each heartbeat so it always gets current values
      try {
      startHeartbeat(() => {
        const freshStats = getLibraryStats();
        return {
          filesShared: freshStats?.downloadedFiles || 0,
          storageUsedBytes: freshStats?.downloadedSizeBytes || 0,
          peersConnected: 0, // heartbeat.js aggregates live peers from the torrent stats itself
          libraryCoverage: freshStats?.coverage || 0,
          contentMode: contentMode,
          nodeType: seedUnlocked ? 'seed' : 'user',
        };
      }, {
        onConfigUpdate: (config) => {
          // Remote config updated from server
          console.log('[App] onConfigUpdate received:', JSON.stringify(config));
          // Apply source mode from server (normalize server keys to app keys)
          if (config.source_mode) {
            console.log('[App] Setting content mode from heartbeat:', config.source_mode);
            setContentMode(normalizeMode(config.source_mode));
          }
          // Apply announcement banner
          if (config.announcement !== undefined) {
            setAnnouncement(config.announcement || '');
          }
        },
        onContentPacks: (packs) => {
          // Content packs received
          setAvailablePacks(packs);
        },
        getSermonInfo: (sermonId) => {
          // Return sermon metadata for seeded torrent reporting
          const sermon = getCatalog().find(s => s.id === sermonId);
          return sermon ? { title: sermon.title, speaker: sermon.speaker, type: sermon.type } : null;
        },
      });
      } catch (e) {
        console.error('[App] Heartbeat start failed (non-critical):', e);
      }

      // Start the BitTorrent node by default (with 30s timeout for DHT/UPnP init)
      try {
        const torrentModule = await import('./services/torrent.js').catch((err) => {
          console.error('[App] Torrent module import failed:', err);
          return null;
        });
        if (torrentModule) {
          console.log('[App] Torrent module loaded, starting session...');
          const initPromise = torrentModule.startSession();
          const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('P2P init timeout (30s)')), 30000)
          );
          await Promise.race([initPromise, timeoutPromise]);
          setP2pRunning(true);
          setNodeOnline(true);
          console.log('[App] P2P node started successfully');
          // The torrent session no longer persists its own list (that caused
          // deleted files to be re-downloaded from their webseeds). Instead we
          // re-seed exactly what's on disk RIGHT NOW — the downloads folder is
          // the single source of truth. Fire-and-forget; never block startup.
          try {
            downloadManager.reseedExisting(getDownloaded())
              .catch((e) => console.warn('[App] Re-seed on startup failed:', e?.message || e));
          } catch (e) {
            console.warn('[App] Re-seed on startup threw:', e?.message || e);
          }
        }
      } catch (e) {
        console.error('[App] P2P node failed to start (non-critical):', e.message, e.stack);
        setP2pRunning(false);
      }

      // Check for app updates (fire-and-forget — never throws, no-op in dev
      // or while the updater pubkey placeholder hasn't been replaced yet)
      checkForUpdates();
    }
    init().catch(e => console.error('[App] init crashed:', e));

    // Refresh sermon list when the canonical master list arrives (adds magnets)
    const handleMasterList = () => {
      setCatalog(getCatalog());
      console.log('[App] Catalog refreshed with canonical torrent links');
    };
    window.addEventListener('si-master-list', handleMasterList);

    // Master list unreachable after all retries — inform the user, but never
    // clobber a server-pushed announcement (only show if the banner is empty)
    const handleMasterListFailed = () => {
      setAnnouncement(prev => prev || 'P2P catalog temporarily unreachable — downloads still work normally.');
    };
    window.addEventListener('si-master-list-failed', handleMasterListFailed);

    // Auto-update downloaded & installed — takes effect on next launch
    const handleUpdateReady = () => {
      setAnnouncement(prev => prev || 'Update installed — takes effect next launch.');
    };
    window.addEventListener('si-update-ready', handleUpdateReady);

    // Notify server when app is closing/navigating away
    const handleBeforeUnload = () => {
      stopHeartbeat();
    };
    window.addEventListener('beforeunload', handleBeforeUnload);

    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
      window.removeEventListener('si-master-list', handleMasterList);
      window.removeEventListener('si-master-list-failed', handleMasterListFailed);
      window.removeEventListener('si-update-ready', handleUpdateReady);
      stopHeartbeat();
    };
  }, []);

  // Poll network health for TopBar indicator
  useEffect(() => {
    if (!p2pRunning) {
      setNetworkHealth({ label: 'Offline', color: 'var(--text-muted)', score: 0 });
      return;
    }
    let cancelled = false;
    const poll = async () => {
      try {
        const torrent = await import('./services/torrent.js').catch(() => null);
        if (!torrent || cancelled) return;
        const status = await torrent.getStatus().catch(() => null);
        const torrents = status?.running ? await torrent.listTorrents().catch(() => []) : [];
        if (cancelled) return;
        const livePeers = torrents.reduce((n, t) => n + (t.stats?.live?.snapshot?.peer_stats?.live || 0), 0);
        const uploaded = torrents.reduce((n, t) => n + (t.stats?.uploaded_bytes || 0), 0);

        // Reachability = the primary health axis (see ConnectionsPanel). Read
        // the last probe result (written by the Connections page) if it's fresh.
        let reachOpen = null;
        try {
          const raw = localStorage.getItem('si-reach');
          if (raw) {
            const r = JSON.parse(raw);
            if (r && Date.now() - (r.ts || 0) < 30 * 60 * 1000) reachOpen = !!r.open;
          }
        } catch {}
        const serving = livePeers >= 1 || uploaded > 0;

        // Mirror ConnectionsPanel tiers exactly.
        let score;
        if (!status?.running) score = 0;
        else if (reachOpen === true && serving) score = 100;
        else if (reachOpen === true) score = 75;
        else if (serving) score = 60;
        else if (reachOpen === false) score = 35;
        else score = 45;
        const label = score >= 80 ? 'Excellent' : score >= 50 ? 'Good' : score > 0 ? 'Fair' : 'Offline';
        const color = score >= 80 ? 'var(--green)' : score >= 50 ? 'var(--gold-text)' : score > 0 ? 'var(--orange)' : 'var(--text-muted)';
        setNetworkHealth({ label, color, score });
      } catch {}
    };
    poll();
    const iv = setInterval(poll, 5000);
    return () => { cancelled = true; clearInterval(iv); };
  }, [p2pRunning]);

  // ── Community chat unread badge ──────────────────────────────────────────
  // Poll the chat server for unread messages — light touch: first check ~10s
  // after mount, then every 60s. Skipped while the Community page is open
  // (it marks messages read itself) or when disabled in Settings.
  useEffect(() => {
    if (!chatNotify || !chatShow || page === 'community') return;
    let cancelled = false;
    const check = async () => {
      const n = await fetchUnreadCount();
      if (!cancelled) setUnreadChat(n);
    };
    const first = setTimeout(check, 10000);
    const iv = setInterval(check, 60000);
    return () => { cancelled = true; clearTimeout(first); clearInterval(iv); };
  }, [page, chatNotify, chatShow]);

  // Opening the Community page clears the badge immediately
  useEffect(() => {
    if (page === 'community') setUnreadChat(0);
  }, [page]);

  // CommunityPage dispatches this after marking new messages as read
  useEffect(() => {
    const onChatRead = () => setUnreadChat(0);
    window.addEventListener('si-chat-read', onChatRead);
    return () => window.removeEventListener('si-chat-read', onChatRead);
  }, []);

  // If the Community page gets hidden in Settings while open, leave it
  useEffect(() => {
    if (!chatShow && page === 'community') setPage('library');
  }, [chatShow, page]);

  const handleChatNotifyChange = useCallback((enabled) => {
    setChatNotify(enabled);
    try { localStorage.setItem('si-chat-notify', enabled ? '1' : '0'); } catch {}
  }, []);

  const handleChatShowChange = useCallback((enabled) => {
    setChatShow(enabled);
    try { localStorage.setItem('si-chat-show', enabled ? '1' : '0'); } catch {}
  }, []);

  // Handle P2P node toggle
  const handleP2pToggle = useCallback(async (enabled) => {
    setP2pEnabled(enabled);
    try {
      const torrentModule = await import('./services/torrent.js').catch(() => null);
      if (!torrentModule) return;
      if (enabled) {
        await torrentModule.startSession();
        setP2pRunning(true);
        setNodeOnline(true);
      } else {
        await torrentModule.stopSession();
        setP2pRunning(false);
        setNodeOnline(false);
      }
    } catch (e) {
      console.warn('[App] P2P toggle error:', e.message);
      setP2pRunning(false);
    }
  }, []);

  // Navigation with revalidation for downloads page
  // Optional 2nd arg: sub-tab (e.g. 'connections' for settings page)
  const navigateTo = useCallback(async (newPage, subTab) => {
    setPage(newPage);
    if (subTab) setSettingsTab(subTab);
    else setSettingsTab(null);
    if (newPage === 'downloads') {
      const changed = await revalidateDownloads();
      if (changed) {
        setCatalog(getCatalog());
        setLibraryStats(getLibraryStats());
      }
    }
  }, []);

  // Expose navigation function for tray menu
  useEffect(() => {
    window.__navigateToSettings = () => navigateTo('settings');
    return () => { delete window.__navigateToSettings; };
  }, [navigateTo]);

  // Listen for download progress updates
  useEffect(() => {
    const markOnceSet = new Set(); // Track which sermons we've already marked
    const unsub = downloadManager.onProgress((sermonId, state) => {
      setDownloadStates(prev => ({ ...prev, [sermonId]: { ...state } }));

      // Mark as downloaded when entering post-processing (file is already saved to disk)
      // States: SEEDING = file saved, seeding to the torrent swarm
      //         COMPLETE = all done (magnet may still arrive via a later notify)
      const postProcessStates = [DL_STATE.SEEDING, DL_STATE.COMPLETE];
      if (postProcessStates.includes(state.state) && !markOnceSet.has(sermonId)) {
        markOnceSet.add(sermonId);
        const size = state.bytesDownloaded || 0;
        markDownloaded(sermonId, state.magnet || `local-${sermonId}`, size);
        setCatalog(getCatalog());
        setLibraryStats(getLibraryStats());
      }
      if (state.state === DL_STATE.COMPLETE) {
        markDownloaded(sermonId, state.magnet, state.bytesDownloaded || 0);
        setCatalog(getCatalog());
        setLibraryStats(getLibraryStats());
      }
    });
    return unsub;
  }, []);

  // Poll live torrent peer count every 5s so Settings & Network pages show live data
  useEffect(() => {
    if (!p2pRunning) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const torrent = await import('./services/torrent.js').catch(() => null);
        if (torrent && !cancelled) {
          const torrents = await torrent.listTorrents().catch(() => []);
          if (cancelled) return;
          const livePeers = torrents.reduce((n, t) => n + (t.stats?.live?.snapshot?.peer_stats?.live || 0), 0);
          setNodeStats(prev => {
            if (prev.peersConnected !== livePeers) {
              return { ...prev, peersConnected: livePeers };
            }
            return prev;
          });
        }
      } catch {}
    };
    poll(); // immediate first read
    const id = setInterval(poll, 5000);
    return () => { cancelled = true; clearInterval(id); };
  }, [p2pRunning]);

  // Sync content mode to download manager
  useEffect(() => {
    const modeMap = {
      cdn: SOURCE_MODE.CDN_PRIMARY,
      'p2p-primary': SOURCE_MODE.P2P_PRIMARY,
      'p2p-only': SOURCE_MODE.P2P_ONLY,
    };
    downloadManager.setMode(modeMap[contentMode] || SOURCE_MODE.CDN_PRIMARY);
    console.log('[App] Content mode synced to download manager:', contentMode, '→', modeMap[contentMode] || SOURCE_MODE.CDN_PRIMARY);
  }, [contentMode]);

  // Sync bandwidth limit
  useEffect(() => {
    downloadManager.setBandwidthLimit(bandwidthLimit);
  }, [bandwidthLimit]);

  // ── AUDIO player events ──────────────────────────────────────────────────
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const onTimeUpdate = () => {
      if (mediaType !== 'audio') return; // Don't update if video is playing
      setCurrentTime(audio.currentTime);
      setDuration(audio.duration || 0);
      setProgress(audio.duration ? (audio.currentTime / audio.duration) * 100 : 0);
    };
    const onEnded = () => { setIsPlaying(false); setProgress(0); setCurrentTime(0); };
    const onLoadedMetadata = () => { if (mediaType === 'audio') setDuration(audio.duration || 0); };
    // Keep isPlaying state in sync with actual audio element state
    const onPlay = () => { if (mediaType === 'audio') setIsPlaying(true); };
    const onPause = () => { if (mediaType === 'audio') setIsPlaying(false); };
    const onError = (e) => {
      if (mediaType !== 'audio') return;
      console.warn('[Player] Audio error:', e, 'src:', audio.src);
      if (currentSermon) {
        const currentSrc = audio.src;
        const fallback = currentSrc.includes('b-cdn.net') ? currentSermon.archiveUrl : currentSermon.cdnUrl;
        if (fallback && fallback !== currentSrc) {
          audio.src = fallback;
          audio.load();
          audio.play().catch(() => setIsPlaying(false));
          return;
        }
      }
      setIsPlaying(false);
    };

    audio.addEventListener('timeupdate', onTimeUpdate);
    audio.addEventListener('ended', onEnded);
    audio.addEventListener('loadedmetadata', onLoadedMetadata);
    audio.addEventListener('play', onPlay);
    audio.addEventListener('pause', onPause);
    audio.addEventListener('error', onError);
    return () => {
      audio.removeEventListener('timeupdate', onTimeUpdate);
      audio.removeEventListener('ended', onEnded);
      audio.removeEventListener('loadedmetadata', onLoadedMetadata);
      audio.removeEventListener('play', onPlay);
      audio.removeEventListener('pause', onPause);
      audio.removeEventListener('error', onError);
    };
  }, [currentSermon, mediaType]);

  // ── Close player ─────────────────────────────────────────────────────────
  const closePlayer = useCallback(() => {
    const audio = audioRef.current;
    const video = videoRef.current;
    if (audio) { audio.pause(); audio.src = ''; }
    if (video) {
      video.pause();
      while (video.firstChild) video.removeChild(video.firstChild);
      video.removeAttribute('src');
      video.load();
    }
    setCurrentSermon(null);
    setIsPlaying(false);
    setProgress(0);
    setCurrentTime(0);
    setDuration(0);
    setVideoMini(false);
    setVideoFullscreen(false);
    setVideoError(null);
    setLocalStreamUrl(null);
  }, []);

  // ── Play a sermon ────────────────────────────────────────────────────────
  const playSermon = useCallback(async (sermon) => {
    const audio = audioRef.current;
    const isVideo = sermon.type === 'video';

    // Toggle play/pause for same sermon
    if (currentSermon?.id === sermon.id) {
      if (isVideo && videoRef.current) {
        if (isPlaying) { videoRef.current.pause(); } else { videoRef.current.play().catch(() => {}); }
      } else if (audio) {
        if (isPlaying) { audio.pause(); } else { audio.play().catch(() => {}); }
      }
      setIsPlaying(!isPlaying);
      return;
    }

    // New sermon — stop any current playback first
    if (audio) { audio.pause(); audio.src = ''; }
    if (videoRef.current) {
      videoRef.current.pause();
      while (videoRef.current.firstChild) videoRef.current.removeChild(videoRef.current.firstChild);
      videoRef.current.removeAttribute('src');
      videoRef.current.load(); // Reset the media element
    }

    setCurrentSermon(sermon);
    setProgress(0);
    setCurrentTime(0);
    setIsPlaying(true);
    setVideoError(null);

    // For downloaded files, try to serve from local disk
    let streamUrl = sermon.cdnUrl || sermon.archiveUrl || sermon.url;
    setLocalStreamUrl(null);
    if (sermon.downloaded) {
      try {
        const tauriMod = await import('@tauri-apps/api/core').catch(() => null);
        if (tauriMod) {
          const ext = sermon.type === 'video' ? 'mp4' : 'mp3';
          const filename = `${sermon.id}.${ext}`;
          const filePath = await tauriMod.invoke('get_sermon_file_path', { filename }).catch(() => null);
          if (filePath && tauriMod.convertFileSrc) {
            const localUrl = tauriMod.convertFileSrc(filePath);
            console.log(`[Player] Using local file: ${filePath} → ${localUrl}`);
            streamUrl = localUrl;
            setLocalStreamUrl(localUrl);
          }
        }
      } catch (e) {
        console.warn('[Player] Local file check failed, falling back to CDN:', e.message);
      }
    }
    console.log(`[Player] Playing ${isVideo ? 'video' : 'audio'}:`, sermon.title, '→', streamUrl);

    if (isVideo) {
      // Video — show mini player
      setVideoMini(true);
      setVideoFullscreen(false);
      setVideoError(null);

      // Play video directly — all CDN videos are now proper MP4 containers
      if (videoRef.current) {
        const v = videoRef.current;
        // Remove any stale source
        v.removeAttribute('src');
        v.load();

        // Use <source> element for proper MIME type hinting (helps WKWebView)
        // Clear any existing sources first
        while (v.firstChild) v.removeChild(v.firstChild);
        const source = document.createElement('source');
        source.src = streamUrl;
        source.type = 'video/mp4';
        v.appendChild(source);
        v.load();

        console.log(`[VideoPlayer] Set source: ${streamUrl.slice(0, 100)}`);

        // Wait for video to be ready before playing (WKWebView needs this)
        const tryPlay = () => {
          v.play().catch((err) => {
            console.warn('[VideoPlayer] Autoplay blocked, trying muted:', err.message);
            v.muted = true;
            v.play().catch((err2) => {
              console.warn('[VideoPlayer] Muted autoplay also failed:', err2.message);
              // Don't set error — user can click to play manually
            });
          });
        };

        if (v.readyState >= 3) {
          // Already have enough data
          tryPlay();
        } else {
          v.addEventListener('canplay', tryPlay, { once: true });
          // Timeout fallback — if canplay never fires in 5s, try anyway
          setTimeout(() => {
            if (v.readyState < 3 && !v.paused) return; // Already playing
            if (v.readyState >= 1) tryPlay();
          }, 5000);
        }
      }
    } else {
      // Audio — use <audio> element only
      setVideoMini(false);
      setVideoFullscreen(false);
      if (audio) {
        audio.src = streamUrl;
        audio.volume = volume;
        audio.load();
        audio.play().catch((err) => {
          console.warn('[Player] Autoplay blocked:', err);
          if (streamUrl === sermon.cdnUrl && sermon.archiveUrl) {
            audio.src = sermon.archiveUrl;
            audio.load();
            audio.play().catch(() => setIsPlaying(false));
          } else {
            setIsPlaying(false);
          }
        });
      }
    }

    // Trigger download in background if not already downloaded
    if (!sermon.downloaded) {
      const existing = downloadManager.getState(sermon.id);
      if (!existing || existing.state === DL_STATE.ERROR) {
        downloadManager.download(sermon).catch(() => {});
      }
    }
  }, [currentSermon, isPlaying, volume]);

  // ── Toggle play/pause from PlayerBar ─────────────────────────────────────
  const togglePlay = useCallback(() => {
    if (!currentSermon) return;
    const isVideo = currentSermon.type === 'video';

    if (isVideo && videoRef.current) {
      if (isPlaying) { videoRef.current.pause(); } else { videoRef.current.play().catch(() => {}); }
    } else if (audioRef.current) {
      if (isPlaying) { audioRef.current.pause(); } else { audioRef.current.play().catch(() => {}); }
    }
    setIsPlaying(!isPlaying);
  }, [isPlaying, currentSermon]);

  // ── Seek ─────────────────────────────────────────────────────────────────
  const seekTo = useCallback((percent) => {
    const isVideo = currentSermon?.type === 'video';
    if (isVideo && videoRef.current && videoRef.current.duration) {
      videoRef.current.currentTime = (percent / 100) * videoRef.current.duration;
    } else if (audioRef.current && audioRef.current.duration) {
      audioRef.current.currentTime = (percent / 100) * audioRef.current.duration;
    }
  }, [currentSermon]);

  // ── Volume ───────────────────────────────────────────────────────────────
  const handleVolumeChange = useCallback((val) => {
    setVolume(val);
    if (audioRef.current) audioRef.current.volume = val;
    if (videoRef.current) videoRef.current.volume = val;
  }, []);

  // ── Download ─────────────────────────────────────────────────────────────
  const handleDownload = useCallback(async (sermonId) => {
    const sermon = getCatalog().find(s => s.id === sermonId);
    if (!sermon) return;
    if (sermon.downloaded) return;
    const existing = downloadManager.getState(sermonId);
    if (existing && existing.state !== DL_STATE.ERROR) return;
    try { await downloadManager.download(sermon); } catch (err) { console.error('[App] Download failed:', err); }
  }, []);

  // ── Remove download ──────────────────────────────────────────────────────
  const handleRemoveDownload = useCallback(async (sermonId) => {
    const sermon = getCatalog().find(s => s.id === sermonId);
    if (!sermon) return;
    // Delete file from disk
    try {
      const tauriMod = await import('@tauri-apps/api/core').catch(() => null);
      if (tauriMod) {
        const ext = sermon.type === 'video' ? 'mp4' : 'mp3';
        const filename = `${sermonId}.${ext}`;
        await tauriMod.invoke('delete_sermon_file', { filename }).catch(() => {});
      }
    } catch {}
    // Remove from download state
    markRemoved(sermonId);
    setCatalog(getCatalog());
    setLibraryStats(getLibraryStats());
    // The file is gone from disk — prune its torrent so the session stops
    // seeding/listing it immediately (otherwise it lingers until next restart).
    // Fire-and-forget: deletion already succeeded regardless of this.
    (async () => {
      try {
        const torrentModule = await import('./services/torrent.js').catch(() => null);
        if (torrentModule) await torrentModule.pruneMissing();
      } catch (e) {
        console.warn('[App] Torrent prune after remove failed:', e?.message || e);
      }
    })();
  }, []);

  // ── Re-download (for incomplete files) ────────────────────────────────
  const handleRedownload = useCallback(async (sermonId) => {
    const sermon = getCatalog().find(s => s.id === sermonId);
    if (!sermon) return;
    // Delete the partial file first
    try {
      const tauriMod = await import('@tauri-apps/api/core').catch(() => null);
      if (tauriMod) {
        const ext = sermon.type === 'video' ? 'mp4' : 'mp3';
        const filename = `${sermonId}.${ext}`;
        await tauriMod.invoke('delete_sermon_file', { filename }).catch(() => {});
      }
    } catch {}
    // Remove from download state
    markRemoved(sermonId);
    setCatalog(getCatalog());
    setLibraryStats(getLibraryStats());
    // Re-download
    try {
      await downloadManager.download(sermon);
    } catch (err) {
      console.error('[App] Re-download failed:', err);
    }
  }, []);

  // ── Open the app downloads folder ────────────────────────────────────────
  const handleOpenFolder = useCallback(async () => {
    try {
      const tauriMod = await import('@tauri-apps/api/core').catch(() => null);
      if (tauriMod) {
        const storagePath = await tauriMod.invoke('get_storage_path');
        await tauriMod.invoke('open_folder', { path: storagePath });
      }
    } catch (e) {
      console.warn('[App] Open folder failed:', e);
    }
  }, []);

  // ── Export download to Desktop with readable name ────────────────────────
  const handleExportDownload = useCallback(async (sermonId) => {
    const sermon = getCatalog().find(s => s.id === sermonId);
    if (!sermon) return;
    try {
      const tauriMod = await import('@tauri-apps/api/core').catch(() => null);
      if (tauriMod) {
        const ext = sermon.type === 'video' ? 'mp4' : 'mp3';
        const filename = `${sermonId}.${ext}`;
        // Clean title for filename
        const cleanTitle = `${sermon.speaker} - ${sermon.title}`.replace(/[/\\:*?"<>|]/g, '_');
        const destName = `${cleanTitle}.${ext}`;
        await tauriMod.invoke('export_sermon_file', { filename, destName });
      }
    } catch (e) {
      console.warn('[App] Export failed:', e);
    }
  }, []);

  // Content mode change
  const handleModeChange = useCallback((mode) => { setContentMode(mode); }, []);

  // Node toggle
  const handleNodeToggle = useCallback((online) => {
    setNodeOnline(online);
    if (online) downloadManager.resume(); else downloadManager.pause();
  }, []);

  // Derived data
  const filteredCatalog = search ? searchCatalog(search) : getCatalog();
  const catalogWithDlState = filteredCatalog.map(s => ({
    ...s, dlState: downloadStates[s.id] || null,
  }));
  const downloadedSermons = getDownloaded().map(s => ({
    ...s, dlState: downloadStates[s.id] || null,
  }));

  // Compute real node stats from catalog
  const realStats = libraryStats ? {
    peersConnected: nodeStats.peersConnected,
    filesShared: libraryStats.downloadedFiles || 0,
    storageUsed: libraryStats.downloadedSize || '0 B',
  } : nodeStats;

  const renderPage = () => {
    switch (page) {
      case 'library':
        return <LibraryPage sermons={catalogWithDlState} currentSermon={currentSermon} isPlaying={isPlaying} onPlay={playSermon} onDownload={handleDownload} search={search} onSearch={setSearch} />;
      case 'downloads':
        return <DownloadsPage sermons={downloadedSermons} currentSermon={currentSermon} isPlaying={isPlaying} onPlay={playSermon} onRemove={handleRemoveDownload} onExport={handleExportDownload} onRedownload={handleRedownload} onOpenFolder={handleOpenFolder} downloadStates={downloadStates} />;
      case 'seed':
        return <SeedNodePage seedUnlocked={seedUnlocked} onUnlock={setSeedUnlocked} catalog={getCatalog()} libraryStats={getLibraryStats()} downloadManager={downloadManager} downloadStates={downloadStates} nodeStats={realStats} />;
      case 'bulk-download':
        return <BulkDownloadPage catalog={getCatalog()} downloadManager={downloadManager} downloadStates={downloadStates} onCatalogUpdate={() => { setCatalog(getCatalog()); setLibraryStats(getLibraryStats()); }} />;
      case 'network':
        return <NetworkPage nodeStats={realStats} />;
      case 'community':
        return <CommunityPage />;
      case 'connections':
        return <ConnectionsPage p2pRunning={p2pRunning} p2pEnabled={p2pEnabled} onP2pToggle={handleP2pToggle} />;
      case 'settings':
        return <SettingsPage contentMode={contentMode} onModeChange={handleModeChange} nodeOnline={nodeOnline} onNodeToggle={handleNodeToggle} p2pEnabled={p2pEnabled} p2pRunning={p2pRunning} onP2pToggle={handleP2pToggle} bandwidthLimit={bandwidthLimit} onBandwidthChange={setBandwidthLimitState} storageLimit={storageLimit} onStorageLimitChange={setStorageLimitState} backgroundMode={backgroundMode} onBackgroundModeChange={setBackgroundMode} chatNotify={chatNotify} onChatNotifyChange={handleChatNotifyChange} chatShow={chatShow} onChatShowChange={handleChatShowChange} nodeStats={realStats} />;
      default:
        return <LibraryPage sermons={catalogWithDlState} currentSermon={currentSermon} isPlaying={isPlaying} onPlay={playSermon} onDownload={handleDownload} search={search} onSearch={setSearch} />;
    }
  };

  return (
    <>
      {/* Hidden audio element for audio-only playback */}
      <audio ref={audioRef} preload="none" />

      {/* Persistent mini video player — bottom-right corner */}
      {currentSermon && currentSermon.type === 'video' && videoMini && (
        <div className={`video-mini-player ${videoFullscreen ? 'fullscreen' : ''}`}>
          <div className="video-mini-header">
            <div className="video-mini-title">{currentSermon.title}</div>
            <div className="video-mini-controls">
              <button
                className="video-mini-btn"
                onClick={() => setVideoFullscreen(!videoFullscreen)}
                title={videoFullscreen ? 'Exit Fullscreen' : 'Fullscreen'}
              >
                {videoFullscreen ? (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="4 14 10 14 10 20" /><polyline points="20 10 14 10 14 4" /><line x1="14" y1="10" x2="21" y2="3" /><line x1="3" y1="21" x2="10" y2="14" /></svg>
                ) : (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 3 21 3 21 9" /><polyline points="9 21 3 21 3 15" /><line x1="21" y1="3" x2="14" y2="10" /><line x1="3" y1="21" x2="10" y2="14" /></svg>
                )}
              </button>
              <button className="video-mini-btn" onClick={closePlayer} title="Close">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
              </button>
            </div>
          </div>
          <video
            ref={videoRef}
            className="video-mini-element"
            playsInline
            preload="auto"
            onClick={() => {
              if (videoRef.current) {
                if (isPlaying) videoRef.current.pause(); else videoRef.current.play().catch(() => {});
              }
            }}
            onTimeUpdate={(e) => {
              const v = e.target;
              setCurrentTime(v.currentTime);
              setDuration(v.duration || 0);
              setProgress(v.duration ? (v.currentTime / v.duration) * 100 : 0);
            }}
            onEnded={() => { setIsPlaying(false); setProgress(0); setCurrentTime(0); }}
            onPlay={() => setIsPlaying(true)}
            onPause={() => setIsPlaying(false)}
            onLoadedMetadata={(e) => { setDuration(e.target.duration || 0); }}
            onError={(e) => {
              // When using <source> elements, error may fire on <source> — always use the <video> ref
              const v = videoRef.current;
              if (!v) return;
              const mediaError = v.error;
              const errorCodes = { 1: 'MEDIA_ERR_ABORTED', 2: 'MEDIA_ERR_NETWORK', 3: 'MEDIA_ERR_DECODE', 4: 'MEDIA_ERR_SRC_NOT_SUPPORTED' };
              const errorName = errorCodes[mediaError?.code] || 'UNKNOWN';
              const sourceEl = v.querySelector('source');
              const src = sourceEl?.src || v.src || '';
              console.warn(`[VideoPlayer] Error: ${errorName} (code ${mediaError?.code}) message: ${mediaError?.message || 'none'} src: ${src?.slice(0, 100)}`);
              // If local file failed, try CDN URL directly
              const cdnUrl = currentSermon?.cdnUrl || currentSermon?.archiveUrl || currentSermon?.url;
              if (cdnUrl && src !== cdnUrl && !src.startsWith('blob:')) {
                console.log('[VideoPlayer] Local playback failed, trying CDN:', cdnUrl);
                // Replace source element
                while (v.firstChild) v.removeChild(v.firstChild);
                const newSource = document.createElement('source');
                newSource.src = cdnUrl;
                newSource.type = 'video/mp4';
                v.appendChild(newSource);
                v.load();
                v.play().catch(() => {
                  setVideoError(`Playback failed: ${errorName}`);
                  setIsPlaying(false);
                });
              } else {
                setVideoError(`Playback failed: ${errorName}`);
                setIsPlaying(false);
              }
            }}
          />
          {/* Error overlay */}
          {videoError && (
            <div className="video-error-overlay">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.6, marginBottom: '8px' }}>
                <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                <line x1="12" y1="9" x2="12" y2="13" />
                <line x1="12" y1="17" x2="12.01" y2="17" />
              </svg>
              <div style={{ fontSize: '0.8rem', marginBottom: '8px', textAlign: 'center', lineHeight: 1.4 }}>{videoError}</div>
              <button
                className="btn btn-gold"
                style={{ fontSize: '0.75rem', padding: '4px 12px' }}
                onClick={() => {
                  const url = currentSermon?.cdnUrl || currentSermon?.url;
                  if (url) window.open(url, '_blank');
                }}
              >
                Open in Browser
              </button>
            </div>
          )}
        </div>
      )}

      <Sidebar
        page={page}
        onNavigate={navigateTo}
        nodeOnline={nodeOnline}
        nodeStats={realStats}
        seedUnlocked={seedUnlocked}
        libraryStats={libraryStats}
        announcement={announcement}
        unreadChat={chatShow && chatNotify ? unreadChat : 0}
        chatShow={chatShow}
      />
      <div className="main-content">
        <TopBar contentMode={contentMode} announcement={announcement} onNavigate={navigateTo} networkHealth={networkHealth} />
        <div className={`content-scroll ${page === 'network' || page === 'connections' ? 'no-pad' : ''}`}>
          <ErrorBoundary>
            {renderPage()}
          </ErrorBoundary>
        </div>
        <DonateBanner />
        {currentSermon && (
          <PlayerBar
            sermon={currentSermon}
            isPlaying={isPlaying}
            progress={progress}
            currentTime={currentTime}
            duration={duration}
            volume={volume}
            onTogglePlay={togglePlay}
            onSeek={seekTo}
            onVolumeChange={handleVolumeChange}
            onClose={closePlayer}
          />
        )}
      </div>
    </>
  );
}
