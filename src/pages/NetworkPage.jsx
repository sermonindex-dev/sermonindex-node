import React, { useRef, useEffect, useState, useMemo } from 'react';
import { fetchNodeMap, fetchNetworkStats, getNodeId, getCachedGeo } from '../services/heartbeat.js';

// No fake/demo nodes — the map shows only real nodes reported by the
// heartbeat server, plus your own node. (Previously this held 5 sample seed
// locations that flashed on screen and looked like a live network.)
const SAMPLE_NODES = [];

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

// Three-way node classification (matches the dashboard):
//   seed → approved seed node
//   node → port OPEN / reachable from the internet
//   peer → running but port CLOSED (or reachability unknown)
function catOf(n) {
  if (n.category) return n.category;               // server already classified
  if (n.type === 'seed') return 'seed';
  return n.reachable ? 'node' : 'peer';
}

// ── Node category → color. ONE source of truth so the map dots + glow, the
// legend (swatch AND label), the stat row, the node list, the country table
// and the hover tooltips can never drift out of sync — change a color here and
// it updates everywhere.
//   seed → BLUE · node (port open / reachable) → GREEN · peer (port closed) → YELLOW
// `hex`/`rgb` are the bright, dark-friendly values painted on the always-dark
// map canvas and its overlays (legend, hover cards). `cssVar` is the
// theme-aware token used on the (light OR dark) node lists, stat row and
// country table — a raw #f8d355 yellow is unreadable on a light surface, so the
// peer text there maps to the readable gold/yellow token instead.
const NODE_COLORS = {
  seed: { hex: '#2d6cb5', rgb: '45,108,181', cssVar: 'var(--seed-blue)' }, // blue
  node: { hex: '#4caf50', rgb: '76,175,80',  cssVar: 'var(--green)' },     // green
  peer: { hex: '#f8d355', rgb: '248,211,85', cssVar: 'var(--gold-text)' }, // yellow
};
function nodeColor(n) {
  return NODE_COLORS[catOf(n)] || NODE_COLORS.peer;
}

// ISO-3166 alpha-2 → full country name, for the country-name hover tooltip.
// The map GeoJSON only carries the 2-letter code (feature.properties.c), so we
// expand it: prefer the app's own names, then the platform Intl list, then the
// raw code. One shared Intl instance (creating it per-call is expensive).
const _regionNames = (() => {
  try { return new Intl.DisplayNames(['en'], { type: 'region' }); } catch { return null; }
})();
function countryName(iso) {
  if (!iso) return '';
  const up = String(iso).toUpperCase();
  if (COUNTRY_NAMES[up]) return COUNTRY_NAMES[up];
  try { return (_regionNames && _regionNames.of(up)) || up; } catch { return up; }
}

// Stable signature of the fields that actually affect what the map draws. Used
// to bail out of a state update when a poll returns identical data, so `nodes`
// keeps the SAME array reference — otherwise every poll (and, because the parent
// hands us a fresh stats object on each of its renders, effectively every parent
// render) would create a new array, re-run the canvas effect and tear down /
// rebuild the whole canvas, which is what made the map vibrate.
function nodesSig(list) {
  return list.map(n =>
    `${n.id}|${n.lat}|${n.lon}|${n.coverage}|${n.category || ''}|${n.type || ''}|${n.reachable ? 1 : 0}|${n.city || ''}|${n.region || ''}|${n.country || ''}`
  ).sort().join(';');
}

// Ray-casting point-in-polygon (screen-space CSS px) for country hover hit-tests.
function pointInRing(px, py, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    if (((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}

// Format a node's location as "City, Region, CountryFullName" (e.g. "Abbotsford, BC, Canada").
// `region` comes from the heartbeat/server; the 2-letter country code is expanded to a full
// name via Intl.DisplayNames. Any missing part is omitted gracefully.
const fmtLoc = (n) => {
  let country = '';
  try { country = new Intl.DisplayNames(['en'], { type: 'region' }).of((n.country || '').toUpperCase()) || n.country; }
  catch { country = n.country || ''; }
  return [n.city, n.region, country].filter(Boolean).join(', ');
};

const iconSeed = <svg width="14" height="14" viewBox="0 0 256 256" fill="currentColor"><path d="M208,32H48A16,16,0,0,0,32,48V208a16,16,0,0,0,16,16H208a16,16,0,0,0,16-16V48A16,16,0,0,0,208,32ZM88,160a8,8,0,1,1-8,8A8,8,0,0,1,88,160ZM48,48H80v97.38a24,24,0,1,0,16,0V115.31l48,48V208H48ZM208,208H160V160a8,8,0,0,0-2.34-5.66L96,92.69V48h32V72a8,8,0,0,0,2.34,5.66l16,16A23.74,23.74,0,0,0,144,104a24,24,0,1,0,24-24,23.74,23.74,0,0,0-10.34,2.35L144,68.69V48h64V208ZM168,96a8,8,0,1,1-8,8A8,8,0,0,1,168,96Z" /></svg>;
const iconUser = <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></svg>;
const iconGlobe = <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><line x1="2" y1="12" x2="22" y2="12" /><path d="M12 2a15 15 0 0 1 4 10 15 15 0 0 1-4 10 15 15 0 0 1-4-10 15 15 0 0 1 4-10z" /></svg>;

export default function NetworkPage({ nodeStats }) {
  const canvasRef = useRef(null);
  const animRef = useRef(null);
  const countryTipRef = useRef(null);      // country-name hover tooltip (positioned imperatively)
  const [nodes, setNodes] = useState(SAMPLE_NODES);
  const [hoveredNode, setHoveredNode] = useState(null);
  const [hoveredCountry, setHoveredCountry] = useState(null); // hovered country name, or null
  const [isLiveData, setIsLiveData] = useState(false);
  const [netStats, setNetStats] = useState(null);
  const [mapTab, setMapTab] = useState('map');

  // Fetch live node data
  useEffect(() => {
    let cancelled = false; // guards in-flight fetches after unmount

    async function loadNodes() {
      const liveNodes = await fetchNodeMap();
      if (cancelled) return;
      const myId = getNodeId();
      const geo = getCachedGeo();

      if (liveNodes.length > 0) {
        const fixed = liveNodes.map(n => {
          if (n.id === myId && geo && (n.city === 'Unknown' || !n.city)) {
            return { ...n, city: geo.city, region: geo.region || '', country: geo.country, lat: geo.lat, lon: geo.lon };
          }
          return n;
        });
        // Only swap in a new array when the data actually changed, so an
        // unchanged poll can't retrigger the canvas rebuild (see nodesSig).
        setNodes(prev => nodesSig(prev) === nodesSig(fixed) ? prev : fixed);
        setIsLiveData(true);
      } else {
        const myNode = geo ? {
          id: myId, lat: geo.lat, lon: geo.lon, city: geo.city, region: geo.region || '', country: geo.country,
          coverage: nodeStats?.filesShared ? Math.min(Math.round((nodeStats.filesShared / 33528) * 100), 100) : 0,
          type: 'user',
        } : null;
        const allNodes = [...SAMPLE_NODES];
        if (myNode && myNode.lat !== 0) allNodes.push(myNode);
        setNodes(prev => nodesSig(prev) === nodesSig(allNodes) ? prev : allNodes);
        setIsLiveData(false);
      }
    }

    async function loadStats() {
      const stats = await fetchNetworkStats();
      if (stats && !cancelled) setNetStats(stats);
    }

    loadNodes();
    loadStats();
    const refreshId = setInterval(() => { loadNodes(); loadStats(); }, 30000);
    return () => { cancelled = true; clearInterval(refreshId); };
    // Depend on the one primitive we read (filesShared) rather than the whole
    // stats object. The parent rebuilds that object on every render, so keying
    // off it re-ran this effect (and cleared/recreated the 30s interval before
    // it could ever fire) constantly. A primitive only changes on real change.
  }, [nodeStats?.filesShared]);

  const countryBreakdown = useMemo(() => {
    const map = {};
    nodes.forEach(n => {
      const cc = n.country || 'XX';
      if (!map[cc]) map[cc] = { code: cc, name: COUNTRY_NAMES[cc] || cc, seeds: 0, nodes: 0, peers: 0, total: 0, cities: new Set() };
      map[cc].total++;
      const c = catOf(n);
      if (c === 'seed') map[cc].seeds++;
      else if (c === 'node') map[cc].nodes++;
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
    let countryShapes = [];               // projected rings + bbox + name, for country hover hit-tests
    let lastW = -1, lastH = -1;           // last applied CSS size, to skip redundant resizes

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
      countryShapes = [];
      if (!geoData) return;
      geoData.features.forEach(f => {
        const iso = f.properties.c;
        const paths = [];
        const rings = [];                         // same projected rings, kept as point arrays for hit-testing
        let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
        const geom = f.geometry;
        const polys = geom.type === 'MultiPolygon' ? geom.coordinates : [geom.coordinates];
        polys.forEach(poly => {
          poly.forEach(ring => {
            const p2 = new Path2D();
            const pts = [];
            ring.forEach((coord, i) => {
              const pt = projectBase(coord[1], coord[0]);
              if (i === 0) p2.moveTo(pt[0], pt[1]);
              else p2.lineTo(pt[0], pt[1]);
              pts.push(pt);
              if (pt[0] < minx) minx = pt[0]; if (pt[0] > maxx) maxx = pt[0];
              if (pt[1] < miny) miny = pt[1]; if (pt[1] > maxy) maxy = pt[1];
            });
            p2.closePath();
            paths.push(p2);
            rings.push(pts);
          });
        });
        if (!countryPaths[iso]) countryPaths[iso] = [];
        countryPaths[iso] = countryPaths[iso].concat(paths);
        // Country-name hover uses the SAME projected features drawn as fills.
        countryShapes.push({ iso, name: countryName(iso), rings, bbox: [minx, miny, maxx, maxy] });
      });
    }

    const W = () => canvas.width / dpr;
    const H = () => canvas.height / dpr;

    const resize = () => {
      const rect = canvas.parentElement.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      // Round to whole CSS pixels and bail if unchanged. getBoundingClientRect
      // reports sub-pixel values that wobble frame-to-frame; without this guard
      // every ResizeObserver tick reassigned canvas.width (which CLEARS the
      // bitmap + resets the transform) and rebuilt the country paths, i.e. it
      // reset the view mid-animation. Integer dims + early-out keep it stable.
      const cw = Math.round(rect.width), ch = Math.round(rect.height);
      if (cw === lastW && ch === lastH) return;
      lastW = cw; lastH = ch;

      canvas.width = cw * dpr;
      canvas.height = ch * dpr;
      canvas.style.width = cw + 'px';
      canvas.style.height = ch + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      // Calculate map bounds preserving aspect ratio
      const pad = 30;
      const availW = cw - pad * 2;
      const availH = ch - pad * 2;
      if (availW / availH > MAP_ASPECT) {
        mapW = availH * MAP_ASPECT;
        mapH = availH;
      } else {
        mapW = availW;
        mapH = availW / MAP_ASPECT;
      }
      mapX = (cw - mapW) / 2;
      mapY = (ch - mapH) / 2;

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
      const myId = getNodeId();

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
        const count = activeCountries[iso] || 0;
        const isActive = count > 0;
        // Density heat-map (dim): opacity scales with node count — subtle for a
        // single node, brighter for 3+ — and caps at 0.30 so the map stays dark
        // overall rather than the previous flat 0.35-for-everyone highlight.
        const fillA = Math.min(count * 0.07, 0.30);
        const strokeA = Math.min(0.10 + count * 0.04, 0.24);
        countryPaths[iso].forEach(path => {
          ctx.fillStyle = isActive ? `rgba(212,175,55,${fillA})` : 'rgba(22,34,48,0.55)';
          ctx.fill(path);
          ctx.strokeStyle = isActive ? `rgba(212,175,55,${strokeA})` : 'rgba(50,80,110,0.18)';
          ctx.lineWidth = isActive ? 0.8 : 0.5;
          ctx.stroke(path);
        });
      });

      ctx.restore(); // unclip

      const seeds = nodes.filter(n => catOf(n) === 'seed');
      const peers = nodes.filter(n => catOf(n) !== 'seed'); // nodes + peers, for backbone lines
      const dashOff = (now / 60) % 24;

      // Seed-to-seed backbone connections
      for (let i = 0; i < seeds.length; i++) {
        for (let j = i + 1; j < seeds.length; j++) {
          const [x1, y1] = project(seeds[i].lat, seeds[i].lon);
          const [x2, y2] = project(seeds[j].lat, seeds[j].lon);
          drawArc(x1, y1, x2, y2, `rgba(${NODE_COLORS.seed.rgb},0.16)`, 0.7, dashOff);
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
          drawArc(px, py, nearestCoords[0], nearestCoords[1], `rgba(${NODE_COLORS.seed.rgb},0.11)`, 0.4, dashOff);
        }
      });

      // Draw nodes
      nodes.forEach(node => {
        const [x, y] = project(node.lat, node.lon);
        const cat = catOf(node);
        const isSeed = cat === 'seed';
        const isMe = node.id === myId;
        // Bubble radius ~50% larger than before (was 6 / 5 / 3.5) so nodes are
        // easier to spot; the glow (baseR * 3 + …) and inner highlight scale with it.
        const baseR = isSeed ? 9 : isMe ? 7.5 : 5.25;
        // Glow "breathes" via pulse, but ONLY the outer glow radius changes —
        // the dot center (x, y) is a pure function of (node, projection), so it
        // never moves frame-to-frame.
        const pulse = Math.sin(now / 3000 + (node.id?.charCodeAt?.(3) || 0)) * 0.3 + 0.7;
        const glowR = baseR * 3 + pulse * 4;

        // Color strictly by category via the shared helper: seed = blue ·
        // node (port open) = green · peer (port closed) = yellow. Your own node
        // keeps its category color and is identified by the "YOU" label below.
        const { hex: dotColor, rgb } = nodeColor(node);
        const glow = ctx.createRadialGradient(x, y, 0, x, y, glowR);
        glow.addColorStop(0, `rgba(${rgb},${(isMe || isSeed) ? 0.32 : 0.18})`);
        glow.addColorStop(1, `rgba(${rgb},0)`);
        ctx.fillStyle = glow;
        ctx.beginPath(); ctx.arc(x, y, glowR, 0, Math.PI * 2); ctx.fill();

        ctx.beginPath(); ctx.arc(x, y, baseR, 0, Math.PI * 2);
        ctx.fillStyle = dotColor;
        ctx.fill();
        ctx.beginPath(); ctx.arc(x, y, isSeed ? 3.5 : 2.25, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255,240,200,0.9)'; ctx.fill();

        if (isSeed) {
          ctx.font = '9px Verdana, sans-serif';
          ctx.fillStyle = `rgba(${NODE_COLORS.seed.rgb},0.85)`;
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

      // 1) Node hit-test first — a node hover always beats a bare-country hover.
      let found = null;
      for (const node of nodes) {
        const [nx, ny] = project(node.lat, node.lon);
        if (Math.hypot(mx - nx, my - ny) < 16) { found = node; break; }
      }
      if (found) {
        setHoveredNode(prev => (prev && prev.id === found.id) ? prev : found);
        setHoveredCountry(prev => prev === null ? prev : null);
        canvas.style.cursor = 'pointer';
        return;
      }
      setHoveredNode(prev => prev === null ? prev : null);

      // 2) Otherwise, which country polygon is the cursor inside? Reuse the same
      // projected GeoJSON rings we filled; bbox pre-check keeps it cheap.
      let name = null;
      for (const shape of countryShapes) {
        const b = shape.bbox;
        if (mx < b[0] || mx > b[2] || my < b[1] || my > b[3]) continue;
        for (const ring of shape.rings) {
          if (pointInRing(mx, my, ring)) { name = shape.name; break; }
        }
        if (name) break;
      }
      if (name) {
        // Position the tooltip imperatively so following the cursor costs no
        // re-render; only the name (which changes rarely) lives in React state.
        const el = countryTipRef.current;
        if (el) { el.style.left = (mx + 14) + 'px'; el.style.top = (my + 16) + 'px'; }
        setHoveredCountry(prev => prev === name ? prev : name);
      } else {
        setHoveredCountry(prev => prev === null ? prev : null);
      }
      canvas.style.cursor = 'default';
    };
    canvas.addEventListener('mousemove', handleMouseMove);

    const handleMouseLeave = () => {
      setHoveredNode(prev => prev === null ? prev : null);
      setHoveredCountry(prev => prev === null ? prev : null);
      canvas.style.cursor = 'default';
    };
    canvas.addEventListener('mouseleave', handleMouseLeave);

    return () => {
      window.removeEventListener('resize', resize);
      observer.disconnect();
      if (animRef.current) cancelAnimationFrame(animRef.current);
      canvas.removeEventListener('mousemove', handleMouseMove);
      canvas.removeEventListener('mouseleave', handleMouseLeave);
    };
  }, [nodes, mapTab, geoData]);

  const seedNodes = nodes.filter(n => catOf(n) === 'seed');
  const openNodes = nodes.filter(n => catOf(n) === 'node');   // port open
  const peerNodes = nodes.filter(n => catOf(n) === 'peer');   // port closed
  const countries = new Set(nodes.map(n => n.country)).size;
  const avgCoverage = nodes.length > 0
    ? (nodes.reduce((acc, n) => acc + (n.coverage || 0), 0) / nodes.length).toFixed(1)
    : 0;

  return (
    <div className="network-fullpage">
      {/* Compact stats row */}
      <div className="net-stats-row">
        <div className="net-stat-mini">
          <span className="net-stat-mini-val">{nodes.length}</span>
          <span className="net-stat-mini-label">Online</span>
        </div>
        <div className="net-stat-mini" title="Approved seed nodes">
          <span className="net-stat-mini-val" style={{ color: NODE_COLORS.seed.cssVar }}>{seedNodes.length}</span>
          <span className="net-stat-mini-label">Seeds</span>
        </div>
        <div className="net-stat-mini" title="Port open — reachable from the internet">
          <span className="net-stat-mini-val" style={{ color: NODE_COLORS.node.cssVar }}>{openNodes.length}</span>
          <span className="net-stat-mini-label">Nodes</span>
        </div>
        <div className="net-stat-mini" title="Running but port closed">
          <span className="net-stat-mini-val" style={{ color: NODE_COLORS.peer.cssVar }}>{peerNodes.length}</span>
          <span className="net-stat-mini-label">Peers</span>
        </div>
        <div className="net-stat-mini">
          <span className="net-stat-mini-val gold">{countries}</span>
          <span className="net-stat-mini-label">Countries</span>
        </div>
        {!isLiveData && <span className="net-sample-badge">Your node</span>}
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
              <div style={{ fontWeight: 600, color: nodeColor(hoveredNode).hex }}>
                {fmtLoc(hoveredNode)}
                {hoveredNode.id === getNodeId() && <span style={{ fontSize: '0.68rem', opacity: 0.7, marginLeft: '6px' }}>(You)</span>}
              </div>
              <div style={{ color: '#9aa3ad', display: 'flex', alignItems: 'center', gap: '4px' }}>
                <span style={{ display: 'inline-flex', color: nodeColor(hoveredNode).hex }}>{catOf(hoveredNode) === 'seed' ? iconSeed : iconUser}</span>
                {catOf(hoveredNode) === 'seed' ? 'Seed Node' : catOf(hoveredNode) === 'node' ? 'Node · port open' : 'Peer · port closed'} · {hoveredNode.coverage}% coverage
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
              <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: NODE_COLORS.seed.hex, display: 'inline-block' }} />
              <span style={{ color: NODE_COLORS.seed.hex }}>Seed node</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: NODE_COLORS.node.hex, display: 'inline-block' }} />
              <span style={{ color: NODE_COLORS.node.hex }}>Node · port open</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: NODE_COLORS.peer.hex, display: 'inline-block' }} />
              <span style={{ color: NODE_COLORS.peer.hex }}>Peer · port closed</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '2px', borderTop: '1px solid rgba(255,255,255,0.15)', paddingTop: '4px' }}>
              <span style={{ width: '14px', height: '2px', background: 'rgba(212,175,55,0.3)', display: 'inline-block', borderRadius: '1px' }} />
              <span style={{ color: '#9aa3ad' }}>Connection</span>
            </div>
          </div>

          {/* Country-name hover tooltip. Always mounted so the mousemove handler
              can position it imperatively (following the cursor costs no
              re-render); only its visibility + text come from `hoveredCountry`.
              pointer-events:none so it can't steal the hover from the canvas. */}
          <div ref={countryTipRef} style={{
            position: 'absolute', left: 0, top: 0, pointerEvents: 'none', zIndex: 6,
            display: hoveredCountry ? 'block' : 'none',
            background: 'rgba(15,25,35,0.92)', border: '1px solid rgba(255,255,255,0.12)',
            borderRadius: '6px', padding: '4px 9px', fontSize: '0.72rem',
            color: '#e4e4da', backdropFilter: 'blur(8px)', whiteSpace: 'nowrap',
          }}>
            {hoveredCountry}
          </div>
        </div>

        {/* Countries view */}
        {mapTab === 'countries' && (
          <div className="net-scroll-content">
            <table className="net-country-table">
              <thead>
                <tr>
                  <th style={{ width: '38%' }}>Country</th>
                  <th>Total</th>
                  <th>Seeds</th>
                  <th>Nodes</th>
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
                    <td>{c.seeds > 0 ? <span style={{ color: NODE_COLORS.seed.cssVar }}>{c.seeds}</span> : <span style={{ color: 'var(--text-muted)' }}>-</span>}</td>
                    <td>{c.nodes > 0 ? <span style={{ color: NODE_COLORS.node.cssVar }}>{c.nodes}</span> : <span style={{ color: 'var(--text-muted)' }}>-</span>}</td>
                    <td>{c.peers > 0 ? <span style={{ color: NODE_COLORS.peer.cssVar }}>{c.peers}</span> : <span style={{ color: 'var(--text-muted)' }}>-</span>}</td>
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
                <span className="node-list-icon" style={{ display: 'flex', color: nodeColor(node).cssVar }}>{iconSeed}</span>
                <div className="node-list-info">
                  <div className="node-list-name" style={{ color: nodeColor(node).cssVar }}>{fmtLoc(node)}</div>
                  <div className="node-list-detail">Seed Node · {node.coverage}% coverage · Full library</div>
                </div>
                <span className="node-list-status online">Online</span>
              </div>
            ))}
            {openNodes.map(node => (
              <div key={node.id} className="node-list-item">
                <span className="node-list-icon" style={{ display: 'flex', color: nodeColor(node).cssVar }}>{iconUser}</span>
                <div className="node-list-info">
                  <div className="node-list-name" style={{ color: nodeColor(node).cssVar }}>
                    {fmtLoc(node)}
                    {node.id === getNodeId() && <span style={{ fontSize: '0.68rem', color: 'var(--green)', marginLeft: '6px' }}>(You)</span>}
                  </div>
                  <div className="node-list-detail">Node · port open · {node.coverage}% coverage</div>
                </div>
                <span className="node-list-status online">Online</span>
              </div>
            ))}
            {peerNodes.map(node => (
              <div key={node.id} className="node-list-item">
                <span className="node-list-icon" style={{ display: 'flex', color: nodeColor(node).cssVar }}>{iconUser}</span>
                <div className="node-list-info">
                  <div className="node-list-name" style={{ color: nodeColor(node).cssVar }}>
                    {fmtLoc(node)}
                    {node.id === getNodeId() && <span style={{ fontSize: '0.68rem', color: 'var(--green)', marginLeft: '6px' }}>(You)</span>}
                  </div>
                  <div className="node-list-detail">Peer · port closed · {node.coverage}% coverage</div>
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
