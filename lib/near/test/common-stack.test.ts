import { Template } from "aws-cdk-lib/assertions";
import * as cdk from "aws-cdk-lib";
import * as dotenv from 'dotenv';
// load test env
dotenv.config({ path: './test/.env-test' });

import { NearCommonStack } from "../lib/common-stack";

describe("NearCommonStack", () => {
  test("synthesizes IAM instance role and output", () => {
    const app = new cdk.App();

    const stack = new NearCommonStack(app, "near-common", {
      env: { account: "111111111111", region: "us-east-1" },
      stackName: "near-nodes-common-test",
    });

    const template = Template.fromStack(stack);

    // Assert an IAM Role with EC2 principal exists
    template.hasResourceProperties("AWS::IAM::Role", {
      AssumeRolePolicyDocument: {
        Statement: [
          {
            Action: "sts:AssumeRole",
            Effect: "Allow",
            Principal: { Service: "ec2.amazonaws.com" },
          },
        ],
      },
    });
  });
}); 