import React, { useState, useRef, useEffect, useCallback, Component } from 'react';
import Sidebar from './components/Sidebar';
import TopBar from './components/TopBar';
import PlayerBar from './components/PlayerBar';
import LibraryPage from './pages/LibraryPage';
import DownloadsPage from './pages/DownloadsPage';
import BulkDownloadPage from './pages/BulkDownloadPage';
import SeedNodePage from './pages/SeedNodePage';
import SettingsPage from './pages/SettingsPage';
import ConnectionsPage from './pages/ConnectionsPage';
import NetworkPage from './pages/NetworkPage';

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
        <div style={{ padding: '48px', textAlign: 'center', background: '#0f1923', color: '#e0e6ed', minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
          <h2 style={{ color: '#d4af37', marginBottom: '16px' }}>Something went wrong</h2>
          <p style={{ color: '#8cb4d5', marginBottom: '24px', maxWidth: '400px' }}>
            The app encountered an unexpected error. This has been logged.
          </p>
          <p style={{ fontFamily: 'monospace', fontSize: '0.8rem', color: '#6a8299', marginBottom: '24px', maxWidth: '500px', wordBreak: 'break-all' }}>
            {this.state.error?.message || 'Unknown error'}
          </p>
          <button
            onClick={() => { this.setState({ hasError: false, error: null }); }}
            style={{ background: '#d4af37', color: '#0f1923', border: 'none', padding: '10px 24px', borderRadius: '8px', fontWeight: 700, cursor: 'pointer', fontSize: '0.9rem' }}
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
  const [ipfsEnabled, setIpfsEnabled] = useState(true);
  const [ipfsRunning, setIpfsRunning] = useState(false);
  const [videoMini, setVideoMini] = useState(false); // true = mini player, false = could be fullscreen
  const [videoFullscreen, setVideoFullscreen] = useState(false);
  const [videoError, setVideoError] = useState(null); // null or error message string
  const [localStreamUrl, setLocalStreamUrl] = useState(null); // local asset:// URL for downloaded files
  const [announcement, setAnnouncement] = useState('');       // server-pushed banner message
  const [availablePacks, setAvailablePacks] = useState([]);   // content packs from server
  const [settingsTab, setSettingsTab] = useState(null);       // which settings sub-tab to open
  const [networkHealth, setNetworkHealth] = useState({ label: 'Offline', color: '#6a8299', score: 0 });
  const audioRef = useRef(null);
  const videoRef = useRef(null);

  // The active media type: 'audio' or 'video'
  const mediaType = currentSermon?.type === 'video' ? 'video' : 'audio';

  // Initialize catalog and IPFS on mount
  useEffect(() => {
    async function init() {
      // Load persistent node ID from disk before anything else
      await loadNodeIdFromDisk();

      await initCatalog();
      setCatalog(getCatalog());
      setLibraryStats(getLibraryStats());

      // Fetch config immediately on startup (don't wait for heartbeat)
      try {
        const config = await fetchConfig();
        if (config.source_mode) setContentMode(config.source_mode);
        if (config.announcement !== undefined) setAnnouncement(config.announcement || '');
      } catch (e) {
        console.warn('[App] Initial config fetch failed:', e.message);
      }

      // Start heartbeat with remote config + content pack callbacks
      // Note: getStats callback is called fresh each heartbeat so it always gets current values
      startHeartbeat(() => {
        const freshStats = getLibraryStats();
        return {
          filesShared: freshStats?.downloadedFiles || 0,
          storageUsedBytes: freshStats?.downloadedSizeBytes || 0,
          peersConnected: 0, // Updated live via ipfs.js peer monitoring
          libraryCoverage: freshStats?.coverage || 0,
          contentMode: contentMode,
          nodeType: seedUnlocked ? 'seed' : 'user',
        };
      }, {
        onConfigUpdate: (config) => {
          // Remote config updated from server
          // Apply source mode from server
          if (config.source_mode) {
            setContentMode(config.source_mode);
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
          // Return sermon metadata for IPFS pin reporting
          const sermon = getCatalog().find(s => s.id === sermonId);
          return sermon ? { title: sermon.title, speaker: sermon.speaker, type: sermon.type } : null;
        },
      });

      // Start IPFS node by default (with 30s timeout to allow DHT init)
      try {
        const ipfsModule = await import('./services/ipfs.js').catch((err) => {
          console.error('[App] IPFS module import failed:', err);
          return null;
        });
        if (ipfsModule) {
          console.log('[App] IPFS module loaded, initializing node...');
          const initPromise = ipfsModule.initNode('sermonindex');
          const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('IPFS init timeout (30s)')), 30000)
          );
          await Promise.race([initPromise, timeoutPromise]);
          setIpfsRunning(true);
          setNodeOnline(true);
          console.log('[App] IPFS node started successfully');
        }
      } catch (e) {
        console.error('[App] IPFS node failed to start (non-critical):', e.message, e.stack);
        setIpfsRunning(false);
      }
    }
    init();

    // Notify server when app is closing/navigating away
    const handleBeforeUnload = () => {
      stopHeartbeat();
    };
    window.addEventListener('beforeunload', handleBeforeUnload);

    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
      stopHeartbeat();
    };
  }, []);

  // Poll network health for TopBar indicator
  useEffect(() => {
    if (!ipfsRunning) {
      setNetworkHealth({ label: 'Offline', color: '#6a8299', score: 0 });
      return;
    }
    let cancelled = false;
    const poll = async () => {
      try {
        const ipfs = await import('./services/ipfs.js').catch(() => null);
        if (!ipfs || !ipfs.getDiagnostics || cancelled) return;
        const diag = await ipfs.getDiagnostics();
        if (cancelled) return;
        const peers = diag?.peerCount || 0;
        const addrs = diag?.multiaddrs || diag?.listen_addresses || [];
        const extAddrs = diag?.externalAddresses || diag?.external_addresses || [];
        const upnp = diag?.upnpStatus || diag?.upnp_status || 'unknown';
        const natpmp = diag?.natpmpStatus || diag?.natpmp_status || 'inactive';
        const relay = diag?.relayStatus || diag?.relay_status || 'inactive';
        const mdnsPeers = diag?.mdnsPeers || diag?.mdns_peers || 0;
        const rvStatus = diag?.rendezvousStatus || diag?.rendezvous_status || 'inactive';
        const nat = diag?.natStatus || '';
        const isPublic = nat.toLowerCase().includes('public') || extAddrs.length > 0;
        const hasRelay = addrs.some(a => a.includes('p2p-circuit'));

        // Match ConnectionsPanel health score exactly
        let score = 0;
        if (peers >= 1) score += 15;
        if (peers >= 5) score += 15;
        if (peers >= 10) score += 10;
        if (addrs.some(a => a.includes('/tcp/') && !a.includes('/ws'))) score += 10; // TCP
        if (addrs.some(a => a.includes('/quic'))) score += 10; // QUIC
        if (addrs.some(a => a.includes('/ws'))) score += 5; // WebSocket
        if (upnp === 'mapped' || extAddrs.length > 0) score += 10; // UPnP
        if (natpmp === 'mapped') score += 10; // NAT-PMP
        if (hasRelay) score += 10; // Circuit Relay
        if (peers > 0) score += 10; // DHT
        if (mdnsPeers > 0) score += 5; // mDNS
        if (rvStatus === 'registered') score += 5; // Rendezvous
        if (isPublic || hasRelay) score += 5; // Hole Punch potential
        score = Math.min(100, score);
        const label = score >= 80 ? 'Excellent' : score >= 50 ? 'Good' : score >= 20 ? 'Fair' : 'Offline';
        const color = score >= 80 ? '#4ecb71' : score >= 50 ? '#d4af37' : score >= 20 ? '#e67e22' : '#6a8299';
        setNetworkHealth({ label, color, score });
      } catch {}
    };
    poll();
    const iv = setInterval(poll, 5000);
    return () => { cancelled = true; clearInterval(iv); };
  }, [ipfsRunning]);

  // Handle IPFS toggle
  const handleIpfsToggle = useCallback(async (enabled) => {
    setIpfsEnabled(enabled);
    try {
      const ipfsModule = await import('./services/ipfs.js').catch(() => null);
      if (!ipfsModule) return;
      if (enabled) {
        await ipfsModule.initNode('sermonindex');
        setIpfsRunning(true);
        setNodeOnline(true);
      } else {
        await ipfsModule.stopNode();
        setIpfsRunning(false);
        setNodeOnline(false);
      }
    } catch (e) {
      console.warn('[App] IPFS toggle error:', e.message);
      setIpfsRunning(false);
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
      // States: PINNING = file saved, pinning to IPFS
      //         COMPLETE = all done
      const postProcessStates = [DL_STATE.PINNING, DL_STATE.COMPLETE];
      if (postProcessStates.includes(state.state) && !markOnceSet.has(sermonId)) {
        markOnceSet.add(sermonId);
        const size = state.bytesDownloaded || 0;
        markDownloaded(sermonId, state.cid || `local-${sermonId}`, size);
        setCatalog(getCatalog());
        setLibraryStats(getLibraryStats());
      }
      if (state.state === DL_STATE.COMPLETE) {
        markDownloaded(sermonId, state.cid, state.bytesDownloaded || 0);
        setCatalog(getCatalog());
        setLibraryStats(getLibraryStats());
      }
    });
    return unsub;
  }, []);

  // Poll IPFS peer count every 5s so Settings & Network pages show live data
  useEffect(() => {
    if (!ipfsRunning) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const ipfs = await import('./services/ipfs.js').catch(() => null);
        if (ipfs && !cancelled) {
          const stats = ipfs.getStats();
          setNodeStats(prev => {
            if (prev.peersConnected !== stats.peersConnected) {
              return { ...prev, peersConnected: stats.peersConnected };
            }
            return prev;
          });
        }
      } catch {}
    };
    poll(); // immediate first read
    const id = setInterval(poll, 5000);
    return () => { cancelled = true; clearInterval(id); };
  }, [ipfsRunning]);

  // Sync content mode to download manager
  useEffect(() => {
    const modeMap = {
      cdn: SOURCE_MODE.CDN_PRIMARY,
      'ipfs-primary': SOURCE_MODE.IPFS_PRIMARY,
      'ipfs-only': SOURCE_MODE.IPFS_ONLY,
    };
    downloadManager.setMode(modeMap[contentMode] || SOURCE_MODE.CDN_PRIMARY);
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
    if (video) { video.pause(); video.src = ''; }
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
    if (videoRef.current) { videoRef.current.pause(); videoRef.current.src = ''; }

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

      // Play video directly (CDN videos should be proper MP4)
      if (videoRef.current) {
        videoRef.current.src = streamUrl;
        videoRef.current.load();
        videoRef.current.play().catch(() => {});
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

  // ── Open IPFS downloads folder ───────────────────────────────────────────
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
      case 'connections':
        return <ConnectionsPage ipfsRunning={ipfsRunning} ipfsEnabled={ipfsEnabled} onIpfsToggle={handleIpfsToggle} />;
      case 'settings':
        return <SettingsPage contentMode={contentMode} onModeChange={handleModeChange} nodeOnline={nodeOnline} onNodeToggle={handleNodeToggle} ipfsEnabled={ipfsEnabled} ipfsRunning={ipfsRunning} onIpfsToggle={handleIpfsToggle} bandwidthLimit={bandwidthLimit} onBandwidthChange={setBandwidthLimitState} storageLimit={storageLimit} onStorageLimitChange={setStorageLimitState} backgroundMode={backgroundMode} onBackgroundModeChange={setBackgroundMode} nodeStats={realStats} />;
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
              console.warn('[VideoPlayer] Error:', e);
              const v = e.target;
              const src = v.src || '';
              // If local file failed, try CDN URL directly
              const cdnUrl = currentSermon?.cdnUrl || currentSermon?.archiveUrl || currentSermon?.url;
              if (cdnUrl && src !== cdnUrl && !src.startsWith('blob:')) {
                console.log('[VideoPlayer] Local playback failed, trying CDN:', cdnUrl);
                v.src = cdnUrl;
                v.load();
                v.play().catch(() => {
                  setVideoError('Failed to play this video.');
                  setIsPlaying(false);
                });
              } else {
                setVideoError('Failed to play this video.');
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
      />
      <div className="main-content">
        <TopBar contentMode={contentMode} announcement={announcement} onNavigate={navigateTo} networkHealth={networkHealth} />
        <div className={`content-scroll ${page === 'network' || page === 'connections' ? 'no-pad' : ''}`}>
          <ErrorBoundary>
            {renderPage()}
          </ErrorBoundary>
        </div>
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
