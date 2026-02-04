#!/usr/bin/env node

import {
	McpServer,
	ResourceTemplate,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// ============================================================================
// SQD Portal MCP Server v0.5.0
// Full-featured wrapper around Portal API: https://portal.sqd.dev
// ============================================================================

const VERSION = "0.5.0";

// Environment configuration
const PORTAL_URL = process.env.PORTAL_URL || "https://portal.sqd.dev";
const DEFAULT_TIMEOUT = 30000;
const DEFAULT_RETRIES = 3;

// Result limits to prevent memory issues
const MAX_RESULTS = 500;
const MAX_RESPONSE_SIZE = 1000; // Max NDJSON lines to process

const server = new McpServer({
	name: "sqd-portal-mcp-server",
	version: VERSION,
});

// ============================================================================
// Types
// ============================================================================

interface Dataset {
	dataset: string;
	aliases: string[];
	real_time: boolean;
}

interface DatasetMetadata extends Dataset {
	start_block: number;
}

interface BlockHead {
	number: number;
	hash: string;
}

type ChainType = "evm" | "solana";

// Common ERC20/721/1155 event signatures
const EVENT_SIGNATURES = {
	// ERC20
	TRANSFER_ERC20:
		"0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
	APPROVAL_ERC20:
		"0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925",
	// ERC721
	TRANSFER_ERC721:
		"0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
	APPROVAL_ERC721:
		"0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925",
	APPROVAL_FOR_ALL:
		"0x17307eab39ab6107e8899845ad3d59bd9653f200f220920489ca2b5937696c31",
	// ERC1155
	TRANSFER_SINGLE:
		"0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62",
	TRANSFER_BATCH:
		"0x4a39dc06d4c0dbc64b70af90fd698a233a518aa5d07e595d983b8c0526c8f7fb",
	// DEX
	UNISWAP_V2_SWAP:
		"0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822",
	UNISWAP_V3_SWAP:
		"0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67",
	SYNC: "0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1",
};

// ============================================================================
// Helper Functions
// ============================================================================

async function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function portalFetch<T>(
	url: string,
	options: {
		method?: string;
		body?: unknown;
		timeout?: number;
		retries?: number;
	} = {},
): Promise<T> {
	const {
		method = "GET",
		body,
		timeout = DEFAULT_TIMEOUT,
		retries = DEFAULT_RETRIES,
	} = options;

	let lastError: Error | null = null;

	for (let attempt = 0; attempt <= retries; attempt++) {
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), timeout);

		try {
			const fetchOptions: RequestInit = {
				method,
				headers: {
					"Accept-Encoding": "gzip",
					"Content-Type": "application/json",
					Accept: "application/json",
				},
				signal: controller.signal,
			};

			if (body) {
				fetchOptions.body = JSON.stringify(body);
			}

			const response = await fetch(url, fetchOptions);
			clearTimeout(timeoutId);

			// Handle specific status codes
			if (response.status === 204) {
				return [] as T;
			}

			if (response.status === 409) {
				// Reorg detected - retry with backoff
				lastError = new Error(
					"Chain reorganization detected (409 Conflict). The requested block range may have been affected by a reorg. Try with a different fromBlock or use finalized blocks.",
				);
				const delay = Math.pow(2, attempt) * 1000;
				await sleep(delay);
				continue;
			}

			if (response.status === 429) {
				// Rate limited - check Retry-After header
				const retryAfter = response.headers.get("Retry-After");
				const delay = retryAfter
					? parseInt(retryAfter, 10) * 1000
					: Math.pow(2, attempt) * 1000;
				lastError = new Error(
					`Rate limited (429). ${retryAfter ? `Retry after ${retryAfter}s.` : `Retrying in ${delay}ms.`}`,
				);
				await sleep(delay);
				continue;
			}

			if (!response.ok) {
				const errorText = await response.text();
				throw new Error(`HTTP ${response.status}: ${errorText}`);
			}

			return (await response.json()) as T;
		} catch (error) {
			clearTimeout(timeoutId);
			lastError = error as Error;

			// Don't retry on client errors (except 409/429 handled above)
			if (lastError.message.includes("HTTP 4")) {
				throw lastError;
			}

			if (attempt < retries) {
				const delay = Math.pow(2, attempt) * 1000;
				await sleep(delay);
			}
		}
	}

	throw lastError || new Error("Request failed after retries");
}

async function portalFetchStream(
	url: string,
	body: unknown,
	timeout: number = 60000,
): Promise<unknown[]> {
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), timeout);

	try {
		const response = await fetch(url, {
			method: "POST",
			headers: {
				"Accept-Encoding": "gzip",
				"Content-Type": "application/json",
				Accept: "application/x-ndjson",
			},
			body: JSON.stringify(body),
			signal: controller.signal,
		});

		clearTimeout(timeoutId);

		if (response.status === 204) {
			return [];
		}

		if (response.status === 409) {
			throw new Error(
				"Chain reorganization detected (409 Conflict). The requested block range may have been affected by a reorg. Try with a different fromBlock or use finalized blocks.",
			);
		}

		if (response.status === 429) {
			const retryAfter = response.headers.get("Retry-After");
			throw new Error(
				`Rate limited (429). ${retryAfter ? `Retry after ${retryAfter}s.` : "Please wait before retrying."}`,
			);
		}

		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(`HTTP ${response.status}: ${errorText}`);
		}

		const text = await response.text();
		const lines = text.split("\n").filter((line) => line.trim());
		// Limit results to prevent memory issues
		const limitedLines = lines.slice(0, MAX_RESPONSE_SIZE);
		if (lines.length > MAX_RESPONSE_SIZE) {
			console.error(`Warning: Response truncated from ${lines.length} to ${MAX_RESPONSE_SIZE} items`);
		}
		return limitedLines.map((line) => JSON.parse(line));
	} catch (error) {
		clearTimeout(timeoutId);
		throw error;
	}
}

// ============================================================================
// Dataset Cache
// ============================================================================

const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
let datasetsCache: { data: Dataset[]; timestamp: number } | null = null;

async function getDatasets(): Promise<Dataset[]> {
	if (datasetsCache && Date.now() - datasetsCache.timestamp < CACHE_TTL) {
		return datasetsCache.data;
	}
	const data = await portalFetch<Dataset[]>(`${PORTAL_URL}/datasets`);
	datasetsCache = { data, timestamp: Date.now() };
	return data;
}

async function validateDataset(dataset: string): Promise<void> {
	const datasets = await getDatasets();
	const found = datasets.some(
		(d) => d.dataset === dataset || d.aliases.includes(dataset),
	);
	if (!found) {
		const suggestions = datasets
			.filter(
				(d) =>
					d.dataset.toLowerCase().includes(dataset.toLowerCase()) ||
					dataset.toLowerCase().includes(d.dataset.split("-")[0].toLowerCase()),
			)
			.slice(0, 5)
			.map((d) => d.dataset);

		let errorMsg = `Unknown dataset: "${dataset}".`;
		if (suggestions.length > 0) {
			errorMsg += ` Did you mean: ${suggestions.join(", ")}?`;
		}
		errorMsg += " Use portal_list_datasets to see available datasets.";
		throw new Error(errorMsg);
	}
}

async function getDatasetMetadata(dataset: string): Promise<{
	start_block: number;
	head: BlockHead;
	finalized_head?: BlockHead;
}> {
	const [metadata, head, finalizedHead] = await Promise.all([
		portalFetch<DatasetMetadata>(`${PORTAL_URL}/datasets/${dataset}/metadata`),
		portalFetch<BlockHead>(`${PORTAL_URL}/datasets/${dataset}/head`),
		portalFetch<BlockHead>(
			`${PORTAL_URL}/datasets/${dataset}/finalized-head`,
		).catch(() => undefined),
	]);
	return {
		start_block: metadata.start_block,
		head,
		finalized_head: finalizedHead,
	};
}

async function validateBlockRange(
	dataset: string,
	fromBlock: number,
	toBlock: number,
	finalizedOnly: boolean = false,
): Promise<{ validatedToBlock: number; head: BlockHead }> {
	const meta = await getDatasetMetadata(dataset);

	if (fromBlock < meta.start_block) {
		throw new Error(
			`fromBlock (${fromBlock}) is before dataset start block (${meta.start_block})`,
		);
	}

	const maxBlock =
		finalizedOnly && meta.finalized_head
			? meta.finalized_head.number
			: meta.head.number;

	if (fromBlock > maxBlock) {
		throw new Error(
			`fromBlock (${fromBlock}) is beyond ${finalizedOnly ? "finalized" : "latest"} block (${maxBlock})`,
		);
	}

	const validatedToBlock = Math.min(toBlock, maxBlock);

	return {
		validatedToBlock,
		head:
			finalizedOnly && meta.finalized_head ? meta.finalized_head : meta.head,
	};
}

// ============================================================================
// Chain Type Detection (EVM or Solana only)
// ============================================================================

function detectChainType(dataset: string): ChainType {
	const lower = dataset.toLowerCase();

	// Solana datasets
	if (
		lower.includes("solana") ||
		lower.startsWith("solana-") ||
		lower === "solana" ||
		lower.includes("eclipse")
	) {
		return "solana";
	}

	// Default to EVM for all other chains
	return "evm";
}

function isL2Chain(dataset: string): boolean {
	const lower = dataset.toLowerCase();
	const l2Patterns = [
		"arbitrum",
		"optimism",
		"base",
		"zksync",
		"linea",
		"scroll",
		"blast",
		"mantle",
		"mode",
		"zora",
		"polygon-zkevm",
		"starknet",
		"taiko",
		"manta",
		"metis",
	];
	return l2Patterns.some((pattern) => lower.includes(pattern));
}

// ============================================================================
// Address Validation
// ============================================================================

function isValidEvmAddress(address: string): boolean {
	return /^0x[a-fA-F0-9]{40}$/.test(address);
}

function isValidSolanaAddress(address: string): boolean {
	return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address);
}

function normalizeEvmAddress(address: string): string {
	if (!address.startsWith("0x")) {
		address = "0x" + address;
	}
	return address.toLowerCase();
}

function normalizeAddresses(
	addresses: string[] | undefined,
	chainType: ChainType,
): string[] | undefined {
	if (!addresses || addresses.length === 0) return undefined;

	return addresses.map((addr) => {
		if (chainType === "evm") {
			if (!isValidEvmAddress(addr)) {
				throw new Error(`Invalid EVM address: ${addr}`);
			}
			return normalizeEvmAddress(addr);
		} else if (chainType === "solana") {
			if (!isValidSolanaAddress(addr)) {
				throw new Error(`Invalid Solana address: ${addr}`);
			}
			return addr;
		}
		return addr;
	});
}

// ============================================================================
// EVM Field Builders
// ============================================================================

function buildEvmBlockFields(includeL2: boolean = false) {
	const fields: Record<string, boolean> = {
		number: true,
		hash: true,
		parentHash: true,
		timestamp: true,
		transactionsRoot: true,
		receiptsRoot: true,
		stateRoot: true,
		logsBloom: true,
		sha3Uncles: true,
		extraData: true,
		miner: true,
		nonce: true,
		mixHash: true,
		size: true,
		gasLimit: true,
		gasUsed: true,
		difficulty: true,
		totalDifficulty: true,
		baseFeePerGas: true,
	};

	if (includeL2) {
		fields.l1BlockNumber = true;
	}

	return fields;
}

function buildEvmTransactionFields(
	includeL2: boolean = false,
	includeReceipt: boolean = false,
) {
	const fields: Record<string, boolean> = {
		transactionIndex: true,
		hash: true,
		from: true,
		to: true,
		value: true,
		input: true,
		nonce: true,
		gas: true,
		gasPrice: true,
		maxFeePerGas: true,
		maxPriorityFeePerGas: true,
		gasUsed: true,
		cumulativeGasUsed: true,
		effectiveGasPrice: true,
		type: true,
		status: true,
		sighash: true,
		contractAddress: true,
		yParity: true,
		chainId: true,
		v: true,
		r: true,
		s: true,
	};

	if (includeL2) {
		fields.l1Fee = true;
		fields.l1FeeScalar = true;
		fields.l1GasPrice = true;
		fields.l1GasUsed = true;
		fields.l1BlobBaseFee = true;
		fields.l1BlobBaseFeeScalar = true;
		fields.l1BaseFeeScalar = true;
	}

	if (includeReceipt) {
		fields.logsBloom = true;
	}

	return fields;
}

function buildEvmLogFields() {
	return {
		logIndex: true,
		transactionIndex: true,
		transactionHash: true,
		address: true,
		data: true,
		topics: true,
	};
}

function buildEvmTraceFields() {
	return {
		traceAddress: true,
		subtraces: true,
		transactionIndex: true,
		transactionHash: true,
		type: true,
		error: true,
		revertReason: true,
		// Call fields
		callFrom: true,
		callTo: true,
		callValue: true,
		callGas: true,
		callSighash: true,
		callInput: true,
		callType: true,
		callResultGasUsed: true,
		callResultOutput: true,
		// Create fields
		createFrom: true,
		createValue: true,
		createGas: true,
		createInit: true,
		createResultGasUsed: true,
		createResultCode: true,
		createResultAddress: true,
		// Suicide fields
		suicideAddress: true,
		suicideBalance: true,
		suicideRefundAddress: true,
		// Reward fields
		rewardAuthor: true,
		rewardValue: true,
		rewardType: true,
	};
}

function buildEvmStateDiffFields() {
	return {
		transactionIndex: true,
		transactionHash: true,
		address: true,
		key: true,
		kind: true,
		prev: true,
		next: true,
	};
}

// ============================================================================
// Solana Field Builders
// ============================================================================

function buildSolanaInstructionFields(includeDiscriminators: boolean = false) {
	const fields: Record<string, boolean> = {
		transactionIndex: true,
		instructionAddress: true,
		programId: true,
		accounts: true,
		data: true,
		isCommitted: true,
		hasDroppedLogMessages: true,
	};

	if (includeDiscriminators) {
		fields.d1 = true;
		fields.d2 = true;
		fields.d4 = true;
		fields.d8 = true;
	}

	return fields;
}

function buildSolanaTransactionFields() {
	return {
		transactionIndex: true,
		signature: true,
		version: true,
		fee: true,
		err: true,
		computeUnitsConsumed: true,
		isCommitted: true,
		hasDroppedLogMessages: true,
		signatures: true,
		accountKeys: true,
		recentBlockhash: true,
		addressTableLookups: true,
		loadedAddresses: true,
	};
}

function buildSolanaBalanceFields() {
	return {
		transactionIndex: true,
		account: true,
		pre: true,
		post: true,
	};
}

function buildSolanaTokenBalanceFields() {
	return {
		transactionIndex: true,
		account: true,
		preMint: true,
		postMint: true,
		preDecimals: true,
		postDecimals: true,
		preProgramId: true,
		postProgramId: true,
		preOwner: true,
		postOwner: true,
		preAmount: true,
		postAmount: true,
	};
}

function buildSolanaLogFields() {
	return {
		transactionIndex: true,
		logIndex: true,
		instructionAddress: true,
		programId: true,
		kind: true,
		message: true,
	};
}

function buildSolanaRewardFields() {
	return {
		pubkey: true,
		lamports: true,
		postBalance: true,
		rewardType: true,
		commission: true,
	};
}

// ============================================================================
// Result Formatting
// ============================================================================

function formatResult(
	data: unknown,
	message?: string,
): { content: Array<{ type: "text"; text: string }> } {
	const text = message
		? `${message}\n\n${JSON.stringify(data, null, 2)}`
		: JSON.stringify(data, null, 2);
	return { content: [{ type: "text", text }] };
}

// ============================================================================
// MCP Resources
// ============================================================================

// Resource: List all datasets
server.resource("datasets", "sqd://datasets", async (uri) => {
	const datasets = await getDatasets();
	return {
		contents: [
			{
				uri: uri.href,
				mimeType: "application/json",
				text: JSON.stringify(datasets, null, 2),
			},
		],
	};
});

// Resource: Dataset info template
server.resource(
	"dataset-info",
	new ResourceTemplate("sqd://datasets/{name}", { list: undefined }),
	async (uri, { name }) => {
		const datasetName = Array.isArray(name) ? name[0] : name;
		await validateDataset(datasetName);
		const metadata = await portalFetch<DatasetMetadata>(
			`${PORTAL_URL}/datasets/${datasetName}/metadata`,
		);
		const head = await portalFetch<BlockHead>(
			`${PORTAL_URL}/datasets/${datasetName}/head`,
		);
		return {
			contents: [
				{
					uri: uri.href,
					mimeType: "application/json",
					text: JSON.stringify({ ...metadata, head }, null, 2),
				},
			],
		};
	},
);

// Resource: EVM API Schema
server.resource("schema-evm", "sqd://schema/evm", async (uri) => {
	const schema = {
		description: "SQD Portal EVM API Documentation",
		version: VERSION,
		endpoints: {
			blocks: {
				description: "Query block data",
				fields: Object.keys(buildEvmBlockFields(true)),
				filters: ["number", "hash"],
			},
			transactions: {
				description: "Query transaction data",
				fields: Object.keys(buildEvmTransactionFields(true)),
				filters: ["from", "to", "sighash", "firstNonce", "lastNonce"],
				relatedData: ["logs", "traces", "stateDiffs"],
			},
			logs: {
				description: "Query event logs",
				fields: Object.keys(buildEvmLogFields()),
				filters: ["address", "topic0", "topic1", "topic2", "topic3"],
				relatedData: ["transaction", "transactionTraces", "transactionLogs"],
			},
			traces: {
				description: "Query internal transactions/traces",
				fields: Object.keys(buildEvmTraceFields()),
				filters: [
					"type",
					"callFrom",
					"callTo",
					"callSighash",
					"suicideRefundAddress",
					"rewardAuthor",
					"createResultAddress",
				],
				relatedData: ["transaction", "transactionLogs", "subtraces", "parents"],
			},
			stateDiffs: {
				description: "Query state changes",
				fields: Object.keys(buildEvmStateDiffFields()),
				filters: ["address", "key", "kind"],
				kindValues: {
					"=": "exists (no change)",
					"+": "created",
					"*": "modified",
					"-": "deleted",
				},
			},
		},
		l2Fields: [
			"l1Fee",
			"l1FeeScalar",
			"l1GasPrice",
			"l1GasUsed",
			"l1BlobBaseFee",
			"l1BlobBaseFeeScalar",
			"l1BaseFeeScalar",
			"l1BlockNumber",
		],
		eventSignatures: EVENT_SIGNATURES,
	};
	return {
		contents: [
			{
				uri: uri.href,
				mimeType: "application/json",
				text: JSON.stringify(schema, null, 2),
			},
		],
	};
});

// Resource: Solana API Schema
server.resource("schema-solana", "sqd://schema/solana", async (uri) => {
	const schema = {
		description: "SQD Portal Solana API Documentation",
		version: VERSION,
		endpoints: {
			instructions: {
				description: "Query instruction data",
				fields: Object.keys(buildSolanaInstructionFields(true)),
				filters: [
					"programId",
					"d1",
					"d2",
					"d4",
					"d8",
					"a0-a15 (account positions)",
					"mentionsAccount",
					"isCommitted",
					"transactionFeePayer",
				],
				discriminatorInfo: {
					d1: "1-byte discriminator (0x-prefixed hex)",
					d2: "2-byte discriminator (0x-prefixed hex)",
					d4: "4-byte discriminator (0x-prefixed hex)",
					d8: "8-byte discriminator - Anchor standard (0x-prefixed hex)",
				},
				relatedData: [
					"transaction",
					"transactionBalances",
					"transactionTokenBalances",
					"transactionInstructions",
					"innerInstructions",
					"logs",
				],
			},
			transactions: {
				description: "Query transaction data",
				fields: Object.keys(buildSolanaTransactionFields()),
				filters: ["feePayer", "isCommitted"],
			},
			balances: {
				description: "Query SOL balance changes",
				fields: Object.keys(buildSolanaBalanceFields()),
				filters: ["account"],
			},
			tokenBalances: {
				description: "Query SPL token balance changes",
				fields: Object.keys(buildSolanaTokenBalanceFields()),
				filters: ["account", "mint", "owner", "preProgramId", "postProgramId"],
			},
			logs: {
				description: "Query log messages",
				fields: Object.keys(buildSolanaLogFields()),
				filters: ["programId", "kind"],
				kindValues: ["log", "data", "other"],
			},
			rewards: {
				description: "Query block rewards",
				fields: Object.keys(buildSolanaRewardFields()),
				filters: ["pubkey"],
			},
		},
	};
	return {
		contents: [
			{
				uri: uri.href,
				mimeType: "application/json",
				text: JSON.stringify(schema, null, 2),
			},
		],
	};
});

// ============================================================================
// Tool: List Datasets
// ============================================================================

server.tool(
	"portal_list_datasets",
	"List all available datasets, optionally filtered by chain type or name pattern",
	{
		chain_type: z
			.enum(["evm", "solana"])
			.optional()
			.describe("Filter by chain type"),
		pattern: z.string().optional().describe("Filter by name pattern (regex)"),
		real_time_only: z
			.boolean()
			.optional()
			.describe("Only show real-time datasets"),
	},
	async ({ chain_type, pattern, real_time_only }) => {
		let datasets = await getDatasets();

		if (chain_type) {
			datasets = datasets.filter(
				(d) => detectChainType(d.dataset) === chain_type,
			);
		}

		if (pattern) {
			const regex = new RegExp(pattern, "i");
			datasets = datasets.filter(
				(d) => regex.test(d.dataset) || d.aliases.some((a) => regex.test(a)),
			);
		}

		if (real_time_only) {
			datasets = datasets.filter((d) => d.real_time);
		}

		return formatResult(datasets, `Found ${datasets.length} datasets`);
	},
);

// ============================================================================
// Tool: Search Datasets
// ============================================================================

server.tool(
	"portal_search_datasets",
	"Search datasets by query string",
	{
		query: z.string().describe("Search query"),
	},
	async ({ query }) => {
		const datasets = await getDatasets();
		const lower = query.toLowerCase();

		const results = datasets.filter(
			(d) =>
				d.dataset.toLowerCase().includes(lower) ||
				d.aliases.some((a) => a.toLowerCase().includes(lower)),
		);

		return formatResult(results, `Found ${results.length} matching datasets`);
	},
);

// ============================================================================
// Tool: Get Dataset Info
// ============================================================================

server.tool(
	"portal_get_dataset_info",
	"Get detailed information about a specific dataset",
	{
		dataset: z.string().describe("Dataset name or alias"),
	},
	async ({ dataset }) => {
		await validateDataset(dataset);
		const metadata = await portalFetch<DatasetMetadata>(
			`${PORTAL_URL}/datasets/${dataset}/metadata`,
		);
		const head = await portalFetch<BlockHead>(
			`${PORTAL_URL}/datasets/${dataset}/head`,
		);
		const chainType = detectChainType(dataset);
		const is_l2 = chainType === "evm" && isL2Chain(dataset);

		return formatResult({
			...metadata,
			head,
			chain_type: chainType,
			is_l2,
		});
	},
);

// ============================================================================
// Tool: Get Block Number
// ============================================================================

server.tool(
	"portal_get_block_number",
	"Get the current/latest block number for a dataset",
	{
		dataset: z.string().describe("Dataset name or alias"),
		type: z
			.enum(["latest", "finalized"])
			.optional()
			.default("latest")
			.describe("Block type"),
	},
	async ({ dataset, type }) => {
		await validateDataset(dataset);
		const endpoint =
			type === "finalized"
				? `${PORTAL_URL}/datasets/${dataset}/finalized-head`
				: `${PORTAL_URL}/datasets/${dataset}/head`;
		const head = await portalFetch<BlockHead>(endpoint);
		return formatResult({ ...head, type });
	},
);

// ============================================================================
// Tool: Block at Timestamp
// ============================================================================

server.tool(
	"portal_block_at_timestamp",
	"Find the block number at a specific timestamp (EVM only)",
	{
		dataset: z.string().describe("Dataset name or alias"),
		timestamp: z.number().describe("Unix timestamp in seconds"),
	},
	async ({ dataset, timestamp }) => {
		await validateDataset(dataset);
		const chainType = detectChainType(dataset);

		if (chainType !== "evm") {
			throw new Error("Block at timestamp is only supported for EVM chains");
		}

		// Binary search for block at timestamp
		const head = await portalFetch<BlockHead>(
			`${PORTAL_URL}/datasets/${dataset}/head`,
		);
		let low = 0;
		let high = head.number;
		let result = 0;

		while (low <= high) {
			const mid = Math.floor((low + high) / 2);
			const query = {
				type: "evm",
				fromBlock: mid,
				toBlock: mid + 1,
				fields: { block: { timestamp: true, number: true } },
				includeAllBlocks: true,
			};

			const response = await portalFetchStream(
				`${PORTAL_URL}/datasets/${dataset}/stream`,
				query,
			);

			if (response.length > 0) {
				const block = response[0] as { header: { timestamp: number } };
				if (block.header.timestamp <= timestamp) {
					result = mid;
					low = mid + 1;
				} else {
					high = mid - 1;
				}
			} else {
				high = mid - 1;
			}
		}

		return formatResult({
			block_number: result,
			timestamp,
			dataset,
		});
	},
);

// ============================================================================
// Tool: Query Blocks (EVM)
// ============================================================================

server.tool(
	"portal_query_blocks",
	"Query block data from an EVM dataset",
	{
		dataset: z.string().describe("Dataset name or alias"),
		from_block: z.number().describe("Starting block number"),
		to_block: z.number().optional().describe("Ending block number"),
		finalized_only: z
			.boolean()
			.optional()
			.default(false)
			.describe("Only query finalized blocks"),
		limit: z.number().optional().default(100).describe("Max blocks to return"),
		include_l2_fields: z
			.boolean()
			.optional()
			.default(false)
			.describe("Include L2-specific fields (auto-detected for L2 chains)"),
	},
	async ({
		dataset,
		from_block,
		to_block,
		limit,
		include_l2_fields,
		finalized_only,
	}) => {
		await validateDataset(dataset);
		const chainType = detectChainType(dataset);

		if (chainType !== "evm") {
			throw new Error(
				"portal_query_blocks is only for EVM chains. Use portal_query_solana_instructions for Solana.",
			);
		}

		const { validatedToBlock } = await validateBlockRange(
			dataset,
			from_block,
			to_block ?? Number.MAX_SAFE_INTEGER,
			finalized_only,
		);
		const endBlock = Math.min(from_block + limit!, validatedToBlock);
		const includeL2 = include_l2_fields || isL2Chain(dataset);

		const query = {
			type: "evm",
			fromBlock: from_block,
			toBlock: endBlock,
			fields: {
				block: buildEvmBlockFields(includeL2),
			},
			includeAllBlocks: true,
		};

		const results = await portalFetchStream(
			`${PORTAL_URL}/datasets/${dataset}/stream`,
			query,
		);

		return formatResult(results, `Retrieved ${results.length} blocks`);
	},
);

// ============================================================================
// Tool: Query Logs (EVM)
// ============================================================================

server.tool(
	"portal_query_logs",
	"Query event logs from an EVM dataset with optional related data fetching",
	{
		dataset: z.string().describe("Dataset name or alias"),
		from_block: z.number().describe("Starting block number"),
		to_block: z.number().optional().describe("Ending block number"),
		finalized_only: z
			.boolean()
			.optional()
			.default(false)
			.describe("Only query finalized blocks"),
		addresses: z
			.array(z.string())
			.optional()
			.describe("Contract addresses to filter"),
		topic0: z
			.array(z.string())
			.optional()
			.describe("Event signatures (topic0)"),
		topic1: z.array(z.string()).optional().describe("Topic1 filter"),
		topic2: z.array(z.string()).optional().describe("Topic2 filter"),
		topic3: z.array(z.string()).optional().describe("Topic3 filter"),
		limit: z.number().optional().default(100).describe("Max logs to return"),
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
		await validateDataset(dataset);
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

		const allLogs = results
			.flatMap((block: unknown) => (block as { logs?: unknown[] }).logs || [])
			.slice(0, limit);
		return formatResult(allLogs, `Retrieved ${allLogs.length} logs`);
	},
);

// ============================================================================
// Tool: Query Transactions (EVM)
// ============================================================================

server.tool(
	"portal_query_transactions",
	"Query transactions from an EVM dataset with optional related data",
	{
		dataset: z.string().describe("Dataset name or alias"),
		from_block: z.number().describe("Starting block number"),
		to_block: z.number().optional().describe("Ending block number"),
		finalized_only: z
			.boolean()
			.optional()
			.default(false)
			.describe("Only query finalized blocks"),
		from_addresses: z.array(z.string()).optional().describe("Sender addresses"),
		to_addresses: z
			.array(z.string())
			.optional()
			.describe("Recipient addresses"),
		sighash: z
			.array(z.string())
			.optional()
			.describe("Function sighash filter (4-byte hex)"),
		first_nonce: z.number().optional().describe("Minimum nonce"),
		last_nonce: z.number().optional().describe("Maximum nonce"),
		limit: z.number().optional().default(100).describe("Max transactions"),
		include_logs: z
			.boolean()
			.optional()
			.default(false)
			.describe("Include logs emitted by transactions"),
		include_traces: z
			.boolean()
			.optional()
			.default(false)
			.describe("Include traces for transactions"),
		include_state_diffs: z
			.boolean()
			.optional()
			.default(false)
			.describe("Include state diffs caused by transactions"),
		include_l2_fields: z
			.boolean()
			.optional()
			.default(false)
			.describe("Include L2-specific fields"),
		include_receipt: z
			.boolean()
			.optional()
			.default(false)
			.describe("Include receipt fields (logsBloom)"),
	},
	async ({
		dataset,
		from_block,
		to_block,
		finalized_only,
		from_addresses,
		to_addresses,
		sighash,
		first_nonce,
		last_nonce,
		limit,
		include_logs,
		include_traces,
		include_state_diffs,
		include_l2_fields,
		include_receipt,
	}) => {
		await validateDataset(dataset);
		const chainType = detectChainType(dataset);

		if (chainType !== "evm") {
			throw new Error("portal_query_transactions is only for EVM chains");
		}

		const normalizedFrom = normalizeAddresses(from_addresses, chainType);
		const normalizedTo = normalizeAddresses(to_addresses, chainType);
		const { validatedToBlock: endBlock } = await validateBlockRange(
			dataset,
			from_block,
			to_block ?? Number.MAX_SAFE_INTEGER,
			finalized_only,
		);
		const includeL2 = include_l2_fields || isL2Chain(dataset);

		const txFilter: Record<string, unknown> = {};
		if (normalizedFrom) txFilter.from = normalizedFrom;
		if (normalizedTo) txFilter.to = normalizedTo;
		if (sighash) txFilter.sighash = sighash;
		if (first_nonce !== undefined) txFilter.firstNonce = first_nonce;
		if (last_nonce !== undefined) txFilter.lastNonce = last_nonce;
		if (include_logs) txFilter.logs = true;
		if (include_traces) txFilter.traces = true;
		if (include_state_diffs) txFilter.stateDiffs = true;

		const fields: Record<string, unknown> = {
			block: { number: true, timestamp: true, hash: true },
			transaction: buildEvmTransactionFields(includeL2, include_receipt),
		};
		if (include_logs) {
			fields.log = buildEvmLogFields();
		}
		if (include_traces) {
			fields.trace = buildEvmTraceFields();
		}
		if (include_state_diffs) {
			fields.stateDiff = buildEvmStateDiffFields();
		}

		const query = {
			type: "evm",
			fromBlock: from_block,
			toBlock: endBlock,
			fields,
			transactions: [txFilter],
		};

		const results = await portalFetchStream(
			`${PORTAL_URL}/datasets/${dataset}/stream`,
			query,
		);

		const allTxs = results
			.flatMap(
				(block: unknown) =>
					(block as { transactions?: unknown[] }).transactions || [],
			)
			.slice(0, limit);
		return formatResult(allTxs, `Retrieved ${allTxs.length} transactions`);
	},
);

// ============================================================================
// Tool: Query Traces (EVM)
// ============================================================================

server.tool(
	"portal_query_traces",
	"Query internal transactions/traces from an EVM dataset",
	{
		dataset: z.string().describe("Dataset name or alias"),
		from_block: z.number().describe("Starting block number"),
		to_block: z.number().optional().describe("Ending block number"),
		finalized_only: z
			.boolean()
			.optional()
			.default(false)
			.describe("Only query finalized blocks"),
		type: z
			.array(z.enum(["call", "create", "suicide", "reward"]))
			.optional()
			.describe("Trace types to filter"),
		call_from: z.array(z.string()).optional().describe("Call from addresses"),
		call_to: z.array(z.string()).optional().describe("Call to addresses"),
		call_sighash: z
			.array(z.string())
			.optional()
			.describe("Call sighash filter (4-byte hex)"),
		suicide_refund_address: z
			.array(z.string())
			.optional()
			.describe("Suicide refund addresses"),
		reward_author: z
			.array(z.string())
			.optional()
			.describe("Reward author addresses"),
		limit: z.number().optional().default(100).describe("Max traces"),
	},
	async ({
		dataset,
		from_block,
		to_block,
		finalized_only,
		type,
		call_from,
		call_to,
		call_sighash,
		suicide_refund_address,
		reward_author,
		limit,
	}) => {
		await validateDataset(dataset);
		const chainType = detectChainType(dataset);

		if (chainType !== "evm") {
			throw new Error("portal_query_traces is only for EVM chains");
		}

		const normalizedCallFrom = normalizeAddresses(call_from, chainType);
		const normalizedCallTo = normalizeAddresses(call_to, chainType);
		const normalizedSuicideRefund = normalizeAddresses(
			suicide_refund_address,
			chainType,
		);
		const normalizedRewardAuthor = normalizeAddresses(reward_author, chainType);
		const { validatedToBlock: endBlock } = await validateBlockRange(
			dataset,
			from_block,
			to_block ?? Number.MAX_SAFE_INTEGER,
			finalized_only,
		);

		const traceFilter: Record<string, unknown> = {};
		if (type) traceFilter.type = type;
		if (normalizedCallFrom) traceFilter.callFrom = normalizedCallFrom;
		if (normalizedCallTo) traceFilter.callTo = normalizedCallTo;
		if (call_sighash) traceFilter.callSighash = call_sighash;
		if (normalizedSuicideRefund)
			traceFilter.suicideRefundAddress = normalizedSuicideRefund;
		if (normalizedRewardAuthor)
			traceFilter.rewardAuthor = normalizedRewardAuthor;

		const query = {
			type: "evm",
			fromBlock: from_block,
			toBlock: endBlock,
			fields: {
				block: { number: true, timestamp: true, hash: true },
				trace: buildEvmTraceFields(),
			},
			traces: [traceFilter],
		};

		const results = await portalFetchStream(
			`${PORTAL_URL}/datasets/${dataset}/stream`,
			query,
		);

		const allTraces = results
			.flatMap(
				(block: unknown) => (block as { traces?: unknown[] }).traces || [],
			)
			.slice(0, limit);
		return formatResult(allTraces, `Retrieved ${allTraces.length} traces`);
	},
);

// ============================================================================
// Tool: Query State Diffs (EVM)
// ============================================================================

server.tool(
	"portal_query_state_diffs",
	"Query state changes from an EVM dataset",
	{
		dataset: z.string().describe("Dataset name or alias"),
		from_block: z.number().describe("Starting block number"),
		to_block: z.number().optional().describe("Ending block number"),
		finalized_only: z
			.boolean()
			.optional()
			.default(false)
			.describe("Only query finalized blocks"),
		addresses: z.array(z.string()).optional().describe("Contract addresses"),
		key: z.array(z.string()).optional().describe("Storage keys"),
		kind: z
			.array(z.enum(["=", "+", "*", "-"]))
			.optional()
			.describe(
				"Diff kinds: = (exists/no change), + (created), * (modified), - (deleted)",
			),
		limit: z.number().optional().default(100).describe("Max state diffs"),
	},
	async ({
		dataset,
		from_block,
		to_block,
		finalized_only,
		addresses,
		key,
		kind,
		limit,
	}) => {
		await validateDataset(dataset);
		const chainType = detectChainType(dataset);

		if (chainType !== "evm") {
			throw new Error("portal_query_state_diffs is only for EVM chains");
		}

		const normalizedAddresses = normalizeAddresses(addresses, chainType);
		const { validatedToBlock: endBlock } = await validateBlockRange(
			dataset,
			from_block,
			to_block ?? Number.MAX_SAFE_INTEGER,
			finalized_only,
		);

		const diffFilter: Record<string, unknown> = {};
		if (normalizedAddresses) diffFilter.address = normalizedAddresses;
		if (key) diffFilter.key = key;
		if (kind) diffFilter.kind = kind;

		const query = {
			type: "evm",
			fromBlock: from_block,
			toBlock: endBlock,
			fields: {
				block: { number: true, timestamp: true, hash: true },
				stateDiff: buildEvmStateDiffFields(),
			},
			stateDiffs: [diffFilter],
		};

		const results = await portalFetchStream(
			`${PORTAL_URL}/datasets/${dataset}/stream`,
			query,
		);

		const allDiffs = results
			.flatMap(
				(block: unknown) =>
					(block as { stateDiffs?: unknown[] }).stateDiffs || [],
			)
			.slice(0, limit);
		return formatResult(allDiffs, `Retrieved ${allDiffs.length} state diffs`);
	},
);

// ============================================================================
// Tool: Get ERC20 Transfers
// ============================================================================

server.tool(
	"portal_get_erc20_transfers",
	"Get ERC20 token transfer events",
	{
		dataset: z.string().describe("Dataset name or alias"),
		from_block: z.number().describe("Starting block number"),
		to_block: z.number().optional().describe("Ending block number"),
		token_addresses: z
			.array(z.string())
			.optional()
			.describe("Token contract addresses"),
		from_addresses: z.array(z.string()).optional().describe("Sender addresses"),
		to_addresses: z
			.array(z.string())
			.optional()
			.describe("Recipient addresses"),
		limit: z.number().optional().default(100).describe("Max transfers"),
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
				return (b.logs || []).map((log) => ({
					blockNumber: b.header?.number,
					transactionHash: log.transactionHash,
					logIndex: log.logIndex,
					tokenAddress: log.address,
					from: "0x" + (log.topics?.[1]?.slice(-40) || ""),
					to: "0x" + (log.topics?.[2]?.slice(-40) || ""),
					value: log.data,
				}));
			})
			.slice(0, limit);

		return formatResult(
			transfers,
			`Retrieved ${transfers.length} ERC20 transfers`,
		);
	},
);

// ============================================================================
// Tool: Get NFT Transfers
// ============================================================================

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
		limit: z.number().optional().default(100).describe("Max transfers"),
	},
	async ({
		dataset,
		from_block,
		to_block,
		contract_addresses,
		token_standard,
		limit,
	}) => {
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
						blockNumber: b.header?.number,
						transactionHash: log.transactionHash,
						logIndex: log.logIndex,
						contractAddress: log.address,
						transferType,
						from,
						to,
						tokenId,
						data: log.data,
					};
				});
			})
			.slice(0, limit);

		return formatResult(
			transfers,
			`Retrieved ${transfers.length} NFT transfers`,
		);
	},
);

// ============================================================================
// Tool: Query Solana Instructions
// ============================================================================

server.tool(
	"portal_query_solana_instructions",
	"Query instruction data from a Solana dataset with advanced filters",
	{
		dataset: z.string().describe("Dataset name or alias"),
		from_block: z.number().describe("Starting slot number"),
		to_block: z.number().optional().describe("Ending slot number"),
		finalized_only: z
			.boolean()
			.optional()
			.default(false)
			.describe("Only query finalized slots"),
		program_id: z.array(z.string()).optional().describe("Program IDs"),
		d1: z
			.array(z.string())
			.optional()
			.describe("1-byte discriminator filter (0x-prefixed hex)"),
		d2: z
			.array(z.string())
			.optional()
			.describe("2-byte discriminator filter (0x-prefixed hex)"),
		d4: z
			.array(z.string())
			.optional()
			.describe("4-byte discriminator filter (0x-prefixed hex)"),
		d8: z
			.array(z.string())
			.optional()
			.describe("8-byte discriminator filter - Anchor (0x-prefixed hex)"),
		a0: z.array(z.string()).optional().describe("Account at index 0"),
		a1: z.array(z.string()).optional().describe("Account at index 1"),
		a2: z.array(z.string()).optional().describe("Account at index 2"),
		a3: z.array(z.string()).optional().describe("Account at index 3"),
		a4: z.array(z.string()).optional().describe("Account at index 4"),
		a5: z.array(z.string()).optional().describe("Account at index 5"),
		a6: z.array(z.string()).optional().describe("Account at index 6"),
		a7: z.array(z.string()).optional().describe("Account at index 7"),
		a8: z.array(z.string()).optional().describe("Account at index 8"),
		a9: z.array(z.string()).optional().describe("Account at index 9"),
		a10: z.array(z.string()).optional().describe("Account at index 10"),
		a11: z.array(z.string()).optional().describe("Account at index 11"),
		a12: z.array(z.string()).optional().describe("Account at index 12"),
		a13: z.array(z.string()).optional().describe("Account at index 13"),
		a14: z.array(z.string()).optional().describe("Account at index 14"),
		a15: z.array(z.string()).optional().describe("Account at index 15"),
		mentions_account: z
			.array(z.string())
			.optional()
			.describe("Accounts mentioned anywhere in the instruction"),
		is_committed: z
			.boolean()
			.optional()
			.describe("Only committed transactions"),
		transaction_fee_payer: z
			.array(z.string())
			.optional()
			.describe("Fee payer filter"),
		limit: z.number().optional().default(100).describe("Max instructions"),
		include_transaction: z
			.boolean()
			.optional()
			.default(false)
			.describe("Include transaction data"),
		include_transaction_balances: z
			.boolean()
			.optional()
			.default(false)
			.describe("Include SOL balance changes"),
		include_transaction_token_balances: z
			.boolean()
			.optional()
			.default(false)
			.describe("Include token balance changes"),
		include_inner_instructions: z
			.boolean()
			.optional()
			.default(false)
			.describe("Include inner (CPI) instructions"),
		include_logs: z
			.boolean()
			.optional()
			.default(false)
			.describe("Include program logs"),
	},
	async ({
		dataset,
		from_block,
		to_block,
		finalized_only,
		program_id,
		d1,
		d2,
		d4,
		d8,
		a0,
		a1,
		a2,
		a3,
		a4,
		a5,
		a6,
		a7,
		a8,
		a9,
		a10,
		a11,
		a12,
		a13,
		a14,
		a15,
		mentions_account,
		is_committed,
		transaction_fee_payer,
		limit,
		include_transaction,
		include_transaction_balances,
		include_transaction_token_balances,
		include_inner_instructions,
		include_logs,
	}) => {
		await validateDataset(dataset);
		const chainType = detectChainType(dataset);

		if (chainType !== "solana") {
			throw new Error(
				"portal_query_solana_instructions is only for Solana chains",
			);
		}

		const { validatedToBlock: endBlock } = await validateBlockRange(
			dataset,
			from_block,
			to_block ?? Number.MAX_SAFE_INTEGER,
			finalized_only,
		);

		const instructionFilter: Record<string, unknown> = {};
		if (program_id) instructionFilter.programId = program_id;
		if (d1) instructionFilter.d1 = d1;
		if (d2) instructionFilter.d2 = d2;
		if (d4) instructionFilter.d4 = d4;
		if (d8) instructionFilter.d8 = d8;
		if (a0) instructionFilter.a0 = a0;
		if (a1) instructionFilter.a1 = a1;
		if (a2) instructionFilter.a2 = a2;
		if (a3) instructionFilter.a3 = a3;
		if (a4) instructionFilter.a4 = a4;
		if (a5) instructionFilter.a5 = a5;
		if (a6) instructionFilter.a6 = a6;
		if (a7) instructionFilter.a7 = a7;
		if (a8) instructionFilter.a8 = a8;
		if (a9) instructionFilter.a9 = a9;
		if (a10) instructionFilter.a10 = a10;
		if (a11) instructionFilter.a11 = a11;
		if (a12) instructionFilter.a12 = a12;
		if (a13) instructionFilter.a13 = a13;
		if (a14) instructionFilter.a14 = a14;
		if (a15) instructionFilter.a15 = a15;
		if (mentions_account) instructionFilter.mentionsAccount = mentions_account;
		if (is_committed !== undefined)
			instructionFilter.isCommitted = is_committed;
		if (transaction_fee_payer)
			instructionFilter.transactionFeePayer = transaction_fee_payer;
		if (include_transaction) instructionFilter.transaction = true;
		if (include_transaction_balances)
			instructionFilter.transactionBalances = true;
		if (include_transaction_token_balances)
			instructionFilter.transactionTokenBalances = true;
		if (include_inner_instructions) instructionFilter.innerInstructions = true;
		if (include_logs) instructionFilter.logs = true;

		const hasDiscriminators = d1 || d2 || d4 || d8;
		const fields: Record<string, unknown> = {
			block: { number: true, hash: true, timestamp: true },
			instruction: buildSolanaInstructionFields(!!hasDiscriminators),
		};
		if (
			include_transaction ||
			include_transaction_balances ||
			include_transaction_token_balances
		) {
			fields.transaction = buildSolanaTransactionFields();
		}
		if (include_transaction_balances) {
			fields.balance = buildSolanaBalanceFields();
		}
		if (include_transaction_token_balances) {
			fields.tokenBalance = buildSolanaTokenBalanceFields();
		}
		if (include_logs) {
			fields.log = buildSolanaLogFields();
		}

		const query = {
			type: "solana",
			fromBlock: from_block,
			toBlock: endBlock,
			fields,
			instructions: [instructionFilter],
		};

		const results = await portalFetchStream(
			`${PORTAL_URL}/datasets/${dataset}/stream`,
			query,
		);

		const allInstructions = results
			.flatMap(
				(block: unknown) =>
					(block as { instructions?: unknown[] }).instructions || [],
			)
			.slice(0, limit);

		return formatResult(
			allInstructions,
			`Retrieved ${allInstructions.length} instructions`,
		);
	},
);

// ============================================================================
// Tool: Query Solana Balances
// ============================================================================

server.tool(
	"portal_query_solana_balances",
	"Query SOL balance changes from a Solana dataset",
	{
		dataset: z.string().describe("Dataset name or alias"),
		from_block: z.number().describe("Starting slot number"),
		to_block: z.number().optional().describe("Ending slot number"),
		finalized_only: z
			.boolean()
			.optional()
			.default(false)
			.describe("Only query finalized slots"),
		account: z
			.array(z.string())
			.optional()
			.describe("Account addresses to filter"),
		limit: z.number().optional().default(100).describe("Max balance changes"),
	},
	async ({ dataset, from_block, to_block, finalized_only, account, limit }) => {
		await validateDataset(dataset);
		const chainType = detectChainType(dataset);

		if (chainType !== "solana") {
			throw new Error("portal_query_solana_balances is only for Solana chains");
		}

		const { validatedToBlock: endBlock } = await validateBlockRange(
			dataset,
			from_block,
			to_block ?? Number.MAX_SAFE_INTEGER,
			finalized_only,
		);

		const balanceFilter: Record<string, unknown> = {};
		if (account) balanceFilter.account = account;

		const query = {
			type: "solana",
			fromBlock: from_block,
			toBlock: endBlock,
			fields: {
				block: { number: true, timestamp: true },
				balance: buildSolanaBalanceFields(),
			},
			balances: [balanceFilter],
		};

		const results = await portalFetchStream(
			`${PORTAL_URL}/datasets/${dataset}/stream`,
			query,
		);

		const allBalances = results
			.flatMap(
				(block: unknown) => (block as { balances?: unknown[] }).balances || [],
			)
			.slice(0, limit);
		return formatResult(
			allBalances,
			`Retrieved ${allBalances.length} balance changes`,
		);
	},
);

// ============================================================================
// Tool: Query Solana Token Balances
// ============================================================================

server.tool(
	"portal_query_solana_token_balances",
	"Query SPL token balance changes from a Solana dataset",
	{
		dataset: z.string().describe("Dataset name or alias"),
		from_block: z.number().describe("Starting slot number"),
		to_block: z.number().optional().describe("Ending slot number"),
		finalized_only: z
			.boolean()
			.optional()
			.default(false)
			.describe("Only query finalized slots"),
		account: z.array(z.string()).optional().describe("Token account addresses"),
		pre_mint: z.array(z.string()).optional().describe("Token mint before tx"),
		post_mint: z.array(z.string()).optional().describe("Token mint after tx"),
		pre_owner: z.array(z.string()).optional().describe("Owner before tx"),
		post_owner: z.array(z.string()).optional().describe("Owner after tx"),
		limit: z
			.number()
			.optional()
			.default(1000)
			.describe("Max token balance changes"),
	},
	async ({
		dataset,
		from_block,
		to_block,
		finalized_only,
		account,
		pre_mint,
		post_mint,
		pre_owner,
		post_owner,
		limit,
	}) => {
		await validateDataset(dataset);
		const chainType = detectChainType(dataset);

		if (chainType !== "solana") {
			throw new Error(
				"portal_query_solana_token_balances is only for Solana chains",
			);
		}

		const { validatedToBlock: endBlock } = await validateBlockRange(
			dataset,
			from_block,
			to_block ?? Number.MAX_SAFE_INTEGER,
			finalized_only,
		);

		const tokenBalanceFilter: Record<string, unknown> = {};
		if (account) tokenBalanceFilter.account = account;
		if (pre_mint) tokenBalanceFilter.preMint = pre_mint;
		if (post_mint) tokenBalanceFilter.postMint = post_mint;
		if (pre_owner) tokenBalanceFilter.preOwner = pre_owner;
		if (post_owner) tokenBalanceFilter.postOwner = post_owner;

		const query = {
			type: "solana",
			fromBlock: from_block,
			toBlock: endBlock,
			fields: {
				block: { number: true, timestamp: true },
				tokenBalance: buildSolanaTokenBalanceFields(),
			},
			tokenBalances: [tokenBalanceFilter],
		};

		const results = await portalFetchStream(
			`${PORTAL_URL}/datasets/${dataset}/stream`,
			query,
		);

		const allTokenBalances = results
			.flatMap(
				(block: unknown) =>
					(block as { tokenBalances?: unknown[] }).tokenBalances || [],
			)
			.slice(0, limit);

		return formatResult(
			allTokenBalances,
			`Retrieved ${allTokenBalances.length} token balance changes`,
		);
	},
);

// ============================================================================
// Tool: Query Solana Logs
// ============================================================================

server.tool(
	"portal_query_solana_logs",
	"Query log messages from a Solana dataset",
	{
		dataset: z.string().describe("Dataset name or alias"),
		from_block: z.number().describe("Starting slot number"),
		to_block: z.number().optional().describe("Ending slot number"),
		finalized_only: z
			.boolean()
			.optional()
			.default(false)
			.describe("Only query finalized slots"),
		program_id: z.array(z.string()).optional().describe("Program IDs"),
		kind: z
			.array(z.enum(["log", "data", "other"]))
			.optional()
			.describe("Log kinds"),
		limit: z.number().optional().default(100).describe("Max logs"),
	},
	async ({
		dataset,
		from_block,
		to_block,
		finalized_only,
		program_id,
		kind,
		limit,
	}) => {
		await validateDataset(dataset);
		const chainType = detectChainType(dataset);

		if (chainType !== "solana") {
			throw new Error("portal_query_solana_logs is only for Solana chains");
		}

		const { validatedToBlock: endBlock } = await validateBlockRange(
			dataset,
			from_block,
			to_block ?? Number.MAX_SAFE_INTEGER,
			finalized_only,
		);

		const logFilter: Record<string, unknown> = {};
		if (program_id) logFilter.programId = program_id;
		if (kind) logFilter.kind = kind;

		const query = {
			type: "solana",
			fromBlock: from_block,
			toBlock: endBlock,
			fields: {
				block: { number: true, timestamp: true },
				log: buildSolanaLogFields(),
			},
			logs: [logFilter],
		};

		const results = await portalFetchStream(
			`${PORTAL_URL}/datasets/${dataset}/stream`,
			query,
		);

		const allLogs = results
			.flatMap((block: unknown) => (block as { logs?: unknown[] }).logs || [])
			.slice(0, limit);
		return formatResult(allLogs, `Retrieved ${allLogs.length} logs`);
	},
);

// ============================================================================
// Tool: Query Solana Rewards
// ============================================================================

server.tool(
	"portal_query_solana_rewards",
	"Query block rewards from a Solana dataset",
	{
		dataset: z.string().describe("Dataset name or alias"),
		from_block: z.number().describe("Starting slot number"),
		to_block: z.number().optional().describe("Ending slot number"),
		finalized_only: z
			.boolean()
			.optional()
			.default(false)
			.describe("Only query finalized slots"),
		pubkey: z.array(z.string()).optional().describe("Reward recipient pubkeys"),
		limit: z.number().optional().default(100).describe("Max rewards"),
	},
	async ({ dataset, from_block, to_block, finalized_only, pubkey, limit }) => {
		await validateDataset(dataset);
		const chainType = detectChainType(dataset);

		if (chainType !== "solana") {
			throw new Error("portal_query_solana_rewards is only for Solana chains");
		}

		const { validatedToBlock: endBlock } = await validateBlockRange(
			dataset,
			from_block,
			to_block ?? Number.MAX_SAFE_INTEGER,
			finalized_only,
		);

		const rewardFilter: Record<string, unknown> = {};
		if (pubkey) rewardFilter.pubkey = pubkey;

		const query = {
			type: "solana",
			fromBlock: from_block,
			toBlock: endBlock,
			fields: {
				block: { number: true, timestamp: true },
				reward: buildSolanaRewardFields(),
			},
			rewards: [rewardFilter],
		};

		const results = await portalFetchStream(
			`${PORTAL_URL}/datasets/${dataset}/stream`,
			query,
		);

		const allRewards = results
			.flatMap(
				(block: unknown) => (block as { rewards?: unknown[] }).rewards || [],
			)
			.slice(0, limit);
		return formatResult(allRewards, `Retrieved ${allRewards.length} rewards`);
	},
);

// ============================================================================
// Tool: Stream Query
// ============================================================================

server.tool(
	"portal_stream",
	"Execute a raw streaming query against the Portal API",
	{
		dataset: z.string().describe("Dataset name or alias"),
		query: z
			.object({
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
			.describe("Raw query object"),
		timeout_ms: z
			.number()
			.optional()
			.default(60000)
			.describe("Request timeout in milliseconds"),
	},
	async ({ dataset, query, timeout_ms }) => {
		await validateDataset(dataset);

		const results = await portalFetchStream(
			`${PORTAL_URL}/datasets/${dataset}/stream`,
			query,
			timeout_ms,
		);

		return formatResult(results, `Retrieved ${results.length} blocks of data`);
	},
);

// ============================================================================
// Tool: Paginated Query
// ============================================================================

server.tool(
	"portal_query_paginated",
	"Execute a paginated query with cursor support for large block ranges",
	{
		dataset: z.string().describe("Dataset name or alias"),
		query: z
			.object({
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
			.describe("Query object"),
		cursor: z
			.string()
			.optional()
			.describe("Pagination cursor from previous response"),
		page_size: z
			.number()
			.optional()
			.default(100)
			.describe("Number of blocks per page"),
	},
	async ({ dataset, query, cursor, page_size }) => {
		await validateDataset(dataset);

		const head = await portalFetch<BlockHead>(
			`${PORTAL_URL}/datasets/${dataset}/head`,
		);

		// If we have a cursor, parse it to get the starting block
		let fromBlock = query.fromBlock;
		if (cursor) {
			const cursorData = JSON.parse(Buffer.from(cursor, "base64").toString());
			fromBlock = cursorData.nextBlock;
		}

		const toBlock = Math.min(
			fromBlock + page_size!,
			query.toBlock ?? head.number,
		);

		const paginatedQuery = {
			...query,
			fromBlock,
			toBlock,
		};

		const results = await portalFetchStream(
			`${PORTAL_URL}/datasets/${dataset}/stream`,
			paginatedQuery,
		);

		// Generate next cursor if there's more data
		let nextCursor: string | null = null;
		if (toBlock < (query.toBlock ?? head.number)) {
			nextCursor = Buffer.from(JSON.stringify({ nextBlock: toBlock })).toString(
				"base64",
			);
		}

		return formatResult({
			data: results,
			pagination: {
				fromBlock,
				toBlock,
				hasMore: nextCursor !== null,
				cursor: nextCursor,
			},
		});
	},
);

// ============================================================================
// Tool: Batch Query (Multi-Dataset)
// ============================================================================

server.tool(
	"portal_batch_query",
	"Execute the same query across multiple datasets in parallel (e.g., track an address across Ethereum, Base, Arbitrum)",
	{
		datasets: z
			.array(z.string())
			.min(1)
			.max(10)
			.describe("List of datasets to query (max 10)"),
		query_type: z
			.enum(["logs", "transactions", "balances"])
			.describe("Type of query to execute"),
		from_block: z
			.number()
			.optional()
			.describe("Starting block (uses last 1000 blocks if not specified)"),
		to_block: z.number().optional().describe("Ending block"),
		addresses: z
			.array(z.string())
			.optional()
			.describe("Addresses to filter (contract for logs, from/to for txs)"),
		topic0: z
			.array(z.string())
			.optional()
			.describe("Event signatures for log queries"),
		limit_per_dataset: z
			.number()
			.optional()
			.default(100)
			.describe("Max results per dataset"),
		finalized_only: z
			.boolean()
			.optional()
			.default(false)
			.describe("Only query finalized blocks"),
	},
	async ({
		datasets,
		query_type,
		from_block,
		to_block,
		addresses,
		topic0,
		limit_per_dataset,
		finalized_only,
	}) => {
		// Validate all datasets first
		await Promise.all(datasets.map((d) => validateDataset(d)));

		// Filter to only EVM datasets for these query types
		const evmDatasets = datasets.filter((d) => detectChainType(d) === "evm");
		if (evmDatasets.length === 0) {
			throw new Error(
				"No EVM datasets provided. Batch query currently only supports EVM chains.",
			);
		}

		// Execute queries in parallel
		const results = await Promise.all(
			evmDatasets.map(async (dataset) => {
				try {
					const meta = await getDatasetMetadata(dataset);
					const maxBlock =
						finalized_only && meta.finalized_head
							? meta.finalized_head.number
							: meta.head.number;

					const effectiveFromBlock = from_block ?? Math.max(0, maxBlock - 1000);
					const effectiveToBlock = to_block ?? maxBlock;

					const { validatedToBlock } = await validateBlockRange(
						dataset,
						effectiveFromBlock,
						effectiveToBlock,
						finalized_only,
					);

					const includeL2 = isL2Chain(dataset);
					let query: Record<string, unknown>;

					if (query_type === "logs") {
						const logFilter: Record<string, unknown> = {};
						if (addresses) {
							logFilter.address = normalizeAddresses(addresses, "evm");
						}
						if (topic0) {
							logFilter.topic0 = topic0;
						}
						query = {
							type: "evm",
							fromBlock: effectiveFromBlock,
							toBlock: validatedToBlock,
							fields: {
								block: { number: true, timestamp: true, hash: true },
								log: buildEvmLogFields(),
							},
							logs: [logFilter],
						};
					} else if (query_type === "transactions") {
						const txFilter: Record<string, unknown> = {};
						if (addresses) {
							const normalized = normalizeAddresses(addresses, "evm");
							txFilter.from = normalized;
							txFilter.to = normalized;
						}
						query = {
							type: "evm",
							fromBlock: effectiveFromBlock,
							toBlock: validatedToBlock,
							fields: {
								block: { number: true, timestamp: true, hash: true },
								transaction: buildEvmTransactionFields(includeL2),
							},
							transactions: [txFilter],
						};
					} else {
						// balances - use state diffs
						const diffFilter: Record<string, unknown> = {
							key: ["balance"],
						};
						if (addresses) {
							diffFilter.address = normalizeAddresses(addresses, "evm");
						}
						query = {
							type: "evm",
							fromBlock: effectiveFromBlock,
							toBlock: validatedToBlock,
							fields: {
								block: { number: true, timestamp: true, hash: true },
								stateDiff: buildEvmStateDiffFields(),
							},
							stateDiffs: [diffFilter],
						};
					}

					const response = await portalFetchStream(
						`${PORTAL_URL}/datasets/${dataset}/stream`,
						query,
					);

					let items: unknown[] = [];
					if (query_type === "logs") {
						items = response.flatMap(
							(block: unknown) => (block as { logs?: unknown[] }).logs || [],
						);
					} else if (query_type === "transactions") {
						items = response.flatMap(
							(block: unknown) =>
								(block as { transactions?: unknown[] }).transactions || [],
						);
					} else {
						items = response.flatMap(
							(block: unknown) =>
								(block as { stateDiffs?: unknown[] }).stateDiffs || [],
						);
					}

					return {
						dataset,
						chain_type: "evm",
						is_l2: includeL2,
						from_block: effectiveFromBlock,
						to_block: validatedToBlock,
						count: items.length,
						items: items.slice(0, limit_per_dataset),
						error: null,
					};
				} catch (error) {
					return {
						dataset,
						chain_type: "evm",
						is_l2: isL2Chain(dataset),
						from_block: from_block ?? 0,
						to_block: to_block ?? 0,
						count: 0,
						items: [],
						error: (error as Error).message,
					};
				}
			}),
		);

		const totalItems = results.reduce((sum, r) => sum + r.count, 0);
		const successCount = results.filter((r) => !r.error).length;

		return formatResult(
			{
				results,
				summary: {
					total_items: totalItems,
					datasets_queried: results.length,
					successful: successCount,
				},
			},
			`Batch query completed: ${totalItems} items across ${successCount}/${results.length} datasets`,
		);
	},
);

// ============================================================================
// Tool: Decode Logs
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
	transactionHash?: string;
	logIndex?: number;
} {
	const topic0 = log.topics[0];
	const eventInfo = KNOWN_EVENTS[topic0];

	if (!eventInfo) {
		return {
			address: log.address,
			event_name: null,
			decoded: null,
			raw: { topics: log.topics, data: log.data },
			transactionHash: log.transactionHash,
			logIndex: log.logIndex,
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
		transactionHash: log.transactionHash,
		logIndex: log.logIndex,
	};
}

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
		await validateDataset(dataset);
		const chainType = detectChainType(dataset);

		if (chainType !== "evm") {
			throw new Error("portal_decode_logs is only for EVM chains");
		}

		const { validatedToBlock } = await validateBlockRange(
			dataset,
			from_block,
			to_block ?? from_block + 1000,
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
			toBlock: validatedToBlock,
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
		);
	},
);

// ============================================================================
// Tool: Get Address Activity
// ============================================================================

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
		await validateDataset(dataset);
		const chainType = detectChainType(dataset);

		if (chainType !== "evm") {
			throw new Error("portal_get_address_activity is only for EVM chains");
		}

		const normalizedAddress = normalizeEvmAddress(address);
		const { validatedToBlock } = await validateBlockRange(
			dataset,
			from_block,
			to_block ?? from_block + 10000,
			finalized_only,
		);

		const includeL2 = isL2Chain(dataset);
		const paddedAddress = "0x" + normalizedAddress.slice(2).padStart(64, "0");

		// Query transactions
		const txQuery = {
			type: "evm",
			fromBlock: from_block,
			toBlock: validatedToBlock,
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
				toBlock: validatedToBlock,
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
				toBlock: validatedToBlock,
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
							transactionHash: log.transactionHash,
						};
					});
				})
				.slice(0, limit);
		}

		return formatResult(
			{
				address: normalizedAddress,
				from_block,
				to_block: validatedToBlock,
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
		);
	},
);

// ============================================================================
// Tool: Get Token Info
// ============================================================================

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
		await validateDataset(dataset);
		const chainType = detectChainType(dataset);

		if (chainType !== "evm") {
			throw new Error(
				"portal_get_token_transfers_for_address is only for EVM chains",
			);
		}

		const normalizedAddress = normalizeEvmAddress(address);
		const paddedAddress = "0x" + normalizedAddress.slice(2).padStart(64, "0");
		const { validatedToBlock } = await validateBlockRange(
			dataset,
			from_block,
			to_block ?? from_block + 10000,
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
			toBlock: validatedToBlock,
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
						transactionHash: log.transactionHash,
						logIndex: log.logIndex,
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
		);
	},
);

// ============================================================================
// Main Entry Point
// ============================================================================

async function main() {
	const transport = new StdioServerTransport();
	await server.connect(transport);
	console.error(`SQD Portal MCP Server v${VERSION} started`);
}

main().catch((error) => {
	console.error("Fatal error:", error);
	process.exit(1);
});
