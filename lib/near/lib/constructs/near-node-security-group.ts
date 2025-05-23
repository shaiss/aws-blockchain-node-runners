import * as cdk from "aws-cdk-lib";
import * as constructs from "constructs";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as nag from "cdk-nag";

export interface NearNodeSecurityGroupProps {
    vpc: cdk.aws_ec2.IVpc;
}

export class NearNodeSecurityGroupConstruct extends constructs.Construct {
    public readonly securityGroup: cdk.aws_ec2.ISecurityGroup;

    constructor(scope: constructs.Construct, id: string, props: NearNodeSecurityGroupProps) {
        super(scope, id);

        const { vpc } = props;

        const sg = new ec2.SecurityGroup(this, "near-node-security-group", {
            vpc,
            description: "Security Group for NEAR blockchain nodes",
            allowAllOutbound: true,
        });

        // --- Public ports (P2P communication) ---
        // NEAR typically uses TCP/UDP 24567 for P2P traffic.
        sg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(24567), "Allow NEAR P2P TCP traffic");
        sg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.udp(24567), "Allow NEAR P2P UDP traffic");

        // --- Private ports restricted to VPC CIDR ---
        // RPC JSON-RPC endpoint (HTTP)
        sg.addIngressRule(
            ec2.Peer.ipv4(vpc.vpcCidrBlock),
            ec2.Port.tcp(3030),
            "Allow internal access to NEAR RPC (HTTP)"
        );

        // Optional Prometheus metrics port (internal only)
        sg.addIngressRule(
            ec2.Peer.ipv4(vpc.vpcCidrBlock),
            ec2.Port.tcp(9333),
            "Allow internal access to NEAR metrics"
        );

        this.securityGroup = sg;

        /**
         * CDK-Nag suppressions
         */
        nag.NagSuppressions.addResourceSuppressions(
            this,
            [
                {
                    id: "AwsSolutions-EC23",
                    reason: "Wildcard ingress needed for P2P NEAR network traffic.",
                },
            ],
            true
        );
    }
} 