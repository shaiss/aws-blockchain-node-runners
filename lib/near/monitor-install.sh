#!/bin/bash

# NEAR Installation Monitoring Script
echo "🚀 NEAR Installation Monitoring Started: $(date)"
echo "Based on your testing: expecting ~20 minutes for make release"
echo ""

INSTANCE_ID="i-0b699a63abfe1f796"
REGION="us-east-1"
PROFILE="shai-sandbox-profile"
CHECK_INTERVAL=120  # 2 minutes

# Function to check installation progress
check_install_progress() {
    echo "⏰ Checking installation progress at $(date)..."
    
    # Check if rustc processes are still running
    RUSTC_COUNT=$(aws ssm send-command \
        --instance-ids $INSTANCE_ID \
        --document-name "AWS-RunShellScript" \
        --parameters 'commands=["ps aux | grep rustc | grep -v grep | wc -l"]' \
        --timeout-seconds 30 \
        --region $REGION \
        --profile $PROFILE \
        --output text --query 'Command.CommandId')
    
    sleep 3
    
    RUSTC_PROCS=$(aws ssm get-command-invocation \
        --command-id $RUSTC_COUNT \
        --instance-id $INSTANCE_ID \
        --region $REGION \
        --profile $PROFILE \
        --query 'StandardOutputContent' \
        --output text | tr -d '\n')
    
    # Check log file size and last lines
    LOG_CHECK=$(aws ssm send-command \
        --instance-ids $INSTANCE_ID \
        --document-name "AWS-RunShellScript" \
        --parameters 'commands=["echo \"Log size: $(wc -c < /var/log/near-install.log) bytes\"","tail -5 /var/log/near-install.log | grep -E \"(Compiling|Finished|Building|error)\" || tail -3 /var/log/near-install.log"]' \
        --timeout-seconds 30 \
        --region $REGION \
        --profile $PROFILE \
        --output text --query 'Command.CommandId')
    
    sleep 3
    
    LOG_STATUS=$(aws ssm get-command-invocation \
        --command-id $LOG_CHECK \
        --instance-id $INSTANCE_ID \
        --region $REGION \
        --profile $PROFILE \
        --query 'StandardOutputContent' \
        --output text)
    
    echo "Active rustc processes: $RUSTC_PROCS"
    echo "$LOG_STATUS"
    echo ""
    
    # Check if neard binary exists (indicates completion)
    BINARY_CHECK=$(aws ssm send-command \
        --instance-ids $INSTANCE_ID \
        --document-name "AWS-RunShellScript" \
        --parameters 'commands=["ls -la /near/mainnet/nearcore/target/release/neard 2>/dev/null || echo \"Binary not yet created\""]' \
        --timeout-seconds 30 \
        --region $REGION \
        --profile $PROFILE \
        --output text --query 'Command.CommandId')
    
    sleep 3
    
    BINARY_STATUS=$(aws ssm get-command-invocation \
        --command-id $BINARY_CHECK \
        --instance-id $INSTANCE_ID \
        --region $REGION \
        --profile $PROFILE \
        --query 'StandardOutputContent' \
        --output text)
    
    if [[ "$BINARY_STATUS" != *"not yet created"* ]]; then
        echo "✅ NEAR binary found! Installation likely complete."
        echo "$BINARY_STATUS"
        return 0
    else
        echo "🔄 Installation still in progress..."
        return 1
    fi
}

# Monitor installation
echo "Starting monitoring loop (checking every $CHECK_INTERVAL seconds)..."
ITERATION=0
while true; do
    ITERATION=$((ITERATION + 1))
    echo "=== Check #$ITERATION ==="
    
    if check_install_progress; then
        echo ""
        echo "🎉 Installation appears to be complete!"
        echo "Next step: Deploy the sync stack"
        break
    fi
    
    # Check if we've been monitoring for too long (> 60 minutes)
    if [ $ITERATION -gt 30 ]; then
        echo "⚠️  Installation taking longer than expected (>60 minutes)"
        echo "Consider checking the instance directly via SSM Session Manager"
    fi
    
    echo "Waiting $CHECK_INTERVAL seconds before next check..."
    sleep $CHECK_INTERVAL
done