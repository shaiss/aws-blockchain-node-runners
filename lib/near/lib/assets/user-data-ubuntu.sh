#!/bin/bash
set -euo pipefail

###############################################################################
# NEAR Node Runner – Ubuntu 24.04 LTS bootstrap script                      #
###############################################################################
# Follows /lib/ example proven patterns + NEAR documentation requirements    #
# https://near-nodes.io/rpc/run-rpc-node-without-nearup                      #
# Fixed based on real-world Ubuntu testing feedback                          #
# 
# ARCHITECTURE FIXES APPLIED:
# - AWS CLI v2 installation moved to bootstrap script (proven method)
# - Dynamic data volume detection with 5-minute timeout
# - Robust CloudWatch agent configuration with S3 fallback
# - Proper NVMe device detection for m7a.2xlarge instances
# - Fixed environment variable sourcing (bootstrap script sets up environment)
###############################################################################

###############################
# Source environment setup    #
###############################
# Environment variables are set by the bootstrap script in /etc/environment
# Source them to make them available in this script
if [[ -f /etc/environment ]]; then
    source /etc/environment
fi

# Also check for CDK environment file if it exists from previous runs
if [[ -f /etc/cdk_environment ]]; then
    source /etc/cdk_environment
fi

# Verify required variables are set
if [[ -z "${AWS_REGION:-}" ]]; then
    echo "ERROR: AWS_REGION not set. Environment not properly configured by bootstrap script."
    exit 1
fi

###############################
# PHASE 1C: Ultra-Early cfn-signal #
###############################
# Send CloudFormation signal immediately after bootstrap completes
# This proves automation works independent of volume/compilation issues
if [[ "$STACK_ID" != "none" ]]; then
  echo "[NEAR-BOOTSTRAP] $(date '+%Y-%m-%dT%H:%M:%S') PHASE 1C: Sending ULTRA-EARLY CloudFormation signal"
  echo "[NEAR-BOOTSTRAP] $(date '+%Y-%m-%dT%H:%M:%S') Bootstrap complete, AWS CLI ready, environment configured - signaling success"
  cfn-signal -e 0 --stack "$STACK_NAME" --resource "$RESOURCE_ID" --region "$AWS_REGION" || true
  echo "[NEAR-BOOTSTRAP] $(date '+%Y-%m-%dT%H:%M:%S') ULTRA-EARLY cfn-signal sent - CloudFormation will complete while NEAR setup continues"
fi

###############################
# Helper variables & funcs    #
###############################
ARCH=$(uname -m)
NEAR_HOME="/near/$NEAR_NETWORK"
BIN_DIR="/usr/local/bin"

# Wait for data volume attachment (CDK attaches as /dev/sdf but maps to NVMe device)
wait_for_data_device() {
    local max_wait=300  # 5 minutes maximum wait
    local wait_interval=10
    local elapsed=0
    local root_device=$(df / | tail -1 | awk '{print $1}' | sed 's/[0-9]*$//')
    
    log "Root device detected as: $root_device"
    log "Waiting for data volume attachment (max ${max_wait}s)..."
    
    while [[ $elapsed -lt $max_wait ]]; do
        # List all available block devices for debugging
        log "Available devices at ${elapsed}s: $(lsblk -d -n -o NAME | tr '\n' ' ')"
        
        # Find NVMe devices that are not the root device and actually exist
        for device in /dev/nvme*n1; do
            # Use glob expansion check to avoid false positives
            if [[ "$device" != "/dev/nvme*n1" && -b "$device" && "$device" != "$root_device" ]]; then
                # Verify device is a block device and not mounted
                if ! mount | grep -q "$device"; then
                    log "Data device found: $device"
                    echo "$device"
                    return 0
                fi
            fi
        done
        
        log "No data device found yet, waiting ${wait_interval}s (elapsed: ${elapsed}s)..."
        sleep $wait_interval
        elapsed=$((elapsed + wait_interval))
    done
    
    log "ERROR: No data device found after ${max_wait}s wait. Available devices:"
    lsblk
    log "CloudFormation may still be creating the data volume, or attachment failed."
    return 1
}

log() { echo "[NEAR-BOOTSTRAP] $(date '+%Y-%m-%dT%H:%M:%S') $*"; }

# Wait for the data device to be attached
DATA_DEVICE=$(wait_for_data_device)
if [[ $? -ne 0 ]]; then
    log "FATAL: Could not detect data device after timeout. NEAR requires dedicated data volume."
    log "Check CloudFormation stack status for data volume creation/attachment issues."
    exit 1
fi

log "Using data device: $DATA_DEVICE"

# Temporary cloudwatch_log function (will be redefined later with full functionality)
cloudwatch_log() { echo "$*"; }

# CloudWatch logging setup
LOG_GROUP="/aws/ec2/user-data"
LOG_STREAM="$(date '+%Y-%m-%d')_$(hostname)_$(date '+%H-%M-%S')"

###############################
# System preparation         #
###############################
log "Starting NEAR node setup - Version: $NEAR_VERSION, Network: $NEAR_NETWORK"

log "Updating system packages (Ubuntu)"
apt-get -yqq update

# Install required packages per NEAR documentation
log "Installing required packages for NEAR node"
apt-get update -yqq
apt-get install -yqq \
    git \
    binutils-dev \
    libcurl4-openssl-dev \
    zlib1g-dev \
    libdw-dev \
    libiberty-dev \
    cmake \
    gcc \
    g++ \
    python3 \
    python3-pip \
    docker.io \
    protobuf-compiler \
    libssl-dev \
    pkg-config \
    clang \
    llvm \
    unzip \
    curl \
    jq

# AWS CLI is now installed by the bootstrap script
log "Verifying AWS CLI availability: $(aws --version)"
cloudwatch_log "AWS CLI available: $(aws --version)"

# CloudWatch agent installation for Ubuntu
# Following AWS best practices per: https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/Install-CloudWatch-Agent-New-Instances-CloudFormation.html
log "Installing CloudWatch agent"

# Download and install CloudWatch agent
wget -q https://s3.amazonaws.com/amazoncloudwatch-agent/ubuntu/amd64/latest/amazon-cloudwatch-agent.deb -O /tmp/amazon-cloudwatch-agent.deb
dpkg -i /tmp/amazon-cloudwatch-agent.deb

# Download CloudWatch agent config from S3 assets (or create default if missing)
if /usr/local/bin/aws s3 cp "$ASSETS_S3_PATH/amazon-cloudwatch-agent.json" /opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json --region "$AWS_REGION" 2>/dev/null; then
    log "CloudWatch config downloaded from S3"
else
    log "CloudWatch config not found in S3, creating basic config"
    # Create a basic CloudWatch agent configuration
    cat > /opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json << 'EOF'
{
    "agent": {
        "metrics_collection_interval": 300,
        "run_as_user": "cwagent"
    },
    "logs": {
        "logs_collected": {
            "files": {
                "collect_list": [
                    {
                        "file_path": "/var/log/near-setup-hotfixed.log",
                        "log_group_name": "/aws/ec2/near-setup",
                        "log_stream_name": "{instance_id}-near-setup"
                    },
                    {
                        "file_path": "/var/log/near-node.log", 
                        "log_group_name": "/aws/ec2/near-node",
                        "log_stream_name": "{instance_id}-near-node"
                    }
                ]
            }
        }
    },
    "metrics": {
        "namespace": "NEAR/Node",
        "metrics_collected": {
            "cpu": {
                "measurement": ["cpu_usage_idle", "cpu_usage_system", "cpu_usage_user"],
                "metrics_collection_interval": 300
            },
            "disk": {
                "measurement": ["used_percent"],
                "metrics_collection_interval": 300,
                "resources": ["*"]
            },
            "mem": {
                "measurement": ["mem_used_percent"],
                "metrics_collection_interval": 300
            }
        }
    }
}
EOF
fi

# Start CloudWatch agent with configuration
/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl -a fetch-config -m ec2 -c file:/opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json -s

log "CloudWatch agent installation completed"

# Set up CloudWatch logging early
/usr/local/bin/aws logs create-log-group --log-group-name "$LOG_GROUP" --region "$AWS_REGION" 2>/dev/null || true
/usr/local/bin/aws logs create-log-stream --log-group-name "$LOG_GROUP" --log-stream-name "$LOG_STREAM" --region "$AWS_REGION" 2>/dev/null || true

cloudwatch_log() {
    local message="$*"
    echo "$message"
    /usr/local/bin/aws logs put-log-events \
        --log-group-name "$LOG_GROUP" \
        --log-stream-name "$LOG_STREAM" \
        --log-events timestamp=$(date +%s)000,message="$message" \
        --region "$AWS_REGION" 2>/dev/null || true
}

log "Starting NEAR node setup - Ubuntu 24.04 LTS - Version: $NEAR_VERSION, Network: $NEAR_NETWORK"
cloudwatch_log "Starting NEAR node setup - Ubuntu 24.04 LTS - Version: $NEAR_VERSION, Network: $NEAR_NETWORK"

###############################
# Optional: limit egress      #
###############################
if [[ "$LIMIT_OUT_TRAFFIC_MBPS" != "0" ]]; then
  log "Configuring egress limit to $LIMIT_OUT_TRAFFIC_MBPS Mbps"
  cloudwatch_log "Configuring traffic limit: $LIMIT_OUT_TRAFFIC_MBPS Mbps"
  tc qdisc add dev eth0 root tbf rate "$LIMIT_OUT_TRAFFIC_MBPS mbit" burst 32kbit latency 400ms || true
fi

###############################
# Prepare data volume         #
###############################

# Show available storage devices
lsblk
log "Available storage devices: $(lsblk)"
cloudwatch_log "Available storage devices: $(lsblk)"

###############################
# Volume setup completed      #
###############################
# NOTE: cfn-signal already sent ultra-early (Phase 1C) - CloudFormation completed
# Data volume ready, continuing with NEAR installation

# Check the filesystem on the data device
sudo file -s "$DATA_DEVICE"

# Format the device only if it is unformatted ("data")
if sudo file -s "$DATA_DEVICE" | grep -q "data"; then
  log "Formatting $DATA_DEVICE as ext4"
  cloudwatch_log "Formatting $DATA_DEVICE as ext4"
  sudo mkfs.ext4 "$DATA_DEVICE"
else
  log "$DATA_DEVICE already has a filesystem, skipping format"
  cloudwatch_log "$DATA_DEVICE already has a filesystem, skipping format"
fi

# Create mount point if it doesn't exist
sudo mkdir -p "$NEAR_HOME"

# Mount the data device
sudo mount "$DATA_DEVICE" "$NEAR_HOME"

# Set ownership to ssm-user
sudo chown -R ssm-user:ssm-user "$NEAR_HOME"

# Make the mount persistent
echo "$DATA_DEVICE $NEAR_HOME ext4 defaults,nofail 0 2" | sudo tee -a /etc/fstab

# Verify setup
df -h | grep "$(basename "$DATA_DEVICE")"
ls -la "$NEAR_HOME"

log "Data volume setup complete"
cloudwatch_log "Data volume setup complete"

###############################
# Install nearcore binary     #
###############################
# Install neard from source using the recommended git-based method
log "Cloning nearcore repository and checking out version $NEAR_VERSION"
cloudwatch_log "Cloning nearcore repository and checking out version $NEAR_VERSION"

mkdir -p /near/mainnet/
cd /near/mainnet/
git clone https://github.com/near/nearcore
cd nearcore
git fetch origin --tags

sudo git checkout tags/"$NEAR_VERSION" -b mynode

# Optionally, add safe.directory if needed for SSM/automation environments
# git config --global --add safe.directory /var/snap/amazon-ssm-agent/11320/nearcore

# Install Rust toolchain for building nearcore
log "Installing Rust toolchain (rustup, cargo) for nearcore build"
cloudwatch_log "Installing Rust toolchain for nearcore build"

# Install Rust system-wide for all users
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y

# Source the cargo environment
source ~/.cargo/env

# Update Rust to latest stable
rustup update

# Make Rust available system-wide by adding to PATH
echo 'export PATH="$HOME/.cargo/bin:$PATH"' >> /etc/profile.d/rust.sh
chmod +x /etc/profile.d/rust.sh

# Also make available for current session and near user
export PATH="$HOME/.cargo/bin:$PATH"

# Verify Rust installation
cargo --version  # Should be 1.85 or newer
CARGO_VERSION=$(cargo --version)
log "Cargo version: $CARGO_VERSION"
cloudwatch_log "Cargo version: $CARGO_VERSION"

# Ensure near user has access to Rust tools
cp -r ~/.cargo /near/mainnet/ || true
chown -R near:near /near/mainnet/.cargo || true


# Build neard binary (assumes build dependencies are already installed)
log "Building neard binary from source"
cloudwatch_log "Building neard binary from source"

# Create build log file for CloudWatch monitoring  
mkdir -p /near/mainnet/nearcore
BUILD_LOG="/near/mainnet/nearcore/build.log"

# Redirect build output to log file AND console for CloudWatch monitoring
{
    echo "$(date): Starting NEAR binary compilation"
    # Ensure Rust is in PATH for compilation
    export PATH="$HOME/.cargo/bin:$PATH"
    source ~/.cargo/env 2>/dev/null || true
    make release 2>&1 | tee >(while read -r line; do
        echo "$(date '+%Y-%m-%d %H:%M:%S'): $line"
        cloudwatch_log "BUILD: $line"
    done)
    echo "$(date): NEAR binary compilation completed with exit code: ${PIPESTATUS[0]}"
} >> "$BUILD_LOG" 2>&1

# Ensure neard binary is in PATH and working
export PATH="/near/mainnet/nearcore/target/release:$PATH"
if ! neard --version; then
    log "NEAR binary installation failed"
    cloudwatch_log "ERROR: NEAR binary installation failed"
    cfn-signal -e 1 --stack "$STACK_NAME" --resource "$RESOURCE_ID" --region "$AWS_REGION" || true
    exit 1
fi

# Copy binary to system PATH for convenience
cp /near/mainnet/nearcore/target/release/neard /usr/local/bin/neard
chmod +x /usr/local/bin/neard

NEAR_BINARY_VERSION=$(neard --version)
log "NEAR binary installed successfully: $NEAR_BINARY_VERSION"
cloudwatch_log "NEAR binary installed successfully: $NEAR_BINARY_VERSION"

###############################
# Signal CloudFormation early #
###############################
# Following Solana/Base pattern: Signal success after infrastructure ready, before blockchain sync
# This allows CloudFormation to complete in ~60 minutes while NEAR state sync continues in background
if [[ "$STACK_ID" != "none" ]]; then
  log "Signalling CloudFormation success - infrastructure ready"
  cloudwatch_log "Infrastructure deployment completed successfully - signaling CloudFormation early"
  cloudwatch_log "NEAR binary compiled and ready - blockchain sync will continue in background"
  cfn-signal -e 0 --stack "$STACK_NAME" --resource "$RESOURCE_ID" --region "$AWS_REGION" || true
fi

###############################
# INIT chain configuration   #
###############################
log "Initializing chain configuration"
cloudwatch_log "Initializing chain configuration"

# Set this variable to either "mainnet" or "testnet"
MAINNET_RPC_ENDPOINTS=(
  "https://1rpc.io/near"
  "https://near.blockpi.network/v1/rpc/public"
  "https://near.drpc.org"
  "https://rpc.web4.near.page"
  "https://free.rpc.fastnear.com"
  "https://near.rpc.grove.city/v1/01fdb492"
  "https://near.lava.build:443"
  "https://endpoints.omniatech.io/v1/near/mainnet/public"
  "https://rpc.ankr.com/near"
  "https://getblock.io/nodes/near/"
  # "https://allthatnode.com/protocol/near.dsrv"        # archival only, not public
  # "https://api.seracle.com/saas/baas/rpc/near/mainnet/public/" # not confirmed public
  # "https://near.lavenderfive.com/"                   # no public/mainnet endpoint in table
  # "https://nodereal.io/api-marketplace/near-rpc"     # not confirmed public
  # "https://near.nownodes.io/"                        # not confirmed public
  # "https://www.quicknode.com/chains/near"            # requires account
  # "https://near-mainnet.gateway.tatum.io/"           # not confirmed public
)

TESTNET_RPC_ENDPOINTS=(
  "https://rpc.testnet.near.org"
  "https://near-testnet.blockpi.network/v1/rpc/public"
  "https://testnet.drpc.org"
  "https://testnet.lava.build:443"
  "https://testnet.ankr.com/near"
  "https://endpoints.omniatech.io/v1/near/testnet/public"
  "https://testnet.rpc.grove.city/v1/01fdb492"
  # "https://rpc.testnet.web4.near.page"      # doesn't exist as of 2024
  # "https://testnet.free.rpc.fastnear.com"   # not confirmed to exist
  # "https://testnet.lavenderfive.com/"       # not public/testnet endpoint in table
  # "https://getblock.io/nodes/near/testnet/" # not confirmed public
)

# Select array based on the value of $network
if [[ "$NEAR_NETWORK" == "testnet" ]]; then
  RPC_ENDPOINTS=("${TESTNET_RPC_ENDPOINTS[@]}")
else
  RPC_ENDPOINTS=("${MAINNET_RPC_ENDPOINTS[@]}")
fi

# Query all providers and aggregate boot nodes
ALL_BOOT_NODES=""
for endpoint in "${RPC_ENDPOINTS[@]}"; do
  echo "Querying $endpoint..."
  NODES=$(curl -s -m 10 -X POST "$endpoint" -H "Content-Type: application/json" -d '{
    "jsonrpc": "2.0",
    "method": "network_info",
    "params": [],
    "id": "dontcare"
  }' | jq -r '.result.active_peers as $list1 | .result.known_producers as $list2 |
    $list1[] as $active_peer | $list2[] |
    select(.peer_id == $active_peer.id) |
    "\(.peer_id)@\($active_peer.addr)"' 2>/dev/null | paste -sd "," -)
  
  if [ ! -z "$NODES" ]; then
    ALL_BOOT_NODES="$ALL_BOOT_NODES,$NODES"
  fi
done

# Remove duplicates and leading comma
BOOT_NODES=$(echo "$ALL_BOOT_NODES" | tr ',' '\n' | sort -u | grep -v '^$' | paste -sd "," -)

echo "Found $(echo $BOOT_NODES | tr ',' '\n' | wc -l) unique boot nodes from multiple providers"

# Initialize with boot nodes in one
/near/mainnet/nearcore/target/release/neard --home /near/mainnet/data init --chain-id "$NEAR_NETWORK" --download-genesis --download-config rpc --boot-nodes "$BOOT_NODES"

# Verify it worked
echo "Boot nodes configured:"
grep "boot_nodes" /near/mainnet/data/config.json
log "Boot nodes configured: $BOOT_NODES"
cloudwatch_log "Boot nodes configured: $BOOT_NODES"


# Configure for RPC node (set tracked_shards as per NEAR docs)
log "Configuring for RPC node (tracking all shards)"
cloudwatch_log "Configuring NEAR node for RPC mode with tracked_shards=[0]"
cd /near/mainnet/data
jq '.tracked_shards = [0]' config.json > config.json.tmp && mv config.json.tmp config.json


###############################
# System user & permissions   #
###############################
log "Creating near system user"
cloudwatch_log "Setting up near system user and permissions"

# Add near user and set permissions
adduser --system --home "$NEAR_HOME" --shell /bin/false --group near || true
chown -R near:near "$NEAR_HOME"

###############################
# Systemd service             #
###############################
log "Creating systemd service for NEAR node"
cloudwatch_log "Setting up systemd service for NEAR daemon"

cat >/etc/systemd/system/near.service <<SERVICE
[Unit]
Description=NEAR Node
After=network.target

[Service]
Type=simple
User=near
Group=near
WorkingDirectory=$NEAR_HOME
ExecStart=$BIN_DIR/neard --home $NEAR_HOME/data run --network-id $NEAR_NETWORK
Restart=always
RestartSec=10
LimitNOFILE=1048576
LimitNPROC=32768

# Enhanced logging for CloudWatch monitoring
StandardOutput=append:/var/log/near-node.log
StandardError=append:/var/log/near-node.log
SyslogIdentifier=near-node

# Environment variables for better logging
Environment="RUST_LOG=nearcore=info,near=info"
Environment="RUST_BACKTRACE=1"

[Install]
WantedBy=multi-user.target
SERVICE

systemctl daemon-reload
systemctl enable near.service

###############################
# CloudWatch Agent setup     #
###############################
# CloudWatch agent installation and configuration is now handled by CDK CloudFormation Init
# This follows AWS best practices per the CloudFormation documentation:
# https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/Install-CloudWatch-Agent-New-Instances-CloudFormation.html
log "CloudWatch agent installation and configuration handled by CDK CloudFormation Init"
cloudwatch_log "CloudWatch agent managed via CloudFormation - skipping manual setup"

###############################
# Health check endpoint       #
###############################
log "Setting up health check endpoint"
cloudwatch_log "Creating health check endpoint on port 8080"

cat >/usr/local/bin/near-health-server.py <<'HEALTH'
#!/usr/bin/env python3
import http.server
import socketserver
import json
import subprocess
import os

PORT = 8080

class HealthHandler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path == '/status' or self.path == '/health':
            try:
                # Check if NEAR service is running
                result = subprocess.run(['systemctl', 'is-active', 'near.service'], 
                                      capture_output=True, text=True)
                is_running = result.returncode == 0
                
                # Get NEAR node status if running
                node_status = "unknown"
                if is_running:
                    try:
                        rpc_result = subprocess.run(['curl', '-s', 'http://localhost:3030/status'], 
                                                  capture_output=True, text=True, timeout=5)
                        if rpc_result.returncode == 0:
                            node_status = "rpc_responding"
                    except:
                        node_status = "rpc_not_ready"
                
                self.send_response(200 if is_running else 503)
                self.send_header('Content-type', 'application/json')
                self.end_headers()
                
                response = {
                    'status': 'healthy' if is_running else 'unhealthy',
                    'service': 'near',
                    'running': is_running,
                    'node_status': node_status
                }
                self.wfile.write(json.dumps(response).encode())
            except Exception as e:
                self.send_response(500)
                self.send_header('Content-type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({'error': str(e)}).encode())
        else:
            self.send_response(404)
            self.end_headers()

with socketserver.TCPServer(("", PORT), HealthHandler) as httpd:
    httpd.serve_forever()
HEALTH

chmod +x /usr/local/bin/near-health-server.py

# Create systemd service for health endpoint
cat >/etc/systemd/system/near-health.service <<SERVICE
[Unit]
Description=NEAR Health Check Endpoint
After=network.target

[Service]
Type=simple
ExecStart=/usr/local/bin/near-health-server.py
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
SERVICE

systemctl daemon-reload
systemctl enable near-health.service
systemctl start near-health.service

###############################
# Performance tuning         #
###############################
log "Applying performance tuning"
cloudwatch_log "Applying performance tuning"

########################################################
# Performance tuning - CPU, memory, disk, network     #
########################################################

########################################################    
# Storage tuning & RocksDB tuning
########################################################

# Configure RocksDB for Multi-Core Usage
log "Configuring RocksDB for multi-core usage"
cloudwatch_log "Configuring RocksDB for multi-core usage"
export ROCKSDB_MAX_BACKGROUND_JOBS=16
export ROCKSDB_MAX_BACKGROUND_COMPACTIONS=8  
export ROCKSDB_MAX_BACKGROUND_FLUSHES=8
export ROCKSDB_MAX_SUBCOMPACTIONS=4
export ROCKSDB_WRITE_BUFFER_SIZE=134217728   # 128MB
export ROCKSDB_MAX_WRITE_BUFFER_NUMBER=6

# Make persistent 
echo 'export ROCKSDB_MAX_BACKGROUND_JOBS=16' | sudo tee -a /etc/environment
echo 'export ROCKSDB_MAX_BACKGROUND_COMPACTIONS=8' | sudo tee -a /etc/environment  
echo 'export ROCKSDB_MAX_BACKGROUND_FLUSHES=8' | sudo tee -a /etc/environment
echo 'export ROCKSDB_MAX_SUBCOMPACTIONS=4' | sudo tee -a /etc/environment
echo 'ROCKSDB_WRITE_BUFFER_SIZE=67108864' | sudo tee -a /etc/environment
echo 'ROCKSDB_MAX_WRITE_BUFFER_NUMBER=6' | sudo tee -a /etc/environment

########################################################
# File System Optimizations
########################################################

# Apply sysctl tuning for filesystem and memory writeback
log "Applying sysctl tuning for filesystem optimizations"
cloudwatch_log "Applying sysctl tuning for filesystem optimizations"
echo 'vm.dirty_ratio = 15' | sudo tee -a /etc/sysctl.conf
echo 'vm.dirty_background_ratio = 2' | sudo tee -a /etc/sysctl.conf
echo 'vm.vfs_cache_pressure = 200' | sudo tee -a /etc/sysctl.conf
sudo sysctl -p

########################################################
# Optimize System-Level I/O
########################################################

# Optimize I/O scheduler for NVMe (assumes data volume is /dev/nvme1n1)
log "Setting I/O scheduler to mq-deadline for NVMe data volume"
cloudwatch_log "Setting I/O scheduler to mq-deadline for NVMe data volume"
echo mq-deadline | sudo tee /sys/block/nvme1n1/queue/scheduler

# Remount /near/mainnet with noatime,nodiratime for database workload
log "Remounting /near/mainnet with noatime,nodiratime"
cloudwatch_log "Remounting /near/mainnet with noatime,nodiratime"
sudo mount -o remount,noatime,nodiratime /near/mainnet

########################################################
# Increase write buffer and reduce sync frequency in NEAR config
########################################################

# Patch NEAR config.json to increase write buffer and reduce sync frequency
log "Patching /near/mainnet/data/config.json to increase write buffer and reduce sync frequency"
cloudwatch_log "Patching /near/mainnet/data/config.json to increase write buffer and reduce sync frequency"
jq '.store = {
  "load_mem_tries_for_tracked_shards": true
}' /near/mainnet/data/config.json > /tmp/config.json && mv /tmp/config.json /near/mainnet/data/config.json

########################################################
# Reduce State Sync Parallelism (RocksDB write tuning)
########################################################

# Further sysctl tuning for heavy write workloads
log "Applying sysctl tuning for RocksDB heavy write workloads"
cloudwatch_log "Applying sysctl tuning for RocksDB heavy write workloads"
echo 'vm.dirty_expire_centisecs = 500' | sudo tee -a /etc/sysctl.conf
echo 'vm.dirty_writeback_centisecs = 100' | sudo tee -a /etc/sysctl.conf
sudo sysctl -p

########################################################
# Network tuning and optimizations (Issue 20, 21, 24)
########################################################
log "Applying advanced network sysctl optimizations"
cloudwatch_log "Applying advanced network sysctl optimizations"

# Apply temporary sysctl settings for network performance
sudo sysctl -w net.core.rmem_max=8388608
sudo sysctl -w net.core.wmem_max=8388608
sudo sysctl -w net.ipv4.tcp_rmem="4096 87380 8388608"
sudo sysctl -w net.ipv4.tcp_wmem="4096 16384 8388608"
sudo sysctl -w net.ipv4.tcp_slow_start_after_idle=0
sudo sysctl -w net.core.netdev_max_backlog=5000
sudo sysctl -w net.core.netdev_budget=600
sudo sysctl -w net.ipv4.tcp_congestion_control=bbr
sudo sysctl -w net.netfilter.nf_conntrack_max=1048576

# Make network sysctl settings persistent
sudo tee -a /etc/sysctl.conf << EOF
net.core.rmem_max=8388608
net.core.wmem_max=8388608
net.ipv4.tcp_rmem=4096 87380 8388608
net.ipv4.tcp_wmem=4096 16384 8388608
net.ipv4.tcp_slow_start_after_idle=0
net.core.netdev_max_backlog=5000
net.core.netdev_budget=600
net.ipv4.tcp_congestion_control=bbr
net.netfilter.nf_conntrack_max=1048576
EOF

sudo sysctl -p

########################################################
# Peer Discovery & Connection Tuning for NEAR Node
########################################################

log "Tuning NEAR peer discovery and connection settings"
cloudwatch_log "Tuning NEAR peer discovery and connection settings"

# 1. Increase minimum outbound peers
jq '.network.minimum_outbound_peers = 25' \
   /near/mainnet/data/config.json > /tmp/config.json && mv /tmp/config.json /near/mainnet/data/config.json

# 2. Increase safe set size (peer pool)
jq '.network.safe_set_size = 60' \
   /near/mainnet/data/config.json > /tmp/config.json && mv /tmp/config.json /near/mainnet/data/config.json

# 3. Increase archival peer connections lower bound
jq '.network.archival_peer_connections_lower_bound = 35' \
   /near/mainnet/data/config.json > /tmp/config.json && mv /tmp/config.json /near/mainnet/data/config.json

# 4. Optimize peer discovery timing and advanced network params
jq '.network.peer_stats_period = {
  "secs": 2,
  "nanos": 0
}' /near/mainnet/data/config.json > /tmp/config.json && mv /tmp/config.json /near/mainnet/data/config.json

jq '.network.monitor_peers_max_period.secs = 15 |
    .network.peer_recent_time_window.secs = 300 |
    .network.experimental.tier1_connect_interval.secs = 30 |
    .network.experimental.tier1_new_connections_per_attempt = 150' \
    /near/mainnet/data/config.json > /near/mainnet/data/config.tmp && \
    mv /near/mainnet/data/config.tmp /near/mainnet/data/config.json

# 5. Increase peer limits (Issue 1)
jq '.network.max_num_peers = 200 | 
    .network.ideal_connections_lo = 160 |
    .network.ideal_connections_hi = 180' \
    /near/mainnet/data/config.json > /tmp/config.json && mv /tmp/config.json /near/mainnet/data/config.json

# 6. Add network buffer optimizations (Issue 24)
jq '.network.handshake_timeout = {
  "secs": 20,
  "nanos": 0
}' /near/mainnet/data/config.json > /tmp/config.json && mv /tmp/config.json /near/mainnet/data/config.json

# 7. Reduce ban window to prevent peer loss (Issue 25)
jq '.network.ban_window = {"secs": 3600, "nanos": 0}' /near/mainnet/data/config.json > /tmp/config.json && mv /tmp/config.json /near/mainnet/data/config.json

log "NEAR peer discovery and connection settings tuned"
cloudwatch_log "NEAR peer discovery and connection settings tuned"

########################################################
# State Sync & Resharding Optimizations (Issue 22, 26)
########################################################

# Increase concurrent requests for state sync (Issue 22)
jq '.state_sync.sync.ExternalStorage.num_concurrent_requests = 8 | .state_sync.sync.ExternalStorage.num_concurrent_requests_during_catchup = 8' /near/mainnet/data/config.json > /tmp/config.json && mv /tmp/config.json /near/mainnet/data/config.json

# Apply transaction size optimizations (Issue 26)
jq '.resharding_config.batch_size = 50000 | 
    .resharding_config.batch_delay.nanos = 1000000'\
    /near/mainnet/data/config.json > /tmp/config.json && mv /tmp/config.json /near/mainnet/data/config.json

# Set network interface to use




###############################
# NEAR process monitoring     #
###############################
log "Setting up NEAR process monitoring"
cloudwatch_log "Creating NEAR process monitoring scripts"

# Create a monitoring script for NEAR processes
cat >/usr/local/bin/near-monitor.sh <<'MONITOR'
#!/bin/bash
# NEAR Node Monitoring Script for CloudWatch

# Function to send CloudWatch metrics
send_cloudwatch_metric() {
    local metric_name="$1"
    local value="$2"
    local unit="${3:-Count}"
    local namespace="Near/Node"
    
    aws cloudwatch put-metric-data \
        --namespace "$namespace" \
        --metric-data MetricName="$metric_name",Value="$value",Unit="$unit" \
        --region "$AWS_REGION" 2>/dev/null || true
}

# Monitor NEAR daemon process
check_near_daemon() {
    if systemctl is-active --quiet near.service; then
        send_cloudwatch_metric "DaemonStatus" 1
        
        # Get NEAR node info if RPC is responding
        local rpc_status=$(curl -s -X POST http://localhost:3030/status -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","method":"status","params":[],"id":"dontcare"}' | jq -r '.result.sync_info.syncing' 2>/dev/null || echo "unknown")
        
        if [ "$rpc_status" = "false" ]; then
            send_cloudwatch_metric "NodeSynced" 1
        elif [ "$rpc_status" = "true" ]; then
            send_cloudwatch_metric "NodeSyncing" 1
        fi
        
        # Log memory usage for NEAR process
        local near_memory=$(ps -o rss= -p $(pgrep neard) 2>/dev/null | awk '{print $1*1024}' || echo "0")
        send_cloudwatch_metric "MemoryUsage" "$near_memory" "Bytes"
        
    else
        send_cloudwatch_metric "DaemonStatus" 0
    fi
}

# Monitor build process if running
check_build_process() {
    if pgrep -f "make release" > /dev/null; then
        send_cloudwatch_metric "BuildInProgress" 1
        
        # Monitor Rust compilation progress
        local compiled_crates=$(grep -c "Compiling" /near/mainnet/nearcore/build.log 2>/dev/null || echo "0")
        send_cloudwatch_metric "CompiledCrates" "$compiled_crates"
    else
        send_cloudwatch_metric "BuildInProgress" 0
    fi
}

# Main monitoring loop
case "${1:-daemon}" in
    "daemon")
        check_near_daemon
        ;;
    "build") 
        check_build_process
        ;;
    "all")
        check_near_daemon
        check_build_process
        ;;
esac
MONITOR

chmod +x /usr/local/bin/near-monitor.sh

# Create systemd timer for monitoring
cat >/etc/systemd/system/near-monitor.service <<SERVICE
[Unit]
Description=NEAR Node Monitoring
After=network.target

[Service]
Type=oneshot
ExecStart=/usr/local/bin/near-monitor.sh all
User=root
SERVICE

cat >/etc/systemd/system/near-monitor.timer <<TIMER
[Unit]
Description=Run NEAR monitoring every 2 minutes
Requires=near-monitor.service

[Timer]
OnCalendar=*:0/2
Persistent=true

[Install]
WantedBy=timers.target
TIMER

systemctl daemon-reload
systemctl enable near-monitor.timer
systemctl start near-monitor.timer

###############################
# Start NEAR node service     #
###############################
log "Starting NEAR node service"
cloudwatch_log "Starting NEAR daemon service"

systemctl start near.service

# Wait and verify service started
sleep 15
if systemctl is-active --quiet near.service; then
    log "NEAR service started successfully"
    cloudwatch_log "NEAR service started successfully - node will begin syncing"
else
    log "NEAR service failed to start"
    cloudwatch_log "ERROR: NEAR service failed to start"
    systemctl status near.service || true
    cfn-signal -e 1 --stack "$STACK_NAME" --resource "$RESOURCE_ID" --region "$AWS_REGION" || true
    exit 1
fi

###############################
# CloudFormation / ASG hooks  #
###############################
# NOTE: cfn-signal already sent after infrastructure ready (early signal pattern)
# This allows CloudFormation to complete while blockchain sync continues in background

# Complete lifecycle action in HA (AutoScaling) deployment
if [[ "$LIFECYCLE_HOOK_NAME" != "none" ]]; then
  log "Completing ASG lifecycle action"
  cloudwatch_log "Completing AutoScaling lifecycle action"
  /usr/local/bin/aws autoscaling complete-lifecycle-action \
    --lifecycle-hook-name "$LIFECYCLE_HOOK_NAME" \
    --auto-scaling-group-name "$ASG_NAME" \
    --lifecycle-action-result "CONTINUE" \
    --region "$AWS_REGION" || true
fi

log "Infrastructure bootstrap completed successfully - NEAR sync continues in background"
cloudwatch_log "NEAR infrastructure ready - blockchain sync running in background (4-5 hours for mainnet)"
cloudwatch_log "CloudFormation signaled early - node will be ready for RPC calls once fully synced"
cloudwatch_log "Health check endpoint available at http://instance-ip:8080/health"
cloudwatch_log "Monitor sync progress with: sudo journalctl -u near.service -f"