import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PORTAL_URL, EVENT_SIGNATURES } from "../../constants/index.js";
import { resolveDataset, validateBlockRange } from "../../cache/datasets.js";
import { detectChainType } from "../../helpers/chain.js";
import { portalFetchStream } from "../../helpers/fetch.js";
import { formatResult } from "../../helpers/format.js";
import { buildEvmLogFields } from "../../helpers/fields.js";
import { normalizeEvmAddress } from "../../helpers/validation.js";

// ============================================================================
// Tool: Get Token Transfers For Address
// ============================================================================

export function registerGetTokenTransfersForAddressTool(server: McpServer) {
  server.tool(
    "portal_get_token_transfers_for_address",
    "Get all token transfers (ERC20/721/1155) for a specific address",
    {
      dataset: z.string().describe("Dataset name or alias"),
      address: z.string().describe("Address to query (sender or recipient)"),
      token_address: z
        .string()
        .optional()
        .describe("Filter by specific token contract"),
      from_block: z.number().describe("Starting block number"),
      to_block: z.number().optional().describe("Ending block number"),
      direction: z
        .enum(["in", "out", "both"])
        .optional()
        .default("both")
        .describe("Transfer direction"),
      token_type: z
        .enum(["erc20", "erc721", "erc1155", "all"])
        .optional()
        .default("all")
        .describe("Token standard to filter"),
      limit: z.number().optional().default(100).describe("Max transfers"),
      finalized_only: z
        .boolean()
        .optional()
        .default(false)
        .describe("Only query finalized blocks"),
    },
    async ({
      dataset,
      address,
      token_address,
      from_block,
      to_block,
      direction,
      token_type,
      limit,
      finalized_only,
    }) => {
      const queryStartTime = Date.now();
      dataset = await resolveDataset(dataset);
      const chainType = detectChainType(dataset);

      if (chainType !== "evm") {
        throw new Error(
          "portal_get_token_transfers_for_address is only for EVM chains",
        );
      }

      const normalizedAddress = normalizeEvmAddress(address);
      const paddedAddress = "0x" + normalizedAddress.slice(2).padStart(64, "0");
      const { validatedToBlock: endBlock } = await validateBlockRange(
        dataset,
        from_block,
        to_block ?? Number.MAX_SAFE_INTEGER,
        finalized_only,
      );

      // Build topic0 filter based on token type
      const topic0s: string[] = [];
      if (
        token_type === "all" ||
        token_type === "erc20" ||
        token_type === "erc721"
      ) {
        topic0s.push(EVENT_SIGNATURES.TRANSFER_ERC20);
      }
      if (token_type === "all" || token_type === "erc1155") {
        topic0s.push(EVENT_SIGNATURES.TRANSFER_SINGLE);
        topic0s.push(EVENT_SIGNATURES.TRANSFER_BATCH);
      }

      // Build log filters based on direction
      const logFilters: Record<string, unknown>[] = [];

      if (direction === "both" || direction === "out") {
        const filter: Record<string, unknown> = {
          topic0: topic0s,
          topic1: [paddedAddress], // from
        };
        if (token_address) {
          filter.address = [normalizeEvmAddress(token_address)];
        }
        logFilters.push(filter);
      }

      if (direction === "both" || direction === "in") {
        const filter: Record<string, unknown> = {
          topic0: topic0s,
          topic2: [paddedAddress], // to
        };
        if (token_address) {
          filter.address = [normalizeEvmAddress(token_address)];
        }
        logFilters.push(filter);
      }

      const query = {
        type: "evm",
        fromBlock: from_block,
        toBlock: endBlock,
        fields: {
          block: { number: true, timestamp: true },
          log: buildEvmLogFields(),
        },
        logs: logFilters,
      };

      const results = await portalFetchStream(
        `${PORTAL_URL}/datasets/${dataset}/stream`,
        query,
      );

      const transfers = results
        .flatMap((block: unknown) => {
          const b = block as {
            header?: { number: number; timestamp: number };
            logs?: Array<{
              address: string;
              topics: string[];
              data: string;
              transactionHash: string;
              logIndex: number;
            }>;
          };
          return (b.logs || []).map((log) => {
            const topic0 = log.topics[0];
            let tokenType = "unknown";
            let from = "";
            let to = "";
            let value = "";
            let tokenId = "";

            if (topic0 === EVENT_SIGNATURES.TRANSFER_ERC20) {
              // Could be ERC20 or ERC721 - check topics count
              from = "0x" + (log.topics[1]?.slice(-40) || "");
              to = "0x" + (log.topics[2]?.slice(-40) || "");
              if (log.topics.length === 4) {
                tokenType = "erc721";
                tokenId = log.topics[3];
              } else {
                tokenType = "erc20";
                value = log.data;
              }
            } else if (topic0 === EVENT_SIGNATURES.TRANSFER_SINGLE) {
              tokenType = "erc1155";
              from = "0x" + (log.topics[2]?.slice(-40) || "");
              to = "0x" + (log.topics[3]?.slice(-40) || "");
              // id and value in data
            } else if (topic0 === EVENT_SIGNATURES.TRANSFER_BATCH) {
              tokenType = "erc1155_batch";
              from = "0x" + (log.topics[2]?.slice(-40) || "");
              to = "0x" + (log.topics[3]?.slice(-40) || "");
            }

            const transferDirection =
              from.toLowerCase() === normalizedAddress ? "out" : "in";

            return {
              block_number: b.header?.number,
              timestamp: b.header?.timestamp,
              token_address: log.address,
              token_type: tokenType,
              direction: transferDirection,
              from,
              to,
              value: value || undefined,
              token_id: tokenId || undefined,
              transaction_hash: log.transactionHash,
              log_index: log.logIndex,
              data: log.data,
            };
          });
        })
        .slice(0, limit);

      const inCount = transfers.filter((t) => t.direction === "in").length;
      const outCount = transfers.filter((t) => t.direction === "out").length;

      return formatResult(
        transfers,
        `Found ${transfers.length} token transfers (${inCount} in, ${outCount} out)`,
        {
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
