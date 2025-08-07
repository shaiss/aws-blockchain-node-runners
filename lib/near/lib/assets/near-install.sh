#!/bin/bash
set -euo pipefail

###############################################################################
# NEAR Protocol Installation Script                                          #
# Phase 2A: Dependencies, Rust, Compilation, and neard init                 #
###############################################################################

NEAR_VERSION="${1:-2.6.5}"
NEAR_NETWORK="${2:-mainnet}"

# Source environment from infrastructure stack
if [[ -f /etc/near-environment ]]; then
    source /etc/near-environment
fi

echo "[NEAR-INSTALL] $(date): Starting NEAR installation for version $NEAR_VERSION on network $NEAR_NETWORK"

# Setup logging
exec > >(tee -a /var/log/near-install.log)
exec 2>&1

###############################
# Helper functions            #
###############################
log() {
    echo "[NEAR-INSTALL] $(date '+%Y-%m-%dT%H:%M:%S'): $*"
}

cloudwatch_log() {
    log "$*"
    # Send to CloudWatch if agent is available
    if command -v amazon-cloudwatch-agent-ctl &> /dev/null; then
        logger -t "near-install" "$*"
    fi
}

wait_for_data_device() {
    log "Waiting for data device to be available"
    local timeout=300 # 5 minutes
    local elapsed=0
    
    while [[ $elapsed -lt $timeout ]]; do
        if [[ -b /dev/nvme1n1 ]]; then
            export DATA_DEVICE="/dev/nvme1n1"
            log "Found data device: $DATA_DEVICE"
            return 0
        fi
        
        sleep 5
        elapsed=$((elapsed + 5))
        log "Waiting for data device... ($elapsed/$timeout seconds)"
    done
    
    log "ERROR: Data device not found after $timeout seconds"
    return 1
}

###############################
# Verify prerequisites       #
###############################
log "Verifying infrastructure prerequisites"

# Verify AWS CLI is available
if ! command -v aws &> /dev/null; then
    log "ERROR: AWS CLI not found - infrastructure stack should have installed it"
    exit 1
fi

# Verify data volume is available and mounted
wait_for_data_device

# Check if data volume is mounted, if not mount it
if ! mount | grep -q "/near/$NEAR_NETWORK"; then
    log "Mounting data volume at /near/$NEAR_NETWORK"
    
    # Create mount point
    mkdir -p "/near/$NEAR_NETWORK"
    
    # Check if volume is formatted
    if ! file -s "$DATA_DEVICE" | grep -q "ext4"; then
        log "Formatting data volume with ext4"
        mkfs.ext4 "$DATA_DEVICE" -F
    fi
    
    # Mount the volume
    mount "$DATA_DEVICE" "/near/$NEAR_NETWORK"
    
    # Add to fstab for persistence
    echo "$DATA_DEVICE /near/$NEAR_NETWORK ext4 defaults,nofail 0 2" >> /etc/fstab
    
    log "Data volume mounted successfully"
else
    log "Data volume already mounted"
fi

# Set NEAR_HOME for this network
export NEAR_HOME="/near/$NEAR_NETWORK"
export PATH="/root/.cargo/bin:$PATH"

###############################
# Install system dependencies #
###############################
log "Installing system dependencies"

apt-get update -y
apt-get install -y \
    curl \
    wget \
    build-essential \
    pkg-config \
    libssl-dev \
    git \
    clang \
    llvm \
    protobuf-compiler \
    jq \
    htop \
    unzip

log "System dependencies installed successfully"

###############################
# Install Rust                #
###############################
log "Installing Rust toolchain"

if ! command -v rustc &> /dev/null; then
    log "Installing Rust via rustup"
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
    source ~/.cargo/env
    
    # Verify Rust installation
    rustc --version
    cargo --version
    log "Rust installed successfully: $(rustc --version)"
else
    log "Rust already installed: $(rustc --version)"
fi

# Ensure Rust is in PATH for future commands
export PATH="/root/.cargo/bin:$PATH"

###############################
# Download NEAR source code  #
###############################
log "Downloading NEAR Protocol source code"

cd "$NEAR_HOME"

if [[ ! -d "nearcore" ]]; then
    log "Cloning nearcore repository"
    git clone https://github.com/near/nearcore.git
else
    log "nearcore repository already exists"
fi

cd nearcore

# Checkout specific version (without 'v' prefix)
CHECKOUT_VERSION="${NEAR_VERSION#v}"
log "Checking out NEAR version: $CHECKOUT_VERSION"

# Fetch latest tags
git fetch --tags

# List available tags for debugging
log "Available tags:"
git tag | grep -E "^[0-9]+\.[0-9]+\.[0-9]+" | tail -10

# Checkout the version
if git tag | grep -q "^${CHECKOUT_VERSION}$"; then
    git checkout "$CHECKOUT_VERSION"
    log "Successfully checked out version $CHECKOUT_VERSION"
else
    log "WARNING: Version $CHECKOUT_VERSION not found, using latest"
    git checkout $(git describe --tags --abbrev=0)
fi

# Show current version
log "Current git version: $(git describe --tags)"

###############################
# Compile NEAR binary        #
###############################
log "Starting NEAR binary compilation (this will take 45-60 minutes)"
cloudwatch_log "NEAR compilation started - estimated 45-60 minutes for completion"

# Create compile log
COMPILE_LOG="/var/log/near-compile.log"
exec > >(tee -a "$COMPILE_LOG")
exec 2>&1

log "Compilation output will be logged to: $COMPILE_LOG"

# Set compilation environment
export CARGO_TARGET_DIR="$NEAR_HOME/nearcore/target"
export RUSTFLAGS="-C target-cpu=native"

# Start compilation with explicit PATH
cd "$NEAR_HOME/nearcore"
log "Starting 'make release' in $(pwd)"

# Use absolute path for cargo to avoid PATH issues
if ! /root/.cargo/bin/cargo build -p neard --release; then
    log "ERROR: NEAR compilation failed"
    cloudwatch_log "NEAR compilation FAILED - check logs for details"
    exit 1
fi

log "NEAR binary compilation completed successfully"
cloudwatch_log "NEAR compilation COMPLETED successfully"

# Verify binary was created
NEARD_BINARY="$CARGO_TARGET_DIR/release/neard"
if [[ -f "$NEARD_BINARY" ]]; then
    log "NEAR binary found at: $NEARD_BINARY"
    
    # Show binary info
    ls -la "$NEARD_BINARY"
    "$NEARD_BINARY" --version
    
    # Copy to system path
    cp "$NEARD_BINARY" /usr/local/bin/neard
    chmod +x /usr/local/bin/neard
    
    log "NEAR binary installed to /usr/local/bin/neard"
else
    log "ERROR: NEAR binary not found after compilation"
    exit 1
fi

###############################
# Initialize NEAR node       #
###############################
log "Initializing NEAR node for network: $NEAR_NETWORK"

cd "$NEAR_HOME"

# Initialize node if not already done
if [[ ! -f "$NEAR_HOME/config.json" ]]; then
    log "Running neard init for $NEAR_NETWORK network"
    /usr/local/bin/neard init --chain-id "$NEAR_NETWORK" --download-genesis
    
    log "NEAR node initialized successfully"
else
    log "NEAR node already initialized"
fi

# Verify configuration files
if [[ -f "$NEAR_HOME/config.json" ]]; then
    log "Configuration files verified:"
    ls -la "$NEAR_HOME"/*.json
    
    # Show config summary
    log "Network config: $(jq -r '.chain_id' "$NEAR_HOME/config.json")"
    log "RPC settings: $(jq -r '.rpc' "$NEAR_HOME/config.json")"
else
    log "ERROR: config.json not found after initialization"
    exit 1
fi

###############################
# Prepare systemd service    #
###############################
log "Creating systemd service for NEAR node"

cat > /etc/systemd/system/near.service << EOF
[Unit]
Description=NEAR Protocol Node
After=network.target
Wants=network.target

[Service]
Type=simple
User=root
WorkingDirectory=$NEAR_HOME
Environment=NEAR_HOME=$NEAR_HOME
ExecStart=/usr/local/bin/neard run
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=near

# Resource limits
LimitNOFILE=65536
LimitNPROC=65536

[Install]
WantedBy=multi-user.target
EOF

# Reload systemd
systemctl daemon-reload
systemctl enable near.service

log "NEAR systemd service created and enabled"

###############################
# Create health check script #
###############################
log "Creating health check script"

cat > /usr/local/bin/near-health-check << 'EOF'
#!/bin/bash
# NEAR Node Health Check Script

NEAR_HOME="${NEAR_HOME:-/near/mainnet}"
RPC_URL="http://localhost:3030"

# Check if neard process is running
if ! pgrep -f "neard run" > /dev/null; then
    echo "ERROR: neard process not running"
    exit 1
fi

# Check RPC endpoint
if ! curl -s "$RPC_URL/status" > /dev/null; then
    echo "WARNING: RPC endpoint not responding"
    exit 2
fi

# Get sync status
SYNC_INFO=$(curl -s "$RPC_URL/status" | jq -r '.sync_info')
LATEST_BLOCK=$(echo "$SYNC_INFO" | jq -r '.latest_block_height')
SYNCING=$(echo "$SYNC_INFO" | jq -r '.syncing')

echo "NEAR Node Health Check - $(date)"
echo "Latest Block: $LATEST_BLOCK"
echo "Syncing: $SYNCING"

if [[ "$SYNCING" == "false" ]]; then
    echo "Status: SYNCED"
    exit 0
else
    echo "Status: SYNCING"
    exit 3
fi
EOF

chmod +x /usr/local/bin/near-health-check

log "Health check script created at /usr/local/bin/near-health-check"

###############################
# Installation complete      #
###############################
log "NEAR installation completed successfully"
cloudwatch_log "NEAR INSTALLATION COMPLETE - Ready for sync stack deployment"

# Create completion marker
echo "$(date): NEAR installation completed" > "$NEAR_HOME/install-complete"

log "Installation summary:"
log "- NEAR version: $(/usr/local/bin/neard --version)"
log "- Network: $NEAR_NETWORK"
log "- Home directory: $NEAR_HOME"
log "- Binary location: /usr/local/bin/neard"
log "- Service: near.service (enabled, not started)"
log "- Health check: /usr/local/bin/near-health-check"

log "Ready for NEAR sync stack to start the node and begin state synchronization"