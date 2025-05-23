import { Match, Template } from "aws-cdk-lib/assertions";
import * as cdk from "aws-cdk-lib";
import * as dotenv from 'dotenv';
dotenv.config({ path: './test/.env-test' });

import * as config from "../lib/config/node-config";
import { NearRpcNodesStack } from "../lib/rpc-nodes-stack";

describe("NearRpcNodesStack", () => {
  test("creates ALB listener on port 3030 and correct desired capacity", () => {
    const app = new cdk.App();

    const stack = new NearRpcNodesStack(app, "near-rpc-nodes-test", {
      stackName: "near-rpc-nodes-test",
      env: { account: "111111111111", region: "us-east-1" },
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

    const template = Template.fromStack(stack);

    // AutoScalingGroup desired capacity
    template.hasResourceProperties("AWS::AutoScaling::AutoScalingGroup", {
      DesiredCapacity: `${config.nodeConfig.numberOfNodes}`,
    });

    // ALB Listener on port 3030
    template.hasResourceProperties("AWS::ElasticLoadBalancingV2::Listener", {
      Port: 3030,
      Protocol: "HTTP",
    });
  });
}); 