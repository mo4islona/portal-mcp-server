import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PORTAL_URL } from "../../constants/index.js";
import { resolveDataset, getBlockHead } from "../../cache/datasets.js";
import { detectChainType } from "../../helpers/chain.js";
import { portalFetchStream } from "../../helpers/fetch.js";
import { formatResult } from "../../helpers/format.js";

// ============================================================================
// Tool: Get Time Series Data
// ============================================================================

/**
 * Aggregate blockchain metrics over time intervals.
 * Perfect for "show me activity trends over the past week" questions.
 */
export function registerGetTimeSeriesDataTool(server: McpServer) {
  server.tool(
    "portal_get_time_series",
    `Aggregate blockchain metrics over time intervals. Perfect for trend analysis and charting.

WHEN TO USE:
- "Show me transaction volume over the past 24 hours"
- "Chart gas prices by hour for the last week"
- "What's the hourly transaction trend on Base?"
- "Track contract activity over time"
- "Visualize block utilization trends"

ONE CALL SOLUTION: Automatically buckets data by time interval and calculates aggregates.

EXAMPLES:
- Hourly txs: { dataset: "base", metric: "transaction_count", interval: "1h", duration: "24h" }
- Daily gas: { dataset: "ethereum", metric: "avg_gas_price", interval: "1d", duration: "7d" }
- 15min activity: { dataset: "polygon", metric: "transaction_count", interval: "15m", duration: "6h" }

FAST: Returns time-bucketed data ready for charting or analysis.`,
    {
      dataset: z.string().describe("Dataset name (supports short names: 'ethereum', 'polygon', 'base', etc.)"),
      metric: z
        .enum(["transaction_count", "avg_gas_price", "gas_used", "block_utilization", "unique_addresses"])
        .describe("Metric to aggregate over time"),
      interval: z
        .enum(["5m", "15m", "1h", "6h", "1d"])
        .describe("Time bucket interval (5m, 15m, 1h, 6h, 1d)"),
      duration: z
        .enum(["1h", "6h", "24h", "7d", "30d"])
        .describe("Total time period to analyze"),
      address: z
        .string()
        .optional()
        .describe("Optional: Filter to specific contract address for contract-specific trends"),
    },
    async ({ dataset, metric, interval, duration, address }) => {
      const queryStartTime = Date.now();
      dataset = await resolveDataset(dataset);
      const chainType = detectChainType(dataset);

      if (chainType !== "evm") {
        throw new Error("portal_get_time_series is only for EVM chains");
      }

      // Calculate block range based on duration
      const head = await getBlockHead(dataset);
      const latestBlock = head.number;

      let blockRange: number;
      switch (duration) {
        case "1h":
          blockRange = 300;
          break;
        case "6h":
          blockRange = 1800;
          break;
        case "24h":
          blockRange = 7200;
          break;
        case "7d":
          blockRange = 50400;
          break;
        case "30d":
          blockRange = 216000;
          break;
      }

      const fromBlock = Math.max(0, latestBlock - blockRange + 1);

      // Calculate bucket size in blocks
      let bucketSize: number;
      switch (interval) {
        case "5m":
          bucketSize = 25; // ~5 minutes at 12s blocks
          break;
        case "15m":
          bucketSize = 75;
          break;
        case "1h":
          bucketSize = 300;
          break;
        case "6h":
          bucketSize = 1800;
          break;
        case "1d":
          bucketSize = 7200;
          break;
      }

      // Build query based on metric
      let query: any = {
        type: "evm",
        fromBlock,
        toBlock: latestBlock,
        includeAllBlocks: true, // IMPORTANT: Get all blocks, not just those matching filters
        fields: {
          block: {
            number: true,
            timestamp: true,
          },
        },
      };

      if (metric === "transaction_count" || metric === "unique_addresses") {
        query.fields.transaction = { transactionIndex: true };
        if (metric === "unique_addresses") {
          query.fields.transaction.from = true;
          query.fields.transaction.to = true;
        }
        query.transactions = address ? [{ to: [address.toLowerCase()] }] : [{}];
      } else if (metric === "avg_gas_price") {
        query.fields.block.baseFeePerGas = true;
      } else if (metric === "gas_used" || metric === "block_utilization") {
        query.fields.block.gasUsed = true;
        query.fields.block.gasLimit = true;
      }

      const results = await portalFetchStream(
        `${PORTAL_URL}/datasets/${dataset}/stream`,
        query,
      );

      if (results.length === 0) {
        throw new Error("No data available for this time period");
      }

      // Group blocks into time buckets (relative to fromBlock)
      const buckets: Map<number, any[]> = new Map();

      // Sample first few blocks to verify bucketing logic
      const sampleBlocks = results.slice(0, 5).concat(results.slice(-5));
      const bucketSamples: string[] = [];

      results.forEach((block: any, idx: number) => {
        // Portal API returns block data directly in the object, not nested
        const blockNumber = block.number || block.header?.number;
        if (!blockNumber) {
          // Debug: show what we actually got
          if (idx === 0) {
            throw new Error(`Block number not found in response. Block keys: ${Object.keys(block).join(', ')}. Sample block: ${JSON.stringify(block).substring(0, 200)}`);
          }
          return; // Skip blocks without numbers
        }

        const relativeBlockNumber = blockNumber - fromBlock;
        const bucketIndex = Math.floor(relativeBlockNumber / bucketSize);

        // Collect samples for debugging
        if (idx < 5 || idx >= results.length - 5) {
          bucketSamples.push(`Block ${blockNumber} (rel=${relativeBlockNumber}) -> bucket ${bucketIndex}`);
        }

        if (!buckets.has(bucketIndex)) {
          buckets.set(bucketIndex, []);
        }
        buckets.get(bucketIndex)!.push(block);
      });


      // Calculate aggregates for each bucket
      const timeSeries = Array.from(buckets.entries())
        .map(([bucketIndex, blocks]) => {
          const firstBlock = blocks[0];
          const lastBlock = blocks[blocks.length - 1];
          const firstBlockNumber = firstBlock.number || firstBlock.header?.number;
          const lastBlockNumber = lastBlock.number || lastBlock.header?.number;
          const timestamp = firstBlock.timestamp || firstBlock.header?.timestamp;

          let value: number;

          if (metric === "transaction_count") {
            value = blocks.reduce((sum, b) => sum + (b.transactions?.length || 0), 0);
          } else if (metric === "avg_gas_price") {
            const gasPrices = blocks
              .map((b) => (b.baseFeePerGas ? parseInt(b.baseFeePerGas) : null))
              .filter((g) => g !== null) as number[];
            value = gasPrices.length > 0 ? gasPrices.reduce((sum, g) => sum + g, 0) / gasPrices.length / 1e9 : 0; // Convert to Gwei
          } else if (metric === "gas_used") {
            value = blocks.reduce((sum, b) => sum + parseInt(b.gasUsed || "0"), 0);
          } else if (metric === "block_utilization") {
            const utilizations = blocks.map((b) =>
              b.gasLimit ? (parseInt(b.gasUsed || "0") / parseInt(b.gasLimit)) * 100 : 0,
            );
            value = utilizations.reduce((sum, u) => sum + u, 0) / utilizations.length;
          } else if (metric === "unique_addresses") {
            const addresses = new Set<string>();
            blocks.forEach((block) => {
              block.transactions?.forEach((tx: any) => {
                if (tx.from) addresses.add(tx.from.toLowerCase());
                if (tx.to) addresses.add(tx.to.toLowerCase());
              });
            });
            value = addresses.size;
          } else {
            value = 0;
          }

          return {
            bucket_index: bucketIndex,
            timestamp,
            block_range: `${firstBlockNumber}-${lastBlockNumber}`,
            blocks_in_bucket: blocks.length,
            value: parseFloat(value.toFixed(2)),
          };
        })
        .sort((a, b) => a.bucket_index - b.bucket_index);

      // Calculate summary statistics
      const values = timeSeries.map((t) => t.value);
      const avg = values.reduce((sum, v) => sum + v, 0) / values.length;
      const min = Math.min(...values);
      const max = Math.max(...values);

      const summary = {
        metric,
        interval,
        duration,
        total_buckets: timeSeries.length,
        total_blocks: results.length,
        from_block: fromBlock,
        to_block: latestBlock,
        statistics: {
          avg: parseFloat(avg.toFixed(2)),
          min: parseFloat(min.toFixed(2)),
          max: parseFloat(max.toFixed(2)),
        },
      };

      if (address) {
        (summary as any).filtered_by_address = address;
      }

      return formatResult(
        {
          summary,
          time_series: timeSeries,
        },
        `Aggregated ${metric} over ${duration} in ${interval} intervals. ${timeSeries.length} data points. Avg: ${avg.toFixed(2)}, Min: ${min.toFixed(2)}, Max: ${max.toFixed(2)}`,
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
