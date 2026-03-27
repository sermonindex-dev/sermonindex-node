/// SermonIndex Native IPFS Node
///
/// A real libp2p node running in Rust with EVERY connectivity layer available:
///
/// TRANSPORTS:
/// - TCP (primary — dialable by IPFS gateways)
/// - QUIC (modern, multiplexed, UDP-based)
/// - WebSocket (fallback — traverses HTTP proxies & corporate firewalls)
/// - IPv6 (dual-stack on all transports)
///
/// NAT TRAVERSAL (multi-layer, automatic):
/// - UPnP port mapping (automatic router traversal — like BitTorrent)
/// - AutoNAT (discovers if we're publicly reachable)
/// - Circuit Relay (auto-reserves relay address when behind NAT)
/// - DCUtR hole punching (upgrades relay to direct connection)
///
/// DISCOVERY:
/// - Kademlia DHT in SERVER mode (full network participant)
/// - mDNS (zero-config local network discovery — same LAN)
/// - Rendezvous (SermonIndex-specific peer registry)
/// - Identify protocol (peer info & address exchange)
///
/// FALLBACK:
/// - If all NAT traversal fails, content is still served via relay
/// - Centralized bridge endpoint as absolute last resort
///
/// This is what makes the network truly decentralized — each app instance
/// is a real, publicly-dialable node. Unlike browser IPFS nodes (Helia),
/// this node can be reached by ipfs.io and other TCP-based gateways.

use crate::bitswap::{
    self, BitswapBlock, BitswapCodec, BitswapResponse,
    BITSWAP_PROTOCOL_1_0, BITSWAP_PROTOCOL_1_1, BITSWAP_PROTOCOL_1_2,
};
use cid::Cid;
use futures::StreamExt;
use libp2p::{
    autonat, dcutr, identify, identity,
    kad::{self, store::MemoryStore, Mode as KadMode},
    mdns, noise, ping, relay, rendezvous, request_response,
    swarm::{NetworkBehaviour, StreamProtocol, SwarmEvent},
    tcp, upnp, yamux, Multiaddr, PeerId, SwarmBuilder,
};
use multihash::Multihash;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;
use tokio::sync::{mpsc, Mutex};

// ── Public bootstrap peers ──
// DNS-based addresses are PRIMARY — they resolve to current IPs via DNS TXT records.
// The swarm uses `.with_dns()` so /dnsaddr/ is resolved automatically.
const BOOTSTRAP_PEERS: &[&str] = &[
    // DNS-based (resolves to current IPs — preferred)
    "/dnsaddr/bootstrap.libp2p.io/p2p/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN",
    "/dnsaddr/bootstrap.libp2p.io/p2p/QmQCU2EcMqAqQPR2i9bChDtGNJchTbq5TbXJJ16u19uLTa",
    "/dnsaddr/bootstrap.libp2p.io/p2p/QmbLHAnMoJPWSCR5Zhtx6BHJX9KiKNN6tpvbUcqanj75Nb",
    "/dnsaddr/bootstrap.libp2p.io/p2p/QmcZf59bWwK5XFi76CZX8cbJ4BhTzzA3gU1ZjYZcYW3dwt",
    // Mars — long-lived static IP (DigitalOcean)
    "/ip4/104.131.131.82/tcp/4001/p2p/QmaCpDMGvV2BGHeYERUEnRQAwe3N8SzbUtfsmvsqQLuvuJ",
    "/ip4/104.131.131.82/udp/4001/quic-v1/p2p/QmaCpDMGvV2BGHeYERUEnRQAwe3N8SzbUtfsmvsqQLuvuJ",
    // DNS4 fallback for individual peers (resolved via A records)
    "/dns4/ny5.bootstrap.libp2p.io/tcp/4001/p2p/QmQCU2EcMqAqQPR2i9bChDtGNJchTbq5TbXJJ16u19uLTa",
    "/dns4/sg1.bootstrap.libp2p.io/tcp/4001/p2p/QmcZf59bWwK5XFi76CZX8cbJ4BhTzzA3gU1ZjYZcYW3dwt",
    "/dns4/sv15.bootstrap.libp2p.io/tcp/4001/p2p/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN",
];

// ── Relay-capable peers for automatic NAT traversal ──
// When UPnP fails and NAT is private, we listen through these relays
// so gateways can reach us via /p2p-circuit addresses.
const RELAY_PEERS: &[&str] = &[
    "/dnsaddr/bootstrap.libp2p.io/p2p/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN",
    "/dnsaddr/bootstrap.libp2p.io/p2p/QmQCU2EcMqAqQPR2i9bChDtGNJchTbq5TbXJJ16u19uLTa",
    "/dnsaddr/bootstrap.libp2p.io/p2p/QmbLHAnMoJPWSCR5Zhtx6BHJX9KiKNN6tpvbUcqanj75Nb",
    "/dnsaddr/bootstrap.libp2p.io/p2p/QmcZf59bWwK5XFi76CZX8cbJ4BhTzzA3gU1ZjYZcYW3dwt",
    "/ip4/104.131.131.82/tcp/4001/p2p/QmaCpDMGvV2BGHeYERUEnRQAwe3N8SzbUtfsmvsqQLuvuJ",
];

// ── SermonIndex rendezvous namespace ──
const RENDEZVOUS_NAMESPACE: &str = "sermonindex/nodes/v1";

/// Commands sent from Tauri frontend to the IPFS node
#[derive(Debug)]
pub enum IpfsCommand {
    /// Add content and pin it. Returns CID string.
    AddFile {
        data: Vec<u8>,
        sermon_id: Option<String>,
        respond: tokio::sync::oneshot::Sender<Result<String, String>>,
    },
    /// Get content by CID
    GetFile {
        cid_str: String,
        respond: tokio::sync::oneshot::Sender<Result<Vec<u8>, String>>,
    },
    /// Provide/announce a CID on the DHT
    Provide {
        cid_str: String,
        respond: tokio::sync::oneshot::Sender<Result<(), String>>,
    },
    /// Get node diagnostics
    GetDiagnostics {
        respond: tokio::sync::oneshot::Sender<NodeDiagnostics>,
    },
    /// List all pinned CIDs
    ListPinned {
        respond: tokio::sync::oneshot::Sender<Vec<String>>,
    },
    /// Remove a pinned CID
    RemovePin {
        cid_str: String,
        respond: tokio::sync::oneshot::Sender<Result<(), String>>,
    },
    /// Stop the node
    Stop {
        respond: tokio::sync::oneshot::Sender<()>,
    },
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct NodeDiagnostics {
    pub running: bool,
    pub peer_id: String,
    pub peer_count: usize,
    pub listen_addresses: Vec<String>,
    pub external_addresses: Vec<String>,
    pub nat_status: String,
    pub upnp_status: String,
    pub natpmp_status: String,
    pub relay_status: String,
    pub mdns_peers: usize,
    pub rendezvous_status: String,
    pub dht_mode: String,
    pub pinned_count: usize,
    pub uptime_secs: u64,
    pub connections: Vec<ConnectionInfo>,
    pub protocol: String,
    pub recent_events: Vec<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ConnectionInfo {
    pub peer_id: String,
    pub address: String,
    pub direction: String,
}

/// Combined libp2p behaviour — ALL protocols for maximum connectivity
#[derive(NetworkBehaviour)]
struct SiBehaviour {
    /// Kademlia DHT — content routing and peer discovery
    kademlia: kad::Behaviour<MemoryStore>,
    /// Identify — exchange peer info and discover addresses
    identify: identify::Behaviour,
    /// Ping — keepalive and latency measurement
    ping: ping::Behaviour,
    /// Relay client — connect through relay when direct fails
    relay_client: relay::client::Behaviour,
    /// DCUtR — direct connection upgrade through relay (hole punching)
    dcutr: dcutr::Behaviour,
    /// AutoNAT — detect if we're publicly reachable
    autonat: autonat::Behaviour,
    /// UPnP — automatic port forwarding on router
    upnp: upnp::tokio::Behaviour,
    /// mDNS — zero-config LAN discovery (same network = instant)
    mdns: mdns::tokio::Behaviour,
    /// Rendezvous client — SermonIndex-specific peer registry
    rendezvous: rendezvous::client::Behaviour,
    /// Bitswap — block exchange protocol (responds to WANT requests from gateways)
    bitswap: request_response::Behaviour<BitswapCodec>,
}

/// The IPFS node handle — send commands to control the node
#[derive(Clone)]
pub struct IpfsHandle {
    cmd_tx: mpsc::Sender<IpfsCommand>,
}

impl IpfsHandle {
    pub async fn add_file(&self, data: Vec<u8>, sermon_id: Option<String>) -> Result<String, String> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.cmd_tx.send(IpfsCommand::AddFile { data, sermon_id, respond: tx })
            .await.map_err(|_| "Node stopped".to_string())?;
        rx.await.map_err(|_| "Node stopped".to_string())?
    }

    pub async fn get_file(&self, cid_str: String) -> Result<Vec<u8>, String> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.cmd_tx.send(IpfsCommand::GetFile { cid_str, respond: tx })
            .await.map_err(|_| "Node stopped".to_string())?;
        rx.await.map_err(|_| "Node stopped".to_string())?
    }

    pub async fn provide(&self, cid_str: String) -> Result<(), String> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.cmd_tx.send(IpfsCommand::Provide { cid_str, respond: tx })
            .await.map_err(|_| "Node stopped".to_string())?;
        rx.await.map_err(|_| "Node stopped".to_string())?
    }

    pub async fn diagnostics(&self) -> NodeDiagnostics {
        let (tx, rx) = tokio::sync::oneshot::channel();
        let _ = self.cmd_tx.send(IpfsCommand::GetDiagnostics { respond: tx }).await;
        rx.await.unwrap_or(NodeDiagnostics {
            running: false,
            peer_id: String::new(),
            peer_count: 0,
            listen_addresses: vec![],
            external_addresses: vec![],
            nat_status: "unknown".into(),
            upnp_status: "unknown".into(),
            natpmp_status: "inactive".into(),
            relay_status: "inactive".into(),
            mdns_peers: 0,
            rendezvous_status: "inactive".into(),
            dht_mode: "unknown".into(),
            pinned_count: 0,
            uptime_secs: 0,
            connections: vec![],
            protocol: "native-libp2p".into(),
            recent_events: vec![],
        })
    }

    pub async fn list_pinned(&self) -> Vec<String> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        let _ = self.cmd_tx.send(IpfsCommand::ListPinned { respond: tx }).await;
        rx.await.unwrap_or_default()
    }

    pub async fn remove_pin(&self, cid_str: String) -> Result<(), String> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.cmd_tx.send(IpfsCommand::RemovePin { cid_str, respond: tx })
            .await.map_err(|_| "Node stopped".to_string())?;
        rx.await.map_err(|_| "Node stopped".to_string())?
    }

    pub async fn stop(&self) {
        let (tx, rx) = tokio::sync::oneshot::channel();
        let _ = self.cmd_tx.send(IpfsCommand::Stop { respond: tx }).await;
        let _ = rx.await;
    }
}

/// Content-addressed block store — maps CID → data
struct BlockStore {
    /// CID string → raw bytes
    blocks: HashMap<String, Vec<u8>>,
    /// sermon_id → CID string (for catalog tracking)
    catalog: HashMap<String, String>,
    /// Persistence directory
    storage_dir: PathBuf,
}

impl BlockStore {
    fn new(storage_dir: PathBuf) -> Self {
        let _ = std::fs::create_dir_all(&storage_dir);
        let mut store = Self {
            blocks: HashMap::new(),
            catalog: HashMap::new(),
            storage_dir,
        };
        store.load_from_disk();
        store
    }

    /// Hash bytes and store as a CIDv1 (SHA-256, raw codec)
    fn add(&mut self, data: &[u8]) -> String {
        let hash = Sha256::digest(data);
        // CIDv1 with raw codec (0x55) and SHA-256 (0x12)
        let mh = Multihash::<64>::wrap(0x12, &hash).expect("valid multihash");
        let cid = Cid::new_v1(0x55, mh);
        let cid_str = cid.to_string();

        self.blocks.insert(cid_str.clone(), data.to_vec());
        self.save_block_to_disk(&cid_str, data);
        cid_str
    }

    fn get(&self, cid_str: &str) -> Option<&Vec<u8>> {
        self.blocks.get(cid_str)
    }

    fn remove(&mut self, cid_str: &str) -> bool {
        let removed = self.blocks.remove(cid_str).is_some();
        if removed {
            let path = self.storage_dir.join(self.safe_filename(cid_str));
            let _ = std::fs::remove_file(path);
        }
        // Also remove from catalog if present
        self.catalog.retain(|_, v| v != cid_str);
        removed
    }

    fn pinned_cids(&self) -> Vec<String> {
        self.blocks.keys().cloned().collect()
    }

    fn save_block_to_disk(&self, cid_str: &str, data: &[u8]) {
        let path = self.storage_dir.join(self.safe_filename(cid_str));
        let _ = std::fs::write(path, data);
    }

    fn safe_filename(&self, cid_str: &str) -> String {
        format!("{}.block", cid_str.replace('/', "_"))
    }

    fn load_from_disk(&mut self) {
        let dir = &self.storage_dir;
        if !dir.exists() { return; }

        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().and_then(|e| e.to_str()) == Some("block") {
                    if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                        let cid_str = stem.replace('_', "/");
                        if let Ok(data) = std::fs::read(&path) {
                            self.blocks.insert(cid_str, data);
                        }
                    }
                }
            }
        }
        log::info!("[IPFS-Rust] Loaded {} blocks from disk", self.blocks.len());

        // Load catalog
        let catalog_path = dir.join("catalog.json");
        if catalog_path.exists() {
            if let Ok(data) = std::fs::read_to_string(&catalog_path) {
                if let Ok(cat) = serde_json::from_str::<HashMap<String, String>>(&data) {
                    self.catalog = cat;
                }
            }
        }
    }

    fn save_catalog_to_disk(&self) {
        let path = self.storage_dir.join("catalog.json");
        if let Ok(data) = serde_json::to_string(&self.catalog) {
            let _ = std::fs::write(path, data);
        }
    }
}

/// Start the native IPFS node. Returns a handle to control it.
/// `announce_address` — optional external address override (e.g. "/ip4/203.0.113.5/tcp/4001")
/// for users who have manually port-forwarded their router.
pub async fn start_node(storage_path: PathBuf, announce_address: Option<String>) -> Result<IpfsHandle, String> {
    let (cmd_tx, cmd_rx) = mpsc::channel::<IpfsCommand>(64);

    // Load or generate persistent identity
    let keypair = load_or_create_keypair(&storage_path)?;
    let local_peer_id = PeerId::from(keypair.public());
    log::info!("[IPFS-Rust] Local Peer ID: {}", local_peer_id);

    // Build the swarm with ALL transports and protocols
    let mut swarm = SwarmBuilder::with_existing_identity(keypair.clone())
        .with_tokio()
        .with_tcp(
            tcp::Config::default().nodelay(true),
            noise::Config::new,
            yamux::Config::default,
        )
        .map_err(|e| format!("TCP transport failed: {e}"))?
        .with_quic()
        .with_dns()
        .map_err(|e| format!("DNS failed: {e}"))?
        .with_websocket(noise::Config::new, yamux::Config::default)
        .await
        .map_err(|e| format!("WebSocket transport failed: {e}"))?
        .with_relay_client(noise::Config::new, yamux::Config::default)
        .map_err(|e| format!("Relay client failed: {e}"))?
        .with_behaviour(|keypair, relay_behaviour| {
            // Kademlia DHT — use the IPFS protocol name for interop
            let mut kad_config = kad::Config::new(
                libp2p::StreamProtocol::try_from_owned("/ipfs/kad/1.0.0".to_string())
                    .expect("valid protocol"),
            );
            kad_config.set_record_ttl(Some(std::time::Duration::from_secs(36 * 3600)));
            kad_config.set_provider_record_ttl(Some(std::time::Duration::from_secs(24 * 3600)));
            kad_config.set_replication_factor(std::num::NonZeroUsize::new(20).unwrap());
            // Limit parallel Kademlia queries to reduce dial pressure
            kad_config.set_parallelism(std::num::NonZeroUsize::new(3).unwrap());

            let store = MemoryStore::new(keypair.public().to_peer_id());
            let mut kademlia = kad::Behaviour::with_config(
                keypair.public().to_peer_id(),
                store,
                kad_config,
            );

            // Set DHT to SERVER mode — we're a full participant
            kademlia.set_mode(Some(KadMode::Server));

            // Add bootstrap peers to Kademlia routing table
            for addr_str in BOOTSTRAP_PEERS {
                if let Ok(addr) = addr_str.parse::<Multiaddr>() {
                    if let Some(libp2p::core::multiaddr::Protocol::P2p(peer_id)) = addr.iter().last() {
                        kademlia.add_address(&peer_id, addr.clone());
                    }
                }
            }

            // mDNS — zero-config LAN discovery
            let mdns = mdns::tokio::Behaviour::new(
                mdns::Config::default(),
                keypair.public().to_peer_id(),
            ).expect("mDNS behaviour");

            // Bitswap protocol — respond to block requests from gateways/peers
            let bitswap_protocols = vec![
                (StreamProtocol::try_from_owned(BITSWAP_PROTOCOL_1_2.to_string()).unwrap(), request_response::ProtocolSupport::Full),
                (StreamProtocol::try_from_owned(BITSWAP_PROTOCOL_1_1.to_string()).unwrap(), request_response::ProtocolSupport::Full),
                (StreamProtocol::try_from_owned(BITSWAP_PROTOCOL_1_0.to_string()).unwrap(), request_response::ProtocolSupport::Full),
            ];
            let bitswap_config = request_response::Config::default()
                .with_request_timeout(std::time::Duration::from_secs(30));
            let bitswap_behaviour = request_response::Behaviour::with_codec(
                BitswapCodec,
                bitswap_protocols,
                bitswap_config,
            );

            SiBehaviour {
                kademlia,
                identify: identify::Behaviour::new(identify::Config::new(
                    "/sermonindex/1.0.0".to_string(),
                    keypair.public(),
                )),
                ping: ping::Behaviour::new(ping::Config::new()),
                relay_client: relay_behaviour,
                dcutr: dcutr::Behaviour::new(keypair.public().to_peer_id()),
                autonat: autonat::Behaviour::new(
                    keypair.public().to_peer_id(),
                    autonat::Config {
                        boot_delay: std::time::Duration::from_secs(10),
                        refresh_interval: std::time::Duration::from_secs(60),
                        ..Default::default()
                    },
                ),
                upnp: upnp::tokio::Behaviour::default(),
                mdns,
                rendezvous: rendezvous::client::Behaviour::new(keypair.clone()),
                bitswap: bitswap_behaviour,
            }
        })
        .map_err(|e| format!("Behaviour failed: {e}"))?
        .with_swarm_config(|cfg| {
            cfg.with_idle_connection_timeout(std::time::Duration::from_secs(60))
               .with_dial_concurrency_factor(std::num::NonZeroU8::new(4).unwrap())
        })
        .build();

    // ── Listen on ALL transports ──
    // Use FIXED port 4001 (standard IPFS) so UPnP mappings persist across restarts
    // and users can manually port-forward if needed (like BitTorrent).
    // Falls back to random port if 4001 is already in use.

    let tcp_port = 4001u16;
    let udp_port = 4001u16;
    let ws_port = 4002u16;

    // Check if port 4001 is available before trying to bind
    let tcp_port_available = std::net::TcpListener::bind(("0.0.0.0", tcp_port)).is_ok();
    let udp_port_available = std::net::UdpSocket::bind(("0.0.0.0", udp_port)).is_ok();

    // TCP
    if tcp_port_available {
        swarm.listen_on(format!("/ip4/0.0.0.0/tcp/{tcp_port}").parse().unwrap())
            .map_err(|e| format!("TCP listen failed: {e}"))?;
        log::info!("[IPFS-Rust] TCP listening on fixed port {tcp_port}");
    } else {
        log::warn!("[IPFS] Port {tcp_port}/tcp in use — using random port (UPnP/NAT-PMP may not work)");
        swarm.listen_on("/ip4/0.0.0.0/tcp/0".parse().unwrap())
            .map_err(|e| format!("TCP listen failed: {e}"))?;
    }

    // QUIC
    if udp_port_available {
        swarm.listen_on(format!("/ip4/0.0.0.0/udp/{udp_port}/quic-v1").parse().unwrap())
            .map_err(|e| format!("QUIC listen failed: {e}"))?;
        log::info!("[IPFS-Rust] QUIC listening on fixed port {udp_port}");
    } else {
        log::warn!("[IPFS] Port {udp_port}/udp in use — using random port");
        let _ = swarm.listen_on("/ip4/0.0.0.0/udp/0/quic-v1".parse().unwrap());
    }

    // WebSocket (different port to avoid conflict)
    match swarm.listen_on(format!("/ip4/0.0.0.0/tcp/{ws_port}/ws").parse().unwrap()) {
        Ok(_) => log::info!("[IPFS-Rust] WebSocket listening on port {ws_port}"),
        Err(e) => log::warn!("[IPFS-Rust] WebSocket listen failed (non-fatal): {e}"),
    }

    // IPv6 dual-stack (best-effort, same fixed ports)
    let _ = swarm.listen_on(format!("/ip6/::/tcp/{tcp_port}").parse().unwrap());
    let _ = swarm.listen_on(format!("/ip6/::/udp/{udp_port}/quic-v1").parse().unwrap());
    let _ = swarm.listen_on(format!("/ip6/::/tcp/{ws_port}/ws").parse().unwrap());

    // ── Early NAT-PMP / PCP mapping ──
    // MUST happen BEFORE dialing bootstrap peers so the router's NAT table
    // has the correct port mapping in place. Otherwise outbound UDP from port 4001
    // gets randomly translated (e.g., to 40050) and peers cache that unreachable address.
    log::info!("[IPFS-Rust] Attempting early NAT-PMP/PCP mapping before bootstrap...");
    let early_natpmp_result = crate::natpmp::try_mapping(tcp_port, udp_port).await;
    if let Some(ref result) = early_natpmp_result {
        log::info!("[NAT-PMP] ✓ Early TCP mapped: local:{} → external:{} via {}",
            tcp_port, result.tcp_external_port, result.gateway);
        if let Some(udp_ext) = result.udp_external_port {
            log::info!("[NAT-PMP] ✓ Early UDP mapped: local:{} → external:{} via {}",
                udp_port, udp_ext, result.gateway);
        }
    } else {
        log::info!("[NAT-PMP] Early mapping not available — will retry in event loop");
    }

    // Explicitly DIAL bootstrap peers
    let mut dialed = 0;
    let mut parse_failed = 0;
    for addr_str in BOOTSTRAP_PEERS {
        match addr_str.parse::<Multiaddr>() {
            Ok(addr) => {
                match swarm.dial(addr.clone()) {
                    Ok(_) => {
                        dialed += 1;
                        log::info!("[IPFS-Rust] Dialing bootstrap: {}", addr_str);
                    }
                    Err(e) => {
                        log::warn!("[IPFS-Rust] Failed to dial {}: {}", addr_str, e);
                    }
                }
            }
            Err(e) => {
                parse_failed += 1;
                log::warn!("[IPFS-Rust] Failed to PARSE multiaddr '{}': {}", addr_str, e);
            }
        }
    }
    log::info!(
        "[IPFS-Rust] Dialing {} bootstrap peers ({} parse failures)",
        dialed, parse_failed
    );

    // ── Manual external address override ──
    // If the user has port-forwarded their router and provided their public IP,
    // tell libp2p about it so DHT provider records include this reachable address.
    if let Some(ref announce_addr) = announce_address {
        if !announce_addr.is_empty() {
            match announce_addr.parse::<Multiaddr>() {
                Ok(addr) => {
                    // Add our peer ID to the address
                    let full_addr: Multiaddr = format!("{}/p2p/{}", addr, local_peer_id)
                        .parse()
                        .unwrap_or(addr.clone());
                    swarm.add_external_address(addr.clone());
                    log::info!("[IPFS] Manual external address set: {}", full_addr);
                }
                Err(e) => {
                    log::warn!("[IPFS] Invalid announce address '{}': {}", announce_addr, e);
                }
            }
        }
    }

    // Bootstrap the DHT
    match swarm.behaviour_mut().kademlia.bootstrap() {
        Ok(_) => log::info!("[IPFS-Rust] DHT bootstrap initiated"),
        Err(e) => log::warn!("[IPFS-Rust] DHT bootstrap queued (will retry): {e}"),
    }

    let block_store = Arc::new(Mutex::new(BlockStore::new(
        storage_path.join("blocks"),
    )));

    // Spawn the event loop
    let handle = IpfsHandle { cmd_tx };
    tokio::spawn(run_event_loop(swarm, cmd_rx, block_store, local_peer_id, early_natpmp_result));

    Ok(handle)
}

/// The main event loop — processes swarm events and commands
async fn run_event_loop(
    mut swarm: libp2p::Swarm<SiBehaviour>,
    mut cmd_rx: mpsc::Receiver<IpfsCommand>,
    block_store: Arc<Mutex<BlockStore>>,
    local_peer_id: PeerId,
    early_natpmp: Option<crate::natpmp::MappingResult>,
) {
    let start_time = Instant::now();
    let mut nat_status = "unknown".to_string();
    let mut upnp_status = "unknown".to_string();
    let mut relay_status = "inactive".to_string();
    let mut relay_addrs: Vec<String> = Vec::new();
    let mut mdns_discovered: usize = 0;
    let mut rendezvous_status = "inactive".to_string();
    let mut rendezvous_peer: Option<PeerId> = None;
    // Initialize NAT-PMP state from early mapping (done before bootstrap)
    let mut natpmp_mapped = early_natpmp.is_some();
    let mut natpmp_tried = early_natpmp.is_some();
    let mut natpmp_tcp_ext: Option<u16> = early_natpmp.as_ref().map(|r| r.tcp_external_port);
    let mut natpmp_udp_ext: Option<u16> = early_natpmp.as_ref().and_then(|r| r.udp_external_port);
    let mut reprovide_pending = false; // Batch re-provides instead of per-address
    let mut relay_reprovide_done = false; // One-shot: true after we've re-provided with relay addrs
    let mut first_relay_at: Option<std::time::Instant> = None; // When first relay address was added
    let mut observed_public_ip: Option<String> = None; // Learned from IDENTIFY observed_addr
    // Track actual listening ports (may differ from requested 4001 if port was in use)
    let mut actual_tcp_port: Option<u16> = None;
    let mut actual_quic_port: Option<u16> = None;

    if natpmp_mapped {
        log::info!("[NAT-PMP] Starting with early mapping: TCP ext:{}, UDP ext:{:?}",
            natpmp_tcp_ext.unwrap_or(0), natpmp_udp_ext);
    }

    // Event log ring buffer — capped at 200 entries for memory safety
    let mut event_log: Vec<String> = Vec::new();
    let max_events = 200;

    // Persistent log file — writes to project source dir for easy access
    let project_log_path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(|p| p.join("ipfs_debug.log"))
        .unwrap_or_else(|| std::path::PathBuf::from("ipfs_debug.log"));
    // Truncate on startup so each run is a fresh log
    let log_file = std::sync::Arc::new(std::sync::Mutex::new(
        std::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&project_log_path)
            .ok()
    ));
    log::info!("[LOG] Debug log: {}", project_log_path.display());

    // Track process start for elapsed timestamps in log file
    let log_start = std::time::Instant::now();

    // Helper: push to event log + write to log file
    macro_rules! elog {
        ($($arg:tt)*) => {{
            let msg = format!($($arg)*);
            log::info!("{}", msg);
            // Write timestamped line to log file
            let elapsed = log_start.elapsed().as_secs_f64();
            let line = format!("[{:>8.3}s] {}\n", elapsed, msg);
            if let Ok(mut guard) = log_file.lock() {
                if let Some(ref mut f) = *guard {
                    use std::io::Write;
                    let _ = f.write_all(line.as_bytes());
                    let _ = f.flush();
                }
            }
            event_log.push(msg);
            if event_log.len() > max_events {
                event_log.remove(0);
            }
        }};
    }

    if natpmp_mapped {
        elog!("[NAT-PMP] Early mapping active: TCP ext:{}, UDP ext:{:?}",
            natpmp_tcp_ext.unwrap_or(0), natpmp_udp_ext);
    }

    // Timers
    let mut bootstrap_interval = tokio::time::interval(std::time::Duration::from_secs(300));
    let mut reprovide_interval = tokio::time::interval(std::time::Duration::from_secs(4 * 3600));
    // Relay check: 30s after start, then every 2 minutes
    let mut relay_check_interval = tokio::time::interval(std::time::Duration::from_secs(30));
    // NAT-PMP/PCP: skip the early check if already mapped, otherwise try at 15s
    let mut natpmp_check_interval = tokio::time::interval(std::time::Duration::from_secs(
        if natpmp_mapped { 3600 } else { 15 }
    ));
    // Rendezvous registration: 60s after start, then every 90s
    let mut rendezvous_interval = tokio::time::interval(std::time::Duration::from_secs(60));
    // Batched re-provide: check every 10s, only runs if reprovide_pending is true
    let mut reprovide_batch_interval = tokio::time::interval(std::time::Duration::from_secs(10));

    log::info!("[IPFS-Rust] Event loop started — all layers active");

    loop {
        tokio::select! {
            // Process swarm events
            event = swarm.select_next_some() => {
                match event {
                    SwarmEvent::NewListenAddr { address, .. } => {
                        let addr_str = address.to_string();
                        let is_relay = addr_str.contains("p2p-circuit");
                        let is_ws = addr_str.contains("/ws");
                        if is_relay {
                            relay_status = "reserved".to_string();
                            relay_addrs.push(addr_str);
                            // Add relay address as external so Kademlia advertises it
                            swarm.add_external_address(address.clone());
                            elog!("[RELAY] Listening via relay: {address}");
                            // Track when first relay address was added (for inline re-provide)
                            if first_relay_at.is_none() {
                                first_relay_at = Some(std::time::Instant::now());
                                elog!("[DHT] First relay address detected — will re-provide after 15s");
                            }
                            reprovide_pending = true;
                        } else if is_ws {
                            elog!("[WS] WebSocket listening on {address}");
                        } else {
                            // Track actual ports from non-relay, non-ws listen addresses
                            // Only track IPv4 0.0.0.0 addresses (our real listeners)
                            if addr_str.starts_with("/ip4/0.0.0.0/") || addr_str.starts_with("/ip4/127.") || addr_str.starts_with("/ip4/192.168.") || addr_str.starts_with("/ip4/10.") || addr_str.starts_with("/ip4/172.") {
                                if addr_str.contains("/quic-v1") {
                                    // Extract UDP port from QUIC address: /ip4/0.0.0.0/udp/{port}/quic-v1
                                    for proto in address.iter() {
                                        if let libp2p::core::multiaddr::Protocol::Udp(p) = proto {
                                            if actual_quic_port.is_none() {
                                                actual_quic_port = Some(p);
                                                elog!("[IPFS] QUIC actual port: {}", p);
                                            }
                                            break;
                                        }
                                    }
                                } else if addr_str.contains("/tcp/") {
                                    // Extract TCP port: /ip4/0.0.0.0/tcp/{port}
                                    for proto in address.iter() {
                                        if let libp2p::core::multiaddr::Protocol::Tcp(p) = proto {
                                            if actual_tcp_port.is_none() {
                                                actual_tcp_port = Some(p);
                                                elog!("[IPFS] TCP actual port: {}", p);
                                            }
                                            break;
                                        }
                                    }
                                }
                            }
                            elog!("[IPFS] Listening on {address}");
                        }
                    }
                    SwarmEvent::ExternalAddrConfirmed { address } => {
                        elog!("[IPFS] External address confirmed: {address}");
                        // Flag for batched re-provide
                        reprovide_pending = true;
                    }
                    SwarmEvent::ConnectionEstablished { peer_id, endpoint, num_established, .. } => {
                        let total_peers = swarm.connected_peers().count();
                        let direction = if endpoint.is_dialer() { "outbound" } else { "INBOUND" };

                        // ── Connection cap: disconnect excess peers to avoid fd exhaustion ──
                        const MAX_PEERS: usize = 50;
                        if total_peers > MAX_PEERS {
                            // Silently drop excess — no log spam
                            let _ = swarm.disconnect_peer_id(peer_id);
                        } else {
                            // Only log when peer actually stays connected
                            elog!("[IPFS] {} {} → {} (total: {})",
                                direction, &peer_id.to_string()[..16], endpoint.get_remote_address(), total_peers);
                        }
                        let _ = num_established; // suppress unused warning

                        // If this peer could be a rendezvous point, try registering
                        // We use bootstrap peers as potential rendezvous servers
                        if rendezvous_peer.is_none() {
                            // Try the first bootstrap peer we connect to as rendezvous
                            for addr_str in BOOTSTRAP_PEERS {
                                if let Ok(addr) = addr_str.parse::<Multiaddr>() {
                                    if let Some(libp2p::core::multiaddr::Protocol::P2p(bootstrap_peer)) = addr.iter().last() {
                                        if bootstrap_peer == peer_id {
                                            rendezvous_peer = Some(peer_id);
                                            // Register with rendezvous
                                            if let Err(e) = swarm.behaviour_mut().rendezvous.register(
                                                rendezvous::Namespace::from_static(RENDEZVOUS_NAMESPACE),
                                                peer_id,
                                                None, // default TTL
                                            ) {
                                                elog!("[RENDEZVOUS] Registration failed: {e:?}");
                                            } else {
                                                rendezvous_status = "registering".to_string();
                                                elog!("[RENDEZVOUS] Registering with {}", &peer_id.to_string()[..16]);
                                            }
                                            break;
                                        }
                                    }
                                }
                            }
                        }
                    }
                    SwarmEvent::ConnectionClosed { peer_id, cause, .. } => {
                        // Only log meaningful disconnects (not cap-enforced drops)
                        if cause.is_some() {
                            log::debug!("[IPFS-Rust] Disconnected from {}: {:?}", &peer_id.to_string()[..16], cause);
                        }
                        // If our rendezvous peer disconnected, clear it so we retry
                        if rendezvous_peer == Some(peer_id) {
                            rendezvous_peer = None;
                            rendezvous_status = "disconnected".to_string();
                        }
                        // If a relay peer disconnected, reset relay so we re-establish
                        let peer_str = peer_id.to_string();
                        let was_relay = RELAY_PEERS.iter().any(|rp| rp.contains(&peer_str[..peer_str.len().min(16)]));
                        if was_relay && relay_status == "reserved" {
                            elog!("[RELAY] Relay peer {} disconnected — will re-establish", &peer_str[..16]);
                            relay_status = "inactive".to_string();
                            relay_addrs.clear();
                            // Speed up re-check
                            relay_check_interval = tokio::time::interval(std::time::Duration::from_secs(15));
                        }
                    }
                    SwarmEvent::OutgoingConnectionError { peer_id, error, .. } => {
                        // Only log to debug — dial failures are normal and extremely verbose
                        log::debug!("[IPFS-Rust] Dial failed {:?}: {error}", peer_id.map(|p| p.to_string().chars().take(16).collect::<String>()));
                    }
                    SwarmEvent::IncomingConnectionError { error, .. } => {
                        log::debug!("[IPFS-Rust] Incoming connection error: {error}");
                    }

                    // ── Kademlia DHT events ──
                    SwarmEvent::Behaviour(SiBehaviourEvent::Kademlia(kad_event)) => {
                        match kad_event {
                            kad::Event::RoutingUpdated { peer, .. } => {
                                log::debug!("[IPFS-Rust] DHT routing updated: {peer}");
                            }
                            kad::Event::OutboundQueryProgressed { result, .. } => {
                                match result {
                                    kad::QueryResult::Bootstrap(Ok(ok)) => {
                                        elog!("[DHT] Bootstrap step OK ({} remaining)", ok.num_remaining);
                                    }
                                    kad::QueryResult::Bootstrap(Err(e)) => {
                                        elog!("[DHT] Bootstrap FAILED: {:?}", e);
                                    }
                                    kad::QueryResult::StartProviding(Ok(kad::AddProviderOk { key })) => {
                                        elog!("[DHT] ✓ Now providing key: {:?}", key);
                                    }
                                    kad::QueryResult::StartProviding(Err(e)) => {
                                        elog!("[DHT] ✗ Provide FAILED: {:?}", e);
                                    }
                                    kad::QueryResult::GetProviders(Ok(result)) => {
                                        match result {
                                            kad::GetProvidersOk::FoundProviders { key, providers } => {
                                                elog!("[DHT] Found {} providers for {:?}", providers.len(), key);
                                            }
                                            kad::GetProvidersOk::FinishedWithNoAdditionalRecord { .. } => {}
                                        }
                                    }
                                    _ => {}
                                }
                            }
                            _ => {}
                        }
                    }

                    // ── Identify events ──
                    SwarmEvent::Behaviour(SiBehaviourEvent::Identify(identify::Event::Received {
                        peer_id, info, ..
                    })) => {
                        // Only add addresses when under capacity — prevents runaway DHT walks
                        let peer_count = swarm.connected_peers().count();
                        if peer_count < 45 {
                            for addr in &info.listen_addrs {
                                swarm.behaviour_mut().kademlia.add_address(&peer_id, addr.clone());
                            }
                        }

                        // ── STUN-like: use observed_addr to discover our external address ──
                        // The remote peer tells us what IP:port they see us at.
                        // This is how we learn our public address even behind NAT.
                        let obs = info.observed_addr.to_string();
                        if !obs.contains("127.0.0.1") && !obs.contains("/p2p-circuit") {
                            // Extract public IP from observed address (e.g. "/ip4/162.156.15.129/tcp/46139")
                            if observed_public_ip.is_none() {
                                for proto in info.observed_addr.iter() {
                                    if let libp2p::core::multiaddr::Protocol::Ip4(ip) = proto {
                                        if !ip.is_loopback() && !ip.is_private() && !ip.is_link_local() {
                                            observed_public_ip = Some(ip.to_string());
                                            elog!("[IDENTIFY] Discovered public IP: {}", ip);

                                            // If NAT-PMP was already mapped (early mapping),
                                            // immediately register external addresses now that we know our public IP
                                            if natpmp_mapped {
                                                if let Some(tcp_ext) = natpmp_tcp_ext {
                                                    let tcp_addr: Multiaddr = format!("/ip4/{}/tcp/{}", ip, tcp_ext)
                                                        .parse().unwrap();
                                                    swarm.add_external_address(tcp_addr.clone());
                                                    elog!("[NAT-PMP] Added external TCP: {}", tcp_addr);
                                                }
                                                if let Some(udp_ext) = natpmp_udp_ext {
                                                    let quic_addr: Multiaddr = format!("/ip4/{}/udp/{}/quic-v1", ip, udp_ext)
                                                        .parse().unwrap();
                                                    swarm.add_external_address(quic_addr.clone());
                                                    elog!("[NAT-PMP] Added external QUIC: {}", quic_addr);
                                                }
                                                reprovide_pending = true;
                                            }
                                            break;
                                        }
                                    }
                                }
                            }
                            let already_known = swarm.external_addresses()
                                .any(|a| a.to_string() == obs);
                            if !already_known {
                                elog!("[IDENTIFY] Peer {} sees us at: {}", &peer_id.to_string()[..16], info.observed_addr);
                            }
                        }
                    }

                    // ── AutoNAT events ──
                    SwarmEvent::Behaviour(SiBehaviourEvent::Autonat(autonat::Event::StatusChanged { old, new })) => {
                        nat_status = format!("{:?}", new);
                        elog!("[NAT] Status changed: {:?} → {:?}", old, new);
                    }

                    // ── UPnP events ──
                    SwarmEvent::Behaviour(SiBehaviourEvent::Upnp(upnp::Event::NewExternalAddr(addr))) => {
                        upnp_status = "mapped".to_string();
                        elog!("[UPnP] Port mapped: {addr}");
                    }
                    SwarmEvent::Behaviour(SiBehaviourEvent::Upnp(upnp::Event::GatewayNotFound)) => {
                        upnp_status = "no_gateway".to_string();
                        elog!("[UPnP] No gateway found — will try relay fallback");
                    }
                    SwarmEvent::Behaviour(SiBehaviourEvent::Upnp(upnp::Event::NonRoutableGateway)) => {
                        upnp_status = "non_routable".to_string();
                        elog!("[UPnP] Gateway is non-routable — will try relay fallback");
                    }

                    // ── DCUtR (hole punching) events ──
                    SwarmEvent::Behaviour(SiBehaviourEvent::Dcutr(event)) => {
                        elog!("[HOLEPUNCH] DCUtR event: {:?}", event);
                    }

                    // ── Relay client events ──
                    SwarmEvent::Behaviour(SiBehaviourEvent::RelayClient(event)) => {
                        elog!("[RELAY] Event: {:?}", event);
                    }

                    // ── mDNS events (LAN discovery) ──
                    SwarmEvent::Behaviour(SiBehaviourEvent::Mdns(event)) => {
                        match event {
                            mdns::Event::Discovered(peers) => {
                                for (peer_id, addr) in peers {
                                    elog!("[mDNS] Discovered local peer: {} at {}", &peer_id.to_string()[..16], addr);
                                    swarm.behaviour_mut().kademlia.add_address(&peer_id, addr.clone());
                                    // Only dial if under capacity
                                    if swarm.connected_peers().count() < 45 {
                                        let _ = swarm.dial(addr);
                                    }
                                    mdns_discovered += 1;
                                }
                            }
                            mdns::Event::Expired(peers) => {
                                for (peer_id, _addr) in peers {
                                    log::debug!("[IPFS-Rust] mDNS peer expired: {peer_id}");
                                    if mdns_discovered > 0 { mdns_discovered -= 1; }
                                }
                            }
                        }
                    }

                    // ── Rendezvous events ──
                    SwarmEvent::Behaviour(SiBehaviourEvent::Rendezvous(event)) => {
                        match event {
                            rendezvous::client::Event::Registered { namespace, ttl, rendezvous_node } => {
                                rendezvous_status = "registered".to_string();
                                elog!("[RENDEZVOUS] Registered in '{}' with {} (TTL: {}s)",
                                    namespace, &rendezvous_node.to_string()[..16], ttl);
                            }
                            rendezvous::client::Event::RegisterFailed { namespace, rendezvous_node, error } => {
                                rendezvous_status = "failed".to_string();
                                elog!("[RENDEZVOUS] Registration failed in '{}' with {}: {:?}",
                                    namespace, &rendezvous_node.to_string()[..16], error);
                            }
                            rendezvous::client::Event::Discovered { registrations, rendezvous_node, .. } => {
                                elog!("[RENDEZVOUS] Discovered {} SermonIndex peers via {}",
                                    registrations.len(), &rendezvous_node.to_string()[..16]);
                                // Dial discovered SermonIndex peers (only if under capacity)
                                let peer_count = swarm.connected_peers().count();
                                for reg in registrations {
                                    let peer = reg.record.peer_id();
                                    for addr in reg.record.addresses() {
                                        swarm.behaviour_mut().kademlia.add_address(&peer, addr.clone());
                                        if peer_count < 45 {
                                            let _ = swarm.dial(addr.clone());
                                        }
                                    }
                                }
                            }
                            rendezvous::client::Event::DiscoverFailed { rendezvous_node, namespace, error } => {
                                log::debug!("[IPFS-Rust] Rendezvous discover failed: {} {:?} {:?}",
                                    rendezvous_node, namespace, error);
                            }
                            _ => {}
                        }
                    }

                    // ── Bitswap events (block exchange with gateways & peers) ──
                    SwarmEvent::Behaviour(SiBehaviourEvent::Bitswap(event)) => {
                        match event {
                            request_response::Event::Message { peer, message, .. } => {
                                match message {
                                    request_response::Message::Request { request, channel, .. } => {
                                        let peer_short = &peer.to_string()[..16.min(peer.to_string().len())];
                                        log::debug!("[BITSWAP] WANT request from {} ({} bytes)", peer_short, request.0.len());

                                        // Parse the wantlist from the incoming message
                                        let want_entries = bitswap::parse_wantlist(&request.0);

                                        let mut response_blocks: Vec<BitswapBlock> = Vec::new();
                                        let mut presences: Vec<(Vec<u8>, bool)> = Vec::new();

                                        let store = block_store.lock().await;

                                        for entry in &want_entries {
                                            if entry.cancel {
                                                continue;
                                            }

                                            // Convert CID bytes to string for BlockStore lookup
                                            let cid_str = bitswap::cid_bytes_to_string(&entry.cid_bytes);

                                            match cid_str {
                                                Some(cid_string) => {
                                                    let have_block = store.get(&cid_string).is_some();
                                                    if have_block {
                                                        elog!("[BITSWAP] WANT '{}' → FOUND", &cid_string[..cid_string.len().min(24)]);
                                                    } else {
                                                        log::debug!("[BITSWAP] WANT '{}' → not in store", &cid_string[..cid_string.len().min(24)]);
                                                    }

                                                    match entry.want_type {
                                                        bitswap::WantType::Block => {
                                                            if let Some(data) = store.get(&cid_string) {
                                                                // Send the actual block data
                                                                let prefix = bitswap::cid_prefix(&entry.cid_bytes);
                                                                response_blocks.push(BitswapBlock {
                                                                    prefix,
                                                                    data: data.clone(),
                                                                });
                                                                elog!("[BITSWAP] Sending block {} ({} bytes) to {}",
                                                                    &cid_string[..16.min(cid_string.len())], data.len(), peer_short);
                                                            } else if entry.send_dont_have {
                                                                presences.push((entry.cid_bytes.clone(), false));
                                                                log::debug!("[BITSWAP] DontHave {} for {}", cid_string, peer_short);
                                                            }
                                                        }
                                                        bitswap::WantType::Have => {
                                                            presences.push((entry.cid_bytes.clone(), have_block));
                                                            if have_block {
                                                                elog!("[BITSWAP] Have {} for {}", &cid_string[..16.min(cid_string.len())], peer_short);
                                                            } else if entry.send_dont_have {
                                                                log::debug!("[BITSWAP] DontHave {} for {}", cid_string, peer_short);
                                                            }
                                                        }
                                                    }
                                                }
                                                None => {
                                                    // Couldn't parse CID bytes
                                                    if entry.send_dont_have {
                                                        presences.push((entry.cid_bytes.clone(), false));
                                                    }
                                                    log::debug!("[BITSWAP] Unparseable CID from {}", peer_short);
                                                }
                                            }
                                        }

                                        drop(store);

                                        // Build and send the response
                                        if !response_blocks.is_empty() || !presences.is_empty() {
                                            let response_data = bitswap::build_response(&response_blocks, &presences);
                                            if !response_blocks.is_empty() {
                                                // Only log when we're actually serving data — that's the interesting event
                                                elog!("[BITSWAP] Serving {} block(s) to {} ({} bytes)",
                                                    response_blocks.len(), peer_short, response_data.len());
                                            }
                                            let _ = swarm.behaviour_mut().bitswap.send_response(
                                                channel,
                                                BitswapResponse(response_data),
                                            );
                                        } else {
                                            // Send empty response so the channel doesn't hang
                                            let _ = swarm.behaviour_mut().bitswap.send_response(
                                                channel,
                                                BitswapResponse(vec![]),
                                            );
                                        }
                                    }
                                    request_response::Message::Response { .. } => {
                                        // We don't initiate Bitswap requests, but log for completeness
                                        log::debug!("[BITSWAP] Got response from {} (unexpected)", peer);
                                    }
                                }
                            }
                            request_response::Event::OutboundFailure { peer, error, .. } => {
                                log::debug!("[BITSWAP] Outbound failure to {}: {:?}", peer, error);
                            }
                            request_response::Event::InboundFailure { peer, error, .. } => {
                                elog!("[BITSWAP] Inbound failure from {}: {:?}", &peer.to_string()[..16.min(peer.to_string().len())], error);
                            }
                            request_response::Event::ResponseSent { peer, .. } => {
                                log::debug!("[BITSWAP] Response sent to {}", peer);
                            }
                        }
                    }

                    _ => {}
                }

                // ── Inline relay re-provide check ──
                // Runs after EVERY swarm event. The InboundCircuitEstablished
                // flood lasts 48+ seconds, so this will fire well after the
                // 15s deadline. We cannot rely on timer branches because
                // tokio::select! starves them during the flood.
                if !relay_reprovide_done {
                    if let Some(relay_time) = first_relay_at {
                        if relay_time.elapsed() >= std::time::Duration::from_secs(15) {
                            relay_reprovide_done = true;
                            let relay_count = swarm.external_addresses()
                                .filter(|a| a.to_string().contains("p2p-circuit"))
                                .count();
                            elog!("[DHT] Relay re-provide triggered INLINE ({relay_count} relay addresses, {:.1}s after first relay)",
                                relay_time.elapsed().as_secs_f64());
                            let store = block_store.lock().await;
                            let cid_keys: Vec<String> = store.pinned_cids();
                            drop(store);
                            let count = cid_keys.len();
                            if count > 0 {
                                let mut provided = 0;
                                for cid_str in &cid_keys {
                                    if let Ok(cid) = cid_str.parse::<Cid>() {
                                        let mh = cid.hash().to_bytes();
                                        let key = kad::RecordKey::new(&mh);
                                        if swarm.behaviour_mut().kademlia.start_providing(key).is_ok() {
                                            provided += 1;
                                        }
                                    }
                                }
                                let ext_addrs: Vec<String> = swarm.external_addresses()
                                    .map(|a| a.to_string())
                                    .collect();
                                elog!("[DHT] Re-provided {provided}/{count} CIDs with relay addresses");
                                elog!("[DHT] External addresses in provider records: {:?}", ext_addrs);
                            }
                        }
                    }
                }
            }

            // Process commands from Tauri frontend
            cmd = cmd_rx.recv() => {
                match cmd {
                    Some(IpfsCommand::AddFile { data, sermon_id, respond }) => {
                        let mut store = block_store.lock().await;
                        let cid_str = store.add(&data);

                        if let Some(sid) = &sermon_id {
                            store.catalog.insert(sid.clone(), cid_str.clone());
                            store.save_catalog_to_disk();
                        }

                        // Announce on DHT
                        if let Ok(cid) = cid_str.parse::<Cid>() {
                            let mh = cid.hash().to_bytes();
                            let key = kad::RecordKey::new(&mh);
                            match swarm.behaviour_mut().kademlia.start_providing(key) {
                                Ok(_query_id) => {
                                    elog!("[DHT] Announcing CID {} (query started)", &cid_str[..cid_str.len().min(24)]);
                                }
                                Err(e) => {
                                    elog!("[DHT] ✗ Provide FAILED for {}: {e}", &cid_str[..cid_str.len().min(24)]);
                                }
                            }
                        }

                        elog!("[IPFS] Added & pinned: {} ({} bytes)", &cid_str[..cid_str.len().min(24)], data.len());
                        let _ = respond.send(Ok(cid_str));
                    }
                    Some(IpfsCommand::GetFile { cid_str, respond }) => {
                        let store = block_store.lock().await;
                        let result = store.get(&cid_str)
                            .cloned()
                            .ok_or_else(|| format!("CID not found: {cid_str}"));
                        let _ = respond.send(result);
                    }
                    Some(IpfsCommand::Provide { cid_str, respond }) => {
                        let result = if let Ok(cid) = cid_str.parse::<Cid>() {
                            let mh = cid.hash().to_bytes();
                            let key = kad::RecordKey::new(&mh);
                            swarm.behaviour_mut().kademlia.start_providing(key)
                                .map(|_| ())
                                .map_err(|e| format!("Provide failed: {e}"))
                        } else {
                            Err(format!("Invalid CID: {cid_str}"))
                        };
                        let _ = respond.send(result);
                    }
                    Some(IpfsCommand::GetDiagnostics { respond }) => {
                        let store = block_store.lock().await;
                        let peer_count = swarm.connected_peers().count();
                        let listen_addrs: Vec<String> = swarm.listeners()
                            .map(|a| a.to_string())
                            .collect();
                        let external_addrs: Vec<String> = swarm.external_addresses()
                            .map(|a| a.to_string())
                            .collect();
                        let connections: Vec<ConnectionInfo> = swarm.connected_peers()
                            .take(50)
                            .map(|p| ConnectionInfo {
                                peer_id: p.to_string(),
                                address: String::new(),
                                direction: "connected".into(),
                            })
                            .collect();

                        let _ = respond.send(NodeDiagnostics {
                            running: true,
                            peer_id: local_peer_id.to_string(),
                            peer_count,
                            listen_addresses: listen_addrs,
                            external_addresses: external_addrs,
                            nat_status: nat_status.clone(),
                            upnp_status: upnp_status.clone(),
                            natpmp_status: if natpmp_mapped { "mapped".to_string() } else if natpmp_tried { "unsupported".to_string() } else { "trying".to_string() },
                            relay_status: relay_status.clone(),
                            mdns_peers: mdns_discovered,
                            rendezvous_status: rendezvous_status.clone(),
                            dht_mode: "server".to_string(),
                            pinned_count: store.pinned_cids().len(),
                            uptime_secs: start_time.elapsed().as_secs(),
                            connections,
                            protocol: "native-libp2p".into(),
                            recent_events: event_log.clone(),
                        });
                    }
                    Some(IpfsCommand::ListPinned { respond }) => {
                        let store = block_store.lock().await;
                        let _ = respond.send(store.pinned_cids());
                    }
                    Some(IpfsCommand::RemovePin { cid_str, respond }) => {
                        let mut store = block_store.lock().await;
                        if store.remove(&cid_str) {
                            let _ = respond.send(Ok(()));
                        } else {
                            let _ = respond.send(Err(format!("CID not found: {cid_str}")));
                        }
                    }
                    Some(IpfsCommand::Stop { respond }) => {
                        log::info!("[IPFS-Rust] Node stopping...");
                        let _ = respond.send(());
                        break;
                    }
                    None => {
                        log::info!("[IPFS-Rust] Command channel closed, stopping node");
                        break;
                    }
                }
            }

            // ── Periodic DHT re-bootstrap (every 5 minutes) ──
            _ = bootstrap_interval.tick() => {
                if let Err(e) = swarm.behaviour_mut().kademlia.bootstrap() {
                    log::warn!("[IPFS-Rust] Re-bootstrap failed: {e}");
                }
            }

            // ── Periodic re-provide of all pinned content (every 4 hours) ──
            // Skip if we don't have external addresses yet — provides will fail
            _ = reprovide_interval.tick() => {
                let has_external = swarm.external_addresses().next().is_some();
                if !has_external {
                    elog!("[DHT] Skipping re-provide — no external addresses yet");
                } else {
                    let store = block_store.lock().await;
                    let cids = store.pinned_cids();
                    drop(store);

                    let count = cids.len();
                    let mut provided = 0;
                    for cid_str in &cids {
                        if let Ok(cid) = cid_str.parse::<Cid>() {
                            let mh = cid.hash().to_bytes();
                            let key = kad::RecordKey::new(&mh);
                            if swarm.behaviour_mut().kademlia.start_providing(key).is_ok() {
                                provided += 1;
                            }
                        }
                    }
                    if count > 0 {
                        let ext_addrs: Vec<String> = swarm.external_addresses()
                            .map(|a| a.to_string())
                            .collect();
                        elog!("[DHT] Re-provided {provided}/{count} CIDs — external addrs: {:?}", ext_addrs);
                    }
                }
            }

            // ── Automatic relay reservation ──
            // Check every 30s initially, then every 2min. If NAT is private,
            // listen through relay peers for public reachability.
            // IMPORTANT: We use relay EVEN if NAT-PMP provided direct addresses,
            // because AutoNAT "Private" means those addresses may not actually be
            // reachable (e.g. double NAT, firewall, carrier-grade NAT on Telus fibre).
            // Relay gives gateways a guaranteed fallback path to reach us.
            _ = relay_check_interval.tick() => {
                let uptime = start_time.elapsed().as_secs();
                let nat_is_private = nat_status.to_lowercase().contains("private")
                    || nat_status == "unknown";
                let has_relay_circuit = swarm.external_addresses().any(|addr| {
                    addr.to_string().contains("p2p-circuit")
                });

                // Attempt relay if: NAT is private (even with NAT-PMP!),
                // no existing relay circuit, and not already reserving
                if uptime >= 20 && nat_is_private && !has_relay_circuit
                    && relay_status != "reserved" && relay_status != "reserving"
                {
                    // Try ALL connected relay peers — more relays = more ways for
                    // gateways to reach us. First successful reservation wins.
                    let mut relay_count = 0;
                    let mut relay_checked = 0;
                    let mut relay_connected = 0;
                    for addr_str in RELAY_PEERS {
                        if let Ok(addr) = addr_str.parse::<Multiaddr>() {
                            if let Some(libp2p::core::multiaddr::Protocol::P2p(relay_peer)) = addr.iter().last() {
                                relay_checked += 1;
                                let connected = swarm.is_connected(&relay_peer);
                                if connected { relay_connected += 1; }
                                if connected {
                                    let circuit_addr: Multiaddr = format!(
                                        "{}/p2p-circuit",
                                        addr
                                    ).parse().unwrap_or_else(|_| addr.clone());

                                    match swarm.listen_on(circuit_addr.clone()) {
                                        Ok(_) => {
                                            elog!("[RELAY] Requested reservation via {}", &relay_peer.to_string()[..16]);
                                            relay_count += 1;
                                        }
                                        Err(e) => {
                                            log::debug!("[RELAY] Failed to listen via {}: {e}", &relay_peer.to_string()[..16]);
                                        }
                                    }
                                }
                            }
                        }
                    }

                    if relay_count > 0 {
                        relay_status = "reserving".to_string();
                        elog!("[RELAY] Requested {relay_count} relay reservation(s)");
                    } else {
                        elog!("[RELAY] 0/{relay_checked} relay peers connected ({relay_connected} reachable) — retrying in 30s");
                    }

                    // Check again in 30s (not too aggressive, not too slow)
                    relay_check_interval = tokio::time::interval(std::time::Duration::from_secs(30));
                }
            }

            // ── NAT-PMP / PCP port mapping ──
            // Alternative to UPnP — many routers (including Telus fibre) support NAT-PMP
            // even when UPnP is disabled. Maps BOTH TCP and UDP (QUIC) ports.
            _ = natpmp_check_interval.tick() => {
                if !natpmp_mapped && upnp_status != "mapped" {
                    let uptime = start_time.elapsed().as_secs();
                    if uptime >= 10 {
                        let tcp_p = actual_tcp_port.unwrap_or(4001);
                        let quic_p = actual_quic_port.unwrap_or(4001);
                        elog!("[NAT-PMP] Attempting NAT-PMP/PCP mapping — TCP:{} UDP/QUIC:{}...", tcp_p, quic_p);
                        natpmp_tried = true;
                        match crate::natpmp::try_mapping(tcp_p, quic_p).await {
                            Some(result) => {
                                elog!("[NAT-PMP] ✓ TCP mapped! local:{} → external:{} via {}",
                                    tcp_p, result.tcp_external_port, result.gateway);
                                natpmp_tcp_ext = Some(result.tcp_external_port);
                                if let Some(udp_ext) = result.udp_external_port {
                                    elog!("[NAT-PMP] ✓ UDP mapped! local:{} → external:{} via {}",
                                        quic_p, udp_ext, result.gateway);
                                    natpmp_udp_ext = Some(udp_ext);
                                } else {
                                    elog!("[NAT-PMP] ✗ UDP mapping failed — QUIC not reachable externally");
                                }
                                natpmp_mapped = true;
                                natpmp_check_interval = tokio::time::interval(std::time::Duration::from_secs(3600));

                                // Add our public IP + mapped ports as external addresses
                                // so DHT provider records include directly-reachable addresses
                                if let Some(ref public_ip) = observed_public_ip {
                                    let tcp_addr: Multiaddr = format!("/ip4/{}/tcp/{}", public_ip, result.tcp_external_port)
                                        .parse().unwrap();
                                    swarm.add_external_address(tcp_addr.clone());
                                    elog!("[NAT-PMP] Added external TCP: {}", tcp_addr);

                                    if let Some(udp_ext) = result.udp_external_port {
                                        let quic_addr: Multiaddr = format!("/ip4/{}/udp/{}/quic-v1", public_ip, udp_ext)
                                            .parse().unwrap();
                                        swarm.add_external_address(quic_addr.clone());
                                        elog!("[NAT-PMP] Added external QUIC: {}", quic_addr);
                                    }
                                    reprovide_pending = true;
                                } else {
                                    elog!("[NAT-PMP] Ports mapped but no public IP discovered yet — will add when IP discovered");
                                }
                            }
                            None => {
                                elog!("[NAT-PMP] NAT-PMP/PCP not supported by router — using relay fallback");
                                natpmp_check_interval = tokio::time::interval(std::time::Duration::from_secs(3600));
                            }
                        }
                    }
                }
            }

            // ── Rendezvous registration & discovery ──
            _ = rendezvous_interval.tick() => {
                // Re-register periodically (TTL expires)
                if let Some(rv_peer) = rendezvous_peer {
                    if swarm.is_connected(&rv_peer) {
                        // Re-register
                        let _ = swarm.behaviour_mut().rendezvous.register(
                            rendezvous::Namespace::from_static(RENDEZVOUS_NAMESPACE),
                            rv_peer,
                            None,
                        );
                        // Also discover other SermonIndex peers
                        swarm.behaviour_mut().rendezvous.discover(
                            Some(rendezvous::Namespace::from_static(RENDEZVOUS_NAMESPACE)),
                            None, // cookie — None = fresh discovery
                            None, // limit
                            rv_peer,
                        );
                    }
                }
            }

            // ── Batched re-provide (every 10s) ──
            // Handles two cases:
            // 1. reprovide_pending flag — re-provide after external address changes
            // 2. relay_reprovide — FALLBACK for the inline check above.
            //    Primary relay re-provide happens inline in the swarm event handler
            //    (fires during the InboundCircuitEstablished flood, which lasts 48+s).
            //    This timer is backup in case the flood stops before 15s.
            _ = reprovide_batch_interval.tick() => {
                // Check if relay re-provide is due (one-shot, 15s after first relay addr)
                if !relay_reprovide_done {
                    if let Some(relay_time) = first_relay_at {
                        if relay_time.elapsed() >= std::time::Duration::from_secs(15) {
                            relay_reprovide_done = true;
                            reprovide_pending = true; // Force the provide below
                            let relay_count = swarm.external_addresses()
                                .filter(|a| a.to_string().contains("p2p-circuit"))
                                .count();
                            elog!("[DHT] Relay re-provide triggered ({relay_count} relay addresses, 15s elapsed)");
                        }
                    }
                }

                if reprovide_pending {
                    reprovide_pending = false;
                    let store = block_store.lock().await;
                    let cid_keys: Vec<String> = store.pinned_cids();
                    drop(store);
                    let count = cid_keys.len();
                    if count > 0 {
                        let mut provided = 0;
                        for cid_str in &cid_keys {
                            if let Ok(cid) = cid_str.parse::<Cid>() {
                                let mh = cid.hash().to_bytes();
                                let key = kad::RecordKey::new(&mh);
                                if swarm.behaviour_mut().kademlia.start_providing(key).is_ok() {
                                    provided += 1;
                                }
                            }
                        }
                        // Log ALL external addresses so we can verify what provider records contain
                        let ext_addrs: Vec<String> = swarm.external_addresses()
                            .map(|a| a.to_string())
                            .collect();
                        elog!("[DHT] Re-provided {provided}/{count} CIDs (batched after address changes)");
                        elog!("[DHT] External addresses in provider records: {:?}", ext_addrs);
                    }
                }
            }
        }
    }
}

/// Load or create a persistent Ed25519 keypair for the node identity
fn load_or_create_keypair(storage_path: &PathBuf) -> Result<identity::Keypair, String> {
    let key_path = storage_path.join("node_key.bin");

    // Try to load existing key
    if key_path.exists() {
        if let Ok(bytes) = std::fs::read(&key_path) {
            if let Ok(keypair) = identity::Keypair::from_protobuf_encoding(&bytes) {
                log::info!("[IPFS-Rust] Loaded existing identity from disk");
                return Ok(keypair);
            }
        }
        log::warn!("[IPFS-Rust] Failed to load key, generating new one");
    }

    // Generate new key
    let keypair = identity::Keypair::generate_ed25519();

    // Save to disk
    let _ = std::fs::create_dir_all(storage_path);
    if let Ok(encoded) = keypair.to_protobuf_encoding() {
        if let Err(e) = std::fs::write(&key_path, &encoded) {
            log::warn!("[IPFS-Rust] Failed to save key: {e}");
        }
    }

    log::info!("[IPFS-Rust] Generated new identity");
    Ok(keypair)
}

