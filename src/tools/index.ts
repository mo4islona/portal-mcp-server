import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// Dataset tools
import { registerListDatasetsTool } from "./datasets/list.js";
import { registerSearchDatasetsTool } from "./datasets/search.js";
import { registerGetDatasetInfoTool } from "./datasets/info.js";

// EVM tools
import { registerGetBlockNumberTool } from "./evm/block-number.js";
import { registerBlockAtTimestampTool } from "./evm/block-at-timestamp.js";
import { registerQueryBlocksTool } from "./evm/query-blocks.js";
import { registerQueryLogsTool } from "./evm/query-logs.js";
import { registerQueryTransactionsTool } from "./evm/query-transactions.js";
import { registerQueryTracesTool } from "./evm/query-traces.js";
import { registerQueryStateDiffsTool } from "./evm/query-state-diffs.js";
import { registerGetErc20TransfersTool } from "./evm/erc20-transfers.js";
import { registerGetNftTransfersTool } from "./evm/nft-transfers.js";

// Solana tools
import { registerQuerySolanaInstructionsTool } from "./solana/query-instructions.js";
import { registerQuerySolanaBalancesTool } from "./solana/query-balances.js";
import { registerQuerySolanaTokenBalancesTool } from "./solana/query-token-balances.js";
import { registerQuerySolanaLogsTool } from "./solana/query-logs.js";
import { registerQuerySolanaRewardsTool } from "./solana/query-rewards.js";

// Utility tools
import { registerStreamTool } from "./utilities/stream.js";
import { registerQueryPaginatedTool } from "./utilities/query-paginated.js";
import { registerBatchQueryTool } from "./utilities/batch-query.js";
import { registerDecodeLogsTool } from "./utilities/decode-logs.js";
import { registerGetAddressActivityTool } from "./utilities/address-activity.js";
import { registerGetTokenTransfersForAddressTool } from "./utilities/token-transfers-for-address.js";

// Convenience tools
import {
  registerGetRecentTransactionsTool,
  registerGetWalletSummaryTool,
  registerGetContractActivityTool,
  registerGetTransactionDensityTool,
  registerGetGasAnalyticsTool,
  registerCompareChainsTool,
  registerGetTopContractsTool,
  registerGetTopAddressesTool,
  registerGetTimeSeriesDataTool,
  registerGetContractDeploymentsTool,
} from "./convenience/index.js";

// Enrichment tools (external data sources)
import {
  registerGetTokenInfoTool,
  registerGetDefiProtocolTool,
  registerGetProtocolsByChainTool,
  registerGetChainTvlTool,
  registerGetYieldPoolsTool,
  registerGetProtocolFeesTool,
} from "./enrichment/index.js";

// ============================================================================
// Tool Registry
// ============================================================================

export function registerAllTools(server: McpServer) {
  // Dataset tools (3)
  registerListDatasetsTool(server);
  registerSearchDatasetsTool(server);
  registerGetDatasetInfoTool(server);

  // EVM tools (9)
  registerGetBlockNumberTool(server);
  registerBlockAtTimestampTool(server);
  registerQueryBlocksTool(server);
  registerQueryLogsTool(server);
  registerQueryTransactionsTool(server);
  registerQueryTracesTool(server);
  registerQueryStateDiffsTool(server);
  registerGetErc20TransfersTool(server);
  registerGetNftTransfersTool(server);

  // Solana tools (5)
  registerQuerySolanaInstructionsTool(server);
  registerQuerySolanaBalancesTool(server);
  registerQuerySolanaTokenBalancesTool(server);
  registerQuerySolanaLogsTool(server);
  registerQuerySolanaRewardsTool(server);

  // Utility tools (6)
  registerStreamTool(server);
  registerQueryPaginatedTool(server);
  registerBatchQueryTool(server);
  registerDecodeLogsTool(server);
  registerGetAddressActivityTool(server);
  registerGetTokenTransfersForAddressTool(server);

  // Convenience tools (10) - High-level wrappers for common tasks
  registerGetRecentTransactionsTool(server);
  registerGetWalletSummaryTool(server);
  registerGetContractActivityTool(server);
  registerGetTransactionDensityTool(server);
  registerGetGasAnalyticsTool(server);
  registerCompareChainsTool(server);
  registerGetTopContractsTool(server);
  registerGetTopAddressesTool(server);
  registerGetTimeSeriesDataTool(server);
  registerGetContractDeploymentsTool(server);

  // Enrichment tools (6) - External data sources for rich metadata
  registerGetTokenInfoTool(server);
  registerGetDefiProtocolTool(server);
  registerGetProtocolsByChainTool(server);
  registerGetChainTvlTool(server);
  registerGetYieldPoolsTool(server);
  registerGetProtocolFeesTool(server);
}
