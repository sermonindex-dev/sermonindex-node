#!/usr/bin/env bash
# Build + install the SermonIndex Node Software on a Raspberry Pi 5 (ARM64, Debian Trixie).
# Run this ON THE PI after rsyncing the source to ~/sermonindex-node.
#   bash ~/pi-build-node.sh
set -euo pipefail
SRC="${1:-$HOME/sermonindex-node}"
log(){ printf '\n\033[1;33m== %s ==\033[0m\n' "$*"; }

[ -f "$SRC/package.json" ] || { echo "Source not found at $SRC — rsync it from the Mac first."; exit 1; }

log "Adding 4 GB build swap (only if total swap < 5 GB)"
if [ "$(free -m | awk '/Swap:/{print $2}')" -lt 5000 ]; then
  if [ ! -e /swapfile2 ]; then
    sudo fallocate -l 4G /swapfile2 2>/dev/null || sudo dd if=/dev/zero of=/swapfile2 bs=1M count=4096
    sudo chmod 600 /swapfile2; sudo mkswap /swapfile2
  fi
  sudo swapon /swapfile2 2>/dev/null || true
fi
free -h

log "Installing build dependencies (apt)"
sudo apt-get update
sudo apt-get install -y build-essential curl wget file git pkg-config \
  libwebkit2gtk-4.1-dev libssl-dev libxdo-dev librsvg2-dev \
  libayatana-appindicator3-dev libsoup-3.0-dev libjavascriptcoregtk-4.1-dev

log "Ensuring Rust + Node are available"
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
command -v cargo >/dev/null || { echo "Rust not found — run rustup first."; exit 1; }
command -v node  >/dev/null || sudo apt-get install -y nodejs npm
echo "node $(node -v) | npm $(npm -v) | $(cargo --version)"

log "Installing JS dependencies (npm ci)"
cd "$SRC"
npm ci

log "Building the app — this compiles the Rust backend and takes a while"
export CARGO_BUILD_JOBS=2          # cap parallelism so 4 GB RAM doesn't OOM
npm run tauri build

log "Installing the built package"
DEB="$(find src-tauri/target -path '*bundle/deb/*.deb' 2>/dev/null | head -1 || true)"
if [ -n "${DEB:-}" ]; then
  sudo apt-get install -y "$DEB"
  echo "Installed: $DEB"
else
  echo "No .deb found — build may have produced an AppImage instead:"
  find src-tauri/target -path '*bundle*' -iname '*.AppImage' 2>/dev/null || true
fi

log "Done"
echo "Next: launch it from the desktop, point storage at this drive on the Seed Node page,"
echo "and start the Audio-only (~400 GB) download."
