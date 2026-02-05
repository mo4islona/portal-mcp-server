import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PORTAL_URL, EVENT_SIGNATURES } from "../../constants/index.js";
import { validateDataset, validateBlockRange } from "../../cache/datasets.js";
import { detectChainType } from "../../helpers/chain.js";
import { portalFetchStream } from "../../helpers/fetch.js";
import { formatResult } from "../../helpers/format.js";
import { buildEvmLogFields } from "../../helpers/fields.js";
import { normalizeAddresses } from "../../helpers/validation.js";

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
// Tool: Decode Logs
// ============================================================================

export function registerDecodeLogsTool(server: McpServer) {
  server.tool(
    "portal_decode_logs",
    "Decode event logs using known event signatures (Transfer, Approval, Swap, etc.)",
    {
      dataset: z.string().describe("Dataset name or alias"),
      from_block: z.number().describe("Starting block number"),
      to_block: z.number().optional().describe("Ending block number"),
      addresses: z
        .array(z.string())
        .optional()
        .describe("Contract addresses to filter"),
      event_types: z
        .array(
          z.enum([
            "Transfer",
            "Approval",
            "ApprovalForAll",
            "Swap",
            "Sync",
            "Deposit",
            "Withdrawal",
            "all",
          ]),
        )
        .optional()
        .default(["all"])
        .describe("Event types to decode"),
      limit: z.number().optional().default(100).describe("Max logs to return"),
      finalized_only: z
        .boolean()
        .optional()
        .default(false)
        .describe("Only query finalized blocks"),
    },
    async ({
      dataset,
      from_block,
      to_block,
      addresses,
      event_types,
      limit,
      finalized_only,
    }) => {
      const queryStartTime = Date.now();
      await validateDataset(dataset);
      const chainType = detectChainType(dataset);

      if (chainType !== "evm") {
        throw new Error("portal_decode_logs is only for EVM chains");
      }

      const { validatedToBlock: endBlock } = await validateBlockRange(
        dataset,
        from_block,
        to_block ?? Number.MAX_SAFE_INTEGER,
        finalized_only,
      );

      // Build topic0 filter based on event types
      let topic0Filter: string[] | undefined;
      if (!event_types?.includes("all")) {
        topic0Filter = [];
        const eventToSig: Record<string, string> = {
          Transfer: EVENT_SIGNATURES.TRANSFER_ERC20,
          Approval: EVENT_SIGNATURES.APPROVAL_ERC20,
          ApprovalForAll: EVENT_SIGNATURES.APPROVAL_FOR_ALL,
          Swap: EVENT_SIGNATURES.UNISWAP_V2_SWAP,
          Sync: EVENT_SIGNATURES.SYNC,
          Deposit:
            "0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c",
          Withdrawal:
            "0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65",
        };
        for (const et of event_types || []) {
          if (eventToSig[et]) {
            topic0Filter.push(eventToSig[et]);
          }
        }
        // Also add Uniswap V3 Swap if Swap is requested
        if (event_types?.includes("Swap")) {
          topic0Filter.push(EVENT_SIGNATURES.UNISWAP_V3_SWAP);
        }
      }

      const logFilter: Record<string, unknown> = {};
      if (addresses) {
        logFilter.address = normalizeAddresses(addresses, "evm");
      }
      if (topic0Filter && topic0Filter.length > 0) {
        logFilter.topic0 = topic0Filter;
      }

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

      const decodedLogs = results
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
          return (b.logs || []).map((log) => ({
            block_number: b.header?.number,
            timestamp: b.header?.timestamp,
            ...decodeLog(log),
          }));
        })
        .slice(0, limit);

      const knownCount = decodedLogs.filter((l) => l.event_name !== null).length;
      const unknownCount = decodedLogs.length - knownCount;

      return formatResult(
        decodedLogs,
        `Decoded ${decodedLogs.length} logs (${knownCount} known events, ${unknownCount} unknown)`,
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
