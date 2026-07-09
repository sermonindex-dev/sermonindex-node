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
