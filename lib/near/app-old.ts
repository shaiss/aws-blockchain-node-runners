#!/usr/bin/env node
import 'dotenv/config';
import "source-map-support/register";
import * as cdk from "aws-cdk-lib";
import * as nag from "cdk-nag";
import * as config from "./lib/config/node-config";

import { NearCommonStack } from "./lib/common-stack";
import { NearSingleNodeStack } from "./lib/single-node-stack";
import { NearRpcNodesStack } from "./lib/rpc-nodes-stack";

const app = new cdk.App();
cdk.Tags.of(app).add("Project", "AWSNear");

new NearCommonStack(app, "near-common", {
    stackName: `near-nodes-common`,
    env: { account: config.baseConfig.accountId, region: config.baseConfig.region },
});

// Decide deployment mode based on env var DEPLOY_MODE (single | ha | both)
const deployMode = process.env.DEPLOY_MODE ?? "both";

if (deployMode === "single" || deployMode === "both") {
    new NearSingleNodeStack(app, "near-single-node", {
        stackName: `near-single-node`,
        env: { account: config.baseConfig.accountId, region: config.baseConfig.region },
        instanceType: config.nodeConfig.instanceType,
        instanceCpuType: config.nodeConfig.instanceCpuType,
        nearNetwork: config.nodeConfig.nearNetwork,
        nearVersion: config.nodeConfig.nearVersion,
        dataVolume: config.nodeConfig.dataVolume,
        limitOutTrafficMbps: config.nodeConfig.limitOutTrafficMbps,
    });
}

if (deployMode === "ha" || deployMode === "both") {
    new NearRpcNodesStack(app, "near-rpc-nodes", {
        stackName: `near-rpc-nodes`,
        env: { account: config.baseConfig.accountId, region: config.baseConfig.region },
        instanceType: config.nodeConfig.instanceType,
        instanceCpuType: config.nodeConfig.instanceCpuType,
        nearNetwork: config.nodeConfig.nearNetwork,
        nearVersion: config.nodeConfig.nearVersion,
        dataVolume: config.nodeConfig.dataVolume,
        albHealthCheckGracePeriodMin: config.nodeConfig.albHealthCheckGracePeriodMin,
        heartBeatDelayMin: config.nodeConfig.heartBeatDelayMin,
        numberOfNodes: config.nodeConfig.numberOfNodes,
        limitOutTrafficMbps: config.nodeConfig.limitOutTrafficMbps,
    });
}

cdk.Aspects.of(app).add(
    new nag.AwsSolutionsChecks({
        verbose: false,
        reports: true,
        logIgnores: false,
    })
); 