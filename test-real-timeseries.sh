#!/bin/bash

# Get the latest block from Base
echo "Fetching latest Base block..."
LATEST=$(curl -s https://portal.sqd.dev/datasets/base-mainnet/head | jq -r '.number')
FROM=$((LATEST - 300))

echo "Latest block: $LATEST"
echo "From block: $FROM (300 blocks ago)"
echo ""
echo "Querying Portal API for all blocks in range..."

# Query Portal API directly to see how many blocks it returns
curl -s -X POST https://portal.sqd.dev/datasets/base-mainnet/stream \
  -H 'Content-Type: application/json' \
  -d "{
    \"type\": \"evm\",
    \"fromBlock\": $FROM,
    \"toBlock\": $LATEST,
    \"includeAllBlocks\": true,
    \"fields\": {
      \"block\": {
        \"number\": true
      }
    }
  }" | jq -r 'length as $len | "Blocks returned: \($len)"'

echo ""
echo "Expected: 300 blocks (for 1 hour at 12s blocks)"
echo ""
echo "If Portal returns fewer blocks, that's a Portal API limitation."
echo "The MCP tool will still bucket whatever blocks ARE returned correctly."
