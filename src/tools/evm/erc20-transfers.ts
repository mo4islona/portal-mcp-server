import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PORTAL_URL, EVENT_SIGNATURES } from "../../constants/index.js";
import type { BlockHead } from "../../types/index.js";
import { validateDataset } from "../../cache/datasets.js";
import { detectChainType } from "../../helpers/chain.js";
import { portalFetch, portalFetchStream } from "../../helpers/fetch.js";
import { formatResult } from "../../helpers/format.js";
import { buildEvmLogFields } from "../../helpers/fields.js";
import { normalizeAddresses, normalizeEvmAddress } from "../../helpers/validation.js";
import { getKnownTokenDecimals, formatTokenValue } from "../../helpers/conversions.js";

// ============================================================================
// Tool: Get ERC20 Transfers
// ============================================================================

export function registerGetErc20TransfersTool(server: McpServer) {
  server.tool(
    "portal_get_erc20_transfers",
    "Get ERC20 token transfer events. Wrapper for Portal API filtering Transfer(address,address,uint256) logs. Target: <1s for 10k blocks.",
    {
      dataset: z.string().describe("Dataset name or alias"),
      from_block: z.number().describe("Starting block number"),
      to_block: z
        .number()
        .optional()
        .describe("Ending block number. RECOMMENDED: <10k blocks for fast responses."),
      token_addresses: z
        .array(z.string())
        .optional()
        .describe("Token contract addresses"),
      from_addresses: z.array(z.string()).optional().describe("Sender addresses"),
      to_addresses: z
        .array(z.string())
        .optional()
        .describe("Recipient addresses"),
      limit: z.number().optional().default(1000).describe("Max transfers"),
    },
    async ({
      dataset,
      from_block,
      to_block,
      token_addresses,
      from_addresses,
      to_addresses,
      limit,
    }) => {
      const queryStartTime = Date.now();
      await validateDataset(dataset);
      const chainType = detectChainType(dataset);

      if (chainType !== "evm") {
        throw new Error("portal_get_erc20_transfers is only for EVM chains");
      }

      const normalizedTokens = normalizeAddresses(token_addresses, chainType);
      const normalizedFrom = from_addresses
        ? from_addresses.map(
            (a) => "0x" + normalizeEvmAddress(a).slice(2).padStart(64, "0"),
          )
        : undefined;
      const normalizedTo = to_addresses
        ? to_addresses.map(
            (a) => "0x" + normalizeEvmAddress(a).slice(2).padStart(64, "0"),
          )
        : undefined;

      const head = await portalFetch<BlockHead>(
        `${PORTAL_URL}/datasets/${dataset}/head`,
      );
      const endBlock = to_block ?? head.number;

      const logFilter: Record<string, unknown> = {
        topic0: [EVENT_SIGNATURES.TRANSFER_ERC20],
      };
      if (normalizedTokens) logFilter.address = normalizedTokens;
      if (normalizedFrom) logFilter.topic1 = normalizedFrom;
      if (normalizedTo) logFilter.topic2 = normalizedTo;

      const query = {
        type: "evm",
        fromBlock: from_block,
        toBlock: endBlock,
        fields: {
          block: { number: true, timestamp: true },
          log: buildEvmLogFields(),
        },
        logs: [logFilter],
      };

      const results = await portalFetchStream(
        `${PORTAL_URL}/datasets/${dataset}/stream`,
        query,
      );

      const allTransfers = results.flatMap((block: unknown) => {
        const b = block as {
          header?: { number: number };
          logs?: Array<{
            transactionHash: string;
            logIndex: number;
            address: string;
            topics?: string[];
            data: string;
          }>;
        };
        return (b.logs || []).map((log) => {
          const tokenAddress = log.address;
          const decimals = getKnownTokenDecimals(tokenAddress) || 18;
          const valueFormatted = formatTokenValue(log.data, decimals);

          return {
            block_number: b.header?.number,
            transaction_hash: log.transactionHash,
            log_index: log.logIndex,
            token_address: tokenAddress,
            from: "0x" + (log.topics?.[1]?.slice(-40) || ""),
            to: "0x" + (log.topics?.[2]?.slice(-40) || ""),
            value: log.data,
            value_decimal: valueFormatted.decimal,
            value_formatted: valueFormatted.formatted,
          };
        });
      });

      const limitedTransfers = allTransfers.slice(0, limit);

      return formatResult(
        limitedTransfers,
        `Retrieved ${limitedTransfers.length} ERC20 transfers${allTransfers.length > limit ? ` (total found: ${allTransfers.length})` : ""}`,
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
