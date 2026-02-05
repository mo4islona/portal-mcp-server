import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PORTAL_URL, EVENT_SIGNATURES } from "../../constants/index.js";
import { resolveDataset, validateBlockRange } from "../../cache/datasets.js";
import { detectChainType, isL2Chain } from "../../helpers/chain.js";
import { portalFetchStream } from "../../helpers/fetch.js";
import { formatResult } from "../../helpers/format.js";
import {
  buildEvmTransactionFields,
  buildEvmTraceFields,
  buildEvmLogFields,
} from "../../helpers/fields.js";
import { normalizeEvmAddress } from "../../helpers/validation.js";

// ============================================================================
// Known Event Signatures
// ============================================================================

const KNOWN_EVENTS: Record<string, { name: string; inputs: string[] }> = {
  // ERC20
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef": {
    name: "Transfer",
    inputs: ["from", "to", "value"],
  },
  "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925": {
    name: "Approval",
    inputs: ["owner", "spender", "value"],
  },
  // ERC721
  "0x17307eab39ab6107e8899845ad3d59bd9653f200f220920489ca2b5937696c31": {
    name: "ApprovalForAll",
    inputs: ["owner", "operator", "approved"],
  },
  // ERC1155
  "0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62": {
    name: "TransferSingle",
    inputs: ["operator", "from", "to", "id", "value"],
  },
  "0x4a39dc06d4c0dbc64b70af90fd698a233a518aa5d07e595d983b8c0526c8f7fb": {
    name: "TransferBatch",
    inputs: ["operator", "from", "to", "ids", "values"],
  },
  // Uniswap V2
  "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822": {
    name: "Swap",
    inputs: [
      "sender",
      "amount0In",
      "amount1In",
      "amount0Out",
      "amount1Out",
      "to",
    ],
  },
  "0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1": {
    name: "Sync",
    inputs: ["reserve0", "reserve1"],
  },
  // Uniswap V3
  "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67": {
    name: "Swap",
    inputs: [
      "sender",
      "recipient",
      "amount0",
      "amount1",
      "sqrtPriceX96",
      "liquidity",
      "tick",
    ],
  },
  // WETH
  "0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c": {
    name: "Deposit",
    inputs: ["dst", "wad"],
  },
  "0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65": {
    name: "Withdrawal",
    inputs: ["src", "wad"],
  },
};

function decodeLog(log: {
  address: string;
  topics: string[];
  data: string;
  transactionHash?: string;
  logIndex?: number;
}): {
  address: string;
  event_name: string | null;
  decoded: Record<string, string> | null;
  raw: { topics: string[]; data: string };
  transaction_hash?: string;
  log_index?: number;
} {
  const topic0 = log.topics[0];
  const eventInfo = KNOWN_EVENTS[topic0];

  if (!eventInfo) {
    return {
      address: log.address,
      event_name: null,
      decoded: null,
      raw: { topics: log.topics, data: log.data },
      transaction_hash: log.transactionHash,
      log_index: log.logIndex,
    };
  }

  const decoded: Record<string, string> = {};

  // Decode indexed parameters from topics
  const indexedCount = Math.min(log.topics.length - 1, 3);
  for (let i = 0; i < indexedCount && i < eventInfo.inputs.length; i++) {
    const topic = log.topics[i + 1];
    const inputName = eventInfo.inputs[i];
    // For addresses, extract last 40 chars
    if (
      inputName === "from" ||
      inputName === "to" ||
      inputName === "owner" ||
      inputName === "spender" ||
      inputName === "operator" ||
      inputName === "sender" ||
      inputName === "recipient" ||
      inputName === "dst" ||
      inputName === "src"
    ) {
      decoded[inputName] = "0x" + topic.slice(-40);
    } else {
      decoded[inputName] = topic;
    }
  }

  // Decode non-indexed parameters from data
  if (log.data && log.data !== "0x") {
    const dataWithoutPrefix = log.data.slice(2);
    const chunks = dataWithoutPrefix.match(/.{64}/g) || [];
    let dataIndex = 0;
    for (
      let i = indexedCount;
      i < eventInfo.inputs.length && dataIndex < chunks.length;
      i++
    ) {
      decoded[eventInfo.inputs[i]] = "0x" + chunks[dataIndex];
      dataIndex++;
    }
  }

  return {
    address: log.address,
    event_name: eventInfo.name,
    decoded,
    raw: { topics: log.topics, data: log.data },
    transaction_hash: log.transactionHash,
    log_index: log.logIndex,
  };
}

// ============================================================================
// Tool: Get Address Activity
// ============================================================================

export function registerGetAddressActivityTool(server: McpServer) {
  server.tool(
    "portal_get_address_activity",
    "Get all activity for an address (transactions sent/received, token transfers, contract interactions)",
    {
      dataset: z.string().describe("Dataset name or alias"),
      address: z.string().describe("Address to query"),
      from_block: z.number().describe("Starting block number"),
      to_block: z.number().optional().describe("Ending block number"),
      include_internal: z
        .boolean()
        .optional()
        .default(false)
        .describe("Include internal transactions (traces)"),
      include_token_transfers: z
        .boolean()
        .optional()
        .default(true)
        .describe("Include ERC20/721/1155 transfers"),
      limit: z
        .number()
        .optional()
        .default(100)
        .describe("Max items per category"),
      finalized_only: z
        .boolean()
        .optional()
        .default(false)
        .describe("Only query finalized blocks"),
    },
    async ({
      dataset,
      address,
      from_block,
      to_block,
      include_internal,
      include_token_transfers,
      limit,
      finalized_only,
    }) => {
      const queryStartTime = Date.now();
      dataset = await resolveDataset(dataset);
      const chainType = detectChainType(dataset);

      if (chainType !== "evm") {
        throw new Error("portal_get_address_activity is only for EVM chains");
      }

      const normalizedAddress = normalizeEvmAddress(address);
      const { validatedToBlock: endBlock } = await validateBlockRange(
        dataset,
        from_block,
        to_block ?? Number.MAX_SAFE_INTEGER,
        finalized_only,
      );

      const includeL2 = isL2Chain(dataset);
      const paddedAddress = "0x" + normalizedAddress.slice(2).padStart(64, "0");

      // Query transactions
      const txQuery = {
        type: "evm",
        fromBlock: from_block,
        toBlock: endBlock,
        fields: {
          block: { number: true, timestamp: true },
          transaction: buildEvmTransactionFields(includeL2),
        },
        transactions: [
          { from: [normalizedAddress] },
          { to: [normalizedAddress] },
        ],
      };

      const txResults = await portalFetchStream(
        `${PORTAL_URL}/datasets/${dataset}/stream`,
        txQuery,
      );

      const transactions = txResults
        .flatMap((block: unknown) => {
          const b = block as {
            header?: { number: number; timestamp: number };
            transactions?: unknown[];
          };
          return (b.transactions || []).map((tx) => ({
            block_number: b.header?.number,
            timestamp: b.header?.timestamp,
            ...(tx as object),
          }));
        })
        .slice(0, limit);

      let internalTxs: unknown[] = [];
      if (include_internal) {
        const traceQuery = {
          type: "evm",
          fromBlock: from_block,
          toBlock: endBlock,
          fields: {
            block: { number: true, timestamp: true },
            trace: buildEvmTraceFields(),
          },
          traces: [
            { callFrom: [normalizedAddress] },
            { callTo: [normalizedAddress] },
          ],
        };

        const traceResults = await portalFetchStream(
          `${PORTAL_URL}/datasets/${dataset}/stream`,
          traceQuery,
        );

        internalTxs = traceResults
          .flatMap((block: unknown) => {
            const b = block as {
              header?: { number: number; timestamp: number };
              traces?: unknown[];
            };
            return (b.traces || []).map((trace) => ({
              block_number: b.header?.number,
              timestamp: b.header?.timestamp,
              ...(trace as object),
            }));
          })
          .slice(0, limit);
      }

      let tokenTransfers: unknown[] = [];
      if (include_token_transfers) {
        const logQuery = {
          type: "evm",
          fromBlock: from_block,
          toBlock: endBlock,
          fields: {
            block: { number: true, timestamp: true },
            log: buildEvmLogFields(),
          },
          logs: [
            {
              topic0: [
                EVENT_SIGNATURES.TRANSFER_ERC20,
                EVENT_SIGNATURES.TRANSFER_SINGLE,
                EVENT_SIGNATURES.TRANSFER_BATCH,
              ],
              topic1: [paddedAddress],
            },
            {
              topic0: [
                EVENT_SIGNATURES.TRANSFER_ERC20,
                EVENT_SIGNATURES.TRANSFER_SINGLE,
                EVENT_SIGNATURES.TRANSFER_BATCH,
              ],
              topic2: [paddedAddress],
            },
          ],
        };

        const logResults = await portalFetchStream(
          `${PORTAL_URL}/datasets/${dataset}/stream`,
          logQuery,
        );

        tokenTransfers = logResults
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
              const decoded = decodeLog(log);
              return {
                block_number: b.header?.number,
                timestamp: b.header?.timestamp,
                token_address: log.address,
                event_name: decoded.event_name,
                ...decoded.decoded,
                transaction_hash: log.transactionHash,
              };
            });
          })
          .slice(0, limit);
      }

      return formatResult(
        {
          address: normalizedAddress,
          from_block,
          to_block: endBlock,
          transactions: {
            count: transactions.length,
            items: transactions,
          },
          internal_transactions: include_internal
            ? { count: internalTxs.length, items: internalTxs }
            : null,
          token_transfers: include_token_transfers
            ? { count: tokenTransfers.length, items: tokenTransfers }
            : null,
        },
        `Address activity: ${transactions.length} txs, ${internalTxs.length} internal, ${tokenTransfers.length} token transfers`,
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
