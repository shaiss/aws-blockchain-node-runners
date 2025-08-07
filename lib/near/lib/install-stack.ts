import * as cdk from "aws-cdk-lib";
import * as cdkConstructs from "constructs";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as ssm from "aws-cdk-lib/aws-ssm";
import * as s3Assets from "aws-cdk-lib/aws-s3-assets";
import * as path from "path";
import * as fs from "fs";
import * as nag from "cdk-nag";
import * as configTypes from "./config/node-config.interface";

export interface NearInstallStackProps extends cdk.StackProps {
    nearNetwork: configTypes.NearNetwork;
    nearVersion: string;
}

export class NearInstallStack extends cdk.Stack {
    public readonly installStatus: string;

    constructor(scope: cdkConstructs.Construct, id: string, props: NearInstallStackProps) {
        super(scope, id, props);

        const { nearNetwork, nearVersion } = props;

        // Import values from infrastructure stack
        const instanceId = cdk.Fn.importValue("NearInstanceId");
        const assetsBucket = cdk.Fn.importValue("NearAssetsBucket");
        const assetsKey = cdk.Fn.importValue("NearAssetsKey");

        // Upload the NEAR installation script to S3
        const installScript = new s3Assets.Asset(this, "near-install-script", {
            path: path.join(__dirname, "assets", "near-install.sh"),
        });

        // Grant the instance access to the install script
        const importedInstanceRoleArn = cdk.Fn.importValue("NearNodeInstanceRoleArn");
        const instanceRole = iam.Role.fromRoleArn(this, "instance-role", importedInstanceRoleArn);
        installScript.bucket.grantRead(instanceRole);

        // Create SSM document for NEAR installation
        const installDocument = new ssm.CfnDocument(this, "near-install-document", {
            documentType: "Command",
            documentFormat: "YAML",
            name: `near-install-${this.stackName}`,
            content: {
                schemaVersion: "2.2",
                description: "Install NEAR Protocol dependencies, Rust, and compile neard binary",
                parameters: {
                    nearVersion: {
                        type: "String",
                        description: "NEAR Protocol version to install",
                        default: nearVersion
                    },
                    nearNetwork: {
                        type: "String", 
                        description: "NEAR network (mainnet/testnet)",
                        default: nearNetwork
                    },
                    installScriptBucket: {
                        type: "String",
                        description: "S3 bucket containing install script"
                    },
                    installScriptKey: {
                        type: "String",
                        description: "S3 key for install script"
                    }
                },
                mainSteps: [
                    {
                        action: "aws:runShellScript",
                        name: "downloadInstallScript",
                        inputs: {
                            timeoutSeconds: "300",
                            runCommand: [
                                "#!/bin/bash",
                                "set -euo pipefail",
                                "echo '[INSTALL-STACK] Downloading NEAR install script from S3'",
                                "aws s3 cp s3://{{installScriptBucket}}/{{installScriptKey}} /tmp/near-install.sh",
                                "chmod +x /tmp/near-install.sh",
                                "echo '[INSTALL-STACK] Install script downloaded successfully'"
                            ]
                        }
                    },
                    {
                        action: "aws:runShellScript",
                        name: "executeInstallScript",
                        inputs: {
                            timeoutSeconds: "4800", // 80 minutes for compilation
                            runCommand: [
                                "#!/bin/bash",
                                "source /etc/near-environment && /tmp/near-install.sh {{nearVersion}} {{nearNetwork}} > /var/log/near-install.log 2>&1"
                            ]
                        }
                    }
                ]
            }
        });

        // Execute the installation via SSM command
        const installExecution = new ssm.CfnAssociation(this, "near-install-execution", {
            name: installDocument.ref,
            targets: [
                {
                    key: "InstanceIds",
                    values: [instanceId]
                }
            ],
            parameters: {
                nearVersion: [nearVersion],
                nearNetwork: [nearNetwork],
                installScriptBucket: [installScript.s3BucketName],
                installScriptKey: [installScript.s3ObjectKey]
            },
            applyOnlyAtCronInterval: false,
            maxConcurrency: "1",
            maxErrors: "0"
        });

        // Stack outputs
        new cdk.CfnOutput(this, "install-document-name", {
            value: installDocument.ref,
            exportName: "NearInstallDocumentName",
        });

        new cdk.CfnOutput(this, "install-association-id", {
            value: installExecution.ref,
            exportName: "NearInstallAssociationId",
            description: "SSM Association ID for tracking installation progress"
        });

        new cdk.CfnOutput(this, "install-status", {
            value: "Installation initiated - monitor via SSM",
            exportName: "NearInstallStatus",
            description: "Use AWS Systems Manager to track installation progress (~80 minutes)"
        });

        this.installStatus = "Installation initiated";

        // Adding suppressions to the stack
        nag.NagSuppressions.addResourceSuppressions(
            this,
            [
                {
                    id: "AwsSolutions-IAM5",
                    reason: "S3 wildcard permissions needed for accessing CDK assets",
                },
                {
                    id: "AwsSolutions-IAM4",
                    reason: "Lambda basic execution role is standard and acceptable",
                },
                {
                    id: "AwsSolutions-L1",
                    reason: "Python 3.9 runtime is acceptable for this Lambda function",
                }
            ],
            true
        );
    }
}
