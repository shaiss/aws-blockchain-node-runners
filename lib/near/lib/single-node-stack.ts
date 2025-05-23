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

        // Asset bundle (user-data scripts etc.)
        const asset = new s3Assets.Asset(this, "assets", {
            path: path.join(__dirname, "assets"),
        });

        // Import shared instance role from common stack (to be created later)
        const importedInstanceRoleArn = cdk.Fn.importValue("NearNodeInstanceRoleArn");
        const instanceRole = iam.Role.fromRoleArn(this, "iam-role", importedInstanceRoleArn);
        asset.bucket.grantRead(instanceRole);

        // Use Amazon Linux 2023 AMI
        const machineImage = new ec2.AmazonLinuxImage({
            generation: ec2.AmazonLinuxGeneration.AMAZON_LINUX_2023,
            kernel: ec2.AmazonLinuxKernel.KERNEL6_1,
            cpuType: instanceCpuType,
        });

        const node = new SingleNodeConstruct(this, "near-single-node", {
            instanceName: STACK_NAME,
            instanceType,
            dataVolumes: [dataVolume],
            rootDataVolumeDeviceName: "/dev/xvda",
            machineImage,
            vpc,
            availabilityZone: chosenAvailabilityZone,
            role: instanceRole,
            securityGroup: instanceSG.securityGroup,
            vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
        });

        // Read user-data script
        const nodeStartScript = fs.readFileSync(path.join(__dirname, "assets", "user-data-alinux.sh")).toString();
        const dataVolumeSizeBytes = dataVolume.sizeGiB * constants.GibibytesToBytesConversionCoefficient;

        const modifiedScript = cdk.Fn.sub(nodeStartScript, {
            _AWS_REGION_: REGION,
            _ASSETS_S3_PATH_: `s3://${asset.s3BucketName}/${asset.s3ObjectKey}`,
            _STACK_NAME_: STACK_NAME,
            _STACK_ID_: STACK_ID,
            _NODE_CF_LOGICAL_ID_: node.nodeCFLogicalId,
            _DATA_VOLUME_TYPE_: dataVolume.type,
            _DATA_VOLUME_SIZE_: dataVolumeSizeBytes.toString(),
            _NEAR_VERSION_: nearVersion,
            _NEAR_NETWORK_: nearNetwork,
            _SNAPSHOT_URL_: snapshotUrl ?? constants.NoneValue,
            _LIMIT_OUT_TRAFFIC_MBPS_: limitOutTrafficMbps.toString(),
        });
        node.instance.addUserData(modifiedScript);

        // TODO: Add CloudWatch dashboard JSON similar to others
        new cdk.CfnOutput(this, "node-instance-id", {
            value: node.instanceId,
        });

        nag.NagSuppressions.addResourceSuppressions(
            this,
            [
                { id: "AwsSolutions-IAM5", reason: "Need read access to the S3 bucket with assets" },
            ],
            true
        );
    }
} 