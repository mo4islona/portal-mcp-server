# Usage Examples - Context-Optimized Queries

## Basic Principles

1. **Start with summary/count tools** - Use aggregation first, drill down if needed
2. **Use timeframes** - Avoid manual block calculations
3. **Use minimal presets** - Only request needed fields
4. **Lower limits** - Default is now 20 (was 100)

---

## Example 1: Counting Events

### ❌ Old Way (100K tokens)
```javascript
// Fetch all logs to count them
logs = portal_query_logs({
  dataset: "base-mainnet",
  from_block: 41700000,
  to_block: 41750000,
  addresses: ["0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"], // USDC
  topic0: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"], // Transfer
  limit: 100
})
// Returns: 100 full logs with all fields = ~100K tokens
// Issue: Probably truncated, context filling up
```

### ✅ New Way (1K tokens)
```javascript
// Count without fetching
count = portal_count_events({
  dataset: "base",
  timeframe: "24h",
  addresses: ["0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"],
  topic0: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"],
  group_by: "none"
})
// Returns: {total_events: 15234, block_range: {...}}
// Result: ~1K tokens, 99% reduction
```

---

## Example 2: Transfer Statistics

### ❌ Old Way (Multiple queries, 200K+ tokens)
```javascript
// Query 1: Get transfers
transfers = portal_get_erc20_transfers({
  dataset: "ethereum-mainnet",
  from_block: 19000000,
  to_block: 19100000,
  limit: 100
})

// Query 2: Count unique senders manually
senders = [...new Set(transfers.map(t => t.from))]

// Query 3: Get token info for each token
tokens = transfers.map(t => t.token_address)
token_info = portal_get_token_info({...}) // Multiple calls

// Issue: Multiple queries, massive context usage
```

### ✅ New Way (2K tokens)
```javascript
// One call with aggregation
stats = portal_aggregate_transfers({
  dataset: "ethereum",
  timeframe: "24h",
  group_by: "token"
})
// Returns: {
//   total_transfers: 45678,
//   unique_senders: 12345,
//   unique_receivers: 23456,
//   grouped: [{token: "0x...", transfer_count: 5000}, ...]
// }
// Result: ~2K tokens, 99% reduction, one call
```

---

## Example 3: Recent Activity Summary

### ❌ Old Way (50K tokens)
```javascript
// Fetch full logs
logs = portal_query_logs({
  dataset: "base-mainnet",
  from_block: 41700000,
  to_block: 41750000,
  limit: 100
})
// Returns: 100 full log objects with all data
// Issue: Full hex data, all fields, fills context
```

### ✅ New Way - Summary (5K tokens)
```javascript
// Get aggregated summary
logs = portal_query_logs({
  dataset: "base",
  timeframe: "1h",
  response_format: "summary"
})
// Returns: {
//   total_logs: 1234,
//   unique_contracts: 45,
//   top_contracts: [...],
//   top_event_types: [...]
// }
// Result: ~5K tokens, 90% reduction
```

### ✅ New Way - Compact (15K tokens)
```javascript
// Get essential fields only
logs = portal_query_logs({
  dataset: "base",
  timeframe: "1h",
  field_preset: "minimal",
  response_format: "compact",
  limit: 20
})
// Returns: [{address, topic0, blockNumber, timestamp}, ...]
// No raw hex data, no verbose fields
// Result: ~15K tokens, 70% reduction
```

---

## Example 4: Identifying Contracts

### ❌ Old Way (External lookups)
```javascript
// See unknown address in results
// 0x833589fcd6edb6e08f4c7c32d4f71b54bda02913

// Manual steps:
// 1. Copy address
// 2. Search on Etherscan
// 3. Find it's USDC
// 4. Multiple round trips, context lost
```

### ✅ New Way (Instant)
```javascript
// Resolve addresses
info = portal_resolve_addresses({
  dataset: "base",
  addresses: ["0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"]
})
// Returns: {
//   resolved_addresses: [{
//     address: "0x833589...",
//     name: "USD Coin",
//     category: "token",
//     symbol: "USDC"
//   }]
// }
// Result: Instant, no external lookups
```

---

## Example 5: Transfer Analysis with Metadata

### ❌ Old Way (Multiple calls)
```javascript
// Query 1: Get transfers
transfers = portal_get_erc20_transfers({
  dataset: "base-mainnet",
  from_block: 41700000,
  to_block: 41750000,
  limit: 20
})

// Query 2: Get token info for each unique token
tokens = [...new Set(transfers.map(t => t.token_address))]
for (token of tokens) {
  info = portal_get_token_info({dataset: "base", address: token})
  // 5-10 additional queries
}
```

### ✅ New Way (One call)
```javascript
// Get transfers with metadata inline
transfers = portal_get_erc20_transfers({
  dataset: "base",
  timeframe: "1h",
  limit: 20,
  include_token_info: true
})
// Returns: [
//   {
//     token_address: "0x833589...",
//     token_symbol: "USDC",    // ← Included
//     token_name: "USD Coin",  // ← Included
//     token_decimals: 6,       // ← Included
//     from: "0x...",
//     to: "0x...",
//     value: "1000000"
//   }
// ]
// Result: One call, no additional lookups
```

---

## Example 6: Time-Based Queries

### ❌ Old Way (Manual calculation)
```javascript
// Step 1: Get latest block
head = portal_get_block_number({dataset: "base-mainnet"})
latest = head.number // 41750000

// Step 2: Calculate blocks for 24h
// Base has ~2s blocks, so 24h = 43200 blocks
from = latest - 43200

// Step 3: Query
logs = portal_query_logs({
  dataset: "base-mainnet",
  from_block: from,
  to_block: latest
})
// Issue: 2 queries, manual math, error-prone
```

### ✅ New Way (Automatic)
```javascript
// One call with timeframe
logs = portal_query_logs({
  dataset: "base",
  timeframe: "24h"
})
// Auto-calculates from latest block
// Knows Base has 2s blocks
// Result: 1 call, no math, accurate
```

---

## Example 7: Progressive Detail

Start with summary, drill down only if needed:

```javascript
// Step 1: Get high-level summary (5K tokens)
summary = portal_query_logs({
  dataset: "base",
  timeframe: "24h",
  response_format: "summary"
})
// Returns: "73 Transfer events, 16 Swap events, 11 Approval events"

// Step 2: User wants to see Swap events
swaps = portal_query_logs({
  dataset: "base",
  timeframe: "24h",
  topic0: ["0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67"], // Swap
  field_preset: "minimal",
  limit: 20
})
// Returns: Essential fields for 20 swaps (~8K tokens)

// Step 3: User wants full details on one specific swap
swap_detail = portal_query_logs({
  dataset: "base",
  from_block: 41745000,
  to_block: 41745001,
  topic0: ["0xc42079..."],
  field_preset: "full",
  limit: 1
})
// Returns: Full detail for 1 swap (~2K tokens)

// Total: 5K + 8K + 2K = 15K tokens
// vs Old way: Fetch all 100 swaps with full detail = 200K tokens
```

---

## Example 8: Combining Features

Maximum context optimization:

```javascript
// Ultra-efficient query
logs = portal_query_logs({
  dataset: "base",
  timeframe: "24h",              // ← No manual blocks
  addresses: ["0x833589..."],     // ← Specific filter
  topic0: ["0xddf252ad..."],      // ← Specific event
  field_preset: "minimal",        // ← Essential fields only
  response_format: "compact",     // ← No verbose fields
  limit: 10                       // ← Low limit
})

// Result: ~2-3K tokens vs 50-100K with old defaults
// 95%+ token reduction
```

---

## Migration Guide

### If you have existing queries:

1. **Do nothing** - They still work, just use less context (lower default limit)

2. **Add timeframes** (easy win):
   ```javascript
   // Before
   portal_query_logs({from_block: X, to_block: Y})

   // After
   portal_query_logs({timeframe: "24h"})
   ```

3. **Add response format** (huge win):
   ```javascript
   // Before
   portal_query_logs({...})

   // After
   portal_query_logs({..., response_format: "summary"})
   ```

4. **Use count tools** (massive win):
   ```javascript
   // Before
   logs = portal_query_logs({...})
   count = logs.length

   // After
   count = portal_count_events({...})
   ```

---

## Token Comparison Chart

| Query Type | Old | New (Standard) | New (Optimized) | Reduction |
|-----------|-----|----------------|-----------------|-----------|
| Count events | 100K | 20K | 1K | 99% |
| View logs | 100K | 20K | 5K | 95% |
| Transfer stats | 200K | 40K | 2K | 99% |
| Time-based | 150K | 25K | 8K | 95% |
| With metadata | 250K | 45K | 10K | 96% |

---

## Best Practices

1. **Always start with aggregation** (count/aggregate tools)
2. **Use summary mode first** - drill down if needed
3. **Use timeframes** - avoid manual calculations
4. **Enable inline metadata** - avoid separate lookups
5. **Resolve addresses early** - identify contracts upfront
6. **Lower limits** - request only what you need
7. **Use minimal presets** - get essential fields only

Result: **50-99% less context usage**, more queries before compaction.
