import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as configTypes from "./node-config.interface";
import * as constants from "../../../constructs/constants";

const parseDataVolumeType = (dataVolumeType: string) => {
    switch (dataVolumeType) {
        case "gp3":
            return ec2.EbsDeviceVolumeType.GP3;
        case "io2":
            return ec2.EbsDeviceVolumeType.IO2;
        case "io1":
            return ec2.EbsDeviceVolumeType.IO1;
        case "instance-store":
            return constants.InstanceStoreageDeviceVolumeType;
        default:
            return ec2.EbsDeviceVolumeType.GP3;
    }
};

export const baseConfig: configTypes.NearBaseConfig = {
    accountId: process.env.AWS_ACCOUNT_ID || "xxxxxxxxxxx",
    region: process.env.AWS_REGION || "us-east-1",
    nearNetwork: <configTypes.NearNetwork>(process.env.NEAR_NETWORK || "mainnet"),
    nearVersion: process.env.NEAR_VERSION || "latest",
};

export const nodeConfig: configTypes.NearBaseNodeConfig & configTypes.NearHAConfig = {
    nearNetwork: baseConfig.nearNetwork,
    nearVersion: baseConfig.nearVersion,
    dataVolume: {
        sizeGiB: process.env.NEAR_DATA_VOL_SIZE ? parseInt(process.env.NEAR_DATA_VOL_SIZE) : 1024,
        type: parseDataVolumeType(process.env.NEAR_DATA_VOL_TYPE?.toLowerCase() || "gp3"),
        iops: process.env.NEAR_DATA_VOL_IOPS ? parseInt(process.env.NEAR_DATA_VOL_IOPS) : 6000,
        throughput: process.env.NEAR_DATA_VOL_THROUGHPUT ? parseInt(process.env.NEAR_DATA_VOL_THROUGHPUT) : 250,
    },
    snapshotUrl: process.env.SNAPSHOT_URL || constants.NoneValue,
    limitOutTrafficMbps: process.env.LIMIT_OUT_TRAFFIC_MBPS ? parseInt(process.env.LIMIT_OUT_TRAFFIC_MBPS) : 1000,

    // HA specific
    albHealthCheckGracePeriodMin: process.env.ALB_HEALTHCHECK_GRACE_MIN ? parseInt(process.env.ALB_HEALTHCHECK_GRACE_MIN) : 10,
    heartBeatDelayMin: process.env.HEARTBEAT_DELAY_MIN ? parseInt(process.env.HEARTBEAT_DELAY_MIN) : 60,
    numberOfNodes: process.env.NUMBER_OF_RPC_NODES ? parseInt(process.env.NUMBER_OF_RPC_NODES) : 2,

    // base node config fields
    instanceType: new ec2.InstanceType(process.env.NEAR_INSTANCE_TYPE || "m7g.2xlarge"),
    instanceCpuType: process.env.CPU_TYPE?.toLowerCase() == "x86_64" ? ec2.AmazonLinuxCpuType.X86_64 : ec2.AmazonLinuxCpuType.ARM_64,
}; 