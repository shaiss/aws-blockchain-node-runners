import * as cdk from "aws-cdk-lib";
import * as cdkConstructs from "constructs";
import * as ssm from "aws-cdk-lib/aws-ssm";
import * as iam from "aws-cdk-lib/aws-iam";
import * as cw from "aws-cdk-lib/aws-cloudwatch";
import * as cwActions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as sns from "aws-cdk-lib/aws-sns";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as nag from "cdk-nag";
import * as configTypes from "./config/node-config.interface";
import * as fs from "fs";
import * as path from "path";

export interface NearSyncStackProps extends cdk.StackProps {
    nearNetwork: configTypes.NearNetwork;
    nearVersion: string;
}

export class NearSyncStack extends cdk.Stack {
    public readonly syncStatus: string;

    constructor(scope: cdkConstructs.Construct, id: string, props: NearSyncStackProps) {
        super(scope, id, props);

        const { nearNetwork, nearVersion } = props;

        // Import values from previous stacks
        const instanceId = cdk.Fn.importValue("NearInstanceId");
        const installStatus = cdk.Fn.importValue("NearInstallStatus");

        // Create SNS topic for alerts
        const alertsTopic = new sns.Topic(this, "near-sync-alerts", {
            displayName: "NEAR Sync Alerts",
            topicName: `near-sync-alerts-${this.stackName}`,
        });

        // Create SSM documents for sync operations
        const startSyncDoc = this.createSyncDocuments(nearNetwork);
        
        // Create CloudWatch alarms for monitoring
        this.createSyncMonitoring(instanceId, alertsTopic);

        // Start the sync process
        const syncExecution = this.startSyncProcess(instanceId, nearNetwork, startSyncDoc);

        // Create sync monitoring dashboard
        this.createSyncDashboard(instanceId);

        // Stack outputs
        new cdk.CfnOutput(this, "sync-status", {
            value: syncExecution.ref,
            exportName: "NearSyncStatus",
        });

        new cdk.CfnOutput(this, "alerts-topic-arn", {
            value: alertsTopic.topicArn,
            exportName: "NearAlertsTopicArn",
        });
    }

    private createSyncDocuments(nearNetwork: string) {
        // Load SSM documents from JSON files
        const ssmDocumentsPath = path.join(__dirname, "assets", "ssm-documents");
        
        // Load near-sync-status document
        const syncStatusDocPath = path.join(ssmDocumentsPath, "near-sync-status.json");
        const syncStatusDocContent = JSON.parse(fs.readFileSync(syncStatusDocPath, "utf8"));
        
        // Load near-health-check document
        const healthCheckDocPath = path.join(ssmDocumentsPath, "near-health-check.json");
        const healthCheckDocContent = JSON.parse(fs.readFileSync(healthCheckDocPath, "utf8"));
        
        // Load near-service-control document
        const serviceControlDocPath = path.join(ssmDocumentsPath, "near-service-control.json");
        const serviceControlDocContent = JSON.parse(fs.readFileSync(serviceControlDocPath, "utf8"));

        // Document to start NEAR sync
        const startSyncDoc = new ssm.CfnDocument(this, "near-start-sync", {
            documentType: "Command",
            documentFormat: "YAML",
            name: `near-start-sync-${this.stackName}`,
            content: {
                schemaVersion: "2.2",
                description: "Start NEAR Protocol node and begin state synchronization",
                parameters: {
                    nearNetwork: {
                        type: "String",
                        description: "NEAR network",
                        default: nearNetwork
                    }
                },
                mainSteps: [
                    {
                        action: "aws:runShellScript",
                        name: "startNearSync",
                        inputs: {
                            timeoutSeconds: "300",
                            runCommand: [
                                "#!/bin/bash",
                                "source /etc/near-environment && echo '[SYNC-STACK] Starting NEAR node' >> /var/log/near-sync.log 2>&1 && systemctl start near.service && sleep 5 && systemctl is-active --quiet near.service && echo '[SYNC-STACK] NEAR service started successfully' >> /var/log/near-sync.log || (echo '[SYNC-STACK] Failed to start NEAR service' >> /var/log/near-sync.log && exit 1)"
                            ]
                        }
                    }
                ]
            }
        });

        // Document for sync status check (using JSON file)
        new ssm.CfnDocument(this, "near-sync-status", {
            documentType: "Command",
            documentFormat: "JSON",
            name: `near-sync-status-${this.stackName}`,
            content: syncStatusDocContent
        });

        // Document for health check (using JSON file)
        new ssm.CfnDocument(this, "near-health-check", {
            documentType: "Command", 
            documentFormat: "JSON",
            name: `near-health-check-${this.stackName}`,
            content: healthCheckDocContent
        });

        // Document for service control (using JSON file)
        new ssm.CfnDocument(this, "near-service-control", {
            documentType: "Command",
            documentFormat: "JSON",
            name: `near-service-control-${this.stackName}`,
            content: serviceControlDocContent
        });
        
        return startSyncDoc;
    }

    private createSyncMonitoring(instanceId: string, alertsTopic: sns.Topic) {
        // CloudWatch alarm for service health
        const serviceHealthAlarm = new cw.Alarm(this, "near-service-health", {
            alarmName: `near-service-health-${this.stackName}`,
            alarmDescription: "NEAR service health check alarm",
            metric: new cw.Metric({
                namespace: "NEAR/Sync",
                metricName: "ServiceHealth",
                dimensionsMap: {
                    InstanceId: instanceId
                },
                statistic: "Maximum"
            }),
            threshold: 1,
            evaluationPeriods: 2,
            comparisonOperator: cw.ComparisonOperator.LESS_THAN_THRESHOLD,
            treatMissingData: cw.TreatMissingData.BREACHING
        });

        serviceHealthAlarm.addAlarmAction(new cwActions.SnsAction(alertsTopic));

        // CloudWatch alarm for sync progress
        const syncProgressAlarm = new cw.Alarm(this, "near-sync-stalled", {
            alarmName: `near-sync-stalled-${this.stackName}`,
            alarmDescription: "NEAR sync appears to be stalled",
            metric: new cw.Metric({
                namespace: "NEAR/Sync",
                metricName: "BlockHeight",
                dimensionsMap: {
                    InstanceId: instanceId
                },
                statistic: "Maximum"
            }),
            threshold: 100, // No progress in 100 data points
            evaluationPeriods: 5,
            comparisonOperator: cw.ComparisonOperator.LESS_THAN_THRESHOLD,
            treatMissingData: cw.TreatMissingData.IGNORE
        });

        syncProgressAlarm.addAlarmAction(new cwActions.SnsAction(alertsTopic));

        // Scheduled health check every 3 minutes
        const healthCheckRule = new events.Rule(this, "health-check-schedule", {
            description: "Schedule health checks every 3 minutes",
            schedule: events.Schedule.rate(cdk.Duration.minutes(3))
        });

        // Create Lambda function for automated health checks with enhanced NEAR API integration
        const healthCheckFunction = new cdk.aws_lambda.Function(this, "health-check-function", {
            runtime: cdk.aws_lambda.Runtime.PYTHON_3_9,
            handler: "index.handler",
            timeout: cdk.Duration.minutes(2),
            code: cdk.aws_lambda.Code.fromInline(`
import boto3
import json
import time
import os

def handler(event, context):
    cloudwatch = boto3.client('cloudwatch')
    ssm = boto3.client('ssm')
    
    instance_id = '${instanceId}'
    
    try:
        # Get NEAR node status via SSM command on the instance
        try:
            # Run command to get comprehensive NEAR API data from the instance
            response = ssm.send_command(
                InstanceIds=[instance_id],
                DocumentName='AWS-RunShellScript',
                Parameters={
                    'commands': [
                        # Get current block height and sync info
                        'curl -s http://127.0.0.1:3030/status | jq -r ".sync_info.latest_block_height // 0"',
                        'curl -s http://127.0.0.1:3030/status | jq -r ".sync_info.syncing // false"',
                        'curl -s http://127.0.0.1:3030/status | jq -r ".uptime_sec // 0"',
                        'curl -s http://127.0.0.1:3030/status | jq -r ".protocol_version // 0"',
                        'curl -s http://127.0.0.1:3030/status | jq -r ".sync_info.syncing // false"',
                        # Get network info
                        'curl -s http://127.0.0.1:3030/network_info | jq -r ".num_active_peers // 0"',
                        'curl -s http://127.0.0.1:3030/network_info | jq -r ".sent_bytes_per_sec // 0"',
                        'curl -s http://127.0.0.1:3030/network_info | jq -r ".received_bytes_per_sec // 0"',
                        # Get service status
                        'systemctl is-active --quiet near.service && echo "active" || echo "inactive"',
                        # Get latest block from network for sync progress calculation
                        'curl -s https://rpc.mainnet.near.org/status | jq -r ".sync_info.latest_block_height // 0"',
                        # Get sync progress percentage (current block / latest block * 100)
                        'CURRENT=$(curl -s http://127.0.0.1:3030/status | jq -r ".sync_info.latest_block_height // 0") && LATEST=$(curl -s https://rpc.mainnet.near.org/status | jq -r ".sync_info.latest_block_height // 0") && if [ "$LATEST" -gt 0 ]; then echo "scale=2; $CURRENT * 100 / $LATEST" | bc; else echo "0"; fi',
                        # Get block height from previous check for delta calculation
                        'cat /tmp/previous_block_height.txt 2>/dev/null || echo "0"',
                        # Store current block height for next check
                        'CURRENT=$(curl -s http://127.0.0.1:3030/status | jq -r ".sync_info.latest_block_height // 0") && echo $CURRENT > /tmp/previous_block_height.txt && echo $CURRENT'
                    ]
                },
                TimeoutSeconds=30
            )
            
            command_id = response['Command']['CommandId']
            time.sleep(5)  # Brief wait
            
            result = ssm.get_command_invocation(
                CommandId=command_id,
                InstanceId=instance_id
            )
            
            status = result.get('Status')
            exit_code = result.get('ResponseCode', 0)
            output = result.get('StandardOutputContent', '')
            
            if status == 'Success' and exit_code == 0:
                # Parse the output lines
                lines = output.strip().split('\\n')
                if len(lines) >= 13:
                    block_height = int(lines[0]) if lines[0].isdigit() else 0
                    syncing = 1 if lines[1].lower() == 'true' else 0
                    uptime_sec = int(lines[2]) if lines[2].isdigit() else 0
                    protocol_version = int(lines[3]) if lines[3].isdigit() else 0
                    syncing_status = 1 if lines[4].lower() == 'true' else 0
                    active_peers = int(lines[5]) if lines[5].isdigit() else 0
                    sent_bytes_per_sec = int(lines[6]) if lines[6].isdigit() else 0
                    received_bytes_per_sec = int(lines[7]) if lines[7].isdigit() else 0
                    service_health = 1 if lines[8].strip() == 'active' else 0
                    latest_network_block = int(lines[9]) if lines[9].isdigit() else 0
                    sync_progress_percent = float(lines[10]) if lines[10].replace('.', '').isdigit() else 0.0
                    previous_block_height = int(lines[11]) if lines[11].isdigit() else 0
                    current_block_height = int(lines[12]) if lines[12].isdigit() else 0
                else:
                    block_height = 0
                    syncing = 0
                    uptime_sec = 0
                    protocol_version = 0
                    syncing_status = 0
                    active_peers = 0
                    sent_bytes_per_sec = 0
                    received_bytes_per_sec = 0
                    service_health = 0
                    latest_network_block = 0
                    sync_progress_percent = 0.0
                    previous_block_height = 0
                    current_block_height = 0
            else:
                block_height = 0
                syncing = 0
                uptime_sec = 0
                protocol_version = 0
                syncing_status = 0
                active_peers = 0
                sent_bytes_per_sec = 0
                received_bytes_per_sec = 0
                service_health = 0
                latest_network_block = 0
                sync_progress_percent = 0.0
                previous_block_height = 0
                current_block_height = 0
                
            # Calculate derived metrics
            block_height_delta = current_block_height - previous_block_height if previous_block_height > 0 else 0
            sync_speed_blocks_per_min = block_height_delta * 2  # Assuming 3-minute intervals, so *2 for per-minute rate
            sync_lag_blocks = latest_network_block - current_block_height if latest_network_block > 0 else 0
            
            # Determine sync status with more granularity
            if service_health == 0:
                sync_status_detailed = 0  # Service down
            elif active_peers == 0:
                sync_status_detailed = 1  # No peers
            elif block_height_delta == 0:
                sync_status_detailed = 2  # Stalled
            elif sync_progress_percent >= 99.5:
                sync_status_detailed = 3  # Fully synced
            else:
                sync_status_detailed = 4  # Actively syncing
                
            print(f'ENHANCED METRICS v2: Block={current_block_height}, Delta={block_height_delta}, Progress={sync_progress_percent:.2f}%, Speed={sync_speed_blocks_per_min} blocks/min, Lag={sync_lag_blocks}, Status={sync_status_detailed}, Peers={active_peers}')
                
        except Exception as ssm_error:
            print(f'SSM command failed: {str(ssm_error)}')
            block_height = 0
            syncing = 0
            service_health = 0
            sync_progress_percent = 0.0
            block_height_delta = 0
            sync_speed_blocks_per_min = 0
            sync_lag_blocks = 0
            sync_status_detailed = 0
            active_peers = 0
            sent_bytes_per_sec = 0
            received_bytes_per_sec = 0
            uptime_sec = 0
            protocol_version = 0
        
        # Send comprehensive enhanced metrics to CloudWatch
        cloudwatch.put_metric_data(
            Namespace='NEAR/Sync',
            MetricData=[
                {
                    'MetricName': 'ServiceHealth',
                    'Dimensions': [{'Name': 'InstanceId', 'Value': instance_id}],
                    'Value': service_health,
                    'Unit': 'Count'
                },
                {
                    'MetricName': 'BlockHeight',
                    'Dimensions': [{'Name': 'InstanceId', 'Value': instance_id}],
                    'Value': block_height,
                    'Unit': 'Count'
                },
                {
                    'MetricName': 'BlockHeightDelta',
                    'Dimensions': [{'Name': 'InstanceId', 'Value': instance_id}],
                    'Value': block_height_delta,
                    'Unit': 'Count'
                },
                {
                    'MetricName': 'SyncProgressPercent',
                    'Dimensions': [{'Name': 'InstanceId', 'Value': instance_id}],
                    'Value': sync_progress_percent,
                    'Unit': 'Percent'
                },
                {
                    'MetricName': 'SyncSpeedBlocksPerMin',
                    'Dimensions': [{'Name': 'InstanceId', 'Value': instance_id}],
                    'Value': sync_speed_blocks_per_min,
                    'Unit': 'Count/Second'
                },
                {
                    'MetricName': 'SyncLagBlocks',
                    'Dimensions': [{'Name': 'InstanceId', 'Value': instance_id}],
                    'Value': sync_lag_blocks,
                    'Unit': 'Count'
                },
                {
                    'MetricName': 'SyncStatusDetailed',
                    'Dimensions': [{'Name': 'InstanceId', 'Value': instance_id}],
                    'Value': sync_status_detailed,
                    'Unit': 'Count'
                },
                {
                    'MetricName': 'ActivePeers',
                    'Dimensions': [{'Name': 'InstanceId', 'Value': instance_id}],
                    'Value': active_peers,
                    'Unit': 'Count'
                },
                {
                    'MetricName': 'NetworkSentBytesPerSec',
                    'Dimensions': [{'Name': 'InstanceId', 'Value': instance_id}],
                    'Value': sent_bytes_per_sec,
                    'Unit': 'Bytes/Second'
                },
                {
                    'MetricName': 'NetworkReceivedBytesPerSec',
                    'Dimensions': [{'Name': 'InstanceId', 'Value': instance_id}],
                    'Value': received_bytes_per_sec,
                    'Unit': 'Bytes/Second'
                },
                {
                    'MetricName': 'UptimeSeconds',
                    'Dimensions': [{'Name': 'InstanceId', 'Value': instance_id}],
                    'Value': uptime_sec,
                    'Unit': 'Seconds'
                },
                {
                    'MetricName': 'ProtocolVersion',
                    'Dimensions': [{'Name': 'InstanceId', 'Value': instance_id}],
                    'Value': protocol_version,
                    'Unit': 'Count'
                }
            ]
        )
        
        return {
            'statusCode': 200,
            'body': json.dumps({
                'service_health': service_health,
                'block_height': block_height,
                'block_height_delta': block_height_delta,
                'sync_progress_percent': sync_progress_percent,
                'sync_speed_blocks_per_min': sync_speed_blocks_per_min,
                'sync_lag_blocks': sync_lag_blocks,
                'sync_status_detailed': sync_status_detailed,
                'active_peers': active_peers,
                'message': 'Enhanced health check completed successfully'
            })
        }
        
    except Exception as e:
        print(f'Health check failed: {str(e)}')
        
        # Send failure metrics
        cloudwatch.put_metric_data(
            Namespace='NEAR/Sync',
            MetricData=[
                {
                    'MetricName': 'ServiceHealth',
                    'Dimensions': [{'Name': 'InstanceId', 'Value': instance_id}],
                    'Value': 0,
                    'Unit': 'Count'
                },
                {
                    'MetricName': 'SyncStatusDetailed',
                    'Dimensions': [{'Name': 'InstanceId', 'Value': instance_id}],
                    'Value': 0,
                    'Unit': 'Count'
                }
            ]
        )
        
        return {
            'statusCode': 500,
            'body': json.dumps(f'Error: {str(e)}')
        }
`),
        });

        // Grant permissions for SSM and CloudWatch
        healthCheckFunction.addToRolePolicy(new iam.PolicyStatement({
            actions: [
                "ssm:SendCommand",
                "ssm:GetCommandInvocation",
                "cloudwatch:PutMetricData"
            ],
            resources: ["*"]
        }));



        healthCheckRule.addTarget(new targets.LambdaFunction(healthCheckFunction));
    }

    private startSyncProcess(instanceId: string, nearNetwork: string, startSyncDoc: ssm.CfnDocument) {
        // Execute the sync start via SSM association
        const syncExecution = new ssm.CfnAssociation(this, "near-sync-execution", {
            name: startSyncDoc.ref,
            targets: [
                {
                    key: "InstanceIds",
                    values: [instanceId]
                }
            ],
            parameters: {
                nearNetwork: [nearNetwork]
            },
            applyOnlyAtCronInterval: false,
            maxConcurrency: "1",
            maxErrors: "0"
        });

        syncExecution.addDependency(startSyncDoc);

        return syncExecution;
    }

    private createSyncDashboard(instanceId: string) {
        const dashboard = new cw.Dashboard(this, "near-sync-dashboard", {
            dashboardName: `near-sync-${this.stackName}`,
            widgets: [
                [
                    new cw.GraphWidget({
                        title: "Sync Status Detailed (0=Down, 1=No Peers, 2=Stalled, 3=Synced, 4=Syncing)",
                        left: [
                            new cw.Metric({
                                namespace: "NEAR/Sync",
                                metricName: "SyncStatusDetailed",
                                dimensionsMap: { InstanceId: instanceId },
                                statistic: "Maximum"
                            })
                        ],
                        width: 12,
                        height: 6
                    })
                ],
                [
                    new cw.GraphWidget({
                        title: "Sync Progress (%)", 
                        left: [
                            new cw.Metric({
                                namespace: "NEAR/Sync",
                                metricName: "SyncProgressPercent",
                                dimensionsMap: { InstanceId: instanceId },
                                statistic: "Maximum"
                            })
                        ],
                        width: 12,
                        height: 6
                    })
                ],
                [
                    new cw.GraphWidget({
                        title: "Block Height & Sync Speed", 
                        left: [
                            new cw.Metric({
                                namespace: "NEAR/Sync",
                                metricName: "BlockHeight",
                                dimensionsMap: { InstanceId: instanceId },
                                statistic: "Maximum"
                            })
                        ],
                        right: [
                            new cw.Metric({
                                namespace: "NEAR/Sync",
                                metricName: "SyncSpeedBlocksPerMin",
                                dimensionsMap: { InstanceId: instanceId },
                                statistic: "Average"
                            })
                        ],
                        width: 12,
                        height: 6
                    })
                ],
                [
                    new cw.GraphWidget({
                        title: "Block Height Delta & Sync Lag", 
                        left: [
                            new cw.Metric({
                                namespace: "NEAR/Sync",
                                metricName: "BlockHeightDelta",
                                dimensionsMap: { InstanceId: instanceId },
                                statistic: "Maximum"
                            })
                        ],
                        right: [
                            new cw.Metric({
                                namespace: "NEAR/Sync",
                                metricName: "SyncLagBlocks",
                                dimensionsMap: { InstanceId: instanceId },
                                statistic: "Maximum"
                            })
                        ],
                        width: 12,
                        height: 6
                    })
                ],
                [
                    new cw.GraphWidget({
                        title: "Network Activity", 
                        left: [
                            new cw.Metric({
                                namespace: "NEAR/Sync",
                                metricName: "NetworkSentBytesPerSec",
                                dimensionsMap: { InstanceId: instanceId },
                                statistic: "Average"
                            })
                        ],
                        right: [
                            new cw.Metric({
                                namespace: "NEAR/Sync",
                                metricName: "NetworkReceivedBytesPerSec",
                                dimensionsMap: { InstanceId: instanceId },
                                statistic: "Average"
                            })
                        ],
                        width: 12,
                        height: 6
                    })
                ],
                [
                    new cw.GraphWidget({
                        title: "Peer Connections & Service Health", 
                        left: [
                            new cw.Metric({
                                namespace: "NEAR/Sync",
                                metricName: "ActivePeers",
                                dimensionsMap: { InstanceId: instanceId },
                                statistic: "Maximum"
                            })
                        ],
                        right: [
                            new cw.Metric({
                                namespace: "NEAR/Sync",
                                metricName: "ServiceHealth",
                                dimensionsMap: { InstanceId: instanceId },
                                statistic: "Maximum"
                            })
                        ],
                        width: 12,
                        height: 6
                    })
                ],
                [
                    new cw.GraphWidget({
                        title: "System Resources (from Infrastructure Stack)",
                        left: [
                            new cw.Metric({
                                namespace: "AWS/EC2",
                                metricName: "CPUUtilization",
                                dimensionsMap: { InstanceId: instanceId },
                                statistic: "Average"
                            })
                        ],
                        right: [
                            new cw.Metric({
                                namespace: "CWAgent", 
                                metricName: "mem_used_percent",
                                dimensionsMap: { InstanceId: instanceId },
                                statistic: "Average"
                            })
                        ],
                        width: 12,
                        height: 6
                    })
                ]
            ]
        });

        // Add CDK Nag suppressions
        nag.NagSuppressions.addResourceSuppressions(
            this,
            [
                {
                    id: "AwsSolutions-SNS3",
                    reason: "SNS topic for operational alerts does not require SSL for internal CloudWatch alarms",
                },
                {
                    id: "AwsSolutions-IAM4",
                    reason: "Lambda basic execution role is standard and acceptable for monitoring functions",
                },
                {
                    id: "AwsSolutions-IAM5",
                    reason: "Wildcard permissions needed for CloudWatch metrics and SSM command execution",
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