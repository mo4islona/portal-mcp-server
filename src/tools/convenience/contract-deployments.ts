import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PORTAL_URL } from "../../constants/index.js";
import { resolveDataset, getBlockHead } from "../../cache/datasets.js";
import { detectChainType } from "../../helpers/chain.js";
import { portalFetchStream } from "../../helpers/fetch.js";
import { formatResult } from "../../helpers/format.js";

// ============================================================================
// Tool: Track Contract Deployments
// ============================================================================

/**
 * Find and track contract deployments (both CREATE and CREATE2).
 * Perfect for "show me recent contract deployments" questions.
 */
export function registerGetContractDeploymentsTool(server: McpServer) {
  server.tool(
    "portal_get_contract_deployments",
    `Track contract deployments including both CREATE and CREATE2 opcodes. Perfect for deployment monitoring.

WHEN TO USE:
- "Show me contracts deployed in the last 24 hours"
- "Find recent contract deployments on Base"
- "Which contracts were deployed today?"
- "Track new smart contracts on this chain"
- "Monitor contract creation activity"

COMPREHENSIVE: Detects BOTH CREATE and CREATE2 deployments via traces.

EXAMPLES:
- Recent deployments: { dataset: "base", num_blocks: 7200 }
- Last hour: { dataset: "ethereum", num_blocks: 300 }
- With deployer info: { dataset: "polygon", num_blocks: 1000, include_deployer: true }

FAST: Returns list of deployed contracts with addresses, deployers, and block info.`,
    {
      dataset: z.string().describe("Dataset name (supports short names: 'ethereum', 'polygon', 'base', etc.)"),
      num_blocks: z
        .number()
        .max(10000)
        .optional()
        .default(1000)
        .describe("Number of recent blocks to analyze (default: 1000, max: 10000 for performance)"),
      include_deployer: z
        .boolean()
        .optional()
        .default(true)
        .describe("Include deployer address information (default: true)"),
      deployer_address: z
        .string()
        .optional()
        .describe("Optional: Filter to deployments by specific deployer address"),
    },
    async ({ dataset, num_blocks, include_deployer, deployer_address }) => {
      const queryStartTime = Date.now();
      dataset = await resolveDataset(dataset);
      const chainType = detectChainType(dataset);

      if (chainType !== "evm") {
        throw new Error("portal_get_contract_deployments is only for EVM chains");
      }

      // Get latest block
      const head = await getBlockHead(dataset);
      const latestBlock = head.number;
      const fromBlock = Math.max(0, latestBlock - num_blocks + 1);

      // Query traces for CREATE and CREATE2 operations
      const query: any = {
        type: "evm",
        fromBlock,
        toBlock: latestBlock,
        fields: {
          block: {
            number: true,
            timestamp: true,
          },
          transaction: {
            hash: true,
            from: true,
          },
          trace: {
            type: true,
            createFrom: true,
            createResultAddress: true,
          },
        },
        traces: [
          {
            type: ["create", "create2"],
          },
        ],
      };

      // Filter by deployer if specified
      if (deployer_address) {
        query.traces[0].createFrom = [deployer_address.toLowerCase()];
      }

      const results = await portalFetchStream(
        `${PORTAL_URL}/datasets/${dataset}/stream`,
        query,
      );

      // Extract contract deployments from traces
      const deployments: Array<{
        contract_address: string;
        deployer: string;
        deployment_type: string;
        transaction_hash: string;
        block_number: number;
        timestamp: number;
      }> = [];

      results.forEach((block: any) => {
        block.transactions?.forEach((tx: any) => {
          tx.traces?.forEach((trace: any) => {
            if (trace.createResultAddress) {
              deployments.push({
                contract_address: trace.createResultAddress.toLowerCase(),
                deployer: trace.createFrom?.toLowerCase() || tx.from?.toLowerCase() || "unknown",
                deployment_type: trace.type === "create" ? "CREATE" : "CREATE2",
                transaction_hash: tx.hash,
                block_number: block.number,
                timestamp: block.timestamp,
              });
            }
          });
        });
      });

      // Sort by block number (most recent first)
      deployments.sort((a, b) => b.block_number - a.block_number);

      // Calculate statistics
      const createCount = deployments.filter((d) => d.deployment_type === "CREATE").length;
      const create2Count = deployments.filter((d) => d.deployment_type === "CREATE2").length;
      const uniqueDeployers = new Set(deployments.map((d) => d.deployer)).size;

      const summary = {
        total_deployments: deployments.length,
        create_deployments: createCount,
        create2_deployments: create2Count,
        unique_deployers: uniqueDeployers,
        blocks_analyzed: results.length,
        from_block: fromBlock,
        to_block: latestBlock,
        most_active_deployer: deployments.length > 0 ? getMostActiveDeployer(deployments) : null,
      };

      if (deployer_address) {
        (summary as any).filtered_by_deployer = deployer_address;
      }

      // Remove deployer info if not requested
      const outputDeployments = include_deployer
        ? deployments
        : deployments.map(({ deployer, ...rest }) => rest);

      return formatResult(
        {
          summary,
          deployments: outputDeployments,
        },
        `Found ${deployments.length} contract deployments (${createCount} CREATE, ${create2Count} CREATE2) across ${results.length} blocks`,
        {
          metadata: {
            dataset,
            from_block: fromBlock,
            to_block: latestBlock,
            query_start_time: queryStartTime,
          },
        },
      );
    },
  );
}

function getMostActiveDeployer(deployments: Array<{ deployer: string }>): {
  address: string;
  deployment_count: number;
} {
  const counts = new Map<string, number>();
  deployments.forEach((d) => {
    counts.set(d.deployer, (counts.get(d.deployer) || 0) + 1);
  });

  let maxAddress = "";
  let maxCount = 0;
  counts.forEach((count, address) => {
    if (count > maxCount) {
      maxCount = count;
      maxAddress = address;
    }
  });

  return { address: maxAddress, deployment_count: maxCount };
}
