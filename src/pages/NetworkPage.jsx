import React, { useRef, useEffect, useState, useMemo } from 'react';
import { fetchNodeMap, fetchNetworkStats, getNodeId, getCachedGeo } from '../services/heartbeat.js';

const SAMPLE_NODES = [
  { id: 'seed-sf', lat: 37.77, lon: -122.42, city: 'San Francisco', country: 'US', coverage: 100, type: 'seed' },
  { id: 'seed-ny', lat: 40.71, lon: -74.01, city: 'New York', country: 'US', coverage: 100, type: 'seed' },
  { id: 'seed-ldn', lat: 51.51, lon: -0.13, city: 'London', country: 'GB', coverage: 100, type: 'seed' },
  { id: 'seed-nrb', lat: -1.29, lon: 36.82, city: 'Nairobi', country: 'KE', coverage: 100, type: 'seed' },
  { id: 'seed-syd', lat: -33.87, lon: 151.21, city: 'Sydney', country: 'AU', coverage: 100, type: 'seed' },
];

const COUNTRY_NAMES = {
  US: 'United States', GB: 'United Kingdom', KE: 'Kenya', AU: 'Australia',
  CA: 'Canada', DE: 'Germany', FR: 'France', IN: 'India', BR: 'Brazil',
  NG: 'Nigeria', ZA: 'South Africa', PH: 'Philippines', KR: 'South Korea',
  JP: 'Japan', MX: 'Mexico', GH: 'Ghana', NL: 'Netherlands', SE: 'Sweden',
  NZ: 'New Zealand', SG: 'Singapore', XX: 'Unknown',
};

// Mercator projection constants — matching the analytics dashboard
const LON_MIN = -130, LON_MAX = 155, LAT_MIN = -55, LAT_MAX = 72;
function mercY(lat) {
  const r = lat * Math.PI / 180;
  return Math.log(Math.tan(Math.PI / 4 + r / 2));
}
const MERC_TOP = mercY(LAT_MAX), MERC_BOT = mercY(LAT_MIN), MERC_RANGE = MERC_TOP - MERC_BOT;
const MAP_ASPECT = (LON_MAX - LON_MIN) / ((MERC_TOP - MERC_BOT) * (180 / Math.PI));

const iconSeed = <svg width="14" height="14" viewBox="0 0 256 256" fill="currentColor"><path d="M208,32H48A16,16,0,0,0,32,48V208a16,16,0,0,0,16,16H208a16,16,0,0,0,16-16V48A16,16,0,0,0,208,32ZM88,160a8,8,0,1,1-8,8A8,8,0,0,1,88,160ZM48,48H80v97.38a24,24,0,1,0,16,0V115.31l48,48V208H48ZM208,208H160V160a8,8,0,0,0-2.34-5.66L96,92.69V48h32V72a8,8,0,0,0,2.34,5.66l16,16A23.74,23.74,0,0,0,144,104a24,24,0,1,0,24-24,23.74,23.74,0,0,0-10.34,2.35L144,68.69V48h64V208ZM168,96a8,8,0,1,1-8,8A8,8,0,0,1,168,96Z" /></svg>;
const iconUser = <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></svg>;
const iconGlobe = <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><line x1="2" y1="12" x2="22" y2="12" /><path d="M12 2a15 15 0 0 1 4 10 15 15 0 0 1-4 10 15 15 0 0 1-4-10 15 15 0 0 1 4-10z" /></svg>;

export default function NetworkPage({ nodeStats }) {
  const canvasRef = useRef(null);
  const animRef = useRef(null);
  const [nodes, setNodes] = useState(SAMPLE_NODES);
  const [hoveredNode, setHoveredNode] = useState(null);
  const [isLiveData, setIsLiveData] = useState(false);
  const [netStats, setNetStats] = useState(null);
  const [mapTab, setMapTab] = useState('map');

  // Fetch live node data
  useEffect(() => {
    async function loadNodes() {
      const liveNodes = await fetchNodeMap();
      const myId = getNodeId();
      const geo = getCachedGeo();

      if (liveNodes.length > 0) {
        const fixed = liveNodes.map(n => {
          if (n.id === myId && geo && (n.city === 'Unknown' || !n.city)) {
            return { ...n, city: geo.city, country: geo.country, lat: geo.lat, lon: geo.lon };
          }
          return n;
        });
        setNodes(fixed);
        setIsLiveData(true);
      } else {
        const myNode = geo ? {
          id: myId, lat: geo.lat, lon: geo.lon, city: geo.city, country: geo.country,
          coverage: nodeStats?.filesShared ? Math.min(Math.round((nodeStats.filesShared / 33528) * 100), 100) : 0,
          type: 'user',
        } : null;
        const allNodes = [...SAMPLE_NODES];
        if (myNode && myNode.lat !== 0) allNodes.push(myNode);
        setNodes(allNodes);
        setIsLiveData(false);
      }
    }

    async function loadStats() {
      const stats = await fetchNetworkStats();
      if (stats) setNetStats(stats);
    }

    loadNodes();
    loadStats();
    const refreshId = setInterval(() => { loadNodes(); loadStats(); }, 30000);
    return () => clearInterval(refreshId);
  }, [nodeStats]);

  const countryBreakdown = useMemo(() => {
    const map = {};
    nodes.forEach(n => {
      const cc = n.country || 'XX';
      if (!map[cc]) map[cc] = { code: cc, name: COUNTRY_NAMES[cc] || cc, seeds: 0, peers: 0, total: 0, cities: new Set() };
      map[cc].total++;
      if (n.type === 'seed') map[cc].seeds++;
      else map[cc].peers++;
      if (n.city && n.city !== 'Unknown') map[cc].cities.add(n.city);
    });
    return Object.values(map).sort((a, b) => b.total - a.total);
  }, [nodes]);

  // Load GeoJSON data
  const [geoData, setGeoData] = useState(null);
  useEffect(() => {
    fetch('./geo.json')
      .then(r => r.json())
      .then(data => setGeoData(data))
      .catch(() => { /* geo.json not available */ });
  }, []);

  // Canvas rendering with GeoJSON + Path2D (matching analytics dashboard)
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;

    let mapX = 0, mapY = 0, mapW = 0, mapH = 0;
    let countryPaths = {};

    function projectBase(lat, lon) {
      const x = mapX + ((lon - LON_MIN) / (LON_MAX - LON_MIN)) * mapW;
      const my = mercY(Math.max(LAT_MIN, Math.min(LAT_MAX, lat)));
      const y = mapY + (MERC_TOP - my) / MERC_RANGE * mapH;
      return [x, y];
    }

    function project(lat, lon) {
      return projectBase(lat, lon);
    }

    function buildCountryPaths() {
      countryPaths = {};
      if (!geoData) return;
      geoData.features.forEach(f => {
        const iso = f.properties.c;
        const paths = [];
        const geom = f.geometry;
        const polys = geom.type === 'MultiPolygon' ? geom.coordinates : [geom.coordinates];
        polys.forEach(poly => {
          poly.forEach(ring => {
            const p2 = new Path2D();
            ring.forEach((coord, i) => {
              const pt = projectBase(coord[1], coord[0]);
              if (i === 0) p2.moveTo(pt[0], pt[1]);
              else p2.lineTo(pt[0], pt[1]);
            });
            p2.closePath();
            paths.push(p2);
          });
        });
        if (!countryPaths[iso]) countryPaths[iso] = [];
        countryPaths[iso] = countryPaths[iso].concat(paths);
      });
    }

    const W = () => canvas.width / dpr;
    const H = () => canvas.height / dpr;

    const resize = () => {
      const rect = canvas.parentElement.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      canvas.style.width = rect.width + 'px';
      canvas.style.height = rect.height + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      // Calculate map bounds preserving aspect ratio
      const pad = 30;
      const availW = rect.width - pad * 2;
      const availH = rect.height - pad * 2;
      if (availW / availH > MAP_ASPECT) {
        mapW = availH * MAP_ASPECT;
        mapH = availH;
      } else {
        mapW = availW;
        mapH = availW / MAP_ASPECT;
      }
      mapX = (rect.width - mapW) / 2;
      mapY = (rect.height - mapH) / 2;

      buildCountryPaths();
    };

    // Build set of countries with active nodes for highlighting
    const activeCountries = {};
    nodes.forEach(n => {
      if (n.country) {
        activeCountries[n.country] = (activeCountries[n.country] || 0) + 1;
      }
    });

    function drawArc(x1, y1, x2, y2, color, lineWidth, dashOffset) {
      const midX = (x1 + x2) / 2;
      const midY = (y1 + y2) / 2;
      const dist = Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2);
      const cpX = midX;
      const cpY = midY - dist * 0.2;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.quadraticCurveTo(cpX, cpY, x2, y2);
      ctx.strokeStyle = color;
      ctx.lineWidth = lineWidth;
      ctx.setLineDash([4, 8]);
      ctx.lineDashOffset = -dashOffset;
      ctx.stroke();
      ctx.setLineDash([]);
    }

    function draw() {
      const w = W(), h = H();
      if (w === 0 || h === 0) { animRef.current = requestAnimationFrame(draw); return; }
      const now = Date.now();

      // Background
      const bg = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w * 0.7);
      bg.addColorStop(0, '#0c1824');
      bg.addColorStop(1, '#060c14');
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, w, h);

      // Clip to map area
      ctx.save();
      ctx.beginPath();
      ctx.rect(mapX, mapY, mapW, mapH);
      ctx.clip();

      // Grid
      ctx.strokeStyle = 'rgba(30,51,72,0.15)';
      ctx.lineWidth = 0.5;
      for (let lon = LON_MIN; lon <= LON_MAX; lon += 30) {
        ctx.beginPath();
        for (let lat = LAT_MIN; lat <= LAT_MAX; lat += 2) {
          const p = project(lat, lon);
          if (lat === LAT_MIN) ctx.moveTo(p[0], p[1]); else ctx.lineTo(p[0], p[1]);
        }
        ctx.stroke();
      }
      for (let lat = -60; lat <= 80; lat += 30) {
        ctx.beginPath();
        for (let lon = LON_MIN; lon <= LON_MAX; lon += 2) {
          const p = project(lat, lon);
          if (lon === LON_MIN) ctx.moveTo(p[0], p[1]); else ctx.lineTo(p[0], p[1]);
        }
        ctx.stroke();
      }

      // Country polygons from GeoJSON
      Object.keys(countryPaths).forEach(iso => {
        const isActive = activeCountries[iso] && activeCountries[iso] > 0;
        countryPaths[iso].forEach(path => {
          if (isActive) {
            const intensity = Math.min(activeCountries[iso] * 0.08, 0.35);
            ctx.fillStyle = `rgba(212,175,55,${intensity})`;
          } else {
            ctx.fillStyle = 'rgba(22,34,48,0.55)';
          }
          ctx.fill(path);
          ctx.strokeStyle = isActive ? 'rgba(212,175,55,0.2)' : 'rgba(50,80,110,0.18)';
          ctx.lineWidth = isActive ? 0.8 : 0.5;
          ctx.stroke(path);
        });
      });

      ctx.restore(); // unclip

      const seeds = nodes.filter(n => n.type === 'seed');
      const peers = nodes.filter(n => n.type !== 'seed');
      const dashOff = (now / 60) % 24;

      // Seed-to-seed backbone connections
      for (let i = 0; i < seeds.length; i++) {
        for (let j = i + 1; j < seeds.length; j++) {
          const [x1, y1] = project(seeds[i].lat, seeds[i].lon);
          const [x2, y2] = project(seeds[j].lat, seeds[j].lon);
          drawArc(x1, y1, x2, y2, 'rgba(212,175,55,0.1)', 0.7, dashOff);
        }
      }

      // Peer-to-nearest-seed connections
      peers.forEach(peer => {
        if (!peer.lat || !peer.lon) return;
        const [px, py] = project(peer.lat, peer.lon);
        let minDist = Infinity, nearestCoords = null;
        seeds.forEach(s => {
          const [sx, sy] = project(s.lat, s.lon);
          const d = Math.sqrt((px - sx) ** 2 + (py - sy) ** 2);
          if (d < minDist) { minDist = d; nearestCoords = [sx, sy]; }
        });
        if (nearestCoords) {
          drawArc(px, py, nearestCoords[0], nearestCoords[1], 'rgba(212,175,55,0.06)', 0.4, dashOff);
        }
      });

      // Draw nodes
      nodes.forEach(node => {
        const [x, y] = project(node.lat, node.lon);
        const isSeed = node.type === 'seed';
        const isMe = node.id === getNodeId();
        const baseR = isSeed ? 6 : isMe ? 5 : 3.5;
        const pulse = Math.sin(now / 3000 + (node.id?.charCodeAt?.(3) || 0)) * 0.3 + 0.7;
        const glowR = baseR * 3 + pulse * 4;

        const glow = ctx.createRadialGradient(x, y, 0, x, y, glowR);
        if (isMe) {
          glow.addColorStop(0, 'rgba(76,175,80,0.35)');
          glow.addColorStop(1, 'rgba(76,175,80,0)');
        } else {
          glow.addColorStop(0, isSeed ? 'rgba(212,175,55,0.3)' : 'rgba(212,175,55,0.15)');
          glow.addColorStop(1, 'rgba(212,175,55,0)');
        }
        ctx.fillStyle = glow;
        ctx.beginPath(); ctx.arc(x, y, glowR, 0, Math.PI * 2); ctx.fill();

        ctx.beginPath(); ctx.arc(x, y, baseR, 0, Math.PI * 2);
        ctx.fillStyle = isMe ? '#4caf50' : isSeed ? '#d4af37' : 'rgba(212,175,55,0.7)';
        ctx.fill();
        ctx.beginPath(); ctx.arc(x, y, isSeed ? 2.5 : 1.5, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255,240,200,0.9)'; ctx.fill();

        if (isSeed) {
          ctx.font = '9px Verdana, sans-serif';
          ctx.fillStyle = 'rgba(212,175,55,0.5)';
          ctx.textAlign = 'center';
          ctx.fillText(node.city, x, y - baseR - 6);
          ctx.fillText(`SEED · ${node.coverage}%`, x, y - baseR + 2);
        } else if (isMe) {
          ctx.font = 'bold 9px Verdana, sans-serif';
          ctx.fillStyle = 'rgba(76,175,80,0.7)';
          ctx.textAlign = 'center';
          ctx.fillText('YOU', x, y - baseR - 4);
        }
      });

      // LIVE indicator
      const livePulse = Math.sin(now / 800) * 0.3 + 0.7;
      ctx.fillStyle = `rgba(76,175,80,${livePulse})`;
      ctx.beginPath(); ctx.arc(w - 16, 16, 4, 0, Math.PI * 2); ctx.fill();
      ctx.font = '9px Verdana, sans-serif';
      ctx.fillStyle = `rgba(76,175,80,${livePulse * 0.8})`;
      ctx.textAlign = 'right';
      ctx.fillText('LIVE', w - 26, 20);

      animRef.current = requestAnimationFrame(draw);
    }

    resize();
    animRef.current = requestAnimationFrame(draw);
    window.addEventListener('resize', resize);

    const observer = new ResizeObserver(() => resize());
    observer.observe(canvas.parentElement);

    const handleMouseMove = (e) => {
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      let found = null;
      for (const node of nodes) {
        const [nx, ny] = project(node.lat, node.lon);
        if (Math.sqrt((mx - nx) ** 2 + (my - ny) ** 2) < 15) { found = node; break; }
      }
      setHoveredNode(found);
      canvas.style.cursor = found ? 'pointer' : 'default';
    };
    canvas.addEventListener('mousemove', handleMouseMove);

    return () => {
      window.removeEventListener('resize', resize);
      observer.disconnect();
      if (animRef.current) cancelAnimationFrame(animRef.current);
      canvas.removeEventListener('mousemove', handleMouseMove);
    };
  }, [nodes, mapTab, geoData]);

  const seedNodes = nodes.filter(n => n.type === 'seed');
  const peerNodes = nodes.filter(n => n.type === 'user');
  const countries = new Set(nodes.map(n => n.country)).size;
  const avgCoverage = nodes.length > 0
    ? (nodes.reduce((acc, n) => acc + (n.coverage || 0), 0) / nodes.length).toFixed(1)
    : 0;

  return (
    <div className="network-fullpage">
      {/* Compact stats row */}
      <div className="net-stats-row">
        <div className="net-stat-mini">
          <span className="net-stat-mini-val gold">{nodes.length}</span>
          <span className="net-stat-mini-label">Nodes</span>
        </div>
        <div className="net-stat-mini">
          <span className="net-stat-mini-val gold">{seedNodes.length}</span>
          <span className="net-stat-mini-label">Seeds</span>
        </div>
        <div className="net-stat-mini">
          <span className="net-stat-mini-val">{peerNodes.length}</span>
          <span className="net-stat-mini-label">Peers</span>
        </div>
        <div className="net-stat-mini">
          <span className="net-stat-mini-val gold">{countries}</span>
          <span className="net-stat-mini-label">Countries</span>
        </div>
        <div className="net-stat-mini">
          <span className="net-stat-mini-val green">{avgCoverage}%</span>
          <span className="net-stat-mini-label">Avg Coverage</span>
        </div>
        {!isLiveData && <span className="net-sample-badge">Sample Data</span>}
      </div>

      {/* Tab bar with 3 tabs */}
      <div className="net-tab-bar">
        <button className={`net-tab ${mapTab === 'map' ? 'active' : ''}`} onClick={() => setMapTab('map')}>
          <span style={{ display: 'inline-flex', marginRight: '6px' }}>{iconGlobe}</span> Global Map
        </button>
        <button className={`net-tab ${mapTab === 'countries' ? 'active' : ''}`} onClick={() => setMapTab('countries')}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: '6px' }}><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>
          Countries
        </button>
        <button className={`net-tab ${mapTab === 'nodes' ? 'active' : ''}`} onClick={() => setMapTab('nodes')}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: '6px' }}><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
          Nodes Online ({nodes.length})
        </button>
      </div>

      {/* Tab content — fills remaining space */}
      <div className="net-tab-content">
        {/* Map — always mounted, hidden when not active */}
        <div className="net-map-container" style={{ display: mapTab === 'map' ? 'block' : 'none' }}>
          <canvas ref={canvasRef} style={{ display: 'block', width: '100%', height: '100%' }} />
          {hoveredNode && (
            <div style={{
              /* Overlay on the always-dark map canvas — fixed dark-friendly colors */
              position: 'absolute', bottom: '16px', left: '16px',
              background: 'rgba(15,25,35,0.92)', border: '1px solid rgba(255,255,255,0.12)',
              borderRadius: '8px', padding: '10px 14px', fontSize: '0.8rem',
              lineHeight: '1.5', backdropFilter: 'blur(8px)',
            }}>
              <div style={{ fontWeight: 600, color: hoveredNode.type === 'seed' ? '#d4af37' : hoveredNode.id === getNodeId() ? '#4caf50' : '#e4e4da' }}>
                {hoveredNode.city}, {hoveredNode.country}
                {hoveredNode.id === getNodeId() && <span style={{ fontSize: '0.68rem', opacity: 0.7, marginLeft: '6px' }}>(You)</span>}
              </div>
              <div style={{ color: '#9aa3ad', display: 'flex', alignItems: 'center', gap: '4px' }}>
                <span style={{ display: 'inline-flex' }}>{hoveredNode.type === 'seed' ? iconSeed : iconUser}</span>
                {hoveredNode.type === 'seed' ? 'Seed Node' : 'Peer'} · {hoveredNode.coverage}% coverage
              </div>
            </div>
          )}

          {/* Map legend */}
          <div style={{
            /* Legend over the always-dark map canvas — fixed dark-friendly colors */
            position: 'absolute', top: '12px', left: '12px',
            background: 'rgba(15,25,35,0.85)', border: '1px solid rgba(255,255,255,0.12)',
            borderRadius: '6px', padding: '8px 12px', fontSize: '0.7rem',
            backdropFilter: 'blur(8px)', display: 'flex', flexDirection: 'column', gap: '4px',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#d4af37', display: 'inline-block' }} />
              <span style={{ color: '#9aa3ad' }}>Seed Node</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: 'rgba(212,175,55,0.5)', display: 'inline-block' }} />
              <span style={{ color: '#9aa3ad' }}>Peer</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#4caf50', display: 'inline-block' }} />
              <span style={{ color: '#9aa3ad' }}>You</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '2px', borderTop: '1px solid rgba(255,255,255,0.15)', paddingTop: '4px' }}>
              <span style={{ width: '14px', height: '2px', background: 'rgba(212,175,55,0.3)', display: 'inline-block', borderRadius: '1px' }} />
              <span style={{ color: '#9aa3ad' }}>Connection</span>
            </div>
          </div>
        </div>

        {/* Countries view */}
        {mapTab === 'countries' && (
          <div className="net-scroll-content">
            <table className="net-country-table">
              <thead>
                <tr>
                  <th style={{ width: '40%' }}>Country</th>
                  <th>Nodes</th>
                  <th>Seeds</th>
                  <th>Peers</th>
                  <th>Cities</th>
                </tr>
              </thead>
              <tbody>
                {countryBreakdown.map(c => (
                  <tr key={c.code}>
                    <td>
                      <span className="net-country-flag">{countryCodeToEmoji(c.code)}</span>
                      <span>{c.name}</span>
                    </td>
                    <td><span className="net-country-count">{c.total}</span></td>
                    <td>{c.seeds > 0 ? <span style={{ color: 'var(--gold-text)' }}>{c.seeds}</span> : <span style={{ color: 'var(--text-muted)' }}>-</span>}</td>
                    <td>{c.peers > 0 ? c.peers : <span style={{ color: 'var(--text-muted)' }}>-</span>}</td>
                    <td style={{ color: 'var(--text-muted)', fontSize: '0.75rem' }}>{[...c.cities].join(', ') || '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Nodes Online view — now a 3rd tab */}
        {mapTab === 'nodes' && (
          <div className="net-scroll-content">
            {seedNodes.map(node => (
              <div key={node.id} className="node-list-item seed">
                <span className="node-list-icon" style={{ display: 'flex', color: 'var(--gold-text)' }}>{iconSeed}</span>
                <div className="node-list-info">
                  <div className="node-list-name">{node.city}, {node.country}</div>
                  <div className="node-list-detail">Seed Node · {node.coverage}% coverage · Full library</div>
                </div>
                <span className="node-list-status online">Online</span>
              </div>
            ))}
            {peerNodes.map(node => (
              <div key={node.id} className="node-list-item">
                <span className="node-list-icon" style={{ display: 'flex', color: node.id === getNodeId() ? 'var(--green)' : undefined }}>{iconUser}</span>
                <div className="node-list-info">
                  <div className="node-list-name">
                    {node.city}, {node.country}
                    {node.id === getNodeId() && <span style={{ fontSize: '0.68rem', color: 'var(--green)', marginLeft: '6px' }}>(You)</span>}
                  </div>
                  <div className="node-list-detail">Peer · {node.coverage}% coverage</div>
                </div>
                <span className="node-list-status online">Online</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function countryCodeToEmoji(code) {
  if (!code || code === 'XX' || code.length !== 2) return '';
  const upper = code.toUpperCase();
  return String.fromCodePoint(
    0x1F1E6 + upper.charCodeAt(0) - 65,
    0x1F1E6 + upper.charCodeAt(1) - 65,
  );
}
