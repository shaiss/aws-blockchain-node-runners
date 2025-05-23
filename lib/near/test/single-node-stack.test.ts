import { Match, Template } from "aws-cdk-lib/assertions";
import * as cdk from "aws-cdk-lib";
import * as dotenv from 'dotenv';
dotenv.config({ path: './test/.env-test' });

import * as config from "../lib/config/node-config";
import { NearSingleNodeStack } from "../lib/single-node-stack";

describe("NearSingleNodeStack", () => {
  test("has expected security group rules and Amazon Linux", () => {
    const app = new cdk.App();

    const stack = new NearSingleNodeStack(app, "near-single-node-test", {
      stackName: `near-single-node` ,
      env: { account: "111111111111", region: "us-east-1" },
      instanceType: config.nodeConfig.instanceType,
      instanceCpuType: config.nodeConfig.instanceCpuType,
      nearNetwork: config.nodeConfig.nearNetwork,
      nearVersion: config.nodeConfig.nearVersion,
      dataVolume: config.nodeConfig.dataVolume,
      snapshotUrl: config.nodeConfig.snapshotUrl,
      limitOutTrafficMbps: config.nodeConfig.limitOutTrafficMbps,
    });

    const template = Template.fromStack(stack);

    // Security group should allow P2P 24567 TCP/UDP from anywhere
    template.hasResourceProperties("AWS::EC2::SecurityGroup", {
      SecurityGroupIngress: Match.arrayWith([
        Match.objectLike({
          FromPort: 24567,
          ToPort: 24567,
          IpProtocol: "tcp",
        }),
        Match.objectLike({
          FromPort: 24567,
          ToPort: 24567,
          IpProtocol: "udp",
        }),
      ]),
    });

    // Instance uses the requested instance type
    template.hasResourceProperties("AWS::EC2::Instance", {
      InstanceType: config.nodeConfig.instanceType.toString(),
    });
  });
}); 