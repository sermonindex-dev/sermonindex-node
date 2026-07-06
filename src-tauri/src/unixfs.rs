/// IPFS UnixFS DAG-PB implementation
///
/// Implements standard IPFS file chunking and reassembly compatible with kubo/go-ipfs:
/// - CIDv1 with SHA-256
/// - 256 KiB fixed-size chunks
/// - Raw leaves (codec 0x55) — leaf blocks are just raw bytes, no protobuf wrapper
/// - DAG-PB root/intermediate nodes (codec 0x70) with UnixFS Data + PBLinks
///
/// A file added here produces the same CID as `ipfs add --cid-version=1 --raw-leaves` in kubo.
///
/// ## Block Layout
///
/// Small file (≤ 256 KiB): single raw block, CID = CIDv1(raw, sha256(data))
///
/// Large file (> 256 KiB):
///   Root: DAG-PB node { UnixFS(type=File, filesize, blocksizes), Links[] }
///   Leaves: raw blocks of ≤ 256 KiB each
///
/// The root node's CID is the "file CID" that represents the whole file.

use cid::Cid;
use multihash::Multihash;
use sha2::{Digest, Sha256};

/// Default chunk size: 256 KiB (matches kubo default)
const CHUNK_SIZE: usize = 262_144;

/// Codec for raw leaf blocks
const RAW_CODEC: u64 = 0x55;

/// Codec for DAG-PB nodes
const DAG_PB_CODEC: u64 = 0x70;

/// SHA-256 multihash code
const SHA2_256: u64 = 0x12;

/// Result of chunking a file: a set of blocks to store and the root CID
pub struct ChunkedFile {
    /// All blocks: (CID string, raw block bytes)
    /// Leaves come first, root node last (for convenient iteration)
    pub blocks: Vec<(String, Vec<u8>)>,
    /// The root CID (= the file's content address)
    pub root_cid: String,
}

/// Chunk a file into standard IPFS UnixFS blocks.
///
/// Returns the root CID and all blocks (leaves + root) that must be stored.
/// Produces CIDs identical to `ipfs add --cid-version=1 --raw-leaves <file>`.
pub fn chunk_file(data: &[u8]) -> ChunkedFile {
    if data.len() <= CHUNK_SIZE {
        // Small file → single raw leaf block
        let cid_str = make_raw_cid(data);
        return ChunkedFile {
            root_cid: cid_str.clone(),
            blocks: vec![(cid_str, data.to_vec())],
        };
    }

    // Large file → chunk into 256 KiB raw leaves + DAG-PB root
    let mut leaves: Vec<(String, Vec<u8>, usize)> = Vec::new(); // (cid, block_data, data_size)
    let mut offset = 0;

    while offset < data.len() {
        let end = (offset + CHUNK_SIZE).min(data.len());
        let chunk = &data[offset..end];
        let cid_str = make_raw_cid(chunk);
        leaves.push((cid_str, chunk.to_vec(), chunk.len()));
        offset = end;
    }

    // Build the DAG-PB root node
    let root_block = build_dag_pb_root(data.len(), &leaves);
    let root_cid = make_dag_pb_cid(&root_block);

    let mut blocks: Vec<(String, Vec<u8>)> = leaves
        .into_iter()
        .map(|(cid, block, _)| (cid, block))
        .collect();
    blocks.push((root_cid.clone(), root_block));

    ChunkedFile { blocks, root_cid }
}

/// Reassemble a file from its blocks.
///
/// Given the root CID and a block-fetching closure, reconstruct the original file.
/// For a single raw leaf, just returns its data.
/// For a DAG-PB root, parses the links and concatenates leaf data.
pub fn reassemble_file(root_cid: &str, get_block: &dyn Fn(&str) -> Option<Vec<u8>>) -> Result<Vec<u8>, String>
{
    let root_data = get_block(root_cid)
        .ok_or_else(|| format!("Root block not found: {}", root_cid))?;

    // Determine codec from CID to know if this is a raw leaf or DAG-PB node
    let cid = root_cid.parse::<Cid>()
        .map_err(|e| format!("Invalid CID: {e}"))?;

    if cid.codec() == RAW_CODEC {
        // Single raw block — the data IS the file
        return Ok(root_data);
    }

    if cid.codec() == DAG_PB_CODEC {
        // DAG-PB node — parse links and collect leaf data
        let links = parse_dag_pb_links(&root_data)?;

        if links.is_empty() {
            // Leaf DAG-PB node with inline data (legacy, non-raw-leaves)
            return parse_unixfs_data(&root_data);
        }

        let mut file_data = Vec::new();
        for link_cid in &links {
            let block = get_block(link_cid)
                .ok_or_else(|| format!("Missing chunk block: {}", link_cid))?;

            // Check if child is raw or DAG-PB
            if let Ok(child_cid) = link_cid.parse::<Cid>() {
                if child_cid.codec() == RAW_CODEC {
                    file_data.extend_from_slice(&block);
                } else {
                    // Recursive: child is another DAG-PB node (for very large files)
                    let child_data = reassemble_file(link_cid, get_block)?;
                    file_data.extend_from_slice(&child_data);
                }
            } else {
                file_data.extend_from_slice(&block);
            }
        }
        return Ok(file_data);
    }

    Err(format!("Unknown codec {} for CID {}", cid.codec(), root_cid))
}

/// Get all CIDs referenced by a root block (for DHT providing and fetching)
pub fn get_block_cids(root_cid: &str, root_data: &[u8]) -> Vec<String> {
    let mut cids = vec![root_cid.to_string()];

    if let Ok(cid) = root_cid.parse::<Cid>() {
        if cid.codec() == DAG_PB_CODEC {
            if let Ok(links) = parse_dag_pb_links(root_data) {
                cids.extend(links);
            }
        }
    }

    cids
}

// ── CID construction ──

fn make_raw_cid(data: &[u8]) -> String {
    let hash = Sha256::digest(data);
    let mh = Multihash::<64>::wrap(SHA2_256 as u64, &hash).expect("valid multihash");
    Cid::new_v1(RAW_CODEC, mh).to_string()
}

fn make_dag_pb_cid(block: &[u8]) -> String {
    let hash = Sha256::digest(block);
    let mh = Multihash::<64>::wrap(SHA2_256 as u64, &hash).expect("valid multihash");
    Cid::new_v1(DAG_PB_CODEC, mh).to_string()
}

// ── DAG-PB / UnixFS protobuf encoding ──
// Hand-encoded to match kubo's exact byte output without codegen.

/// Build a DAG-PB root node for a chunked file.
///
/// PBNode {
///   Data: UnixFS { type=File, filesize=total, blocksizes=[chunk_sizes] }
///   Links: [ PBLink { Hash=leaf_cid, Tsize=leaf_block_size } ... ]
/// }
fn build_dag_pb_root(total_size: usize, leaves: &[(String, Vec<u8>, usize)]) -> Vec<u8> {
    // Step 1: Build UnixFS Data message
    let unixfs_data = build_unixfs_file_node(total_size, leaves);

    // Step 2: Build PBLinks for each leaf
    let mut links_encoded: Vec<Vec<u8>> = Vec::new();
    for (cid_str, block_data, _data_size) in leaves {
        let cid = cid_str.parse::<Cid>().expect("valid CID");
        let cid_bytes = cid.to_bytes();
        let tsize = block_data.len() as u64;

        let mut link = Vec::new();
        // field 1 = Hash (CID bytes)
        write_tag(1, 2, &mut link);
        write_length_delimited(&cid_bytes, &mut link);
        // field 2 = Name (empty string for file chunks)
        // Omit — empty name is the default
        // field 3 = Tsize (cumulative size of target DAG)
        write_tag(3, 0, &mut link);
        encode_varint(tsize, &mut link);

        links_encoded.push(link);
    }

    // Step 3: Encode PBNode { Links (field 2), Data (field 1) }
    // IMPORTANT: In DAG-PB, Links (field 2) MUST come before Data (field 1) in serialization.
    // This is due to a historical go-protobuf encoder ordering that became canonical.
    let mut node = Vec::new();

    // Links first (field 2, repeated)
    for link in &links_encoded {
        write_tag(2, 2, &mut node);
        write_length_delimited(link, &mut node);
    }

    // Data second (field 1)
    write_tag(1, 2, &mut node);
    write_length_delimited(&unixfs_data, &mut node);

    node
}

/// Build UnixFS Data message for a file root node:
/// message Data { Type=File(2), filesize=total, blocksizes=[sizes] }
fn build_unixfs_file_node(total_size: usize, leaves: &[(String, Vec<u8>, usize)]) -> Vec<u8> {
    let mut data = Vec::new();

    // field 1 = Type (enum) — File = 2
    write_tag(1, 0, &mut data);
    encode_varint(2, &mut data);

    // field 2 = Data (bytes) — empty for root of chunked file
    // Omit

    // field 3 = filesize (uint64)
    write_tag(3, 0, &mut data);
    encode_varint(total_size as u64, &mut data);

    // field 4 = blocksizes (repeated uint64) — size of each child's DATA (not block size)
    for (_cid, _block, data_size) in leaves {
        write_tag(4, 0, &mut data);
        encode_varint(*data_size as u64, &mut data);
    }

    data
}

// ── DAG-PB parsing (for reassembly) ──

/// Parse PBLinks from a DAG-PB encoded block, returning child CID strings.
fn parse_dag_pb_links(block: &[u8]) -> Result<Vec<String>, String> {
    let mut links = Vec::new();
    let mut pos = 0;

    while pos < block.len() {
        let (field_num, wire_type, new_pos) = read_tag(block, pos);
        pos = new_pos;

        match (field_num, wire_type) {
            (2, 2) => {
                // PBLink (length-delimited)
                let (link_data, new_pos) = read_length_delimited(block, pos);
                pos = new_pos;
                // Parse PBLink to extract Hash (field 1)
                if let Some(cid_str) = parse_pb_link_hash(link_data) {
                    links.push(cid_str);
                }
            }
            (1, 2) => {
                // Data field — skip
                let (_data, new_pos) = read_length_delimited(block, pos);
                pos = new_pos;
            }
            (_, 0) => {
                // Varint — skip
                let (_, new_pos) = read_varint(block, pos);
                pos = new_pos;
            }
            (_, 2) => {
                // Unknown length-delimited — skip
                let (_, new_pos) = read_length_delimited(block, pos);
                pos = new_pos;
            }
            _ => {
                return Err(format!("Unexpected wire type {} at pos {}", wire_type, pos));
            }
        }
    }

    Ok(links)
}

/// Parse the Hash field from a PBLink message
fn parse_pb_link_hash(data: &[u8]) -> Option<String> {
    let mut pos = 0;

    while pos < data.len() {
        let (field_num, wire_type, new_pos) = read_tag(data, pos);
        pos = new_pos;

        match (field_num, wire_type) {
            (1, 2) => {
                // Hash = CID bytes
                let (cid_bytes, new_pos) = read_length_delimited(data, pos);
                pos = new_pos;
                // Parse CID from raw bytes
                if let Ok(cid) = Cid::try_from(cid_bytes) {
                    return Some(cid.to_string());
                }
                if let Ok(cid) = Cid::read_bytes(std::io::Cursor::new(cid_bytes)) {
                    return Some(cid.to_string());
                }
                return None;
            }
            (_, 0) => {
                let (_, new_pos) = read_varint(data, pos);
                pos = new_pos;
            }
            (_, 2) => {
                let (_, new_pos) = read_length_delimited(data, pos);
                pos = new_pos;
            }
            _ => break,
        }
    }

    None
}

/// Extract inline data from a UnixFS Data message (for legacy non-raw-leaves nodes)
fn parse_unixfs_data(block: &[u8]) -> Result<Vec<u8>, String> {
    // First parse PBNode to get Data field
    let mut pos = 0;
    let mut pb_data: Option<&[u8]> = None;

    while pos < block.len() {
        let (field_num, wire_type, new_pos) = read_tag(block, pos);
        pos = new_pos;

        match (field_num, wire_type) {
            (1, 2) => {
                let (data, new_pos) = read_length_delimited(block, pos);
                pos = new_pos;
                pb_data = Some(data);
            }
            (2, 2) => {
                let (_, new_pos) = read_length_delimited(block, pos);
                pos = new_pos;
            }
            (_, 0) => {
                let (_, new_pos) = read_varint(block, pos);
                pos = new_pos;
            }
            (_, 2) => {
                let (_, new_pos) = read_length_delimited(block, pos);
                pos = new_pos;
            }
            _ => break,
        }
    }

    let unixfs_msg = pb_data.ok_or("No Data field in PBNode")?;

    // Parse UnixFS Data message to get field 2 (Data bytes)
    let mut pos = 0;
    while pos < unixfs_msg.len() {
        let (field_num, wire_type, new_pos) = read_tag(unixfs_msg, pos);
        pos = new_pos;

        match (field_num, wire_type) {
            (2, 2) => {
                let (data, _) = read_length_delimited(unixfs_msg, pos);
                return Ok(data.to_vec());
            }
            (_, 0) => {
                let (_, new_pos) = read_varint(unixfs_msg, pos);
                pos = new_pos;
            }
            (_, 2) => {
                let (_, new_pos) = read_length_delimited(unixfs_msg, pos);
                pos = new_pos;
            }
            _ => break,
        }
    }

    Err("No Data bytes in UnixFS message".to_string())
}

// ── Low-level protobuf helpers ──

fn write_tag(field: u32, wire_type: u32, buf: &mut Vec<u8>) {
    encode_varint(((field << 3) | wire_type) as u64, buf);
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

fn write_length_delimited(data: &[u8], buf: &mut Vec<u8>) {
    encode_varint(data.len() as u64, buf);
    buf.extend_from_slice(data);
}

fn read_tag(data: &[u8], pos: usize) -> (u32, u32, usize) {
    let (val, new_pos) = read_varint(data, pos);
    let field = (val >> 3) as u32;
    let wire_type = (val & 0x07) as u32;
    (field, wire_type, new_pos)
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
        if shift >= 64 { break; }
    }
    (result, pos)
}

fn read_length_delimited(data: &[u8], pos: usize) -> (&[u8], usize) {
    let (len, new_pos) = read_varint(data, pos);
    let len = len as usize;
    let end = (new_pos + len).min(data.len());
    (&data[new_pos..end], end)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn small_file_single_block() {
        let data = b"Hello, IPFS world!";
        let result = chunk_file(data);
        assert_eq!(result.blocks.len(), 1);
        assert_eq!(result.blocks[0].1, data);
        // Should be raw codec CID
        let cid: Cid = result.root_cid.parse().unwrap();
        assert_eq!(cid.codec(), RAW_CODEC);
    }

    #[test]
    fn large_file_chunked() {
        // 600 KB file → 3 chunks (256 + 256 + 88 KB)
        let data = vec![0xABu8; 600 * 1024];
        let result = chunk_file(&data);
        // 3 leaf blocks + 1 root
        assert_eq!(result.blocks.len(), 4);
        // Root should be DAG-PB
        let root_cid: Cid = result.root_cid.parse().unwrap();
        assert_eq!(root_cid.codec(), DAG_PB_CODEC);
    }

    #[test]
    fn round_trip() {
        let data = vec![42u8; 600 * 1024];
        let chunked = chunk_file(&data);

        // Build a block map
        let blocks: std::collections::HashMap<String, Vec<u8>> = chunked.blocks
            .into_iter()
            .collect();

        let reassembled = reassemble_file(&chunked.root_cid, &|cid| {
            blocks.get(cid).cloned()
        }).unwrap();

        assert_eq!(reassembled, data);
    }

    #[test]
    fn small_file_round_trip() {
        let data = b"small file";
        let chunked = chunk_file(data);
        let blocks: std::collections::HashMap<String, Vec<u8>> = chunked.blocks
            .into_iter()
            .collect();
        let reassembled = reassemble_file(&chunked.root_cid, &|cid| {
            blocks.get(cid).cloned()
        }).unwrap();
        assert_eq!(reassembled, data.to_vec());
    }

    #[test]
    fn deterministic_cid() {
        let data = b"same content, same CID";
        let r1 = chunk_file(data);
        let r2 = chunk_file(data);
        assert_eq!(r1.root_cid, r2.root_cid);
    }

    #[test]
    fn exactly_one_chunk() {
        // Exactly 256 KiB → single raw block, no DAG-PB wrapper
        let data = vec![0u8; CHUNK_SIZE];
        let result = chunk_file(&data);
        assert_eq!(result.blocks.len(), 1);
        let cid: Cid = result.root_cid.parse().unwrap();
        assert_eq!(cid.codec(), RAW_CODEC);
    }

    #[test]
    fn one_byte_over_chunk() {
        // 256 KiB + 1 byte → 2 leaves + 1 root
        let data = vec![0u8; CHUNK_SIZE + 1];
        let result = chunk_file(&data);
        assert_eq!(result.blocks.len(), 3); // 2 leaves + 1 root
        let root_cid: Cid = result.root_cid.parse().unwrap();
        assert_eq!(root_cid.codec(), DAG_PB_CODEC);
    }
}
