#!/bin/bash
# Fixed Dynamic Boot Nodes Script for NEAR Protocol
# Fetches current boot nodes from multiple RPC endpoints and handles base58 conversion properly
# Designed to be used before neard init: neard --home /near/mainnet/data init --chain-id mainnet --download-genesis --download-config rpc --boot-nodes "$BOOT_NODES"

set -euo pipefail

# Set this variable to either "mainnet" or "testnet"
# Use environment variable if available, otherwise default to mainnet
network="${NEAR_NETWORK:-mainnet}"

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

echo "[BOOT-NODES] Starting dynamic boot nodes fetch for $network..."

# Query all providers and aggregate boot nodes (EXACTLY like your local script)
ALL_BOOT_NODES=""

for endpoint in "${RPC_ENDPOINTS[@]}"; do
  echo "[BOOT-NODES] Querying $endpoint..."
  
  # Get ALL nodes from RPC endpoint (no head limit, no processing)
  NODES=$(curl -s -m 10 -X POST "$endpoint" -H "Content-Type: application/json" -d '{
    "jsonrpc": "2.0",
    "method": "network_info",
    "params": [],
    "id": "dontcare"
  }' | jq -r '.result.active_peers as $list1 | .result.known_producers as $list2 |
    $list1[] as $active_peer | $list2[] |
    select(.peer_id == $active_peer.id) |
    "ed25519:\(.peer_id)@\($active_peer.addr)"' 2>/dev/null | paste -sd "," -)
  
  if [ ! -z "$NODES" ]; then
    ALL_BOOT_NODES="$ALL_BOOT_NODES,$NODES"
    echo "[BOOT-NODES] Found $(echo "$NODES" | tr ',' '\n' | wc -l) nodes from $endpoint"
  else
    echo "[BOOT-NODES] No nodes found from $endpoint"
  fi
done

# Remove duplicates and leading comma
BOOT_NODES=$(echo "$ALL_BOOT_NODES" | tr ',' '\n' | sort -u | grep -v '^$' | paste -sd "," -)

echo "[BOOT-NODES] Found $(echo "$BOOT_NODES" | tr ',' '\n' | wc -l) unique boot nodes from multiple providers"

# Note: NEAR expects base58 Peer IDs with 'ed25519:' prefix. No conversion to hex is performed.

# If we got valid boot nodes, export them
if [ ! -z "$BOOT_NODES" ]; then
    echo "[BOOT-NODES] Final boot nodes: $BOOT_NODES"
    
    # Export for use in neard init
    export BOOT_NODES
    echo "[BOOT-NODES] BOOT_NODES variable is ready for neard init"
    echo "[BOOT-NODES] Example usage: neard --home /near/mainnet/data init --chain-id mainnet --download-genesis --download-config rpc --boot-nodes \"$BOOT_NODES\""
else
    echo "[BOOT-NODES] WARNING: No valid boot nodes found from any provider"
    echo "[BOOT-NODES] Using fallback boot nodes..."
    
    # Fallback to known working boot nodes
    FALLBACK_BOOT_NODES="ed25519:7PGseFbWxvYVgZ89K1uTJKYoKetWs7BJWHbyXp8Qb22M@35.194.0.7:24567,ed25519:6DSjzL1qVQ8q6TtMkYT3sMo6eNRE3YQonxTp3LaxoJN2@35.194.0.7:24568,ed25519:9K67QmwAqAwQ4g8jua42NRK5sVeAeHKnz1AbZe1s5Jd3@35.194.0.7:24569"
    export BOOT_NODES="$FALLBACK_BOOT_NODES"
    echo "[BOOT-NODES] Applied fallback boot nodes"
fi

echo "[BOOT-NODES] Script completed successfully"
