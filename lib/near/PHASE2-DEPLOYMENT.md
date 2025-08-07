# 🚀 NEAR Phase 2 Multi-Stack Deployment Guide

## 🏗️ Architecture Overview

The **Phase 2 Multi-Stack Architecture** implements AWS best practices with **lifecycle separation** across 3 distinct stacks:

### **📋 Stack Layers**

1. **🏗️ Infrastructure Stack** (~5 minutes)
   - EC2 instance, volumes, networking
   - Basic bootstrap and volume attachment
   - **Goal**: Fast infrastructure validation

2. **⚙️ Install Stack** (~60 minutes)  
   - Dependencies, Rust toolchain
   - NEAR compilation (`make release`)
   - Node initialization (`neard init`)
   - **Goal**: Isolated compilation process

3. **🔄 Sync Stack** (~4-5 hours)
   - State synchronization (`neard run`)
   - Comprehensive monitoring
   - Health checks and alerting
   - **Goal**: Production monitoring

## 🚀 Quick Start Deployment

### Prerequisites
```bash
# Ensure AWS profile is configured
export AWS_PROFILE=shai-sandbox-profile
export AWS_REGION=us-east-1

# Navigate to NEAR directory
cd /Users/Shai.Perednik/Documents/code_workspace/near-aws-blockchain-noderunnner/lib/near
```

### **Option 1: Full Deployment (Recommended)**
Deploy all stacks in correct dependency order:
```bash
npx cdk deploy near-common near-infrastructure near-install near-sync \
  --app "npx ts-node --prefer-ts-exts multi-stack-app.ts" \
  --profile shai-sandbox-profile \
  --require-approval never
```

### **Option 2: Incremental Deployment**
Deploy stacks individually for precise control:
```bash
# Step 1: Common resources (IAM roles)
npx cdk deploy near-common \
  --app "npx ts-node --prefer-ts-exts multi-stack-app.ts" \
  --profile shai-sandbox-profile

# Step 2: Infrastructure (~5 min)
npx cdk deploy near-infrastructure \
  --app "npx ts-node --prefer-ts-exts multi-stack-app.ts" \
  --profile shai-sandbox-profile

# Step 3: Installation (~60 min)
npx cdk deploy near-install \
  --app "npx ts-node --prefer-ts-exts multi-stack-app.ts" \
  --profile shai-sandbox-profile

# Step 4: Sync monitoring (~immediate, then 4-5 hrs sync)
npx cdk deploy near-sync \
  --app "npx ts-node --prefer-ts-exts multi-stack-app.ts" \
  --profile shai-sandbox-profile
```

## ⏱️ Expected Timeline

| Phase | Duration | Status Indicators |
|-------|----------|------------------|
| **Infrastructure** | ~5 minutes | EC2 running, volume attached, CloudWatch agent active |
| **Install** | ~60 minutes | Rust installed, NEAR compiled, `neard init` complete |
| **Sync** | ~4-5 hours | `neard run` started, blockchain syncing to latest block |

## 📊 Monitoring & Verification

### **Phase 1: Infrastructure Validation** 
```bash
# Check stack status
aws cloudformation describe-stacks --stack-name near-infrastructure --region us-east-1

# Verify instance is running
aws ec2 describe-instances \
  --filters "Name=tag:aws:cloudformation:stack-name,Values=near-infrastructure" \
  --query 'Reservations[0].Instances[0].State.Name' --output text

# Check CloudWatch logs
aws logs describe-log-groups --log-group-name-prefix "/aws/ec2/near-infrastructure"
```

### **Phase 2: Installation Monitoring**
```bash
# Monitor SSM command execution
aws ssm list-command-invocations \
  --details \
  --query 'CommandInvocations[?contains(DocumentName, `near-install`)].[Status,DocumentName,InstanceId]' \
  --output table

# Check installation logs via SSM
aws ssm send-command \
  --instance-ids $(aws ec2 describe-instances \
    --filters "Name=tag:aws:cloudformation:stack-name,Values=near-infrastructure" \
    --query 'Reservations[0].Instances[0].InstanceId' --output text) \
  --document-name "AWS-RunShellScript" \
  --parameters 'commands=["tail -20 /var/log/near-install.log"]'
```

### **Phase 3: Sync Monitoring**
```bash
# Check NEAR service status
aws ssm send-command \
  --instance-ids $(aws ec2 describe-instances \
    --filters "Name=tag:aws:cloudformation:stack-name,Values=near-infrastructure" \
    --query 'Reservations[0].Instances[0].InstanceId' --output text) \
  --document-name "near-sync-status-near-sync"

# View CloudWatch dashboard
echo "https://console.aws.amazon.com/cloudwatch/home?region=us-east-1#dashboards:name=near-sync-near-sync"
```

## 🔧 Troubleshooting

### **Infrastructure Stack Issues**
```bash
# Check volume attachment
aws ec2 describe-volumes \
  --filters "Name=tag:aws:cloudformation:stack-name,Values=near-infrastructure" \
  --query 'Volumes[0].Attachments[0].State' --output text

# Should return: "attached"
```

### **Install Stack Issues**
```bash
# Check compilation progress
aws ssm send-command \
  --instance-ids INSTANCE_ID \
  --document-name "AWS-RunShellScript" \
  --parameters 'commands=["ps aux | grep -E \"(cargo|rustc)\" | grep -v grep"]'

# Check for compilation errors
aws ssm send-command \
  --instance-ids INSTANCE_ID \
  --document-name "AWS-RunShellScript" \
  --parameters 'commands=["grep -i error /var/log/near-install.log | tail -10"]'
```

### **Sync Stack Issues**
```bash
# Check NEAR service health
aws ssm send-command \
  --instance-ids INSTANCE_ID \
  --document-name "near-health-check-near-sync"

# Check sync progress
aws ssm send-command \
  --instance-ids INSTANCE_ID \
  --document-name "AWS-RunShellScript" \
  --parameters 'commands=["curl -s http://localhost:3030/status | jq .sync_info"]'
```

## 🧹 Cleanup

### **Selective Cleanup** (Recommended)
```bash
# Remove sync stack only (keep infrastructure for testing)
npx cdk destroy near-sync --app "npx ts-node --prefer-ts-exts multi-stack-app.ts"

# Remove install + sync (keep infrastructure)
npx cdk destroy near-sync near-install --app "npx ts-node --prefer-ts-exts multi-stack-app.ts"
```

### **Complete Cleanup**
```bash
# Remove all stacks (reverse dependency order)
npx cdk destroy near-sync near-install near-infrastructure near-common \
  --app "npx ts-node --prefer-ts-exts multi-stack-app.ts" \
  --profile shai-sandbox-profile
```

## 📈 Success Indicators

### **✅ Infrastructure Success**
- EC2 instance in "running" state
- Data volume "attached" status  
- CloudWatch agent running
- SSM connectivity active

### **✅ Install Success**
- Rust toolchain installed (`rustc --version`)
- NEAR binary compiled (`/usr/local/bin/neard --version`)
- Configuration files present (`/near/mainnet/config.json`)
- Systemd service enabled (`near.service`)

### **✅ Sync Success**
- NEAR service running (`systemctl is-active near.service`)
- RPC endpoint responding (`curl http://localhost:3030/status`)
- Block height increasing (check every 10 minutes)
- CloudWatch metrics flowing

## 🎯 Next Steps

Once **Phase 2** is successfully deployed:

1. **Monitor sync progress** via CloudWatch dashboard
2. **Set up SNS notifications** for alerts
3. **Test RPC endpoints** once sync completes
4. **Scale monitoring** as needed
5. **Plan Phase 3** enhancements (if desired)

## 📞 Support

- **Logs**: Check `/var/log/near-*.log` on the instance
- **Metrics**: CloudWatch namespace `NEAR/*`
- **Commands**: Use SSM documents for operational tasks
- **Debugging**: Each stack can be debugged independently

---

🎉 **Phase 2 Multi-Stack Architecture - Production Ready!**