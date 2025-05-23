# NEAR Node Runner – Implementation Plan

> This file is intentionally *machine-friendly*: each task is a GitHub-style check-box so that scripts or CI jobs can parse progress (`[ ]` = open, `[x]` = done).

## Legend
* `[x]` – completed in repository
* `[ ]` – work is still pending

---

## 0. Scaffolding
- [x] Create directory tree `lib/near/` with sub-folders (`doc`, `lib/assets`, `lib/config`, `lib/constructs`, `sample-configs`, `test`).
- [x] Add placeholder files (`.env-sample`, `app.ts`, `cdk.json`, `jest.config.json`, `README.md`).
- [x] Add `.gitkeep` to empty folders.

## 1. Baseline File Copy & Renaming
- [x] Copy Solana blueprint files into `lib/near/lib/`:
  - `single-node-stack.ts` → `near/lib/single-node-stack.ts`
  - `ha-nodes-stack.ts` → `near/lib/rpc-nodes-stack.ts`
  - `constructs/node-security-group.ts` → `constructs/near-node-security-group.ts`
  - all referenced `assets/*` files.
- [x] Replace all `Solana` identifiers with `Near` equivalents.

## 2. Amazon Linux 2023 Migration
- [x] Swap Ubuntu AMI logic with Amazon Linux 2023 image in both stacks.
- [x] Remove Ubuntu-specific commands from user-data; create `assets/user-data-alinux.sh`.

## 3. User-Data Script (`user-data-alinux.sh`)
- [x] Install prerequisites via `dnf`.
- [x] Download / build `near` binary for specified `NEAR_VERSION`.
- [x] Fetch `genesis.json` & `config.json` for `${NEAR_NETWORK}`.
- [x] (Optional) download & restore snapshot (`SNAPSHOT_URL`).
- [x] Create simple `/health` endpoint and systemd service for NEAR node.

## 4. Security Group Construct
- [x] Implement `near-node-security-group.ts` with inbound ports:
  - `TCP 24567` – p2p
  - `TCP 3030` – RPC
  - (optional) `TCP 9333` – metrics

## 5. Configuration Layer
- [x] Define `node-config.interface.ts` for types (network, version, instanceType, etc.).
- [x] Implement `.env` parser in `node-config.ts` (pattern from Ethereum).
- [x] Update `.env-sample` with NEAR-specific keys.

## 6. CDK App Wiring (`app.ts`)
- [x] Create `NearCommonStack` (shared IAM & optional snapshot bucket).
- [x] Instantiate `NearSingleNodeStack` when `DEPLOY_MODE=single`.
- [x] Instantiate `NearRpcNodesStack` when `DEPLOY_MODE=ha`.

## 7. Sample Configs
- [x] Add `sample-configs/ha-rpc-mainnet.env`.
- [x] Add `sample-configs/single-testnet.env`.

## 8. Build & Synth
- [x] Ensure `npm run build` succeeds in `lib/near`.
- [x] Ensure `cdk synth` produces valid CloudFormation templates (requires AWS credentials).

## 9. Unit Tests
- [x] Copy Jest setup pattern from Solana/Ethereum (uses `aws-cdk-lib/assertions`).
- [x] Add `test/.env-test` with minimal config & creds placeholders (no real keys).
- [x] Write `common-stack.test.ts` – assert IAM role and outputs.
- [x] Write `single-node-stack.test.ts` – assert Security Group ingress rules (24567/3030) and Amazon Linux AMI usage.
- [x] Write `rpc-nodes-stack.test.ts` – assert ALB listener on 3030 and desiredCapacity matches env.

## 10. Documentation & Diagrams
- [x] Extend README with section on architecture (single vs HA) – include diagrams.
- [x] Create `doc/assets/Architecture-SingleNode.drawio.png` (placeholder present).
- [x] Create `doc/assets/Architecture-HANodes.drawio.png` (placeholder present).
- [x] Add "Optimizing Data Transfer Costs" subsection similar to Solana but NEAR-specific.
- [x] Add Well-Architected checklist table covering Security, Cost, Reliability, etc. (excerpt + placeholder for full table).

## 11. Secrets Manager Assessment
- [x] Reviewed NEAR RPC documentation - no API keys or secrets required for RPC node operation
- [x] Analyzed Solana implementation - SecretsManagerReadWrite policy is included but not actually used
- [x] **Decision**: AWS Secrets Manager is NOT needed for NEAR nodes as they don't require:
  - API keys for node operation
  - Private keys (nodes generate their own if needed)
  - Authentication tokens for RPC access
  - Any other sensitive configuration data
- [ ] Consider removing SecretsManagerReadWrite policy from common-stack.ts to follow least privilege

## 12. CloudWatch Dashboard Implementation
- [x] Create `lib/constructs/node-cw-dashboard.ts` with NEAR-specific metrics:
  - Standard EC2 metrics (CPU, Memory, Network, Disk I/O)
  - NEAR-specific metrics:
    - Block height (`near_block_height`)
    - Sync status (`near_sync_status`)
    - Peer count (`near_peer_count`)
    - Transaction pool size (`near_tx_pool_size`)
- [x] Add CloudWatch dashboard to single-node-stack.ts
- [x] Add CloudWatch dashboard to rpc-nodes-stack.ts (multi-instance view)
- [x] Configure CloudWatch agent in user-data script to collect NEAR metrics
- [x] Add dashboard JSON template similar to Solana/Ethereum patterns
- [x] Create CloudWatch agent configuration file (amazon-cloudwatch-agent.json)
- [x] Create NEAR metrics collection script (collect-near-metrics.sh)
- [x] Add health check endpoint on port 8080 for ALB health checks

---

Generated: 2025-05-23 