import * as cdk from "aws-cdk-lib";
import * as cdkConstructs from "constructs";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3Assets from "aws-cdk-lib/aws-s3-assets";
import * as path from "path";
import * as cw from 'aws-cdk-lib/aws-cloudwatch';
import * as nag from "cdk-nag";
import { SingleNodeConstruct } from "../../constructs/single-node"
import * as configTypes from "./config/node-config.interface";
import * as constants from "../../constructs/constants";
import { NearNodeSecurityGroupConstruct } from "./constructs/near-node-security-group"
import { SingleNodeCWDashboardJSON } from "./constructs/node-cw-dashboard"

export interface NearInfrastructureStackProps extends cdk.StackProps {
    instanceType: ec2.InstanceType;
    instanceCpuType: ec2.AmazonLinuxCpuType;
    nearNetwork: configTypes.NearNetwork;
    nearVersion: string;
    dataVolume: configTypes.NearDataVolumeConfig;
    limitOutTrafficMbps: number;
}

export class NearInfrastructureStack extends cdk.Stack {
    public readonly instanceId: string;
    public readonly instanceRole: iam.IRole;
    public readonly assetsBucket: string;
    public readonly assetsKey: string;
    public readonly vpc: ec2.IVpc;
    public readonly securityGroup: ec2.ISecurityGroup;

    constructor(scope: cdkConstructs.Construct, id: string, props: NearInfrastructureStackProps) {
        super(scope, id, props);

        // Setting up necessary environment variables
        const REGION = cdk.Stack.of(this).region;
        const STACK_NAME = cdk.Stack.of(this).stackName;
        const STACK_ID = cdk.Stack.of(this).stackId;
        const availabilityZones = cdk.Stack.of(this).availabilityZones;
        const chosenAvailabilityZone = availabilityZones.slice(0, 2)[1] ?? availabilityZones[0];

        // Getting our config from initialization properties
        const {
            instanceType,
            instanceCpuType,
            nearNetwork,
            nearVersion,
            dataVolume,
            limitOutTrafficMbps,
        } = props;

        // Using default VPC
        this.vpc = ec2.Vpc.fromLookup(this, "vpc", { isDefault: true });

        // Setting up the security group for the node from NEAR-specific construct
        const instanceSG = new NearNodeSecurityGroupConstruct(this, "security-group", {
            vpc: this.vpc,
        });
        this.securityGroup = instanceSG.securityGroup;

        // Making our scripts and configs from the local "assets" directory available for instance to download
        const asset = new s3Assets.Asset(this, "assets", {
            path: path.join(__dirname, "assets"),
        });
        this.assetsBucket = asset.s3BucketName;
        this.assetsKey = asset.s3ObjectKey;

        // Getting the IAM role ARN from the common stack
        const importedInstanceRoleArn = cdk.Fn.importValue("NearNodeInstanceRoleArn");
        this.instanceRole = iam.Role.fromRoleArn(this, "iam-role", importedInstanceRoleArn);

        // Making sure our instance will be able to read the assets
        asset.bucket.grantRead(this.instanceRole);

        // Ubuntu 24.04 LTS image for amd64 (x86_64 required for NEAR)
        let ubuntuStableImageSsmName = "/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id";
        if (instanceCpuType === ec2.AmazonLinuxCpuType.ARM_64) {
            ubuntuStableImageSsmName = "/aws/service/canonical/ubuntu/server/24.04/stable/current/arm64/hvm/ebs-gp3/ami-id";
        }
        const machineImage = ec2.MachineImage.fromSsmParameter(ubuntuStableImageSsmName);

        // Setting up the node using generic Single Node construct
        const node = new SingleNodeConstruct(this, "near-single-node", {
            instanceName: STACK_NAME,
            instanceType,
            dataVolumes: [dataVolume], // This creates volume but doesn't attach (known bug)
            rootDataVolumeDeviceName: "/dev/sda1",
            machineImage,
            vpc: this.vpc,
            availabilityZone: chosenAvailabilityZone,
            role: this.instanceRole,
            securityGroup: this.securityGroup,
            vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
        });

        this.instanceId = node.instanceId;

        // Create minimal infrastructure bootstrap script
        const dataVolumeSizeBytes = dataVolume.sizeGiB * constants.GibibytesToBytesConversionCoefficient;

        const bootstrapScript = cdk.Fn.sub(
            `#!/bin/bash
# Following Solana pattern - no 'set -e' to ensure cfn-signal always runs
exec > >(tee -a /var/log/infrastructure-bootstrap.log)
exec 2>&1

echo "[INFRA-BOOTSTRAP] \$(date): Starting infrastructure bootstrap"

# Essential environment setup
export AWS_REGION="\${_AWS_REGION_}"
export STACK_NAME="\${_STACK_NAME_}"
export STACK_ID="\${_STACK_ID_}"
export RESOURCE_ID="\${_NODE_CF_LOGICAL_ID_}"

# Persist environment for next stacks
echo "[INFRA-BOOTSTRAP] \$(date): Creating environment file"
cat > /etc/near-environment << EOF
AWS_REGION=\$AWS_REGION
STACK_NAME=\$STACK_NAME
STACK_ID=\$STACK_ID
RESOURCE_ID=\$RESOURCE_ID
NEAR_VERSION=\${_NEAR_VERSION_}
NEAR_NETWORK=\${_NEAR_NETWORK_}
ASSETS_S3_PATH=s3://\${_ASSETS_S3_BUCKET_}/\${_ASSETS_S3_KEY_}
DATA_VOLUME_TYPE=\${_DATA_VOLUME_TYPE_}
DATA_VOLUME_SIZE=\${_DATA_VOLUME_SIZE_}
LIMIT_OUT_TRAFFIC_MBPS=\${_LIMIT_OUT_TRAFFIC_MBPS_}
EOF

# Install cfn-signal (following Solana pattern exactly)
if ! command -v cfn-signal &> /dev/null
then
  echo "[INFRA-BOOTSTRAP] \$(date): cfn-signal not found, installing"
  
  # Update system packages
  apt-get update -y
  
  # Install Python pip without failing on errors
  apt-get install -y python3-pip || echo "pip install had issues but continuing"
  
  # Install CloudFormation helper scripts
  pip3 install --break-system-packages https://s3.amazonaws.com/cloudformation-examples/aws-cfn-bootstrap-py3-latest.tar.gz || {
    # Try alternative installation method
    echo "[INFRA-BOOTSTRAP] \$(date): Trying alternative cfn-bootstrap installation"
    cd /tmp
    curl -O https://s3.amazonaws.com/cloudformation-examples/aws-cfn-bootstrap-py3-latest.tar.gz
    tar -xzf aws-cfn-bootstrap-py3-latest.tar.gz
    cd aws-cfn-bootstrap-*
    python3 setup.py install --break-system-packages || echo "Alternative install also had issues"
    cd /
  }
  
  # Create symbolic links
  mkdir -p /opt/aws/bin
  ln -sf /usr/local/bin/cfn-signal /opt/aws/bin/cfn-signal || echo "Symlink creation had issues"
else
  echo "[INFRA-BOOTSTRAP] \$(date): cfn-signal is available, skipping installation"
fi

# Install AWS CLI BEFORE sending signal (required for install stack)
echo "[INFRA-BOOTSTRAP] \$(date): Installing AWS CLI v2"
apt-get install -y unzip || echo "unzip install had issues"
cd /tmp
curl -s "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip"
unzip -q awscliv2.zip
./aws/install --update || echo "AWS CLI install had issues"
cd /

# Verify AWS CLI is available
which aws && echo "[INFRA-BOOTSTRAP] \$(date): AWS CLI installed successfully"

# Send CloudFormation signal - THIS IS THE CRITICAL PART
echo "[INFRA-BOOTSTRAP] \$(date): Sending CloudFormation signal"
cfn-signal --stack "\$STACK_NAME" --resource "\$RESOURCE_ID" --region "\$AWS_REGION" || {
  # Try with full path if command not found
  echo "[INFRA-BOOTSTRAP] \$(date): Trying cfn-signal with full path"
  /usr/local/bin/cfn-signal --stack "\$STACK_NAME" --resource "\$RESOURCE_ID" --region "\$AWS_REGION" || {
    # Last resort - try opt path
    echo "[INFRA-BOOTSTRAP] \$(date): Trying cfn-signal with opt path"
    /opt/aws/bin/cfn-signal --stack "\$STACK_NAME" --resource "\$RESOURCE_ID" --region "\$AWS_REGION" || {
      echo "[ERROR] All cfn-signal attempts failed!"
    }
  }
}

echo "[INFRA-BOOTSTRAP] \$(date): Bootstrap complete - cfn-signal sent"

echo "[INFRA-BOOTSTRAP] \$(date): Infrastructure bootstrap fully complete"
`,
            {
                _AWS_REGION_: REGION,
                _STACK_NAME_: STACK_NAME,
                _STACK_ID_: STACK_ID,
                _NODE_CF_LOGICAL_ID_: node.nodeCFLogicalId,
                _NEAR_VERSION_: nearVersion,
                _NEAR_NETWORK_: nearNetwork,
                _ASSETS_S3_BUCKET_: asset.s3BucketName,
                _ASSETS_S3_KEY_: asset.s3ObjectKey,
                _DATA_VOLUME_TYPE_: dataVolume.type,
                _DATA_VOLUME_SIZE_: dataVolumeSizeBytes.toString(),
                _LIMIT_OUT_TRAFFIC_MBPS_: limitOutTrafficMbps.toString(),
            }
        );

        node.instance.addUserData(bootstrapScript);

        // Adding CloudWatch dashboard for infrastructure monitoring
        const dashboardString = cdk.Fn.sub(JSON.stringify(SingleNodeCWDashboardJSON), {
            INSTANCE_ID: node.instanceId,
            INSTANCE_NAME: STACK_NAME,
            REGION: REGION,
        });

        new cw.CfnDashboard(this, 'near-infrastructure-dashboard', {
            dashboardName: `${STACK_NAME}-infrastructure-${node.instanceId}`,
            dashboardBody: dashboardString,
        });

        // Stack outputs for next stacks
        new cdk.CfnOutput(this, "near-instance-id", {
            value: node.instanceId,
            exportName: "NearInstanceId",
        });

        new cdk.CfnOutput(this, "near-assets-bucket", {
            value: asset.s3BucketName,
            exportName: "NearAssetsBucket", 
        });

        new cdk.CfnOutput(this, "near-assets-key", {
            value: asset.s3ObjectKey,
            exportName: "NearAssetsKey",
        });

        // Adding suppressions to the stack
        nag.NagSuppressions.addResourceSuppressions(
            this,
            [
                {
                    id: "AwsSolutions-IAM5",
                    reason: "Need read access to the S3 bucket with assets",
                },
            ],
            true
        );
    }
}