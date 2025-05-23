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
- [ ] Install prerequisites via `dnf`.
- [ ] Download / build `near` binary for specified `NEAR_VERSION`.
- [ ] Fetch `genesis.json` & `config.json` for `${NEAR_NETWORK}`.
- [ ] (Optional) download & restore snapshot (`SNAPSHOT_URL`).
- [ ] Create simple `/health` endpoint and systemd service for NEAR node.

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
- [ ] Ensure `cdk synth` produces valid CloudFormation templates (requires AWS credentials).

## 9. Unit Tests
- [ ] Copy/paste baseline Jest tests; update to NEAR naming.
- [ ] Add test to check ALB DNS output exists.

## 10. Documentation
- [ ] Flesh out `README.md` with prerequisites, deployment, cleanup.
- [ ] Add architectural diagram in `doc/`.

---

Generated: 2025-05-23 