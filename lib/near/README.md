# NEAR Node Runner Blueprint (AWS CDK)

This blueprint provisions the AWS infrastructure required to run **NEAR RPC and/or single nodes** on Amazon EC2.  It follows the same conventions as the Ethereum, Solana, and other blueprints in this repository.

---
## 1  Prerequisites

1. **Node.js ≥ 18** and **npm** installed.
2. **AWS CDK v2** (you can also use `npx cdk`).
3. **AWS credentials** exported in your shell *or* configured via `aws configure`.
   ```bash
   # Example using temporary credentials
   export AWS_ACCESS_KEY_ID=AKIA...               # required
   export AWS_SECRET_ACCESS_KEY=xxxxxxxxxxxxxxxx  # required
   export AWS_SESSION_TOKEN=yyyyyyyyyyyyyyyyyyy   # only if using STS/temp creds
   export AWS_REGION=us-east-1                    # region can also be placed in .env or AWS config
   ```
   If you use named profiles, set `AWS_PROFILE=myprofile` instead.

> ℹ️ The CDK stacks perform look-ups (e.g. the default VPC) at *synth* time. You therefore must have credentials configured **even to run `cdk synth`**. This is identical to the Ethereum/Solana blueprints.

---
## 2  Getting Started

```bash
# Clone the repository (if you haven't already)
$ git clone https://github.com/aws-samples/aws-blockchain-node-runners.git
$ cd aws-blockchain-node-runners

# Install root dependencies (one level up from lib/near)
$ npm install

# Enter the NEAR blueprint folder
$ cd lib/near

# Create your environment file
$ cp .env-sample .env
$ $EDITOR .env          # customise values (network, instance size, etc.)

# Compile the TypeScript code
$ npm run build

# (First-time only) bootstrap your AWS environment
# If AWS_ACCOUNT_ID / AWS_REGION are exported you can pass them explicitly, otherwise CDK infers them from your credentials.
$ npx cdk bootstrap | tee bootstrap.log

# Synthesize CloudFormation templates (requires AWS creds!)
$ npm run synth   # or: npx cdk synth | tee synth.log
```
The synthesized templates will be printed to the console and written to `cdk.out/`.

---
## 3a  Mock-Deployment / Template Review Only
If you only want to **generate** the CloudFormation templates and inspect them without provisioning anything yet, simply run the *build* + *bootstrap* + *synth* steps above.  The rendered templates are written to `cdk.out/` and no resources are deployed.

When you're ready to deploy for real, proceed to the next section.

---
## 3  Deploying

```bash
# Deploy the common stack first (shared IAM role, etc.)
$ npx cdk deploy near-common

# Deploy a single node *or* an HA RPC farm, depending on DEPLOY_MODE
$ npx cdk deploy near-single-node
# —or—
$ npx cdk deploy near-rpc-nodes
```
If `DEPLOY_MODE=both` in your `.env`, you can deploy both stacks.

---
## 4  Cleaning Up

```bash
$ npx cdk destroy near-rpc-nodes     # or near-single-node
$ npx cdk destroy near-common
```
Remember to remove EBS volumes or S3 snapshots if you created any outside of CDK.

---
## 5  Advanced: Synth Without Credentials

If you **cannot** or **do not want to** provide AWS credentials, you have two options:

1. Pre-populate `cdk.context.json` with the lookup results from an environment that *does* have credentials.  CDK will then use that cached context and will not make live AWS calls.
2. Refactor the stacks to **avoid look-ups** (pass VPC/Subnet IDs via environment variables or config).  This is outside the default blueprint scope but the code is structured so you can replace `Vpc.fromLookup` with `Vpc.fromVpcAttributes` if needed.

---
## 6  Architecture Overview

### 6.1  Single-Node Deployment
![Single Node Diagram](./doc/assets/Architecture-SingleNode.drawio.png)
*One EC2 instance in the default VPC, security-group rules open NEAR P2P (24567) + internal RPC (3030).*  
Used for development or low-traffic private workloads.

### 6.2  HA (RPC Farm) Deployment
![HA Nodes Diagram](./doc/assets/Architecture-HANodes.drawio.png)
*Auto Scaling Group (up to 4 nodes) behind an internal Application Load Balancer; ALB listens on port 3030; nodes share identical user-data and CW dashboards.*

---
## 7  Optimizing Data-Transfer Costs
NEAR RPC nodes can emit **tens of terabytes** of outbound traffic each month.  Consider:
1.  Using the `LIMIT_OUT_TRAFFIC_MBPS` setting (see `.env`) to rate-limit egress once the node is in sync. 20 Mbit/s ≈ 6 TiB/month.
2.  Keeping the RPC endpoint **private** (inside the VPC) and fronting it with your own cache or API gateway.
3.  Exploring AWS **PrivateLink** or **Gateway Load Balancer** for multi-VPC access without Internet egress charges.

---
## 8  Well-Architected Checklist (excerpt)
| Pillar | Control | Check | Remarks |
|--------|---------|-------|---------|
| Security | Network isolation | RPC exposed only on internal ALB | Modify SG/ALB if public access is required |
| Reliability | ASG & ALB | HA stack deploys up to 4 nodes with health checks | desiredCapacity is user-configurable |
| Cost Opt | Egress limits | Use `LIMIT_OUT_TRAFFIC_MBPS` | Potential >80 % savings |
| Perf Eff | Graviton | Default instance type `m7g` for best price/perf | Override in `.env` if x86 is required |

*(See `doc/` folder for the complete table.)*

---
### Useful Links
* AWS CDK docs – [Environment-Agnostic Stacks](https://docs.aws.amazon.com/cdk/latest/guide/environments.html#environments_env_agnostic)
* AWS CDK docs – [Sharing & Reusing Context](https://docs.aws.amazon.com/cdk/latest/guide/context.html#context-sharing)
* NEAR node documentation – <https://github.com/near/node-docs>

---
© 2025 AWS Samples – Licensed under the Apache 2.0 License 