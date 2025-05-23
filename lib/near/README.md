# NEAR Node Runner Blueprint (AWS CDK)

Provision NEAR RPC and single nodes on AWS using a reusable, production-grade CDK blueprint. This follows the conventions of the Ethereum, Solana, and other blueprints in this repository.

## Table of Contents
- [NEAR Node Runner Blueprint (AWS CDK)](#near-node-runner-blueprint-aws-cdk)
  - [Table of Contents](#table-of-contents)
  - [Overview](#overview)
  - [Prerequisites](#prerequisites)
  - [Setup Instructions](#setup-instructions)
  - [Mock Deployment (Template Review)](#mock-deployment-template-review)
  - [Deploying to AWS](#deploying-to-aws)
  - [Cleaning Up](#cleaning-up)
  - [Synth Without Credentials](#synth-without-credentials)
  - [Architecture Overview](#architecture-overview)
    - [Single-Node Deployment](#single-node-deployment)
    - [HA (RPC Farm) Deployment](#ha-rpc-farm-deployment)
  - [Optimizing Data Transfer Costs](#optimizing-data-transfer-costs)
  - [Well-Architected Checklist](#well-architected-checklist)
  - [Useful Links](#useful-links)

---

## Overview

This blueprint provisions the AWS infrastructure required to run **NEAR RPC and/or single nodes** on Amazon EC2. It is designed for both development and production, supporting single-node and highly available (HA) deployments. The blueprint follows best practices for security, cost, and operational excellence, and is modeled after the Ethereum, Solana, and BSC blueprints in this repository.

## Prerequisites

- **Node.js ≥ 18** and **npm**
- **AWS CDK v2** (`npm install -g aws-cdk` or use `npx cdk`)
- **AWS credentials** exported in your shell *or* configured via `aws configure`:

```bash
export AWS_ACCESS_KEY_ID=AKIA...               # required
export AWS_SECRET_ACCESS_KEY=xxxxxxxxxxxxxxxx  # required
export AWS_SESSION_TOKEN=yyyyyyyyyyyyyyyyyyy   # only if using STS/temp creds
export AWS_REGION=us-east-1                    # region can also be placed in .env or AWS config
```

If you use named profiles:
```bash
export AWS_PROFILE=myprofile
```

> **Note:** CDK stacks perform lookups (e.g., default VPC) at *synth* time. You must have credentials configured **even to run `cdk synth`**.

## Setup Instructions

Follow these steps to prepare your environment:

1. **Clone the repository and install dependencies**

   ```bash
   git clone https://github.com/aws-samples/aws-blockchain-node-runners.git
   cd aws-blockchain-node-runners
   npm install
   ```

2. **Enter the NEAR blueprint directory**

   ```bash
   cd lib/near
   ```

3. **Configure your environment**

   Copy the sample environment file and edit it to customize values (network, instance size, etc.):

   ```bash
   cp .env-sample .env
   $EDITOR .env
   ```

4. **Build and prepare**

   ```bash
   npm run build
   npx cdk bootstrap
   npx cdk synth
   ```

After completing these setup steps, choose one of the deployment options below.

## Mock Deployment (Template Review)

If you only want to **review CloudFormation templates** without deploying resources, the `npx cdk synth` command from step 4 above generates templates in `cdk.out/` with **no resources deployed**.

## Deploying to AWS

After completing the setup steps above:

1. **Deploy common resources**
   ```bash
   npx cdk deploy near-common
   ```

2. **Deploy your node configuration**
   ```bash
   # Single node
   npx cdk deploy near-single-node
   
   # OR HA setup
   npx cdk deploy near-rpc-nodes
   ```

   **Note:** Your deployment choice depends on the `DEPLOY_MODE` setting in `.env`.

## Cleaning Up

```bash
npx cdk destroy near-rpc-nodes     # or near-single-node
npx cdk destroy near-common
```

> **Remember:** Remove EBS volumes or S3 snapshots if you created any outside of CDK.

## Synth Without Credentials

If you **cannot** or **do not want to** provide AWS credentials:

1. Pre-populate `cdk.context.json` with lookup results from an environment that *does* have credentials. CDK will then use cached context and not make live AWS calls.
2. Refactor the stacks to **avoid lookups** (pass VPC/Subnet IDs via env vars or config). The code is structured so you can replace `Vpc.fromLookup` with `Vpc.fromVpcAttributes` if needed.

## Architecture Overview

### Single-Node Deployment

![Single Node Diagram](./doc/assets/diagram_6cce0f44.png)

*One EC2 instance in the default VPC. Security group rules open NEAR P2P (24567) + internal RPC (3030). Used for development or low-traffic private workloads.*

### HA (RPC Farm) Deployment

![HA Nodes Diagram](./doc/assets/diagram_4fbe9d0c.png)

*Auto Scaling Group (up to 4 nodes) behind an internal Application Load Balancer. ALB listens on port 3030. Nodes share identical user-data and CloudWatch dashboards.*

## Optimizing Data Transfer Costs

NEAR RPC nodes can emit **tens of terabytes** of outbound traffic each month. Consider:

- Using the `LIMIT_OUT_TRAFFIC_MBPS` setting (see `.env`) to rate-limit egress once the node is in sync. 20 Mbit/s ≈ 6 TiB/month.
- Keeping the RPC endpoint **private** (inside the VPC) and fronting it with your own cache or API gateway.
- Exploring AWS **PrivateLink** or **Gateway Load Balancer** for multi-VPC access without Internet egress charges.

## Well-Architected Checklist

| Pillar      | Control            | Check                                         | Remarks                                 |
|-------------|--------------------|-----------------------------------------------|-----------------------------------------|
| Security    | Network isolation  | RPC exposed only on internal ALB              | Modify SG/ALB if public access required |
| Reliability | ASG & ALB          | HA stack deploys up to 4 nodes with health checks | desiredCapacity is user-configurable    |
| Cost Opt    | Egress limits      | Use `LIMIT_OUT_TRAFFIC_MBPS`                  | Potential >80% savings                  |
| Perf Eff    | Graviton           | Default instance type `m7g` for best price/perf | Override in `.env` if x86 is required   |


## Useful Links

- [AWS CDK docs – Environment-Agnostic Stacks](https://docs.aws.amazon.com/cdk/latest/guide/environments.html#environments_env_agnostic)
- [AWS CDK docs – Sharing & Reusing Context](https://docs.aws.amazon.com/cdk/latest/guide/context.html#context-sharing)
- [NEAR node documentation](https://github.com/near/node-docs)

---

© 2025 AWS Samples – Licensed under the Apache 2.0 License 