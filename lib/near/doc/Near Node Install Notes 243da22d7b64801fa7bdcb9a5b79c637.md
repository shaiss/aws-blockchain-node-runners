# Near Node Install Notes

# **Prerequisites**

## Issue 1

must run `sudo apt update` as `apt update` fails with a permissions issue

must use sudo for `apt install` command

## Issue 6

make release command doesn’t work. you have to run these commands to setup rust first.

The below command were for release 2.6.5 for mainnet.

When I tried installing 2.7.0-rc.4 I had to use rustup nightly, but couldn’t run make release because of an error with **`Edition2024`**

```bash
export RUSTUP_HOME=/near/mainnet/.rustup && export CARGO_HOME=/near/mainnet/.cargo && mkdir -p $RUSTUP_HOME $CARGO_HOME

# Update Rust to latest version
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- --no-modify-path -y
. "/near/mainnet/.cargo/env"
rustup update

# Verify version
cargo --version  # Should be 1.85

# Now compilation should work
cd nearcore
make release
```

## Issue 2

this command in the docs is wrong

```bash
apt install -y git binutils-dev libcurl4-openssl-dev zlib1g-dev libdw-dev libiberty-dev cmake gcc g++ python docker.io protobuf-compiler libssl-dev pkg-config clang llvm cargo awscli
```

should be:

```bash
sudo apt install -y git binutils-dev libcurl4-openssl-dev zlib1g-dev libdw-dev libiberty-dev cmake gcc g++ python3 python3-pip docker.io protobuf-compiler libssl-dev pkg-config clang llvm
```

Install AWSCLI best practice w/o. Don’t use app install

```bash
sudo apt install -y unzip curl
sudo curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip"
sudo unzip awscliv2.zip
sudo sudo ./aws/install
sudo ln -sf /usr/local/bin/aws /usr/bin/aws
aws --version # to confirm install
```

## Issue 8

there’s no mention in the docs of using a data volume.  In AWS we do and need to set it up in the OS.

I had to mount and format the 1tb volume the cdk deployed with the following command sequence:

```bash
# Check available storage
lsblk

# 1. Check filesystem
sudo file -s /dev/nvme1n1

# 2. Format if needed (only if output shows "data")
sudo mkfs.ext4 /dev/nvme1n1

# 3. Mount the 1TB volume
sudo mount /dev/nvme1n1 /near/mainnet

# 4. Set ownership
sudo chown -R ssm-user:ssm-user /near/mainnet

# 5. Make mount permanent
echo "/dev/nvme1n1 /near/mainnet ext4 defaults,nofail 0 2" | sudo tee -a /etc/fstab

# 6. Verify setup
df -h | grep nvme1n1
ls -la /near/mainnet/
```

# **1. Clone `nearcore` project from GitHub**

## Issue 3.1

```bash
cd /near/mainnet/
git clone https://github.com/near/nearcore
cd nearcore
git config --global --add safe.directory /var/snap/amazon-ssm-agent/11320/nearcore ## new command that's not in the docs
git fetch origin --tags
```

these commands must be run with sudo prefixed

`sudo git fetch origin --tags` doesn’t return anything?

## issue 4

Testnet: 

`sudo git checkout tags/2.7.0-rc.4 -b mynode` is the lateset tag for the rc, but we need a way to read this from the .env and .env.sample

Mainnet: 

`sudo git checkout tags/2.6.5 -b mynode` for mainnet

# **2. Compile `nearcore` binary**

no issues w/ `make release` so long as rust is installed in the prerequisites

make release seems to take near 20min on m7a.2xl aws instance

# **3. Initialize working directory w/ Epoch Sync**

we’re combing the init working directory step with the epoch sync requirement as we need to pull a boot node.

step `4. Get data backup` is collapsed into this on.

## issue 9

the neard command is corrected below and includes dynamic boot node loading

You need to run epoch sync as part of the node setup docs, the commands below automates the process

```bash
# Set this variable to either "mainnet" or "testnet"
network="mainnet"

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
if [[ "$network" == "testnet" ]]; then
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
/near/mainnet/nearcore/target/release/neard --home /near/mainnet/data init --chain-id mainnet --download-genesis --download-config rpc --boot-nodes "$BOOT_NODES"

# Verify it worked
echo "Boot nodes configured:"
grep "boot_nodes" /near/mainnet/data/config.json
```

**1. Increase Peer Limits** 

```bash
# test to increase to 160-200 peers
jq '.network.max_num_peers = 200 | 
    .network.ideal_connections_lo = 160 |
    .network.ideal_connections_hi = 180' \
    /near/mainnet/data/config.json > /tmp/config.json && mv /tmp/config.json /near/mainnet/data/config.json
```

# Issue 20

Network performance is awful on aws 3.57mb down

running `sudo bash /near/mainnet/nearcore/scripts/set_kernel_params.sh` per the docs is supposed to optimize performance and is temporary

scripts/set_kernel_params.sh

```bash
#!/bin/bash

# This script sets specific sysctl parameters for running a validator.
# Run it as: sudo ./set_kernel_params.sh

# Increase maximum read and write buffer sizes
sysctl -w net.core.rmem_max=8388608
sysctl -w net.core.wmem_max=8388608

# Configure TCP read and write memory parameters
sysctl -w net.ipv4.tcp_rmem="4096 87380 8388608"
sysctl -w net.ipv4.tcp_wmem="4096 16384 8388608"

# Disable slow start after idle
sysctl -w net.ipv4.tcp_slow_start_after_idle=0

echo "Network settings have been updated."
```

the command below makes the script permanent

```bash
sudo tee -a /etc/sysctl.conf << EOF
net.core.rmem_max=8388608
net.core.wmem_max=8388608
net.ipv4.tcp_rmem=4096 87380 8388608
net.ipv4.tcp_wmem=4096 16384 8388608
net.ipv4.tcp_slow_start_after_idle=0
EOF
```

# Issue 21

even after addressing the settings in issue 20, download speeds were below 30Mbps.  Applying the below get’s to near 40Mbps

```bash
# 1. Increase network queue lengths
sudo sysctl -w net.core.netdev_max_backlog=5000
sudo sysctl -w net.core.netdev_budget=600

# 2. Optimize TCP congestion control
sudo sysctl -w net.ipv4.tcp_congestion_control=bbr

# 3. Increase connection tracking
sudo sysctl -w net.netfilter.nf_conntrack_max=1048576

# 4. Add to persistent config
sudo tee -a /etc/sysctl.conf << EOF
net.core.netdev_max_backlog=5000
net.core.netdev_budget=600
net.ipv4.tcp_congestion_control=bbr
net.netfilter.nf_conntrack_max=1048576
EOF
```

## Issue 22

Based on Pull Request #3882 which achieved **200x performance improvements** through parallelization:

- **Current**: 5.31 MB/s
- **Expected with 50 concurrent requests**: 10-15 MB/s
- **Expected with optimized settings**: 15-25 MB/s (3-5x improvement)

**Default vs. Optimized:**

- **Default**: num_concurrent_requests: 25
- **Optimized**: num_concurrent_requests: 50 (100% increase)
- **Default**: num_concurrent_requests_during_catchup: 5
- **Optimized**: num_concurrent_requests_during_catchup: 15 (200% increase)

```bash
jq '.state_sync.sync.ExternalStorage.num_concurrent_requests = 25 | .state_sync.sync.ExternalStorage.num_concurrent_requests_during_catchup = 15' /near/mainnet/data/config.json > /tmp/config.json && mv /tmp/config.json /near/mainnet/data/config.json
```

This might need to be reset back to the defaults if rocksDB shows errors applying state updates

## Issue 23

**Network Threading**: More parallel peer connections and block requests

**Storage Optimization**: Better RocksDB parallelism for I/O operations

**Verify Changes and Restart**

```bash
# Verify the configuration
echo "=== Checking Parallelization Settings ==="
cat /near/mainnet/data/config.json | jq '.state_sync'
```

## Issue 24

**Add Network Buffer Optimizations**

These are supported in current NEAR versions:

```bash
jq '.network.handshake_timeout = {
  "secs": 20,
  "nanos": 0
}' /near/mainnet/data/config.json > /tmp/config.json && mv /tmp/config.json /near/mainnet/data/config.json
```

## Issue 25

**Reduce Ban Windows to Prevent Peer Loss**

Based on the Common Node Errors documentation:

```bash
jq '.network.ban_window = 1' /near/mainnet/data/config.json > /tmp/config.json && mv /tmp/config.json /near/mainnet/data/config.json
```

# **5. Run the node**

## Issue 7

neard is run pointing to the new mounted drive from issue 8

```bash
# 3. ✅ Start your node with Epoch Sync
/near/mainnet/nearcore/target/release/neard --home /near/mainnet/data run
```

OR we run the neard command with the the following to Run NEAR with CPU affinity to use all cores

```bash
taskset -c 0-7 /near/mainnet/nearcore/target/release/neard --home /near/mainnet/data run
```

# Performance Tuning

## **🔧 Peer Discovery Settings to Increase**

Looking at your current config, here are the key settings we can adjust:

**1. Increase Minimum Outbound Connections**

```bash
jq '.network.minimum_outbound_peers = 25' \
   /near/mainnet/data/config.json > /tmp/config.json && mv /tmp/config.json /near/mainnet/data/config.json
```

**2. Increase Safe Set Size (Peer Pool)**

```bash
jq '.network.safe_set_size = 60' \
   /near/mainnet/data/config.json > /tmp/config.json && mv /tmp/config.json /near/mainnet/data/config.json
```

**3. Increase Archival Peer Connections**

```bash
jq '.network.archival_peer_connections_lower_bound = 35' \
   /near/mainnet/data/config.json > /tmp/config.json && mv /tmp/config.json /near/mainnet/data/config.json
```

**4. Optimize Peer Discovery Timing**

```bash
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
```

## Storage Tuning`

## **🎯 RocksDB Optimization Solutions**

**2. Optimize RocksDB Settings for State Sync**

```bash
# Stop NEAR process (Ctrl+C), then apply these optimizations:

# Increase write buffer and reduce sync frequency
jq '.store = {
  "load_mem_tries_for_tracked_shards": true,
  "background_migration_threads": 4,
  "migration_batch_size": 50,
  "trie_cache_capacity": 50000000
}' /near/mainnet/data/config.json > /tmp/config.json && mv /tmp/config.json /near/mainnet/data/config.json
```

**3. Increase EBS Volume Performance**

Your current **6000 IOPS** may not be enough for intensive state sync. Let's increase it:

```bash
{
  "cli_command": "aws ec2 modify-volume --volume-id vol-087cc8aed4f8afa66 --iops 10000 --throughput 500 --profile shai-sandbox-profile --region us-east-1"
}
```

Volume performance upgrade:

- **IOPS**: 6000 → **10000** (67% increase)
- **Throughput**: 250 → **500 MB/s** (100% increase)

**4. File System Optimizations**

```bash
# Apply immediately while volume is being upgraded
echo 'vm.dirty_ratio = 5' | sudo tee -a /etc/sysctl.conf
echo 'vm.dirty_background_ratio = 2' | sudo tee -a /etc/sysctl.conf
echo 'vm.vfs_cache_pressure = 50' | sudo tee -a /etc/sysctl.conf
sudo sysctl -p
```

**5. Reduce State Sync Parallelism**

The "Unexpected state response" errors + slow writes suggest too much concurrency:

```bash
# Optimize RocksDB for heavy write workloads
echo 'vm.dirty_expire_centisecs = 500' | sudo tee -a /etc/sysctl.conf
echo 'vm.dirty_writeback_centisecs = 100' | sudo tee -a /etc/sysctl.conf  
sudo sysctl -p
```

### **1. Configure RocksDB for Multi-Core Usage**

```bash
# Stop NEAR process (Ctrl+C)
# Set RocksDB to use all 8 cores
export ROCKSDB_MAX_BACKGROUND_JOBS=16
export ROCKSDB_MAX_BACKGROUND_COMPACTIONS=8  
export ROCKSDB_MAX_BACKGROUND_FLUSHES=8
export ROCKSDB_MAX_SUBCOMPACTIONS=4
export ROCKSDB_WRITE_BUFFER_SIZE=67108864   # 64MB
export ROCKSDB_MAX_WRITE_BUFFER_NUMBER=6

# Make persistent 
echo 'export ROCKSDB_MAX_BACKGROUND_JOBS=16' | sudo tee -a /etc/environment
echo 'export ROCKSDB_MAX_BACKGROUND_COMPACTIONS=8' | sudo tee -a /etc/environment  
echo 'export ROCKSDB_MAX_BACKGROUND_FLUSHES=8' | sudo tee -a /etc/environment
echo 'export ROCKSDB_MAX_SUBCOMPACTIONS=4' | sudo tee -a /etc/environment
echo 'ROCKSDB_WRITE_BUFFER_SIZE=67108864' | sudo tee -a /etc/environment
echo 'ROCKSDB_MAX_WRITE_BUFFER_NUMBER=6' | sudo tee -a /etc/environment
```

# issue 26

## Create a systemd service with proper limits

```bash
# Create a systemd service with proper limits
sudo tee /etc/systemd/system/near.service << 'EOF'
[Unit]
Description=NEAR Protocol Node
After=network.target

[Service]
Type=simple
User=ssm-user
Group=ssm-user
WorkingDirectory=/near/mainnet/nearcore
ExecStart=/near/mainnet/nearcore/target/release/neard --home /near/mainnet/data run
Restart=always
RestartSec=10
LimitNOFILE=1048576
LimitNPROC=32768

[Install]
WantedBy=multi-user.target
EOF

# Reload systemd and start the service
sudo systemctl daemon-reload
sudo systemctl enable near.service
sudo systemctl start near.service
```

# Issue 27

we’re using epoch sync per the latest docs we still need state sync enabled per https://near.zulipchat.com/#narrow/channel/297873-node/topic/Epoch.20Sync.20Enabled.20but.20full.20state.20still.20downloading/near/532730384

```tsx
# Configure for epoch sync (remove conflicting state sync settings)
jq '.state_sync_enabled = true | .tracked_shards = [0] | .epoch_sync.disable_epoch_sync_for_bootstrapping = false | .epoch_sync.ignore_epoch_sync_network_requests = false' /near/mainnet/data/config.json > /near/mainnet/data/config.tmp
mv /near/mainnet/data/config.tmp /near/mainnet/data/config.json
```

# Timing

## **NEAR Node Sync Performance**

| Phase | Start Time | End Time | Duration | Status |
| --- | --- | --- | --- | --- |
| **Node Startup** | 03:41:49 | 03:42:02 | **13 seconds** | ✅ Complete |
| **Epoch Sync** | 03:42:02 | 03:42:26 | **24 seconds** | ✅ Complete |
| **Header Download** | 03:42:26 | 03:53:54 | **11m 28s** | ✅ Complete |
| **State Sync** | 03:53:54 | - | **6+ minutes** | 🔄 In Progress |