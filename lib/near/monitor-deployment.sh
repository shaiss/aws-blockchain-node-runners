#!/bin/bash

# 4-Step NEAR Deployment Monitoring Script
# Step 1: Monitor CDK deployment for environment fix validation
# Step 2: Confirm cfn-signal success in ~45-60 minutes  
# Step 3: Validate automation before proceeding to Phase 2
# Step 4: Implement multi-stack once Phase 1 proven working

echo "🚀 NEAR Deployment Monitoring Started: $(date)"
echo "Expected deployment phases:"
echo "  1. Asset publishing (2-3 minutes)"
echo "  2. Stack creation (5-10 minutes)" 
echo "  3. EC2 launch + compilation (45-60 minutes)"
echo "  4. cfn-signal success (automation validated)"
echo ""

DEPLOY_START=$(date +%s)
STACK_NAME="near-single-node"
REGION="us-east-1"

# Function to check deployment status
check_deployment_status() {
    echo "⏰ Checking deployment status at $(date)..."
    
    # Check if stack exists
    aws cloudformation describe-stacks --stack-name $STACK_NAME --region $REGION --query 'Stacks[0].[StackName,StackStatus,CreationTime]' --output table 2>/dev/null
    
    if [ $? -eq 0 ]; then
        echo "✅ Stack found - proceeding to detailed monitoring"
        return 0
    else
        echo "⏳ Stack not yet created (likely still publishing assets)"
        return 1
    fi
}

# Wait for stack to appear
echo "STEP 1: Waiting for CDK deployment to create CloudFormation stack..."
while ! check_deployment_status; do
    ELAPSED=$(( $(date +%s) - $DEPLOY_START ))
    echo "   Elapsed: ${ELAPSED}s - Waiting for stack creation..."
    sleep 30
done

echo ""
echo "🎯 Stack created! Beginning Phase 1 monitoring..."
echo "Next: Monitor EC2 instance launch and NEAR compilation progress"