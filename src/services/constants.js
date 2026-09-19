/**
 * Shared network constants — defined ONCE here so the same value can't drift
 * between files. Import from here rather than re-declaring.
 */

// Community chat Edge Script (server/chat-edge-script.js).
export const CHAT_API = 'https://community-chat-z71kj.bunny.run/';

// BitTorrent listen ports — must match LISTEN_PORT_RANGE in
// src-tauri/src/torrent_node.rs (42800..42840, i.e. 42800–42839 inclusive).
export const TORRENT_PORT_MIN = 42800;
export const TORRENT_PORT_MAX = 42839;
export const TORRENT_PORT_RANGE = '42800–42839'; // display string

// ── Listening port ──────────────────────────────────────────────────────────
// The port may be pinned in Connections (`set_listen_port`). These bounds are
// what the OS will actually allow, not a policy of ours:
//   • 0 is not a port you can be reached on (it means "any free port").
//   • Below 1024 is privileged on macOS and Linux. The app does not run as
//     root, so binding 80 or 443 fails outright. Windows has no such rule.
//   • 65535 is the end of the 16-bit port field. There is no limit on how many
//     ports may be "allowed" — a node uses exactly one TCP port.
export const PORT_MIN = 1;
export const PORT_MAX = 65535;
export const PORT_PRIVILEGED_MAX = 1023; // below this needs root on macOS/Linux
