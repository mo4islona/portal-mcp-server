#!/bin/bash

# Test CREATE traces to see if CREATE2 is included
curl -s -X POST https://portal.sqd.dev/datasets/binance-mainnet/stream \
  -H 'Content-Type: application/json' \
  -d '{"type":"evm","fromBlock":45000000,"toBlock":45000010,"traces":[{"type":["create"]}],"fields":{"trace":{"type":true,"createFrom":true,"createResultAddress":true,"createInit":true}}}' | head -100
