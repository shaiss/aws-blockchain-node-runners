import * as cdk from "aws-cdk-lib";
import * as constructs from "constructs";
import * as iam from "aws-cdk-lib/aws-iam";
import * as nag from "cdk-nag";

export interface NearCommonStackProps extends cdk.StackProps {}

export class NearCommonStack extends cdk.Stack {
    AWS_STACKNAME = cdk.Stack.of(this).stackName;
    AWS_ACCOUNT_ID = cdk.Stack.of(this).account;

    constructor(scope: constructs.Construct, id: string, props: NearCommonStackProps) {
        super(scope, id, props);

        const region = cdk.Stack.of(this).region;

        const instanceRole = new iam.Role(this, "near-node-role", {
            assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
            managedPolicies: [
                iam.ManagedPolicy.fromAwsManagedPolicyName("SecretsManagerReadWrite"),
                iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonSSMManagedInstanceCore"),
                iam.ManagedPolicy.fromAwsManagedPolicyName("CloudWatchAgentServerPolicy"),
            ],
        });

        // Allow CloudFormation signal
        instanceRole.addToPolicy(
            new iam.PolicyStatement({
                resources: ["*"],
                actions: ["cloudformation:SignalResource"],
            })
        );

        instanceRole.addToPolicy(
            new iam.PolicyStatement({
                resources: [
                    `arn:aws:autoscaling:${region}:${this.AWS_ACCOUNT_ID}:autoScalingGroup:*:autoScalingGroupName/near-*`,
                ],
                actions: ["autoscaling:CompleteLifecycleAction"],
            })
        );

        // Allow access to CloudFormation templates bucket (example)
        instanceRole.addToPolicy(
            new iam.PolicyStatement({
                resources: [
                    `arn:aws:s3:::cloudformation-examples`,
                    `arn:aws:s3:::cloudformation-examples/*`,
                ],
                actions: ["s3:ListBucket", "s3:*Object", "s3:GetBucket*"],
            })
        );

        instanceRole.addToPolicy(
            new iam.PolicyStatement({
                resources: [`arn:aws:cloudwatch::${this.AWS_ACCOUNT_ID}:dashboard/near-*`],
                actions: ["cloudwatch:PutDashboard", "cloudwatch:GetDashboard"],
            })
        );

        // Add CloudWatch Logs permissions for user-data script logging
        instanceRole.addToPolicy(
            new iam.PolicyStatement({
                resources: [
                    `arn:aws:logs:${region}:${this.AWS_ACCOUNT_ID}:log-group:/aws/ec2/user-data`,
                    `arn:aws:logs:${region}:${this.AWS_ACCOUNT_ID}:log-group:/aws/ec2/user-data:*`
                ],
                actions: [
                    "logs:CreateLogGroup",
                    "logs:CreateLogStream", 
                    "logs:PutLogEvents",
                    "logs:DescribeLogStreams",
                    "logs:DescribeLogGroups"
                ],
            })
        );

        new cdk.CfnOutput(this, "Instance Role ARN", {
            value: instanceRole.roleArn,
            exportName: "NearNodeInstanceRoleArn",
        });

        nag.NagSuppressions.addResourceSuppressions(
            this,
            [
                {
                    id: "AwsSolutions-IAM4",
                    reason: "Amazon managed policies used are restrictive enough",
                },
                {
                    id: "AwsSolutions-IAM5",
                    reason: "Wildcard resources required for cloudformation signal and autoscaling actions",
                },
            ],
            true
        );
    }
} 