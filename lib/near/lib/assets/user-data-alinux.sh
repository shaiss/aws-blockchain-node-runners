#!/bin/bash
set -euo pipefail

###############################################################################
# NEAR Node Runner – Amazon Linux 2023 bootstrap script                       #
###############################################################################
# This script is rendered by AWS CDK. Place-holders wrapped with _XYZ_        #
# variables are substituted at deploy-time (see CDK stacks).                  #
#                                                                             #
# Required template variables                                                 #
#   _AWS_REGION_                     – AWS region                             #
#   _ASSETS_S3_PATH_                 – S3 URI to additional assets            #
#   _STACK_NAME_                     – CloudFormation stack name              #
#   _STACK_ID_                       – CloudFormation stack id (or "none")    #
#   _NODE_CF_LOGICAL_ID_             – LogicalId of the EC2 instance resource #
#   _DATA_VOLUME_TYPE_               – gp3 | io2 | io1 | instance-store       #
#   _DATA_VOLUME_SIZE_               – size in bytes                          #
#   _NEAR_VERSION_                   – nearcore release tag (e.g. v1.38.1)    #
#   _NEAR_NETWORK_                   – mainnet | testnet | betanet            #
#   _SNAPSHOT_URL_                   – optional snapshot tar.zst URL or "none"#
#   _LIFECYCLE_HOOK_NAME_            – (HA only) ASG lifecycle hook name or   #
#                                       "none"                               #
#   _ASG_NAME_                       – (HA only) AutoScalingGroup name or     #
#                                       "none"                               #
#   _LIMIT_OUT_TRAFFIC_MBPS_         – egress limit or 0                      #
###############################################################################

###############################
# Persist CDK parameters     #
###############################
cat >/etc/cdk_environment <<EOF
AWS_REGION=_AWS_REGION_
ASSETS_S3_PATH=_ASSETS_S3_PATH_
STACK_NAME=_STACK_NAME_
STACK_ID=_STACK_ID_
RESOURCE_ID=_NODE_CF_LOGICAL_ID_
DATA_VOLUME_TYPE=_DATA_VOLUME_TYPE_
DATA_VOLUME_SIZE=_DATA_VOLUME_SIZE_
NEAR_VERSION=_NEAR_VERSION_
NEAR_NETWORK=_NEAR_NETWORK_
SNAPSHOT_URL=_SNAPSHOT_URL_
LIFECYCLE_HOOK_NAME=_LIFECYCLE_HOOK_NAME_
ASG_NAME=_ASG_NAME_
LIMIT_OUT_TRAFFIC_MBPS=_LIMIT_OUT_TRAFFIC_MBPS_
EOF
chmod 600 /etc/cdk_environment
source /etc/cdk_environment

# Export for subshells
while read -r line; do export "$line"; done </etc/cdk_environment

###############################
# Helper variables & funcs    #
###############################
ARCH=$(uname -m)
NEAR_HOME="/near/${NEAR_NETWORK}"
BIN_DIR="/usr/local/bin"
DATA_DEVICE="/dev/xvdb"

log() { echo "[NEAR-BOOTSTRAP] $(date '+%Y-%m-%dT%H:%M:%S') $*"; }

###############################
# OS prep                     #
###############################
log "Updating system packages"
dnf -y update

dnf install -y git curl jq unzip bzip2 tar coreutils util-linux zstd wget amazon-cloudwatch-agent

###############################
# Optional: limit egress      #
###############################
if [[ "$LIMIT_OUT_TRAFFIC_MBPS" != "0" ]]; then
  log "Configuring egress limit to ${LIMIT_OUT_TRAFFIC_MBPS}Mbps"
  tc qdisc add dev eth0 root tbf rate "${LIMIT_OUT_TRAFFIC_MBPS}mbit" burst 32kbit latency 400ms || true
fi

###############################
# Prepare data volume         #
###############################
if [[ "$DATA_VOLUME_TYPE" != "instance-store" ]]; then
  log "Formatting & mounting EBS data volume (${DATA_DEVICE})"
  mkfs.ext4 -F $DATA_DEVICE
  mkdir -p ${NEAR_HOME}
  mount $DATA_DEVICE ${NEAR_HOME}
  echo "$DATA_DEVICE ${NEAR_HOME} ext4 defaults,nofail 0 2" >> /etc/fstab
else
  log "Using instance store for data – assumed mounted already"
  mkdir -p ${NEAR_HOME}
fi

###############################
# Install nearcore binary     #
###############################
case "$ARCH" in
  x86_64)
    NEAR_RELEASE_ASSET="near-${NEAR_VERSION}-x86_64-unknown-linux-gnu.tar.gz";;
  aarch64|arm64)
    NEAR_RELEASE_ASSET="near-${NEAR_VERSION}-aarch64-unknown-linux-gnu.tar.gz";;
  *)
    log "Unsupported architecture: $ARCH"; exit 1;;
esac

NEAR_DOWNLOAD_URL="https://github.com/near/nearcore/releases/download/${NEAR_VERSION}/${NEAR_RELEASE_ASSET}"

log "Downloading near binary from ${NEAR_DOWNLOAD_URL}"
wget -qO /tmp/near.tar.gz "$NEAR_DOWNLOAD_URL"
mkdir -p /tmp/near-bin
 tar -xzf /tmp/near.tar.gz -C /tmp/near-bin
install -m 0755 /tmp/near-bin/near ${BIN_DIR}/near
near --version || true

###############################
# Fetch chain configuration   #
###############################
log "Fetching genesis & config for ${NEAR_NETWORK}"
GENESIS_URL="https://near-protocol-public.s3.amazonaws.com/${NEAR_NETWORK}/genesis.json"
CONFIG_URL="https://near-protocol-public.s3.amazonaws.com/${NEAR_NETWORK}/config.json"

mkdir -p ${NEAR_HOME}
cd ${NEAR_HOME}

curl -sSL "$GENESIS_URL" -o genesis.json
curl -sSL "$CONFIG_URL" -o config.json

###############################
# Optionally restore snapshot #
###############################
if [[ "$SNAPSHOT_URL" != "none" && "$SNAPSHOT_URL" != "" ]]; then
  log "Downloading snapshot from $SNAPSHOT_URL"
  wget -qO /tmp/snapshot.tar.zst "$SNAPSHOT_URL"
  log "Extracting snapshot – this may take a while…"
  tar --use-compress-program=unzstd -xPf /tmp/snapshot.tar.zst -C ${NEAR_HOME}
fi

###############################
# System user & permissions   #
###############################
log "Creating near system user"
useradd -r -s /sbin/nologin -d ${NEAR_HOME} near || true
chown -R near:near ${NEAR_HOME}

###############################
# Systemd service             #
###############################
cat >/etc/systemd/system/near.service <<SERVICE
[Unit]
Description=NEAR Node
After=network-online.target
Wants=network-online.target

[Service]
User=near
Group=near
WorkingDirectory=${NEAR_HOME}
ExecStart=${BIN_DIR}/near --home ${NEAR_HOME} run --network-id ${NEAR_NETWORK} --rpc-port 3030
Restart=on-failure
LimitNOFILE=1048576

[Install]
WantedBy=multi-user.target
SERVICE

systemctl daemon-reload
systemctl enable --now near.service

###############################
# CloudWatch Agent (optional) #
###############################
log "Configuring CloudWatch Agent"

# Copy CloudWatch agent config from S3
aws s3 cp "${ASSETS_S3_PATH}/amazon-cloudwatch-agent.json" /opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json

# Start CloudWatch agent
/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl \
    -a fetch-config \
    -m ec2 \
    -c file:/opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json \
    -s || true

# Copy and set up NEAR metrics collection script
aws s3 cp "${ASSETS_S3_PATH}/collect-near-metrics.sh" /usr/local/bin/collect-near-metrics.sh
chmod +x /usr/local/bin/collect-near-metrics.sh

# Set up cron job to collect NEAR metrics every minute
cat >/etc/cron.d/near-metrics <<CRON
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/sbin:/bin:/usr/sbin:/usr/bin
* * * * * root /usr/local/bin/collect-near-metrics.sh >> /var/log/near-metrics.log 2>&1
CRON

# Create simple health check endpoint
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
                
                self.send_response(200 if is_running else 503)
                self.send_header('Content-type', 'application/json')
                self.end_headers()
                
                response = {
                    'status': 'healthy' if is_running else 'unhealthy',
                    'service': 'near',
                    'running': is_running
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
systemctl enable --now near-health.service

###############################
# CloudFormation / ASG hooks  #
###############################
# Signal success for single-node deployment
if [[ "$STACK_ID" != "none" ]]; then
  log "Signalling CloudFormation success"
  cfn-signal -e 0 --stack "$STACK_NAME" --resource "$RESOURCE_ID" --region "$AWS_REGION" || true
fi

# Complete lifecycle action in HA (AutoScaling) deployment
if [[ "$LIFECYCLE_HOOK_NAME" != "none" ]]; then
  log "Completing ASG lifecycle action"
  /usr/bin/aws autoscaling complete-lifecycle-action \
    --lifecycle-hook-name "$LIFECYCLE_HOOK_NAME" \
    --auto-scaling-group-name "$ASG_NAME" \
    --lifecycle-action-result "CONTINUE" \
    --region "$AWS_REGION" || true
fi

log "Bootstrap script completed successfully." 