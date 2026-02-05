# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.0] - 2025-01-XX

### Added
- `portal_search_datasets` - Search datasets by name or alias
- `portal_get_dataset_info` - Get detailed metadata for a dataset
- `portal_get_block_number` - Get current or finalized block number
- `portal_query_blocks` - Query blocks with field selection
- `portal_query_transactions` - Query transactions with filters
- `portal_query_traces` - Query internal call traces
- `portal_query_state_diffs` - Query storage state changes
- `portal_get_erc20_transfers` - Dedicated ERC20 transfer queries
- `portal_get_nft_transfers` - ERC721/ERC1155 transfer queries
- `portal_query_solana_instructions` - Solana program instruction queries
- `portal_query_solana_balances` - SOL balance change queries
- `portal_query_solana_token_balances` - SPL token balance queries
- `portal_query_solana_logs` - Solana program log queries
- `portal_query_solana_rewards` - Staking/voting reward queries
- `portal_query_paginated` - Pagination support for large queries
- `portal_batch_query` - Parallel query execution
- `portal_decode_logs` - ABI-based event log decoding
- `portal_get_address_activity` - Comprehensive address activity
- `portal_get_token_transfers_for_address` - Address token transfer history
- Automatic retry with exponential backoff
- Rate limit handling (429 responses)
- Chain reorganization detection (409 responses)

### Changed
- Improved error messages with actionable guidance
- Enhanced input validation with Zod schemas

## [0.3.0] - 2025-01-XX

### Added
- Initial public release
- `portal_list_datasets` - List available blockchain datasets
- `portal_get_metadata` - Get dataset metadata
- `portal_get_head` - Get current head block
- `portal_get_finalized_head` - Get finalized head block
- `portal_block_at_timestamp` - Find block at timestamp
- `portal_stream` - Stream blockchain data
- `portal_finalized_stream` - Stream finalized data
- `portal_query_logs` - Query event logs
