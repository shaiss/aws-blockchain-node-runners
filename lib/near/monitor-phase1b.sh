#!/bin/bash

# Phase 1B Monitoring Script
# Tests early cfn-signal implementation

echo "🚀 Phase 1B Monitoring Started: $(date)"
echo "Testing early cfn-signal (after basic setup, before compilation)"
echo ""

STACK_NAME="near-single-node"
REGION="us-east-1"
START_TIME=$(date +%s)

monitor_stack() {
    echo "⏰ $(date): Checking CloudFormation status..."
    
    STATUS=$(aws cloudformation describe-stacks --stack-name $STACK_NAME --region $REGION --query 'Stacks[0].StackStatus' --output text 2>/dev/null)
    
    case $STATUS in
        "CREATE_IN_PROGRESS")
            echo "   🔄 Stack creating resources..."
            return 0
            ;;
        "CREATE_COMPLETE")
            echo "   ✅ SUCCESS! CloudFormation completed successfully"
            echo "   🎯 Early cfn-signal worked! NEAR compilation continues in background"
            return 1
            ;;
        "CREATE_FAILED" | "ROLLBACK_*")
            echo "   ❌ Stack failed: $STATUS"
            return 2
            ;;
        *)
            echo "   ⚠️  Unknown status: $STATUS"
            return 0
            ;;
    esac
}

# Monitor until completion or failure
while true; do
    monitor_stack
    result=$?
    
    if [ $result -eq 1 ]; then
        # Success
        ELAPSED=$(( $(date +%s) - $START_TIME ))
        echo ""
        echo "🎉 PHASE 1B SUCCESS!"
        echo "   ⏱️  Total time: ${ELAPSED} seconds"
        echo "   ✅ CloudFormation completed with early cfn-signal"
        echo "   🔄 NEAR compilation continuing in background"
        echo ""
        echo "Next: Monitor NEAR compilation via CloudWatch logs"
        break
    elif [ $result -eq 2 ]; then
        # Failure
        echo ""
        echo "❌ PHASE 1B FAILED - Need to investigate"
        break
    fi
    
    # Continue monitoring
    sleep 30
done