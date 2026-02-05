import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PORTAL_URL, EVENT_SIGNATURES } from "../../constants/index.js";
import type { BlockHead } from "../../types/index.js";
import { validateDataset } from "../../cache/datasets.js";
import { detectChainType } from "../../helpers/chain.js";
import { portalFetch, portalFetchStream } from "../../helpers/fetch.js";
import { formatResult } from "../../helpers/format.js";
import { buildEvmLogFields } from "../../helpers/fields.js";
import { normalizeAddresses } from "../../helpers/validation.js";

// ============================================================================
// Tool: Get NFT Transfers
// ============================================================================

export function registerGetNftTransfersTool(server: McpServer) {
  server.tool(
    "portal_get_nft_transfers",
    "Get NFT (ERC721/ERC1155) transfer events",
    {
      dataset: z.string().describe("Dataset name or alias"),
      from_block: z.number().describe("Starting block number"),
      to_block: z.number().optional().describe("Ending block number"),
      contract_addresses: z
        .array(z.string())
        .optional()
        .describe("NFT contract addresses"),
      token_standard: z
        .enum(["erc721", "erc1155", "both"])
        .optional()
        .default("both")
        .describe("Token standard"),
      limit: z.number().optional().default(1000).describe("Max transfers"),
    },
    async ({
      dataset,
      from_block,
      to_block,
      contract_addresses,
      token_standard,
      limit,
    }) => {
      const queryStartTime = Date.now();
      await validateDataset(dataset);
      const chainType = detectChainType(dataset);

      if (chainType !== "evm") {
        throw new Error("portal_get_nft_transfers is only for EVM chains");
      }

      const normalizedContracts = normalizeAddresses(
        contract_addresses,
        chainType,
      );
      const head = await portalFetch<BlockHead>(
        `${PORTAL_URL}/datasets/${dataset}/head`,
      );
      const endBlock = to_block ?? head.number;

      const signatures: string[] = [];
      if (token_standard === "erc721" || token_standard === "both") {
        signatures.push(EVENT_SIGNATURES.TRANSFER_ERC721);
      }
      if (token_standard === "erc1155" || token_standard === "both") {
        signatures.push(EVENT_SIGNATURES.TRANSFER_SINGLE);
        signatures.push(EVENT_SIGNATURES.TRANSFER_BATCH);
      }

      const logFilter: Record<string, unknown> = {
        topic0: signatures,
      };
      if (normalizedContracts) logFilter.address = normalizedContracts;

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

      const transfers = results
        .flatMap((block: unknown) => {
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
            const topic0 = log.topics?.[0];
            let transferType = "unknown";
            let from = "";
            let to = "";
            let tokenId = "";

            if (topic0 === EVENT_SIGNATURES.TRANSFER_ERC721) {
              transferType = "erc721";
              from = "0x" + (log.topics?.[1]?.slice(-40) || "");
              to = "0x" + (log.topics?.[2]?.slice(-40) || "");
              tokenId = log.topics?.[3] || "";
            } else if (topic0 === EVENT_SIGNATURES.TRANSFER_SINGLE) {
              transferType = "erc1155_single";
              from = "0x" + (log.topics?.[2]?.slice(-40) || "");
              to = "0x" + (log.topics?.[3]?.slice(-40) || "");
            } else if (topic0 === EVENT_SIGNATURES.TRANSFER_BATCH) {
              transferType = "erc1155_batch";
              from = "0x" + (log.topics?.[2]?.slice(-40) || "");
              to = "0x" + (log.topics?.[3]?.slice(-40) || "");
            }

            return {
              block_number: b.header?.number,
              transaction_hash: log.transactionHash,
              log_index: log.logIndex,
              contract_address: log.address,
              transfer_type: transferType,
              from,
              to,
              token_id: tokenId,
              data: log.data,
            };
          });
        })
        .slice(0, limit);

      return formatResult(
        transfers,
        `Retrieved ${transfers.length} NFT transfers`,
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
