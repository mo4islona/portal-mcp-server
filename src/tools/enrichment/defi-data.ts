import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  getDefiLlamaProtocols,
  getDefiLlamaProtocol,
  findProtocolsByChain,
  findProtocolByName,
  getChainTvl,
  getYieldPools,
  getProtocolFees,
} from "../../helpers/external-apis.js";
import { formatResult } from "../../helpers/format.js";

// ============================================================================
// Tool: Get DeFi Protocol Data
// ============================================================================

export function registerGetDefiProtocolTool(server: McpServer) {
  server.tool(
    "portal_get_defi_protocol",
    `Get DeFi protocol data from DeFi Llama. Returns TVL, chains, categories, social links.

WHEN TO USE:
- "What's Uniswap's TVL?" → Get protocol metrics
- "Show me Aave details" → Fetch protocol info
- "Which chains is Curve on?" → Get deployment info
- "What category is this protocol?" → Get classification

DATA SOURCE: DeFi Llama API (https://defillama.com)

EXAMPLES:
- By name: { protocol: "uniswap" }
- By slug: { protocol: "aave-v3" }
- Search: { protocol: "curve" }

INCLUDES: TVL, chains, category, logo, audits, social links, token info`,
    {
      protocol: z
        .string()
        .describe("Protocol name or slug (e.g., 'uniswap', 'aave', 'curve')"),
    },
    async ({ protocol }) => {
      const queryStartTime = Date.now();

      // First try to find the protocol in the list
      const protocolData = await findProtocolByName(protocol);
      if (!protocolData) {
        throw new Error(`Protocol not found: ${protocol}. Try searching with a different name or check https://defillama.com`);
      }

      // Get detailed protocol data
      const details = await getDefiLlamaProtocol(protocolData.slug);

      return formatResult(
        {
          basic: {
            name: protocolData.name,
            slug: protocolData.slug,
            category: protocolData.category,
            chains: protocolData.chains,
            tvl: protocolData.tvl,
            logo: protocolData.logo,
            url: protocolData.url,
            twitter: protocolData.twitter,
          },
          metrics: {
            tvl: protocolData.tvl,
            change_1h: protocolData.change_1h,
            change_1d: protocolData.change_1d,
            change_7d: protocolData.change_7d,
            mcap: protocolData.mcap,
            fdv: protocolData.fdv,
          },
          chainTvls: protocolData.chainTvls,
          security: {
            audits: protocolData.audits,
            audit_note: protocolData.audit_note,
            oracles: protocolData.oracles,
          },
          details,
        },
        `${protocolData.name}: $${(protocolData.tvl / 1e9).toFixed(2)}B TVL across ${protocolData.chains.length} chains`,
        {
          metadata: {
            query_start_time: queryStartTime,
          },
        },
      );
    },
  );
}

// ============================================================================
// Tool: Get Protocols by Chain
// ============================================================================

export function registerGetProtocolsByChainTool(server: McpServer) {
  server.tool(
    "portal_get_protocols_by_chain",
    `Get all DeFi protocols on a specific chain from DeFi Llama.

WHEN TO USE:
- "What DeFi protocols are on Base?" → List all protocols
- "Show me Arbitrum DeFi ecosystem" → Get chain overview
- "Which protocols deployed on Optimism?" → Find deployments

DATA SOURCE: DeFi Llama API

EXAMPLES:
- All protocols: { chain: "base" }
- Top 10 by TVL: { chain: "ethereum", limit: 10, sort_by_tvl: true }
- Specific category: { chain: "arbitrum", category: "dex" }

RETURNS: Protocol list with TVL, categories, chains`,
    {
      chain: z.string().describe("Chain name (e.g., 'ethereum', 'base', 'arbitrum')"),
      limit: z
        .number()
        .optional()
        .default(50)
        .describe("Max protocols to return (default 50)"),
      sort_by_tvl: z
        .boolean()
        .optional()
        .default(true)
        .describe("Sort by TVL descending (default true)"),
      category: z
        .string()
        .optional()
        .describe("Filter by category (e.g., 'dex', 'lending', 'bridge')"),
    },
    async ({ chain, limit, sort_by_tvl, category }) => {
      const queryStartTime = Date.now();

      let protocols = await findProtocolsByChain(chain);

      // Filter by category if specified
      if (category) {
        const normalizedCategory = category.toLowerCase();
        protocols = protocols.filter((p) =>
          p.category.toLowerCase().includes(normalizedCategory)
        );
      }

      // Sort by TVL if requested
      if (sort_by_tvl) {
        protocols.sort((a, b) => (b.tvl || 0) - (a.tvl || 0));
      }

      // Limit results
      const limitedProtocols = protocols.slice(0, limit);

      // Calculate total TVL
      const totalTvl = limitedProtocols.reduce((sum, p) => sum + (p.tvl || 0), 0);

      return formatResult(
        {
          summary: {
            chain,
            total_protocols: protocols.length,
            showing: limitedProtocols.length,
            total_tvl: totalTvl,
            category_filter: category || "all",
          },
          protocols: limitedProtocols.map((p) => ({
            name: p.name,
            slug: p.slug,
            tvl: p.tvl,
            category: p.category,
            chains: p.chains,
            change_1d: p.change_1d,
            change_7d: p.change_7d,
            logo: p.logo,
            url: p.url,
          })),
        },
        `Found ${protocols.length} protocols on ${chain}. Total TVL: $${(totalTvl / 1e9).toFixed(2)}B`,
        {
          metadata: {
            query_start_time: queryStartTime,
          },
        },
      );
    },
  );
}

// ============================================================================
// Tool: Get Chain TVL
// ============================================================================

export function registerGetChainTvlTool(server: McpServer) {
  server.tool(
    "portal_get_chain_tvl",
    `Get total value locked (TVL) for a blockchain from DeFi Llama.

WHEN TO USE:
- "What's the TVL on Base?" → Get chain metrics
- "How much value is on Arbitrum?" → Check TVL
- "Compare Optimism vs Base TVL" → Get metrics for comparison

DATA SOURCE: DeFi Llama API

EXAMPLES:
- Single chain: { chain: "base" }
- For comparison: { chain: "ethereum" }

RETURNS: Total TVL and protocol count`,
    {
      chain: z.string().describe("Chain name (e.g., 'ethereum', 'base', 'arbitrum')"),
    },
    async ({ chain }) => {
      const queryStartTime = Date.now();

      const data = await getChainTvl(chain);

      return formatResult(
        data,
        `${chain}: $${(data.tvl / 1e9).toFixed(2)}B TVL across ${data.protocols} protocols`,
        {
          metadata: {
            query_start_time: queryStartTime,
          },
        },
      );
    },
  );
}

// ============================================================================
// Tool: Get Yield Opportunities
// ============================================================================

export function registerGetYieldPoolsTool(server: McpServer) {
  server.tool(
    "portal_get_yield_pools",
    `Get yield farming opportunities from DeFi Llama. Find best APY/APR across protocols.

WHEN TO USE:
- "What are the best yields on Base?" → Find high APY pools
- "Show me stablecoin yields" → Filter by stablecoins
- "Where can I earn 10%+?" → Find yield opportunities

DATA SOURCE: DeFi Llama Yields API

EXAMPLES:
- Top yields: { chain: "base", min_apy: 5, limit: 10 }
- Stablecoin yields: { chain: "ethereum", stablecoin: true }
- Specific protocol: { protocol: "aave" }

RETURNS: APY, TVL, exposure, IL risk, pool details`,
    {
      chain: z.string().optional().describe("Filter by chain (e.g., 'base', 'ethereum')"),
      protocol: z.string().optional().describe("Filter by protocol (e.g., 'aave', 'uniswap')"),
      min_tvl: z.number().optional().describe("Minimum TVL in USD"),
      min_apy: z.number().optional().describe("Minimum APY percentage"),
      stablecoin: z.boolean().optional().describe("Only stablecoin pools"),
      limit: z.number().optional().default(20).describe("Max pools to return (default 20)"),
    },
    async ({ chain, protocol, min_tvl, min_apy, stablecoin, limit }) => {
      const queryStartTime = Date.now();

      let pools = await getYieldPools();

      // Apply filters
      if (chain) {
        const normalizedChain = chain.toLowerCase();
        pools = pools.filter((p) =>
          p.chain?.toLowerCase() === normalizedChain
        );
      }

      if (protocol) {
        const normalizedProtocol = protocol.toLowerCase();
        pools = pools.filter((p) =>
          p.project?.toLowerCase().includes(normalizedProtocol)
        );
      }

      if (min_tvl) {
        pools = pools.filter((p) => (p.tvlUsd || 0) >= min_tvl);
      }

      if (min_apy) {
        pools = pools.filter((p) => (p.apy || 0) >= min_apy);
      }

      if (stablecoin) {
        pools = pools.filter((p) => p.stablecoin === true);
      }

      // Sort by APY descending
      pools.sort((a, b) => (b.apy || 0) - (a.apy || 0));

      // Limit results
      const limitedPools = pools.slice(0, limit);

      return formatResult(
        {
          summary: {
            total_pools: pools.length,
            showing: limitedPools.length,
            filters: { chain, protocol, min_tvl, min_apy, stablecoin },
            highest_apy: limitedPools[0]?.apy || 0,
          },
          pools: limitedPools.map((p) => ({
            pool: p.pool,
            chain: p.chain,
            project: p.project,
            symbol: p.symbol,
            tvl: p.tvlUsd,
            apy: p.apy,
            apyBase: p.apyBase,
            apyReward: p.apyReward,
            il7d: p.il7d,
            exposure: p.exposure,
            poolMeta: p.poolMeta,
          })),
        },
        `Found ${pools.length} yield pools. Best APY: ${(limitedPools[0]?.apy || 0).toFixed(2)}%`,
        {
          metadata: {
            query_start_time: queryStartTime,
          },
        },
      );
    },
  );
}

// ============================================================================
// Tool: Get Protocol Fees
// ============================================================================

export function registerGetProtocolFeesTool(server: McpServer) {
  server.tool(
    "portal_get_protocol_fees",
    `Get protocol fees and revenue data from DeFi Llama.

WHEN TO USE:
- "How much does Uniswap make?" → Get fee revenue
- "What are Aave's fees?" → Check protocol earnings
- "Show me protocol revenue trends" → Get historical data

DATA SOURCE: DeFi Llama Fees API

EXAMPLES:
- Current fees: { protocol: "uniswap" }
- Revenue data: { protocol: "aave-v3" }

RETURNS: Daily/monthly fees, revenue, trends`,
    {
      protocol: z
        .string()
        .describe("Protocol slug (e.g., 'uniswap', 'aave-v3', 'curve')"),
    },
    async ({ protocol }) => {
      const queryStartTime = Date.now();

      const data = await getProtocolFees(protocol);

      return formatResult(
        data,
        `${protocol} fees and revenue data`,
        {
          metadata: {
            query_start_time: queryStartTime,
          },
        },
      );
    },
  );
}
