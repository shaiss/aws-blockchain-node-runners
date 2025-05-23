import * as cdk from "aws-cdk-lib";
import * as constructs from "constructs";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3Assets from "aws-cdk-lib/aws-s3-assets";
import * as cw from 'aws-cdk-lib/aws-cloudwatch';
import * as nag from "cdk-nag";
import * as path from "path";
import * as fs from "fs";
import * as configTypes from "./config/node-config.interface";
import { NearNodeSecurityGroupConstruct } from "./constructs/near-node-security-group";
import { HANodesConstruct } from "../../constructs/ha-rpc-nodes-with-alb";
import * as constants from "../../constructs/constants";
import * as nodeCwDashboard from "./constructs/node-cw-dashboard";

export interface NearRpcNodesStackProps extends cdk.StackProps {
    instanceType: ec2.InstanceType;
    instanceCpuType: ec2.AmazonLinuxCpuType;

    nearNetwork: configTypes.NearNetwork;
    nearVersion: string;
    dataVolume: configTypes.NearDataVolumeConfig;

    albHealthCheckGracePeriodMin: number;
    heartBeatDelayMin: number;
    numberOfNodes: number;
    limitOutTrafficMbps: number;
}

export class NearRpcNodesStack extends cdk.Stack {
    constructor(scope: constructs.Construct, id: string, props: NearRpcNodesStackProps) {
        super(scope, id, props);

        // Environment
        const REGION = cdk.Stack.of(this).region;
        const STACK_NAME = cdk.Stack.of(this).stackName;
        const lifecycleHookName = STACK_NAME;
        const autoScalingGroupName = STACK_NAME;

        const {
            instanceType,
            instanceCpuType,
            nearNetwork,
            nearVersion,
            dataVolume,
            albHealthCheckGracePeriodMin,
            heartBeatDelayMin,
            numberOfNodes,
            limitOutTrafficMbps,
        } = props;

        // Default VPC
        const vpc = ec2.Vpc.fromLookup(this, "vpc", { isDefault: true });

        const instanceSG = new NearNodeSecurityGroupConstruct(this, "security-group", { vpc });

        // Asset bundle
        const asset = new s3Assets.Asset(this, "assets", {
            path: path.join(__dirname, "assets"),
        });

        const importedInstanceRoleArn = cdk.Fn.importValue("NearNodeInstanceRoleArn");
        const instanceRole = iam.Role.fromRoleArn(this, "iam-role", importedInstanceRoleArn);
        asset.bucket.grantRead(instanceRole);

        // Amazon Linux 2023 AMI
        const machineImage = new ec2.AmazonLinuxImage({
            generation: ec2.AmazonLinuxGeneration.AMAZON_LINUX_2023,
            kernel: ec2.AmazonLinuxKernel.KERNEL6_1,
            cpuType: instanceCpuType,
        });

        // Build user-data script
        const nodeScript = fs.readFileSync(path.join(__dirname, "assets", "user-data-alinux.sh")).toString();
        const dataVolumeSizeBytes = dataVolume.sizeGiB * constants.GibibytesToBytesConversionCoefficient;

        const modifiedInitNodeScript = cdk.Fn.sub(nodeScript, {
            _AWS_REGION_: REGION,
            _ASSETS_S3_PATH_: `s3://${asset.s3BucketName}/${asset.s3ObjectKey}`,
            _STACK_NAME_: STACK_NAME,
            _STACK_ID_: constants.NoneValue,
            _NODE_CF_LOGICAL_ID_: constants.NoneValue,
            _DATA_VOLUME_TYPE_: dataVolume.type,
            _DATA_VOLUME_SIZE_: dataVolumeSizeBytes.toString(),
            _NEAR_VERSION_: nearVersion,
            _NEAR_NETWORK_: nearNetwork,
            _SNAPSHOT_URL_: constants.NoneValue,
            _LIFECYCLE_HOOK_NAME_: lifecycleHookName,
            _ASG_NAME_: autoScalingGroupName,
            _LIMIT_OUT_TRAFFIC_MBPS_: limitOutTrafficMbps.toString(),
        });

        const healthCheckPath = "/status";
        const rpcNodes = new HANodesConstruct(this, "rpc-nodes", {
            instanceType,
            dataVolumes: [dataVolume],
            rootDataVolumeDeviceName: "/dev/xvda",
            machineImage,
            role: instanceRole,
            vpc,
            securityGroup: instanceSG.securityGroup,
            userData: modifiedInitNodeScript,
            numberOfNodes,
            rpcPortForALB: 3030,
            albHealthCheckGracePeriodMin,
            healthCheckPath,
            heartBeatDelayMin,
            lifecycleHookName,
            autoScalingGroupName,
        });

        // Adding CloudWatch dashboard for multiple RPC nodes
        // Note: For HA setup, we'll create a dashboard that can monitor multiple instances
        const dashboardString = cdk.Fn.sub(JSON.stringify(nodeCwDashboard.SingleNodeCWDashboardJSON), {
            INSTANCE_ID: "*",  // Wildcard to show all instances in the ASG
            INSTANCE_NAME: STACK_NAME,
            REGION: REGION,
        });

        new cw.CfnDashboard(this, 'rpc-nodes-cw-dashboard', {
            dashboardName: `${STACK_NAME}-rpc-nodes`,
            dashboardBody: dashboardString,
        });

        new cdk.CfnOutput(this, "alb-url", {
            value: rpcNodes.loadBalancerDnsName,
        });

        nag.NagSuppressions.addResourceSuppressions(
            this,
            [
                { id: "AwsSolutions-AS3", reason: "No notifications needed" },
                { id: "AwsSolutions-S1", reason: "No access log needed for ALB logs bucket" },
                { id: "AwsSolutions-EC28", reason: "Using basic monitoring to save costs" },
                { id: "AwsSolutions-IAM5", reason: "Need read access to the S3 bucket with assets" },
            ],
            true
        );
    }
} 