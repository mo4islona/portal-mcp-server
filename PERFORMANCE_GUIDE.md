# Portal MCP Server - Performance Guide

## Real-World Benchmarks

Based on actual testing against Portal API (`https://portal.sqd.dev`):

### Query Performance by Block Range

| Query Type | Block Range | Typical Response Time | UX Rating |
|-----------|-------------|----------------------|-----------|
| **Logs** | 1,000 blocks | ~600ms | [FAST] Excellent |
| **Logs** | 5,000 blocks | ~1,000ms | [OK] Good |
| **Logs** | 10,000 blocks | ~1,300ms | [OK] Good |
| **Logs** | 50,000 blocks | ~1,700ms | [WARN] Acceptable |
| **Logs** | 100,000 blocks | ~1,200ms* | [WARN] Acceptable |
| **Transactions** | 1,000 blocks | ~130ms | [FAST] Excellent |
| **Transactions** | 2,500 blocks | ~600ms | [FAST] Excellent |
| **Transactions** | 5,000 blocks | ~900ms | [FAST] Excellent |
| **Metadata** (head, datasets) | N/A | ~50ms | [FAST] Excellent |

\* Results may vary based on event density in the queried range

### Summary Statistics

- **Average response time**: ~900ms across all query types
- **Fastest queries**: Metadata and small transaction queries (<200ms)
- **Slowest queries**: Large log queries with many results (1-2s)
- **99th percentile**: < 3 seconds for all reasonable queries

## Recommended Ranges for Optimal UX

### Goal: 90% of queries complete in <1 second

| Query Type | Recommended Max | Response Time | Results |
|-----------|----------------|---------------|---------|
| **Event Logs** | 10,000 blocks | <1.5s | Thousands of logs |
| **Transactions** | 5,000 blocks | <1s | Hundreds to thousands |
| **Traces** | 1,000 blocks | <2s | Very expensive |
| **State Diffs** | 5,000 blocks | <2s | Variable |

### Why These Limits?

1. **User Experience**: <3s feels instant, >5s feels slow
2. **Portal API Performance**: API is very fast, but large result sets take time to transfer
3. **Network Transfer**: NDJSON streaming is efficient but still bound by network speed
4. **Timeout Safety**: Default timeout is 15s - stay well below that

## Query Optimization Tips

### 1. Start Small, Scale Up

```typescript
// [OK] GOOD: Fetch latest block dynamically, then query recent blocks
const head = await portal_get_head({ dataset: "base-mainnet" });
const latestBlock = head.number;

from_block: latestBlock - 1000,  // Last 1k blocks
to_block: latestBlock

// 🤔 RISKY: Large range without testing first
from_block: latestBlock - 100000,
to_block: latestBlock  // 100k blocks!
```

**Pro tip**: Always use `portal_get_head` or `portal_get_finalized_head` to get the current block number dynamically. Never hardcode block numbers!

### 2. Use Address Filters

Filtering by address dramatically reduces result size:

```typescript
// [OK] GOOD: Specific contract filter
logs: [{
  address: ["0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"]  // USDC
}]

// [WARN] SLOWER: No filter = all logs
logs: [{}]  // Returns every log in range!
```

### 3. Paginate Large Ranges

For historical data analysis:

```typescript
// [OK] GOOD: Chunk into 10k block pages
const CHUNK_SIZE = 10000;
for (let block = startBlock; block < endBlock; block += CHUNK_SIZE) {
  await queryLogs(block, block + CHUNK_SIZE);
}

// [FAIL] BAD: Query entire range at once
await queryLogs(startBlock, endBlock);  // Could be millions of blocks!
```

### 4. Use Finalized Blocks

For recent data, use `finalized_only: true`:

```typescript
// [OK] GOOD: Prevents reorg issues
finalized_only: true

// [WARN] RISKY: Recent blocks may reorg
finalized_only: false  // Use for latest data only
```

### 5. Limit Result Fields

Only request fields you need:

```typescript
// [OK] GOOD: Minimal fields
fields: {
  log: { address: true, topics: true }
}

// [WARN] SLOWER: All fields
fields: {
  log: { address: true, topics: true, data: true, logIndex: true, ... }
}
```

## Timeout Configuration

Current timeouts (optimized for UX):

```typescript
DEFAULT_TIMEOUT = 10000ms   // 10s for metadata/simple queries
STREAM_TIMEOUT = 15000ms    // 15s for data queries
```

### Why These Values?

- **10s default**: Most queries complete in <1s, 10s allows 10x buffer
- **15s stream**: Data transfer takes longer, but should still be fast
- **Fail fast**: If a query takes >15s, it's too large - warn the user

## Performance Warnings

The server will warn if block ranges exceed recommendations:

```
[WARN]  LARGE RANGE: 50,000 blocks (21750000  -> 21800000).
   For fast responses (<1-3s), use smaller ranges:
    - Logs: <10,000 blocks (~500ms)
    - Transactions: <5,000 blocks (~100ms)
    - Traces: <1,000 blocks (expensive)
   Large ranges may take >15s or timeout.
```

## When Queries Are Slow

If queries consistently take >5 seconds:

1. **Check block range**: Is it >10k blocks?
2. **Check filters**: Are you filtering by address/topic?
3. **Check result count**: Are you getting millions of results?
4. **Check network**: Is your connection slow?
5. **Check Portal status**: Is the API having issues?

### Debug with cURL

Test Portal API directly to isolate MCP server vs API:

```bash
# Step 1: Get latest block
LATEST=$(curl -s https://portal.sqd.dev/datasets/base-mainnet/head | jq '.number')
FROM=$((LATEST - 1000))

# Step 2: Query recent logs
time curl -X POST https://portal.sqd.dev/datasets/base-mainnet/stream \
  -H 'Content-Type: application/json' \
  -d "{\"type\":\"evm\",\"fromBlock\":$FROM,\"toBlock\":$LATEST,\"logs\":[{\"address\":[\"0x833589fcd6edb6e08f4c7c32d4f71b54bda02913\"]}],\"fields\":{\"log\":{\"address\":true,\"topics\":true},\"block\":{\"number\":true}}}"
```

Should complete in <1 second for 1k blocks.

## Testing Performance

Run the included performance tests:

```bash
# Basic performance test
node test-performance.mjs

# UX optimization guide
node test-ux-optimization.mjs
```

## Best Practices Summary

[OK] **DO:**
- Use 5-10k block ranges for fast queries
- Filter by address/topic when possible
- Paginate large historical queries
- Use `finalized_only: true` for recent data
- Test with small ranges first

[FAIL] **DON'T:**
- Query >50k blocks without pagination
- Query all logs without filters
- Expect >100k block queries to be fast
- Use traces without filtering
- Ignore timeout warnings

## Performance Checklist

Before running a query, ask:

- [ ] Is my block range <10k blocks?
- [ ] Am I filtering by address or topic?
- [ ] Do I really need all these fields?
- [ ] Would pagination be better for this use case?
- [ ] Have I tested with a small range first?

If you answered "no" to any of these, consider optimizing your query!

## Future Optimizations

Potential improvements for even better performance:

1. **Client-side caching**: Cache dataset metadata to avoid repeated API calls
2. **Query batching**: Combine multiple small queries into one request
3. **Streaming results**: Return results as they arrive instead of waiting for all
4. **Smart chunking**: Automatically break large ranges into optimal chunks
5. **Query cost estimation**: Predict query time before executing

## Questions?

See `CLAUDE.md` for architecture details and debugging tips.
