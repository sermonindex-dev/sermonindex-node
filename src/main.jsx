import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles.css';

// Initialize theme before React renders to avoid a flash of the wrong theme.
// Default is LIGHT regardless of OS preference; 'dark' only if explicitly saved.
(() => {
  let saved = null;
  try { saved = localStorage.getItem('si-theme'); } catch {}
  document.documentElement.dataset.theme = saved === 'dark' ? 'dark' : 'light';
})();
// BitTorrent PoC — exposes window.torrentPoc in devtools (see POC-TORRENT.md)
import './services/torrent.js';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
