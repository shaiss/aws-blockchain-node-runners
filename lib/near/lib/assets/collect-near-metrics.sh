#!/bin/bash
# Script to collect NEAR node metrics and send to CloudWatch

set -euo pipefail

# Load environment
source /etc/cdk_environment

# Get instance ID
INSTANCE_ID=$(ec2-metadata --instance-id | cut -d ' ' -f 2)
REGION="${AWS_REGION}"

# Function to put metric to CloudWatch
put_metric() {
    local metric_name=$1
    local value=$2
    local unit=${3:-"None"}
    
    aws cloudwatch put-metric-data \
        --region "$REGION" \
        --namespace "CWAgent" \
        --metric-name "$metric_name" \
        --value "$value" \
        --unit "$unit" \
        --dimensions InstanceId="$INSTANCE_ID" || true
}

# Check if NEAR is running
if ! systemctl is-active --quiet near.service; then
    put_metric "near_sync_status" 0 "None"
    exit 0
fi

# Wait a bit for RPC to be ready
sleep 2

# Get NEAR node status using RPC
NODE_STATUS=$(curl -s -X POST http://localhost:3030 \
    -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","method":"status","params":[],"id":"dontcare"}' 2>/dev/null || echo "{}")

# Extract metrics from status
if [[ -n "$NODE_STATUS" && "$NODE_STATUS" != "{}" ]]; then
    # Check if we got an actual result
    if echo "$NODE_STATUS" | jq -e '.result' >/dev/null 2>&1; then
        # Sync status (1 = synced, 0 = syncing)
        SYNCING=$(echo "$NODE_STATUS" | jq -r '.result.sync_info.syncing // true')
        if [[ "$SYNCING" == "false" ]]; then
            put_metric "near_sync_status" 1 "None"
        else
            put_metric "near_sync_status" 0 "None"
        fi
        
        # Block height
        BLOCK_HEIGHT=$(echo "$NODE_STATUS" | jq -r '.result.sync_info.latest_block_height // 0')
        if [[ "$BLOCK_HEIGHT" != "0" ]]; then
            put_metric "near_block_height" "$BLOCK_HEIGHT" "Count"
        fi
        
        # Also get the latest block time if available
        BLOCK_TIME=$(echo "$NODE_STATUS" | jq -r '.result.sync_info.latest_block_time // null')
    fi
fi

# Get peer count using network_info RPC method
PEER_INFO=$(curl -s -X POST http://localhost:3030 \
    -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","method":"network_info","params":[],"id":"dontcare"}' 2>/dev/null || echo "{}")

if [[ -n "$PEER_INFO" && "$PEER_INFO" != "{}" ]]; then
    if echo "$PEER_INFO" | jq -e '.result' >/dev/null 2>&1; then
        # Try different possible field names for peer count
        PEER_COUNT=$(echo "$PEER_INFO" | jq -r '.result.num_active_peers // .result.active_peers_count // .result.connected_peers // 0')
        put_metric "near_peer_count" "$PEER_COUNT" "Count"
    fi
fi

# Note: Transaction pool metrics may not be available via RPC
# This is a placeholder that can be enabled if NEAR adds this endpoint
# TX_POOL=$(curl -s -X POST http://localhost:3030 \
#     -H "Content-Type: application/json" \
#     -d '{"jsonrpc":"2.0","method":"tx_pool","params":[],"id":"dontcare"}' 2>/dev/null || echo "{}")
# 
# if [[ -n "$TX_POOL" && "$TX_POOL" != "{}" ]]; then
#     TX_COUNT=$(echo "$TX_POOL" | jq -r '.result.transactions | length // 0')
#     put_metric "near_tx_pool_size" "$TX_COUNT" "Count"
# fi 