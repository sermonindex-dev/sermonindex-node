import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles.css';
// BitTorrent PoC — exposes window.torrentPoc in devtools (see POC-TORRENT.md)
import './services/torrent.js';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
