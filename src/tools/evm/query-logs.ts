import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PORTAL_URL } from "../../constants/index.js";
import { resolveDataset, validateBlockRange } from "../../cache/datasets.js";
import { detectChainType, isL2Chain } from "../../helpers/chain.js";
import { portalFetchStream } from "../../helpers/fetch.js";
import { formatResult } from "../../helpers/format.js";
import {
  buildEvmLogFields,
  buildEvmTransactionFields,
  buildEvmTraceFields,
} from "../../helpers/fields.js";
import {
  normalizeAddresses,
  validateQuerySize,
  formatBlockRangeWarning,
  getQueryExamples,
} from "../../helpers/validation.js";

// ============================================================================
// Tool: Query Logs (EVM)
// ============================================================================

export function registerQueryLogsTool(server: McpServer) {
  server.tool(
    "portal_query_logs",
    `Query event logs (emitted events) from EVM chains. This is THE TOOL for tracking on-chain events.

WHEN TO USE:
- "Track all USDC transfers" → Filter by USDC address + Transfer event signature
- "Monitor Uniswap swaps on pool X" → Filter by pool address + Swap event
- "Get all events from contract Y" → Just filter by address
- "Find Transfer events with specific recipient" → Use topic1 for indexed parameters

PERFORMANCE: <1s for 10k blocks when filtered. ALWAYS filter by address or topics.

EXAMPLES:
- ERC20 transfers: { addresses: ["0xUSDC..."], topic0: ["0xddf252ad...Transfer"] }
- All contract events: { addresses: ["0xContract..."], from_block: X, to_block: Y }
- Indexed parameter: { topic1: ["0x000...paddedAddress"] } for transfer recipient

SEE ALSO: portal_get_erc20_transfers (easier for token transfers), portal_get_nft_transfers`,
    {
      dataset: z.string().describe("Dataset name or alias"),
      from_block: z.number().describe("Starting block number"),
      to_block: z
        .number()
        .optional()
        .describe(
          "Ending block number. RECOMMENDED: <10k blocks for fast (<1s) responses. Larger ranges may be slow or timeout.",
        ),
      finalized_only: z
        .boolean()
        .optional()
        .default(false)
        .describe("Only query finalized blocks"),
      addresses: z
        .array(z.string())
        .optional()
        .describe("Contract addresses to filter (e.g., ['0xUSDC...', '0xDAI...']). IMPORTANT: Always include this or topics for fast queries."),
      topic0: z
        .array(z.string())
        .optional()
        .describe("Event signatures (topic0). E.g., Transfer = 0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"),
      topic1: z.array(z.string()).optional().describe("Topic1 filter (often: from address in Transfer, indexed parameter 1)"),
      topic2: z.array(z.string()).optional().describe("Topic2 filter (often: to address in Transfer, indexed parameter 2)"),
      topic3: z.array(z.string()).optional().describe("Topic3 filter (indexed parameter 3, chain-specific)"),
      limit: z.number().max(1000).optional().default(20).describe("Max logs to return (default: 20, max: 1000). Note: Lower default for MCP to reduce context usage."),
      include_transaction: z
        .boolean()
        .optional()
        .default(false)
        .describe("Include parent transaction data"),
      include_transaction_traces: z
        .boolean()
        .optional()
        .default(false)
        .describe("Include traces for parent transactions"),
      include_transaction_logs: z
        .boolean()
        .optional()
        .default(false)
        .describe("Include all logs from parent transactions"),
    },
    async ({
      dataset,
      from_block,
      to_block,
      finalized_only,
      addresses,
      topic0,
      topic1,
      topic2,
      topic3,
      limit,
      include_transaction,
      include_transaction_traces,
      include_transaction_logs,
    }) => {
      const queryStartTime = Date.now();
      dataset = await resolveDataset(dataset);
      const chainType = detectChainType(dataset);

      if (chainType !== "evm") {
        throw new Error("portal_query_logs is only for EVM chains");
      }

      const normalizedAddresses = normalizeAddresses(addresses, chainType);
      const { validatedToBlock: endBlock } = await validateBlockRange(
        dataset,
        from_block,
        to_block ?? Number.MAX_SAFE_INTEGER,
        finalized_only,
      );
      const includeL2 = isL2Chain(dataset);

      // Validate query size to prevent crashes
      const blockRange = endBlock - from_block;
      const hasFilters = !!(normalizedAddresses || topic0 || topic1 || topic2 || topic3);

      const validation = validateQuerySize({
        blockRange,
        hasFilters,
        queryType: "logs",
        limit: limit ?? 100,
      });

      if (!validation.valid) {
        // Add examples to help user fix the query
        const examples = !hasFilters ? getQueryExamples("logs") : "";
        throw new Error(validation.error + examples);
      }

      // Warn about potentially slow queries
      if (validation.warning) {
        console.error(
          formatBlockRangeWarning(from_block, endBlock, "logs", hasFilters),
        );
      }

      const logFilter: Record<string, unknown> = {};
      if (normalizedAddresses) logFilter.address = normalizedAddresses;
      if (topic0) logFilter.topic0 = topic0;
      if (topic1) logFilter.topic1 = topic1;
      if (topic2) logFilter.topic2 = topic2;
      if (topic3) logFilter.topic3 = topic3;
      if (include_transaction) logFilter.transaction = true;
      if (include_transaction_traces) logFilter.transactionTraces = true;
      if (include_transaction_logs) logFilter.transactionLogs = true;

      const fields: Record<string, unknown> = {
        block: { number: true, timestamp: true, hash: true },
        log: buildEvmLogFields(),
      };
      if (
        include_transaction ||
        include_transaction_traces ||
        include_transaction_logs
      ) {
        fields.transaction = buildEvmTransactionFields(includeL2);
      }
      if (include_transaction_traces) {
        fields.trace = buildEvmTraceFields();
      }

      const query = {
        type: "evm",
        fromBlock: from_block,
        toBlock: endBlock,
        fields,
        logs: [logFilter],
      };

      const results = await portalFetchStream(
        `${PORTAL_URL}/datasets/${dataset}/stream`,
        query,
      );

      const allLogs = results.flatMap(
        (block: unknown) => (block as { logs?: unknown[] }).logs || [],
      );

      // Apply limit after collecting all results
      const limitedLogs = allLogs.slice(0, limit);

      return formatResult(
        limitedLogs,
        `Retrieved ${limitedLogs.length} logs${allLogs.length > limit ? ` (total found: ${allLogs.length})` : ""}`,
        {
          maxItems: limit,
          warnOnTruncation: false,
          metadata: {
            dataset,
            from_block,
            to_block: endBlock,
            query_start_time: queryStartTime,
          },
        },
      );
    },
  );
}
