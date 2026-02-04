# SQD Portal MCP Server

An MCP (Model Context Protocol) server that provides access to blockchain data through the [SQD Portal API](https://portal.sqd.dev). Query blocks, transactions, logs, traces, and more across 100+ EVM and Solana networks.

## Features

- Access 100+ blockchain networks (Ethereum, Polygon, Arbitrum, Base, Solana, etc.)
- Query blocks, transactions, logs, traces, and state diffs
- ERC20/ERC721/ERC1155 token transfer tracking
- Solana instructions, balances, and token data
- Automatic retry with exponential backoff
- Pagination support for large queries

## Installation

```bash
npm install
npm run build
```

## Usage

### With Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "sqd-portal": {
      "command": "node",
      "args": ["/path/to/portal-mcp-server/dist/index.js"]
    }
  }
}
```

### With MCP Inspector

```bash
npm run inspect
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORTAL_URL` | `https://portal.sqd.dev` | Portal API base URL |

## Available Tools

### Dataset Discovery

| Tool | Description |
|------|-------------|
| `portal_list_datasets` | List all available blockchain datasets |
| `portal_search_datasets` | Search datasets by name or alias |
| `portal_get_dataset_info` | Get metadata for a specific dataset |

### Block & Time Queries

| Tool | Description |
|------|-------------|
| `portal_get_block_number` | Get current head or finalized block number |
| `portal_block_at_timestamp` | Find block number at a specific timestamp |
| `portal_query_blocks` | Query blocks with optional field selection |

### EVM Data Queries

| Tool | Description |
|------|-------------|
| `portal_query_logs` | Query event logs with topic/address filters |
| `portal_query_transactions` | Query transactions by address, selector, etc. |
| `portal_query_traces` | Query internal call traces |
| `portal_query_state_diffs` | Query storage state changes |
| `portal_get_erc20_transfers` | Get ERC20 token transfers |
| `portal_get_nft_transfers` | Get ERC721/ERC1155 NFT transfers |

### Solana Data Queries

| Tool | Description |
|------|-------------|
| `portal_query_solana_instructions` | Query Solana program instructions |
| `portal_query_solana_balances` | Query SOL balance changes |
| `portal_query_solana_token_balances` | Query SPL token balance changes |
| `portal_query_solana_logs` | Query Solana program logs |
| `portal_query_solana_rewards` | Query staking/voting rewards |

### Advanced Queries

| Tool | Description |
|------|-------------|
| `portal_stream` | Stream data with custom queries |
| `portal_query_paginated` | Paginated queries for large results |
| `portal_batch_query` | Execute multiple queries in parallel |
| `portal_decode_logs` | Decode event logs using ABI |
| `portal_get_address_activity` | Get all activity for an address |
| `portal_get_token_transfers_for_address` | Get token transfers for an address |

## Example Queries

**List available networks:**
```
Use portal_list_datasets to show me available blockchain networks
```

**Get recent transfers:**
```
Use portal_get_erc20_transfers to get USDC transfers on Ethereum in the last 100 blocks
```

**Query Uniswap swaps:**
```
Use portal_query_logs to find Uniswap V3 Swap events on Arbitrum
```

## License

MIT
