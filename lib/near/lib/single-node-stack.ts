import * as cdk from "aws-cdk-lib";
import * as constructs from "constructs";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3Assets from "aws-cdk-lib/aws-s3-assets";
import * as path from "path";
import * as fs from "fs";
import * as cw from 'aws-cdk-lib/aws-cloudwatch';
import * as nag from "cdk-nag";
import { SingleNodeConstruct } from "../../constructs/single-node";
import * as configTypes from "./config/node-config.interface";
import * as constants from "../../constructs/constants";
import { NearNodeSecurityGroupConstruct } from "./constructs/near-node-security-group";
import * as nodeCwDashboard from "./constructs/node-cw-dashboard";
// TODO: Implement NEAR CloudWatch dashboard JSON or remove

export interface NearSingleNodeStackProps extends cdk.StackProps {
    instanceType: ec2.InstanceType;
    instanceCpuType: ec2.AmazonLinuxCpuType;
    nearNetwork: configTypes.NearNetwork;
    nearVersion: string;
    dataVolume: configTypes.NearDataVolumeConfig;
    snapshotUrl?: string;
    limitOutTrafficMbps: number;
}

export class NearSingleNodeStack extends cdk.Stack {
    constructor(scope: constructs.Construct, id: string, props: NearSingleNodeStackProps) {
        super(scope, id, props);

        // Environment vars
        const REGION = cdk.Stack.of(this).region;
        const STACK_NAME = cdk.Stack.of(this).stackName;
        const STACK_ID = cdk.Stack.of(this).stackId;
        const availabilityZones = cdk.Stack.of(this).availabilityZones;
        const chosenAvailabilityZone = availabilityZones.slice(0, 2)[1] ?? availabilityZones[0];

        const {
            instanceType,
            instanceCpuType,
            nearNetwork,
            nearVersion,
            dataVolume,
            snapshotUrl,
            limitOutTrafficMbps,
        } = props;

        // Default VPC
        const vpc = ec2.Vpc.fromLookup(this, "vpc", { isDefault: true });

        // Security group
        const instanceSG = new NearNodeSecurityGroupConstruct(this, "security-group", {
            vpc,
        });

        // Asset bundle (CloudWatch config etc.)
        const asset = new s3Assets.Asset(this, "assets", {
            path: path.join(__dirname, "assets"),
        });

        // Upload user-data script as separate S3 asset to bypass CloudFormation 25KB limit
        const userDataAsset = new s3Assets.Asset(this, "user-data-script", {
            path: path.join(__dirname, "assets", "user-data-ubuntu.sh"),
        });

        // Import shared instance role from common stack (to be created later)
        const importedInstanceRoleArn = cdk.Fn.importValue("NearNodeInstanceRoleArn");
        const instanceRole = iam.Role.fromRoleArn(this, "iam-role", importedInstanceRoleArn);
        asset.bucket.grantRead(instanceRole);
        userDataAsset.grantRead(instanceRole);
        
        // CloudWatch Logs permissions are added in the common-stack.ts where the base role is defined

        // Use Ubuntu 24.04 LTS (latest LTS with fixed package installation issues)
        let ubuntuStableImageSsmName = "/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id"

        const machineImage = ec2.MachineImage.fromSsmParameter(ubuntuStableImageSsmName);

        // CloudWatch Agent Configuration for Ubuntu
        const cloudWatchAgentConfig = {
            "metrics": {
                "namespace": "NEAR/Node",
                "append_dimensions": {
                    "InstanceId": "${!aws:InstanceId}",
                    "InstanceType": "${!aws:InstanceType}",
                    "AutoScalingGroupName": "${!aws:AutoScalingGroupName}"
                },
                "metrics_collected": {
                    "cpu": {
                        "measurement": ["cpu_usage_idle", "cpu_usage_iowait", "cpu_usage_user", "cpu_usage_system"],
                        "metrics_collection_interval": 300,
                        "totalcpu": false
                    },
                    "disk": {
                        "measurement": ["used_percent"],
                        "metrics_collection_interval": 300,
                        "resources": ["*"]
                    },
                    "diskio": {
                        "measurement": ["io_time", "read_bytes", "write_bytes", "reads", "writes"],
                        "metrics_collection_interval": 300,
                        "resources": ["*"]
                    },
                    "mem": {
                        "measurement": ["mem_used_percent"],
                        "metrics_collection_interval": 300
                    },
                    "netstat": {
                        "measurement": ["tcp_established", "tcp_time_wait"],
                        "metrics_collection_interval": 300
                    },
                    "swap": {
                        "measurement": ["swap_used_percent"],
                        "metrics_collection_interval": 300
                    }
                }
            },
            "logs": {
                "logs_collected": {
                    "files": {
                        "collect_list": [
                            {
                                "file_path": "/var/log/cloud-init-output.log",
                                "log_group_name": "/aws/ec2/near/cloud-init",
                                "log_stream_name": "{instance_id}",
                                "timezone": "UTC",
                                "multi_line_start_pattern": "^\\d{4}-\\d{2}-\\d{2}\\s+\\d{2}:\\d{2}:\\d{2}"
                            },
                            {
                                "file_path": "/var/log/syslog",
                                "log_group_name": "/aws/ec2/near/syslog", 
                                "log_stream_name": "{instance_id}",
                                "timezone": "UTC"
                            },
                            {
                                "file_path": "/near/mainnet/nearcore/build.log",
                                "log_group_name": "/aws/ec2/near/build",
                                "log_stream_name": "{instance_id}",
                                "timezone": "UTC",
                                "multi_line_start_pattern": "^\\s*(Compiling|Finished|error|warning)"
                            },
                            {
                                "file_path": "/var/log/user-data.log",
                                "log_group_name": "/aws/ec2/near/bootstrap",
                                "log_stream_name": "{instance_id}",
                                "timezone": "UTC",
                                "multi_line_start_pattern": "^\\[NEAR-BOOTSTRAP\\]"
                            },
                            {
                                "file_path": "/var/log/near-node.log",
                                "log_group_name": "/aws/ec2/near/daemon",
                                "log_stream_name": "{instance_id}",
                                "timezone": "UTC",
                                "multi_line_start_pattern": "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}"
                            },
                            {
                                "file_path": "/var/log/auth.log",
                                "log_group_name": "/aws/ec2/near/auth",
                                "log_stream_name": "{instance_id}",
                                "timezone": "UTC"
                            }
                        ]
                    }
                },
                "log_stream_name": "{instance_id}_{hostname}"
            }
        };

        const node = new SingleNodeConstruct(this, "near-single-node", {
            instanceName: STACK_NAME,
            instanceType,
            dataVolumes: [dataVolume], // ✅ SIMPLE: Just pass the data volume like Solana/Ethereum do
            rootDataVolumeDeviceName: "/dev/sda1",
            machineImage,
            vpc,
            availabilityZone: chosenAvailabilityZone,
            role: instanceRole,
            securityGroup: instanceSG.securityGroup,
            vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
        });

        // CloudWatch agent installation moved to S3-uploaded user-data script 
        // This avoids CloudFormation Init conflicts and bypasses the 25KB user-data limit

        // Create minimal bootstrap script that downloads and executes the full script from S3
        // This bypasses CloudFormation's 25KB user-data limit
        const dataVolumeSizeBytes = dataVolume.sizeGiB * constants.GibibytesToBytesConversionCoefficient;

        const bootstrapScript = cdk.Fn.sub(
            `#!/bin/bash
set -euo pipefail

# Logging setup - redirect all output to log file
exec > >(tee -a /var/log/user-data.log)
exec 2>&1

echo "[BOOTSTRAP] \$(date): Starting NEAR node bootstrap process"

# Variables passed from CloudFormation
export AWS_REGION="\${_AWS_REGION_}"
export STACK_NAME="\${_STACK_NAME_}"
export STACK_ID="\${_STACK_ID_}"
export NODE_CF_LOGICAL_ID="\${_NODE_CF_LOGICAL_ID_}"
export NEAR_VERSION="\${_NEAR_VERSION_}"
export NEAR_NETWORK="\${_NEAR_NETWORK_}"
export ASSETS_S3_PATH="s3://\${_ASSETS_S3_BUCKET_}/\${_ASSETS_S3_KEY_}"
export DATA_VOLUME_TYPE="\${_DATA_VOLUME_TYPE_}"
export DATA_VOLUME_SIZE="\${_DATA_VOLUME_SIZE_}"
export LIFECYCLE_HOOK_NAME="\${_LIFECYCLE_HOOK_NAME_}"
export ASG_NAME="\${_ASG_NAME_}"
export LIMIT_OUT_TRAFFIC_MBPS="\${_LIMIT_OUT_TRAFFIC_MBPS_}"

# Persist environment variables for the main script
echo "[BOOTSTRAP] \$(date): Persisting environment variables"
cat >> /etc/environment << EOF
AWS_REGION=\$AWS_REGION
STACK_NAME=\$STACK_NAME
STACK_ID=\$STACK_ID
NODE_CF_LOGICAL_ID=\$NODE_CF_LOGICAL_ID
NEAR_VERSION=\$NEAR_VERSION
NEAR_NETWORK=\$NEAR_NETWORK
ASSETS_S3_PATH=\$ASSETS_S3_PATH
DATA_VOLUME_TYPE=\$DATA_VOLUME_TYPE
DATA_VOLUME_SIZE=\$DATA_VOLUME_SIZE
LIFECYCLE_HOOK_NAME=\$LIFECYCLE_HOOK_NAME
ASG_NAME=\$ASG_NAME
LIMIT_OUT_TRAFFIC_MBPS=\$LIMIT_OUT_TRAFFIC_MBPS
EOF

echo "[BOOTSTRAP] \$(date): Downloading main setup script from S3: s3://\${_USER_DATA_S3_BUCKET_}/\${_USER_DATA_S3_KEY_}"

# Install AWS CLI if not available (using proven v2 method)
if ! command -v aws &> /dev/null; then
    echo "[BOOTSTRAP] \$(date): Installing AWS CLI v2"
    cd /tmp
    apt-get update -yqq
    apt-get install -yqq unzip curl
    curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip"
    unzip -q awscliv2.zip
    ./aws/install --update
    ln -sf /usr/local/bin/aws /usr/bin/aws
    echo "[BOOTSTRAP] \$(date): AWS CLI installed: \$(aws --version)"
    cd /
fi

# Attach data volume (workaround for shared construct bug)
echo "[BOOTSTRAP] \$(date): Finding and attaching data volume"
INSTANCE_ID=\$(curl -s http://169.254.169.254/latest/meta-data/instance-id)
INSTANCE_AZ=\$(curl -s http://169.254.169.254/latest/meta-data/placement/availability-zone)

# Find unattached volume in same AZ with our stack tag
VOLUME_ID=\$(aws ec2 describe-volumes \\
  --region "\${_AWS_REGION_}" \\
  --filters "Name=availability-zone,Values=\$INSTANCE_AZ" \\
            "Name=status,Values=available" \\
            "Name=tag:aws:cloudformation:stack-name,Values=\${_STACK_NAME_}" \\
  --query 'Volumes[0].VolumeId' --output text)

if [[ "\$VOLUME_ID" != "None" && "\$VOLUME_ID" != "" ]]; then
  echo "[BOOTSTRAP] \$(date): Found data volume: \$VOLUME_ID, attaching to \$INSTANCE_ID"
  aws ec2 attach-volume \\
    --volume-id "\$VOLUME_ID" \\
    --instance-id "\$INSTANCE_ID" \\
    --device "/dev/sdf" \\
    --region "\${_AWS_REGION_}"
  
  echo "[BOOTSTRAP] \$(date): Waiting for volume attachment to complete"
  for i in {1..30}; do
    if aws ec2 describe-volumes \\
      --volume-ids "\$VOLUME_ID" \\
      --region "\${_AWS_REGION_}" \\
      --query 'Volumes[0].Attachments[0].State' --output text | grep -q "attached"; then
      echo "[BOOTSTRAP] \$(date): Volume successfully attached as /dev/nvme1n1"
      break
    fi
    echo "[BOOTSTRAP] \$(date): Waiting for attachment... (\$i/30)"
    sleep 2
  done
else
  echo "[BOOTSTRAP] \$(date): WARNING: No unattached data volume found in AZ \$INSTANCE_AZ"
fi

# Download the main setup script from S3
aws s3 cp "s3://\${_USER_DATA_S3_BUCKET_}/\${_USER_DATA_S3_KEY_}" /tmp/near-setup.sh --region "\${_AWS_REGION_}"

# Make it executable
chmod +x /tmp/near-setup.sh

echo "[BOOTSTRAP] \$(date): Executing main setup script"

# Execute the main script with all environment variables available
/tmp/near-setup.sh

echo "[BOOTSTRAP] \$(date): Main setup script completed with exit code: \$?"
`,
            {
                _AWS_REGION_: REGION,
                _STACK_NAME_: STACK_NAME,
                _STACK_ID_: cdk.Stack.of(this).stackId,
                _NODE_CF_LOGICAL_ID_: node.nodeCFLogicalId,
                _NEAR_VERSION_: nearVersion,
                _NEAR_NETWORK_: nearNetwork,
                _ASSETS_S3_BUCKET_: asset.s3BucketName,
                _ASSETS_S3_KEY_: asset.s3ObjectKey,
                _USER_DATA_S3_BUCKET_: userDataAsset.s3BucketName,
                _USER_DATA_S3_KEY_: userDataAsset.s3ObjectKey,
                _DATA_VOLUME_TYPE_: dataVolume.type,
                _DATA_VOLUME_SIZE_: dataVolumeSizeBytes.toString(),
                _LIFECYCLE_HOOK_NAME_: constants.NoneValue,
                _ASG_NAME_: constants.NoneValue,
                _LIMIT_OUT_TRAFFIC_MBPS_: limitOutTrafficMbps.toString(),
            }
        );
        
        node.instance.addUserData(bootstrapScript);

        // Adding CloudWatch dashboard to the node
        const dashboardString = cdk.Fn.sub(JSON.stringify(nodeCwDashboard.SingleNodeCWDashboardJSON), {
            INSTANCE_ID: node.instanceId,
            INSTANCE_NAME: STACK_NAME,
            REGION: REGION,
        });

        new cw.CfnDashboard(this, 'single-cw-dashboard', {
            dashboardName: `${STACK_NAME}-${node.instanceId}`,
            dashboardBody: dashboardString,
        });

        new cdk.CfnOutput(this, "node-instance-id", {
            value: node.instanceId,
        });

        nag.NagSuppressions.addResourceSuppressions(
            this,
            [
                { id: "AwsSolutions-IAM5", reason: "Need GetObject, ListBucket access to the S3 bucket with assets" },
            ],
            true
        );
    }
} 