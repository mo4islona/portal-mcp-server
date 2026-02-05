import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PORTAL_URL } from "../../constants/index.js";
import { resolveDataset } from "../../cache/datasets.js";
import { portalFetchStream } from "../../helpers/fetch.js";
import { formatResult } from "../../helpers/format.js";

// ============================================================================
// Tool: Stream Query
// ============================================================================

export function registerStreamTool(server: McpServer) {
  server.tool(
    "portal_stream",
    "Execute a raw streaming query against the Portal API",
    {
      dataset: z.string().describe("Dataset name or alias"),
      query: z
        .object({
          type: z.enum(["evm", "solana"]).describe("REQUIRED: Chain type (evm or solana)"),
          fromBlock: z.number(),
          toBlock: z.number().optional(),
          fields: z.record(z.unknown()).optional(),
          includeAllBlocks: z.boolean().optional(),
          logs: z.array(z.record(z.unknown())).optional(),
          transactions: z.array(z.record(z.unknown())).optional(),
          traces: z.array(z.record(z.unknown())).optional(),
          stateDiffs: z.array(z.record(z.unknown())).optional(),
          instructions: z.array(z.record(z.unknown())).optional(),
          balances: z.array(z.record(z.unknown())).optional(),
          tokenBalances: z.array(z.record(z.unknown())).optional(),
          rewards: z.array(z.record(z.unknown())).optional(),
        })
        .describe("Raw query object (must include 'type': 'evm' or 'solana')"),
      timeout_ms: z
        .number()
        .optional()
        .default(60000)
        .describe("Request timeout in milliseconds"),
    },
    async ({ dataset, query, timeout_ms }) => {
      dataset = await resolveDataset(dataset);

      const results = await portalFetchStream(
        `${PORTAL_URL}/datasets/${dataset}/stream`,
        query,
        timeout_ms,
      );

      return formatResult(results, `Retrieved ${results.length} blocks of data`);
    },
  );
}
