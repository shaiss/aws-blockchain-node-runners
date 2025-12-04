#!/usr/bin/env node
import 'dotenv/config';
import "source-map-support/register";
import * as cdk from "aws-cdk-lib";
import * as nag from "cdk-nag";
import * as config from "./lib/config/node-config";

import { NearCommonStack } from "./lib/common-stack";
import { NearInfrastructureStack } from "./lib/infrastructure-stack";
import { NearInstallStack } from "./lib/install-stack";
import { NearSyncStack } from "./lib/sync-stack";

/**
 * NEAR Multi-Stack Application
 * 
 * This implements the approved two-phase approach:
 * Phase 1: Early cfn-signal pattern (like Solana/Base) - signals after infrastructure ready
 * Phase 2: Multi-stack architecture following AWS best practices for lifecycle separation
 * 
 * Stack Progression:
 * 1. Common Stack - IAM roles, shared resources
 * 2. Infrastructure Stack - EC2 instance, cfn-signal (~5 min)
 * 3. Install Stack - NEAR installation via SSM (~80 min)  
 * 4. Sync Stack - Start NEAR service and monitoring (~immediate, 4-5hr sync)
 */

const app = new cdk.App();
cdk.Tags.of(app).add("Project", "AWSNear");
cdk.Tags.of(app).add("Architecture", "MultiStack");

// Phase 1: Common resources (IAM roles, security groups, etc.)
const commonStack = new NearCommonStack(app, "near-common", {
    stackName: `near-nodes-common`,
    env: { account: config.baseConfig.accountId, region: config.baseConfig.region },
    description: "NEAR Common Stack - Shared IAM roles and security groups",
});

// Only deploy single node with multi-stack architecture for now
// TODO: Add HA support to multi-stack architecture in future
const deployMode = process.env.DEPLOY_MODE ?? "single";

if (deployMode === "single") {
    console.log("🚀 Deploying NEAR node with multi-stack architecture");
    console.log("📋 Stack progression: Infrastructure → Install → Sync");

    // Phase 2: Infrastructure Stack - Fast deployment with cfn-signal
    const infrastructureStack = new NearInfrastructureStack(app, "near-infrastructure", {
        stackName: `near-infrastructure`,
        env: { account: config.baseConfig.accountId, region: config.baseConfig.region },
        description: "NEAR Infrastructure Stack - EC2 instance with cfn-signal fixes",
        instanceType: config.nodeConfig.instanceType,
        instanceCpuType: config.nodeConfig.instanceCpuType,
        nearNetwork: config.nodeConfig.nearNetwork,
        nearVersion: config.nodeConfig.nearVersion,
        dataVolume: config.nodeConfig.dataVolume,
        limitOutTrafficMbps: config.nodeConfig.limitOutTrafficMbps,
    });

    // Explicit dependency on common stack
    infrastructureStack.addDependency(commonStack);

    // Phase 3: Install Stack - NEAR binary installation and compilation
    const installStack = new NearInstallStack(app, "near-install", {
        stackName: `near-install`,
        env: { account: config.baseConfig.accountId, region: config.baseConfig.region },
        description: "NEAR Install Stack - NEAR binary installation via SSM",
        nearNetwork: config.nodeConfig.nearNetwork,
        nearVersion: config.nodeConfig.nearVersion,
    });

    // Install stack depends on infrastructure being ready
    installStack.addDependency(infrastructureStack);

    // Phase 4: Sync Stack - Start NEAR service and monitoring
    const syncStack = new NearSyncStack(app, "near-sync", {
        stackName: `near-sync`,
        env: { account: config.baseConfig.accountId, region: config.baseConfig.region },
        description: "NEAR Sync Stack - Start NEAR service and sync monitoring",
        nearNetwork: config.nodeConfig.nearNetwork,
        nearVersion: config.nodeConfig.nearVersion,
    });

    // Sync stack depends on installation being complete
    syncStack.addDependency(installStack);

    console.log("✅ Multi-stack architecture configured");
    console.log("⏱️  Expected timeline:");
    console.log("   - Infrastructure: ~5 minutes (cfn-signal working)");
    console.log("   - Install: ~80 minutes (Rust compilation)");
    console.log("   - Sync: ~immediate (4-5 hours for full sync)");

} else if (deployMode === "ha") {
    console.error("❌ HA mode not yet supported with multi-stack architecture");
    console.error("   Please use DEPLOY_MODE=single for now");
    process.exit(1);
} else {
    console.error("❌ Invalid DEPLOY_MODE. Use 'single' for multi-stack architecture");
    process.exit(1);
}

// Apply CDK Nag security checks
cdk.Aspects.of(app).add(
    new nag.AwsSolutionsChecks({
        verbose: false,
        reports: true,
        logIgnores: false,
    })
);

console.log("🔐 CDK Nag security checks enabled");