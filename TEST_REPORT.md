# SQD Portal MCP Server v0.3.0 - Test Report

**Date:** 2026-02-04  
**Version:** 0.3.0  
**Total Tools:** 16  
**Tests Passed:** 16/16 (100%)

## Test Summary

| # | Tool | Status | Result |
|---|------|--------|--------|
| 1 | `portal_list_datasets` | PASS | Found 22 dataset(s) (evm) with real-time data |
| 2 | `portal_search_datasets` | PASS | Found 4 dataset(s) matching "polygon" |
| 3 | `portal_get_dataset_info` | PASS | Dataset "base-mainnet" (evm): Real-time data from block 0 to 41705357 |
| 4 | `portal_get_block_number` | PASS | Block: 428495517 (arbitrum-one finalized) |
| 5 | `portal_block_at_timestamp` | PASS | Block at 2025-01-01: 21525891 |
| 6 | `portal_query_blocks` | PASS | Retrieved 3 evm block(s) with transactions |
| 7 | `portal_query_logs` | PASS | Found 127 log(s) across 6 block(s) (USDT transfers) |
| 8 | `portal_query_transactions` | PASS | Found 35 transaction(s) across 3 block(s) |
| 9 | `portal_query_traces` | PASS | Found 3602 trace(s) across 3 block(s) |
| 10 | `portal_query_state_diffs` | PASS | Found 3825 state diff(s) across 3 block(s) |
| 11 | `portal_get_erc20_transfers` | PASS | Found 127 ERC20 transfer(s) (USDT) |
| 12 | `portal_get_nft_transfers` | PASS | Found 1356 NFT transfer event(s) (ERC721) |
| 13 | `portal_query_solana_instructions` | PASS | Found 7760 instruction(s) across 6 slot(s) |
| 14 | `portal_query_substrate_events` | PASS | Found 4 event(s) across 2 block(s) (Polkadot Balances.Transfer) |
| 15 | `portal_stream` | PASS | Query returned 3 result(s) (advanced query) |
| 16 | `portal_query_paginated` | PASS | Retrieved 2 result(s), cursor: 21525910 |

## Test Details

### Dataset Discovery Tools

#### 1. portal_list_datasets
```json
{"chain_type": "evm", "real_time_only": true}
```
- Filters by chain type (evm/solana/substrate)
- Filters by real-time availability
- Returns 22 real-time EVM datasets

#### 2. portal_search_datasets
```json
{"query": "polygon"}
```
- Fuzzy search across dataset names and aliases
- Groups results by chain type
- Found 4 Polygon-related datasets

#### 3. portal_get_dataset_info
```json
{"dataset": "base-mainnet"}
```
- Returns comprehensive metadata
- Includes head/finalized block numbers
- Auto-detects chain type

### Block & Timestamp Tools

#### 4. portal_get_block_number
```json
{"dataset": "arbitrum-one", "type": "finalized"}
```
- Supports latest and finalized block types
- Returns block hash alongside number

#### 5. portal_block_at_timestamp
```json
{"dataset": "ethereum-mainnet", "timestamp": "2025-01-01T00:00:00Z"}
```
- Accepts ISO 8601 and Unix timestamps
- Returns block closest to timestamp

### EVM Query Tools

#### 6. portal_query_blocks
```json
{"dataset": "ethereum-mainnet", "from_block": 21525890, "to_block": 21525892, "include_transactions": true}
```
- Multi-chain support (EVM, Solana, Substrate)
- Optional transaction and log inclusion

#### 7. portal_query_logs
```json
{"dataset": "ethereum-mainnet", "from_block": 21525890, "to_block": 21525895, "address": "0xdac17f958d2ee523a2206206994597c13d831ec7", "topic0": "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"}
```
- Filter by contract address
- Filter by event signature (topic0-3)
- Tested with USDT Transfer events

#### 8. portal_query_transactions
```json
{"dataset": "ethereum-mainnet", "from_block": 21525890, "to_block": 21525892, "to_address": "0xdac17f958d2ee523a2206206994597c13d831ec7"}
```
- Filter by sender and/or recipient
- Address validation and normalization

#### 9. portal_query_traces
```json
{"dataset": "ethereum-mainnet", "from_block": 21525890, "to_block": 21525892, "type": ["call"]}
```
- Internal transaction traces
- Filter by trace type (call, create, suicide, reward)

#### 10. portal_query_state_diffs
```json
{"dataset": "ethereum-mainnet", "from_block": 21525890, "to_block": 21525892}
```
- Storage and balance changes
- Heavy query (20 block limit)

### Token Transfer Tools

#### 11. portal_get_erc20_transfers
```json
{"dataset": "ethereum-mainnet", "from_block": 21525890, "to_block": 21525895, "token": "0xdac17f958d2ee523a2206206994597c13d831ec7"}
```
- Parses Transfer events into structured data
- Filter by token contract, sender, recipient

#### 12. portal_get_nft_transfers
```json
{"dataset": "ethereum-mainnet", "from_block": 21525890, "to_block": 21525895, "token_standard": "erc721"}
```
- Supports ERC721 and ERC1155
- Finds Transfer, TransferSingle, TransferBatch events

### Multi-Chain Tools

#### 13. portal_query_solana_instructions
```json
{"dataset": "solana-mainnet", "from_block": 250000000, "to_block": 250000005}
```
- Query Solana program instructions
- Filter by program ID
- Exclude/include failed transactions

#### 14. portal_query_substrate_events
```json
{"dataset": "polkadot", "from_block": 20000000, "to_block": 20000005, "pallet": "Balances", "event_name": "Transfer"}
```
- Query Polkadot/Kusama ecosystem events
- Filter by pallet and event name

### Advanced Tools

#### 15. portal_stream
```json
{"dataset": "ethereum-mainnet", "query": {"type": "evm", "fromBlock": 21525890, ...}}
```
- Raw API access for complex queries
- Auto-detects chain type if not specified

#### 16. portal_query_paginated
```json
{"dataset": "ethereum-mainnet", "from_block": 21525890, "to_block": 21526000, "page_size": 20}
```
- Cursor-based pagination
- Returns next cursor for continuation
- Supports blocks, logs, transactions

## Bugs Fixed During Testing

1. **Trace fields**: Updated field names (`callOutput` → `callResultOutput`, etc.)
2. **Solana block fields**: Changed `slot` → `number`, `blockHeight` → `height`
3. **Substrate event fields**: Changed `indexInBlock` → `index`
4. **Log fields**: Removed unsupported `blockHash` field

## Environment

- Node.js with ES modules
- TypeScript 5.7
- MCP SDK 1.12.0
- Zod 3.24.0

## Configuration

Environment variables supported:
- `SQD_PORTAL_URL` - Custom Portal URL (default: https://portal.sqd.dev)
- `SQD_TIMEOUT` - Request timeout in ms (default: 30000)
- `SQD_MAX_RETRIES` - Retry attempts (default: 3)
- `SQD_RETRY_DELAY` - Base retry delay in ms (default: 1000)
