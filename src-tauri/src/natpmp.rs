/// NAT-PMP / PCP port mapping module.
///
/// Separated into its own module to avoid trait conflicts with sha2::Digest
/// (which has a blanket `new()` method that collides with crab_nat types).

use std::net::{IpAddr, Ipv4Addr};

/// Result of a successful port mapping attempt.
pub struct MappingResult {
    pub gateway: String,
    pub tcp_external_port: u16,
    pub udp_external_port: Option<u16>, // None if UDP mapping failed
}

/// Detect the default gateway IP by checking common addresses.
/// Returns the gateway that responds to NAT-PMP fastest.
fn gateway_candidates() -> Vec<Ipv4Addr> {
    let mut candidates = Vec::new();

    // Try to detect actual gateway from routing table
    #[cfg(unix)]
    if let Ok(output) = std::process::Command::new("route")
        .args(["-n", "get", "default"])
        .output()
    {
        let stdout = String::from_utf8_lossy(&output.stdout);
        for line in stdout.lines() {
            let trimmed = line.trim();
            if trimmed.starts_with("gateway:") {
                if let Some(ip_str) = trimmed.strip_prefix("gateway:") {
                    if let Ok(ip) = ip_str.trim().parse::<Ipv4Addr>() {
                        log::info!("[NAT-PMP] Detected default gateway: {}", ip);
                        candidates.push(ip);
                    }
                }
            }
        }
    }

    // Fallback common gateway IPs (in case detection fails)
    let fallbacks = [
        Ipv4Addr::new(192, 168, 2, 1),   // Telus fibre
        Ipv4Addr::new(192, 168, 1, 1),
        Ipv4Addr::new(192, 168, 0, 1),
        Ipv4Addr::new(10, 0, 0, 1),
        Ipv4Addr::new(10, 0, 0, 138),    // Some Telus fibre gateways
    ];

    for gw in &fallbacks {
        if !candidates.contains(gw) {
            candidates.push(*gw);
        }
    }

    candidates
}

/// Try a single gateway for TCP+UDP mapping with a per-gateway timeout.
async fn try_gateway(
    gw: Ipv4Addr,
    tcp_port: u16,
    udp_port: u16,
) -> Option<MappingResult> {
    let local = IpAddr::V4(Ipv4Addr::UNSPECIFIED);

    // Try TCP first — this is required
    match crab_nat::try_port_mapping(
        IpAddr::V4(gw),
        local,
        crab_nat::InternetProtocol::Tcp,
        tcp_port,
        Some(tcp_port),
        Some(7200), // 2 hour lifetime
    )
    .await
    {
        Ok(tcp_mapping) => {
            let tcp_ext = tcp_mapping.external_port;
            let gateway = format!("{}", tcp_mapping.gateway);
            std::mem::forget(tcp_mapping);

            log::info!("[NAT-PMP] TCP mapped: local {} → external {} via {}", tcp_port, tcp_ext, gateway);

            // Now try UDP for QUIC on the same gateway
            let udp_ext = match crab_nat::try_port_mapping(
                IpAddr::V4(gw),
                local,
                crab_nat::InternetProtocol::Udp,
                udp_port,
                Some(udp_port),
                Some(7200),
            )
            .await
            {
                Ok(udp_mapping) => {
                    let ext = udp_mapping.external_port;
                    log::info!("[NAT-PMP] UDP mapped: local {} → external {} via {}", udp_port, ext, gateway);
                    std::mem::forget(udp_mapping);
                    Some(ext)
                }
                Err(e) => {
                    log::warn!("[NAT-PMP] UDP mapping failed on {}: {:?} — QUIC won't be reachable externally", gw, e);
                    None
                }
            };

            Some(MappingResult {
                gateway,
                tcp_external_port: tcp_ext,
                udp_external_port: udp_ext,
            })
        }
        Err(e) => {
            log::debug!("[NAT-PMP] Gateway {} TCP failed: {e:?}", gw);
            None
        }
    }
}

/// Try NAT-PMP/PCP port mapping on common gateway addresses.
/// Maps BOTH TCP and UDP (for QUIC) on the given ports.
/// Each gateway attempt is capped at 3 seconds to avoid blocking startup.
/// Returns Some(MappingResult) on success (at minimum TCP must succeed), None if unsupported.
pub async fn try_mapping(tcp_port: u16, udp_port: u16) -> Option<MappingResult> {
    let gateways = gateway_candidates();

    for gw in &gateways {
        log::debug!("[NAT-PMP] Trying gateway {}...", gw);

        // Cap each gateway attempt at 3 seconds to avoid blocking startup
        match tokio::time::timeout(
            std::time::Duration::from_secs(3),
            try_gateway(*gw, tcp_port, udp_port),
        )
        .await
        {
            Ok(Some(result)) => return Some(result),
            Ok(None) => {} // Gateway responded but rejected
            Err(_) => {
                log::debug!("[NAT-PMP] Gateway {} timed out (3s)", gw);
            }
        }
    }

    None
}
