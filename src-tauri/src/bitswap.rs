/// Minimal Bitswap 1.2.0 protocol responder
///
/// This implements just enough of the Bitswap protocol to respond to WANT
/// requests from IPFS gateways and other peers. When a gateway resolves our
/// peer ID via the DHT provider records, it connects and sends Bitswap WANT
/// messages. We respond with the actual block data.
///
/// Protocol IDs we support:
/// - /ipfs/bitswap/1.2.0  (current)
/// - /ipfs/bitswap/1.1.0  (fallback)
/// - /ipfs/bitswap/1.0.0  (legacy)
///
/// Message format: length-prefixed protobuf (Message)
///
/// We only handle incoming wantlist requests and respond with blocks.
/// We never initiate want requests ourselves (we're a server/seeder).

use async_trait::async_trait;
use futures::prelude::*;
use libp2p::swarm::StreamProtocol;
use std::io;

// ── Protocol IDs ──

pub const BITSWAP_PROTOCOL_1_2: &str = "/ipfs/bitswap/1.2.0";
pub const BITSWAP_PROTOCOL_1_1: &str = "/ipfs/bitswap/1.1.0";
pub const BITSWAP_PROTOCOL_1_0: &str = "/ipfs/bitswap/1.0.0";

/// Maximum message size (4 MB — same as go-bitswap)
const MAX_MESSAGE_SIZE: usize = 4 * 1024 * 1024;

// ── Protobuf wire types (manually decoded, no codegen needed) ──
// Bitswap Message protobuf:
//
// message Message {
//   message Wantlist {
//     message Entry {
//       bytes block = 1;       // CID bytes
//       int32 priority = 2;
//       bool cancel = 3;
//       WantType wantType = 4; // 0=Block, 1=Have
//       bool sendDontHave = 5;
//     }
//     repeated Entry entries = 1;
//     bool full = 2;
//   }
//   Wantlist wantlist = 1;
//   repeated bytes blocks = 2;         // Bitswap 1.0 blocks
//   repeated Block payload = 3;        // Bitswap 1.1+ blocks
//   repeated BlockPresence blockPresences = 4;
//
//   message Block {
//     bytes prefix = 1;  // CID prefix (version + codec + hash fn + hash len)
//     bytes data = 2;    // raw block data
//   }
//   message BlockPresence {
//     bytes cid = 1;
//     BlockPresenceType type = 2; // 0=Have, 1=DontHave
//   }
// }

/// A parsed wantlist entry from an incoming Bitswap message
#[derive(Debug, Clone)]
pub struct WantEntry {
    pub cid_bytes: Vec<u8>,
    pub want_type: WantType,
    pub send_dont_have: bool,
    pub cancel: bool,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum WantType {
    Block = 0,
    Have = 1,
}

/// A block to send back in a Bitswap response
#[derive(Debug, Clone)]
pub struct BitswapBlock {
    pub prefix: Vec<u8>, // CID prefix (version + codec + hash fn + hash len)
    pub data: Vec<u8>,   // raw block data
}

/// Parse CID bytes from a wantlist entry and return the CID string.
/// Bitswap sends raw CID bytes (no length prefix), so we try both
/// `try_from` (raw) and `read_bytes` (stream/length-prefixed).
pub fn cid_bytes_to_string(cid_bytes: &[u8]) -> Option<String> {
    // Try raw CID bytes first (most common in Bitswap)
    if let Ok(c) = cid::Cid::try_from(cid_bytes) {
        return Some(c.to_string());
    }
    // Fallback: stream format with varint length prefix
    if let Ok(c) = cid::Cid::read_bytes(std::io::Cursor::new(cid_bytes)) {
        return Some(c.to_string());
    }
    log::warn!("[BITSWAP] Failed to parse CID from {} bytes: {:02x?}",
        cid_bytes.len(), &cid_bytes[..cid_bytes.len().min(20)]);
    None
}

/// Extract CID prefix bytes (version + codec + hash function + hash size)
pub fn cid_prefix(cid_bytes: &[u8]) -> Vec<u8> {
    if let Ok(cid) = cid::Cid::read_bytes(std::io::Cursor::new(cid_bytes)) {
        let mut prefix = Vec::new();
        // Version
        encode_varint(cid.version() as u64, &mut prefix);
        // Codec
        encode_varint(cid.codec(), &mut prefix);
        // Hash function code
        let mh = cid.hash();
        encode_varint(mh.code(), &mut prefix);
        // Hash digest size
        encode_varint(mh.size() as u64, &mut prefix);
        prefix
    } else {
        vec![]
    }
}

/// Parse incoming Bitswap message to extract wantlist entries
pub fn parse_wantlist(data: &[u8]) -> Vec<WantEntry> {
    let mut entries = Vec::new();
    let mut pos = 0;

    while pos < data.len() {
        let (field_num, wire_type, new_pos) = read_tag(data, pos);
        pos = new_pos;

        if field_num == 1 && wire_type == 2 {
            // field 1 = wantlist (length-delimited)
            let (wantlist_data, new_pos) = read_length_delimited(data, pos);
            pos = new_pos;
            // Parse wantlist sub-message
            entries.extend(parse_wantlist_entries(wantlist_data));
        } else {
            // Skip other fields
            pos = skip_field(data, pos, wire_type);
        }
    }

    entries
}

fn parse_wantlist_entries(data: &[u8]) -> Vec<WantEntry> {
    let mut entries = Vec::new();
    let mut pos = 0;

    while pos < data.len() {
        let (field_num, wire_type, new_pos) = read_tag(data, pos);
        pos = new_pos;

        if field_num == 1 && wire_type == 2 {
            // field 1 = repeated Entry (length-delimited)
            let (entry_data, new_pos) = read_length_delimited(data, pos);
            pos = new_pos;
            if let Some(entry) = parse_single_entry(entry_data) {
                entries.push(entry);
            }
        } else {
            pos = skip_field(data, pos, wire_type);
        }
    }

    entries
}

fn parse_single_entry(data: &[u8]) -> Option<WantEntry> {
    let mut cid_bytes = Vec::new();
    let mut want_type = WantType::Block;
    let mut send_dont_have = false;
    let mut cancel = false;
    let mut pos = 0;

    while pos < data.len() {
        let (field_num, wire_type, new_pos) = read_tag(data, pos);
        pos = new_pos;

        match (field_num, wire_type) {
            (1, 2) => {
                // block = CID bytes
                let (bytes, new_pos) = read_length_delimited(data, pos);
                pos = new_pos;
                cid_bytes = bytes.to_vec();
            }
            (3, 0) => {
                // cancel
                let (val, new_pos) = read_varint(data, pos);
                pos = new_pos;
                cancel = val != 0;
            }
            (4, 0) => {
                // wantType
                let (val, new_pos) = read_varint(data, pos);
                pos = new_pos;
                want_type = if val == 1 { WantType::Have } else { WantType::Block };
            }
            (5, 0) => {
                // sendDontHave
                let (val, new_pos) = read_varint(data, pos);
                pos = new_pos;
                send_dont_have = val != 0;
            }
            _ => {
                pos = skip_field(data, pos, wire_type);
            }
        }
    }

    if cid_bytes.is_empty() {
        return None;
    }

    Some(WantEntry { cid_bytes, want_type, send_dont_have, cancel })
}

/// Build a Bitswap response message containing blocks and/or presences
pub fn build_response(blocks: &[BitswapBlock], presences: &[(Vec<u8>, bool)]) -> Vec<u8> {
    let mut msg = Vec::new();

    // field 3 = repeated Block payload (Bitswap 1.1+)
    for block in blocks {
        let mut block_msg = Vec::new();
        // field 1 = prefix
        write_tag(1, 2, &mut block_msg);
        write_length_delimited(&block.prefix, &mut block_msg);
        // field 2 = data
        write_tag(2, 2, &mut block_msg);
        write_length_delimited(&block.data, &mut block_msg);

        write_tag(3, 2, &mut msg);
        write_length_delimited(&block_msg, &mut msg);
    }

    // field 4 = repeated BlockPresence
    for (cid_bytes, have) in presences {
        let mut presence_msg = Vec::new();
        // field 1 = cid
        write_tag(1, 2, &mut presence_msg);
        write_length_delimited(cid_bytes, &mut presence_msg);
        // field 2 = type (0=Have, 1=DontHave)
        write_tag(2, 0, &mut presence_msg);
        encode_varint(if *have { 0 } else { 1 }, &mut presence_msg);

        write_tag(4, 2, &mut msg);
        write_length_delimited(&presence_msg, &mut msg);
    }

    msg
}

// ── Protobuf wire format helpers ──

fn read_tag(data: &[u8], pos: usize) -> (u32, u32, usize) {
    let (val, new_pos) = read_varint(data, pos);
    let field_num = (val >> 3) as u32;
    let wire_type = (val & 0x07) as u32;
    (field_num, wire_type, new_pos)
}

fn read_varint(data: &[u8], mut pos: usize) -> (u64, usize) {
    let mut result: u64 = 0;
    let mut shift = 0;
    while pos < data.len() {
        let byte = data[pos];
        pos += 1;
        result |= ((byte & 0x7F) as u64) << shift;
        if byte & 0x80 == 0 {
            break;
        }
        shift += 7;
        if shift >= 64 {
            break;
        }
    }
    (result, pos)
}

fn read_length_delimited(data: &[u8], pos: usize) -> (&[u8], usize) {
    let (len, new_pos) = read_varint(data, pos);
    let len = len as usize;
    let end = (new_pos + len).min(data.len());
    (&data[new_pos..end], end)
}

fn skip_field(data: &[u8], pos: usize, wire_type: u32) -> usize {
    match wire_type {
        0 => {
            // varint
            let (_, new_pos) = read_varint(data, pos);
            new_pos
        }
        1 => pos + 8, // 64-bit
        2 => {
            // length-delimited
            let (_, new_pos) = read_length_delimited(data, pos);
            new_pos
        }
        5 => pos + 4, // 32-bit
        _ => data.len(), // unknown — skip to end
    }
}

fn encode_varint(mut val: u64, buf: &mut Vec<u8>) {
    loop {
        let byte = (val & 0x7F) as u8;
        val >>= 7;
        if val == 0 {
            buf.push(byte);
            break;
        }
        buf.push(byte | 0x80);
    }
}

fn write_tag(field_num: u32, wire_type: u32, buf: &mut Vec<u8>) {
    encode_varint(((field_num as u64) << 3) | (wire_type as u64), buf);
}

fn write_length_delimited(data: &[u8], buf: &mut Vec<u8>) {
    encode_varint(data.len() as u64, buf);
    buf.extend_from_slice(data);
}

// ── Outbound request building ──

/// Build a Bitswap WANT-Block request message for the given CID bytes.
/// This asks a peer to send us the actual block data.
pub fn build_want_block(cid_bytes: &[u8]) -> Vec<u8> {
    // Build the Entry sub-message
    let mut entry = Vec::new();
    // field 1 = block (CID bytes)
    write_tag(1, 2, &mut entry);
    write_length_delimited(cid_bytes, &mut entry);
    // field 2 = priority (int32) — use 1
    write_tag(2, 0, &mut entry);
    encode_varint(1, &mut entry);
    // field 3 = cancel (bool) — false
    // (omit, default is false)
    // field 4 = wantType (0=Block)
    write_tag(4, 0, &mut entry);
    encode_varint(0, &mut entry); // WantType::Block
    // field 5 = sendDontHave (bool) — true, so we get a definitive answer
    write_tag(5, 0, &mut entry);
    encode_varint(1, &mut entry);

    // Build the Wantlist sub-message
    let mut wantlist = Vec::new();
    // field 1 = repeated Entry
    write_tag(1, 2, &mut wantlist);
    write_length_delimited(&entry, &mut wantlist);
    // field 2 = full (bool) — false (incremental)
    // (omit, default is false)

    // Build the top-level Message
    let mut msg = Vec::new();
    // field 1 = wantlist
    write_tag(1, 2, &mut msg);
    write_length_delimited(&wantlist, &mut msg);

    msg
}

/// A block received in a Bitswap response
#[derive(Debug, Clone)]
pub struct ReceivedBlock {
    pub prefix: Vec<u8>,
    pub data: Vec<u8>,
}

/// A block presence from a Bitswap response
#[derive(Debug, Clone)]
pub struct ReceivedPresence {
    pub cid_bytes: Vec<u8>,
    pub have: bool,
}

/// Parsed Bitswap response
#[derive(Debug, Default)]
pub struct ParsedResponse {
    pub blocks: Vec<ReceivedBlock>,
    pub presences: Vec<ReceivedPresence>,
}

/// Parse a Bitswap response message to extract blocks and presences
pub fn parse_response(data: &[u8]) -> ParsedResponse {
    let mut result = ParsedResponse::default();
    let mut pos = 0;

    while pos < data.len() {
        let (field_num, wire_type, new_pos) = read_tag(data, pos);
        pos = new_pos;

        match (field_num, wire_type) {
            (2, 2) => {
                // field 2 = repeated bytes blocks (Bitswap 1.0 legacy — raw block data)
                let (block_data, new_pos) = read_length_delimited(data, pos);
                pos = new_pos;
                result.blocks.push(ReceivedBlock {
                    prefix: vec![],
                    data: block_data.to_vec(),
                });
            }
            (3, 2) => {
                // field 3 = repeated Block payload (Bitswap 1.1+)
                let (block_msg, new_pos) = read_length_delimited(data, pos);
                pos = new_pos;
                if let Some(block) = parse_payload_block(block_msg) {
                    result.blocks.push(block);
                }
            }
            (4, 2) => {
                // field 4 = repeated BlockPresence
                let (presence_msg, new_pos) = read_length_delimited(data, pos);
                pos = new_pos;
                if let Some(presence) = parse_block_presence(presence_msg) {
                    result.presences.push(presence);
                }
            }
            _ => {
                pos = skip_field(data, pos, wire_type);
            }
        }
    }

    result
}

fn parse_payload_block(data: &[u8]) -> Option<ReceivedBlock> {
    let mut prefix = Vec::new();
    let mut block_data = Vec::new();
    let mut pos = 0;

    while pos < data.len() {
        let (field_num, wire_type, new_pos) = read_tag(data, pos);
        pos = new_pos;

        match (field_num, wire_type) {
            (1, 2) => {
                let (bytes, new_pos) = read_length_delimited(data, pos);
                pos = new_pos;
                prefix = bytes.to_vec();
            }
            (2, 2) => {
                let (bytes, new_pos) = read_length_delimited(data, pos);
                pos = new_pos;
                block_data = bytes.to_vec();
            }
            _ => {
                pos = skip_field(data, pos, wire_type);
            }
        }
    }

    if block_data.is_empty() {
        None
    } else {
        Some(ReceivedBlock { prefix, data: block_data })
    }
}

fn parse_block_presence(data: &[u8]) -> Option<ReceivedPresence> {
    let mut cid_bytes = Vec::new();
    let mut have = false;
    let mut pos = 0;

    while pos < data.len() {
        let (field_num, wire_type, new_pos) = read_tag(data, pos);
        pos = new_pos;

        match (field_num, wire_type) {
            (1, 2) => {
                let (bytes, new_pos) = read_length_delimited(data, pos);
                pos = new_pos;
                cid_bytes = bytes.to_vec();
            }
            (2, 0) => {
                let (val, new_pos) = read_varint(data, pos);
                pos = new_pos;
                have = val == 0; // 0=Have, 1=DontHave
            }
            _ => {
                pos = skip_field(data, pos, wire_type);
            }
        }
    }

    if cid_bytes.is_empty() {
        None
    } else {
        Some(ReceivedPresence { cid_bytes, have })
    }
}

// ── libp2p StreamProtocol codec for Bitswap ──

#[derive(Debug, Clone)]
pub struct BitswapCodec;

#[derive(Debug, Clone)]
pub struct BitswapRequest(pub Vec<u8>);

#[derive(Debug, Clone)]
pub struct BitswapResponse(pub Vec<u8>);

#[async_trait]
impl libp2p::request_response::Codec for BitswapCodec {
    type Protocol = StreamProtocol;
    type Request = BitswapRequest;
    type Response = BitswapResponse;

    async fn read_request<T>(
        &mut self,
        _protocol: &StreamProtocol,
        io: &mut T,
    ) -> io::Result<Self::Request>
    where
        T: AsyncRead + Unpin + Send,
    {
        let mut len_bytes = 0usize;
        let mut msg_len: u64 = 0;
        let mut shift = 0u32;

        // Read varint-prefixed length
        loop {
            let mut byte = [0u8; 1];
            io.read_exact(&mut byte).await?;
            len_bytes += 1;
            msg_len |= ((byte[0] & 0x7F) as u64) << shift;
            if byte[0] & 0x80 == 0 {
                break;
            }
            shift += 7;
            if len_bytes >= 10 {
                return Err(io::Error::new(io::ErrorKind::InvalidData, "varint too long"));
            }
        }

        if msg_len as usize > MAX_MESSAGE_SIZE {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "message too large"));
        }

        let mut buf = vec![0u8; msg_len as usize];
        io.read_exact(&mut buf).await?;
        Ok(BitswapRequest(buf))
    }

    async fn read_response<T>(
        &mut self,
        _protocol: &StreamProtocol,
        io: &mut T,
    ) -> io::Result<Self::Response>
    where
        T: AsyncRead + Unpin + Send,
    {
        // We don't initiate requests, so we rarely read responses,
        // but implement it for completeness
        let mut len_bytes = 0usize;
        let mut msg_len: u64 = 0;
        let mut shift = 0u32;
        loop {
            let mut byte = [0u8; 1];
            io.read_exact(&mut byte).await?;
            len_bytes += 1;
            msg_len |= ((byte[0] & 0x7F) as u64) << shift;
            if byte[0] & 0x80 == 0 { break; }
            shift += 7;
            if len_bytes >= 10 {
                return Err(io::Error::new(io::ErrorKind::InvalidData, "varint too long"));
            }
        }
        let mut buf = vec![0u8; msg_len as usize];
        io.read_exact(&mut buf).await?;
        Ok(BitswapResponse(buf))
    }

    async fn write_request<T>(
        &mut self,
        _protocol: &StreamProtocol,
        io: &mut T,
        req: Self::Request,
    ) -> io::Result<()>
    where
        T: AsyncWrite + Unpin + Send,
    {
        let mut len_buf = Vec::new();
        encode_varint(req.0.len() as u64, &mut len_buf);
        io.write_all(&len_buf).await?;
        io.write_all(&req.0).await?;
        io.close().await?;
        Ok(())
    }

    async fn write_response<T>(
        &mut self,
        _protocol: &StreamProtocol,
        io: &mut T,
        res: Self::Response,
    ) -> io::Result<()>
    where
        T: AsyncWrite + Unpin + Send,
    {
        let mut len_buf = Vec::new();
        encode_varint(res.0.len() as u64, &mut len_buf);
        io.write_all(&len_buf).await?;
        io.write_all(&res.0).await?;
        io.close().await?;
        Ok(())
    }
}
