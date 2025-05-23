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
### Useful Links
* AWS CDK docs – [Environment-Agnostic Stacks](https://docs.aws.amazon.com/cdk/latest/guide/environments.html#environments_env_agnostic)
* AWS CDK docs – [Sharing & Reusing Context](https://docs.aws.amazon.com/cdk/latest/guide/context.html#context-sharing)
* NEAR node documentation – <https://github.com/near/node-docs>

---
© 2025 AWS Samples – Licensed under the Apache 2.0 License 