# Portal MCP Server - Quick Reference

## [FAST] Performance at a Glance

**Average Response Time**: ~200ms  
**Target**: All queries <3 seconds

## 📏 Recommended Block Ranges

| Query Type | Max Blocks | Response Time |
|-----------|-----------|---------------|
| **Logs** | 10,000 | ~500ms |
| **Transactions** | 5,000 | ~100ms |
| **Traces** | 1,000 | ~2s |

## [OK] Best Practices

### 1. Always Fetch Latest Block First
```javascript
// DO THIS FIRST!
const head = await portal_get_head({ dataset: "base-mainnet" });
const latest = head.number;

// Then query recent blocks
const logs = await portal_query_logs({
  from_block: latest - 1000,  // Last 1k blocks
  to_block: latest
});
```

### 2. Filter for Faster Queries
```javascript
// [OK] FAST: Specific address
addresses: ["0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"]

// [FAIL] SLOW: No filter = all logs!
addresses: []
```

### 3. Paginate Large Ranges
```javascript
// Query 100k blocks in 10k chunks
for (let block = startBlock; block < endBlock; block += 10000) {
  await queryLogs(block, block + 10000);
}
```

## [SPEED] Quick Commands

```bash
# Get latest block
curl -s https://portal.sqd.dev/datasets/base-mainnet/head | jq '.number'

# List all datasets
curl -s https://portal.sqd.dev/datasets | jq -r '.[].dataset'

# Test performance
node test-performance.mjs
```

## 🛠️ Tools

| Tool | Use Case |
|------|----------|
| `portal_get_head` | Get latest block (ALWAYS USE FIRST!) |
| `portal_get_finalized_head` | Get latest finalized block |
| `portal_query_logs` | Query event logs |
| `portal_query_transactions` | Query transactions |
| `portal_list_datasets` | List available chains |

## [WARN] Avoid These Mistakes

1. [FAIL] Hardcoding block numbers
2. [FAIL] Querying >50k blocks without pagination
3. [FAIL] No address/topic filters on log queries
4. [FAIL] Ignoring timeout warnings

## 📚 Documentation

- **CLAUDE.md** - Architecture & debugging
- **PERFORMANCE_GUIDE.md** - Detailed optimization guide
- **UX_OPTIMIZATION_SUMMARY.md** - Improvement summary
