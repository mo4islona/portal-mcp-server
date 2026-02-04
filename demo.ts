#!/usr/bin/env npx tsx

/**
 * SQD Portal MCP Server Demo Script
 *
 * This script demonstrates the capabilities of the MCP server by making
 * real API calls to the SQD Portal. Run with: npx tsx demo.ts
 */

const PORTAL_URL = "https://portal.sqd.dev";

// ANSI colors for pretty output
const colors = {
	reset: "\x1b[0m",
	bright: "\x1b[1m",
	dim: "\x1b[2m",
	cyan: "\x1b[36m",
	green: "\x1b[32m",
	yellow: "\x1b[33m",
	magenta: "\x1b[35m",
	blue: "\x1b[34m",
	red: "\x1b[31m",
};

function header(text: string) {
	console.log(
		`\n${colors.bright}${colors.cyan}${"═".repeat(60)}${colors.reset}`,
	);
	console.log(`${colors.bright}${colors.cyan}  ${text}${colors.reset}`);
	console.log(
		`${colors.bright}${colors.cyan}${"═".repeat(60)}${colors.reset}\n`,
	);
}

function subheader(text: string) {
	console.log(`\n${colors.yellow}▶ ${text}${colors.reset}`);
}

function tool(name: string, reason: string) {
	console.log(
		`\n${colors.bright}${colors.magenta}🔧 Tool: ${name}${colors.reset}`,
	);
	console.log(`${colors.dim}   Why: ${reason}${colors.reset}\n`);
}

function info(label: string, value: string | number) {
	console.log(
		`  ${colors.dim}${label}:${colors.reset} ${colors.green}${value}${colors.reset}`,
	);
}

function json(data: unknown, indent = 2) {
	const str = JSON.stringify(data, null, indent);
	// Colorize JSON
	const colored = str
		.replace(/"([^"]+)":/g, `${colors.blue}"$1"${colors.reset}:`)
		.replace(/: "([^"]+)"/g, `: ${colors.green}"$1"${colors.reset}`)
		.replace(/: (\d+)/g, `: ${colors.magenta}$1${colors.reset}`);
	console.log(colored);
}

async function fetchPortal<T>(endpoint: string, body?: unknown): Promise<T> {
	const options: RequestInit = {
		headers: { "Content-Type": "application/json" },
	};
	if (body) {
		options.method = "POST";
		options.body = JSON.stringify(body);
	}
	const response = await fetch(`${PORTAL_URL}${endpoint}`, options);
	if (!response.ok) {
		throw new Error(`API error: ${response.status} ${response.statusText}`);
	}
	return response.json();
}

async function streamPortal(
	endpoint: string,
	body: unknown,
): Promise<unknown[]> {
	const response = await fetch(`${PORTAL_URL}${endpoint}`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"Accept-Encoding": "gzip",
		},
		body: JSON.stringify(body),
	});
	if (!response.ok) {
		const text = await response.text();
		throw new Error(`API error: ${response.status} - ${text}`);
	}
	const text = await response.text();
	return text
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
}

function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function demo1_ListDatasets() {
	header("Demo 1: Discover Available Datasets");

	console.log(
		"The MCP server can list and search across 100+ blockchain datasets...\n",
	);

	tool(
		"portal_list_datasets",
		"Get all available blockchain networks in one call",
	);

	const datasets =
		await fetchPortal<
			Array<{ dataset: string; aliases?: string[]; real_time?: boolean }>
		>("/datasets");

	info("Total datasets available", datasets.length);
	info("Real-time datasets", datasets.filter((d) => d.real_time).length);

	subheader("Sample EVM Chains:");
	const evmChains = [
		"ethereum-mainnet",
		"base-mainnet",
		"arbitrum-one",
		"optimism-mainnet",
		"polygon-mainnet",
	];
	for (const chain of evmChains) {
		const found = datasets.find(
			(d) => d.dataset === chain || (d.aliases && d.aliases.includes(chain)),
		);
		if (found) {
			const rtLabel = found.real_time
				? `${colors.cyan}(real-time)${colors.reset}`
				: "";
			console.log(`  ${colors.green}✓${colors.reset} ${chain} ${rtLabel}`);
		}
	}

	subheader("Sample Solana Networks:");
	const solanaChains = datasets
		.filter((d) => d.dataset && d.dataset.includes("solana"))
		.slice(0, 3);
	for (const chain of solanaChains) {
		const rtLabel = chain.real_time
			? `${colors.cyan}(real-time)${colors.reset}`
			: "";
		console.log(
			`  ${colors.green}✓${colors.reset} ${chain.dataset} ${rtLabel}`,
		);
	}
}

async function demo2_ChainStatus() {
	header("Demo 2: Real-time Chain Status");

	console.log("Query the latest block and finalized block for any chain...\n");

	tool(
		"portal_get_block_number",
		"Get current chain head and finalized block for reorg safety",
	);

	const chains = ["ethereum-mainnet", "base-mainnet", "arbitrum-one"];

	for (const chain of chains) {
		const [head, finalizedHead] = await Promise.all([
			fetchPortal<{ number: number; hash: string }>(`/datasets/${chain}/head`),
			fetchPortal<{ number: number; hash: string }>(
				`/datasets/${chain}/finalized-head`,
			).catch(() => null),
		]);

		subheader(chain);
		info("Latest block", head.number.toLocaleString());
		if (finalizedHead) {
			info("Finalized block", finalizedHead.number.toLocaleString());
			info(
				"Blocks to finality",
				(head.number - finalizedHead.number).toString(),
			);
		}
		info("Latest hash", head.hash.slice(0, 18) + "...");
	}
}

async function demo3_QueryLogs() {
	header("Demo 3: Query ERC-20 Transfer Events");

	console.log("Find USDC transfers on Ethereum in a recent block range...\n");

	tool(
		"portal_query_logs",
		"Query event logs filtered by contract address and topic signatures",
	);

	const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
	const TRANSFER_TOPIC =
		"0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

	// Get latest block
	const head = await fetchPortal<{ number: number }>(
		"/datasets/ethereum-mainnet/head",
	);
	const fromBlock = head.number - 100;

	info(
		"Querying blocks",
		`${fromBlock.toLocaleString()} to ${head.number.toLocaleString()}`,
	);
	info("Contract", `USDC (${USDC.slice(0, 10)}...)`);
	info("Event", "Transfer(address,address,uint256)");

	const query = {
		type: "evm",
		fromBlock,
		toBlock: head.number,
		fields: {
			block: { number: true, timestamp: true },
			log: {
				address: true,
				topics: true,
				data: true,
				transactionHash: true,
			},
		},
		logs: [
			{
				address: [USDC],
				topic0: [TRANSFER_TOPIC],
			},
		],
	};

	const results = await streamPortal(
		"/datasets/ethereum-mainnet/stream",
		query,
	);
	const allLogs = results.flatMap((block: any) => block.logs || []);

	subheader(`Found ${allLogs.length} USDC transfers!`);

	// Show first 3 significant transfers (> $10) with decoded amounts
	const significantTransfers = allLogs
		.filter((log: any) => {
			try {
				const amount = BigInt(log.data);
				return amount > BigInt(10 * 10 ** 6); // > $10 USDC
			} catch {
				return false;
			}
		})
		.slice(0, 3);

	for (const log of significantTransfers) {
		const rawAmount = BigInt(log.data);
		const dollars = Number(rawAmount / BigInt(10 ** 4)) / 100; // Keep 2 decimal places
		const from = "0x" + log.topics[1].slice(26);
		const to = "0x" + log.topics[2].slice(26);
		console.log(`\n  ${colors.green}Transfer${colors.reset}`);
		console.log(`    From: ${from.slice(0, 10)}...${from.slice(-8)}`);
		console.log(`    To:   ${to.slice(0, 10)}...${to.slice(-8)}`);
		console.log(
			`    Amount: ${colors.bright}$${dollars.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDC${colors.reset}`,
		);
	}
}

async function demo4_QueryTransactions() {
	header("Demo 4: Query Uniswap Router Transactions");

	console.log("Find swap transactions on Uniswap V3 Router...\n");

	tool(
		"portal_query_transactions",
		"Query transactions by sender/recipient address and function sighash",
	);

	const UNISWAP_ROUTER = "0xe592427a0aece92de3edee1f18e0157c05861564";

	// Get latest block
	const head = await fetchPortal<{ number: number }>(
		"/datasets/ethereum-mainnet/head",
	);
	const fromBlock = head.number - 50;

	info("Router", "Uniswap V3 SwapRouter");
	info(
		"Block range",
		`${fromBlock.toLocaleString()} - ${head.number.toLocaleString()}`,
	);

	const query = {
		type: "evm",
		fromBlock,
		toBlock: head.number,
		fields: {
			block: { number: true, timestamp: true },
			transaction: {
				hash: true,
				from: true,
				to: true,
				value: true,
				gasUsed: true,
				effectiveGasPrice: true,
				sighash: true,
			},
		},
		transactions: [
			{
				to: [UNISWAP_ROUTER],
			},
		],
	};

	const results = await streamPortal(
		"/datasets/ethereum-mainnet/stream",
		query,
	);
	const allTxs = results.flatMap((block: any) => block.transactions || []);

	subheader(`Found ${allTxs.length} Uniswap transactions!`);

	// Show first 3 with gas costs
	const sample = allTxs.slice(0, 3);
	for (const tx of sample) {
		const gasCost =
			(BigInt(tx.gasUsed) * BigInt(tx.effectiveGasPrice)) / BigInt(10 ** 18);
		const ethValue = BigInt(tx.value) / BigInt(10 ** 18);
		console.log(
			`\n  ${colors.magenta}${tx.hash.slice(0, 18)}...${colors.reset}`,
		);
		console.log(`    From: ${tx.from.slice(0, 10)}...`);
		console.log(`    Sighash: ${tx.sighash}`);
		console.log(`    ETH sent: ${ethValue.toString()} ETH`);
		console.log(`    Gas cost: ~${gasCost.toString()} ETH`);
	}
}

async function demo5_MultiChainBatch() {
	header("Demo 5: Multi-Chain Batch Query");

	console.log("Query multiple chains in parallel - a key v0.5.0 feature!\n");

	tool(
		"portal_batch_query",
		"Execute identical queries across multiple chains in parallel",
	);

	const chains = ["ethereum-mainnet", "base-mainnet", "arbitrum-one"];
	const WETH_ADDRESSES: Record<string, string> = {
		"ethereum-mainnet": "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
		"base-mainnet": "0x4200000000000000000000000000000000000006",
		"arbitrum-one": "0x82af49447d8a07e3bd95bd0d56f35241523fbab1",
	};
	const TRANSFER_TOPIC =
		"0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

	console.log("Querying WETH transfers across 3 chains simultaneously...\n");

	const startTime = Date.now();

	// Parallel queries
	const results = await Promise.all(
		chains.map(async (chain) => {
			const head = await fetchPortal<{ number: number }>(
				`/datasets/${chain}/head`,
			);
			const fromBlock = head.number - 100;

			const query = {
				type: "evm",
				fromBlock,
				toBlock: head.number,
				fields: {
					block: { number: true },
					log: { address: true, topics: true, data: true },
				},
				logs: [
					{
						address: [WETH_ADDRESSES[chain]],
						topic0: [TRANSFER_TOPIC],
					},
				],
			};

			const data = await streamPortal(`/datasets/${chain}/stream`, query);
			const logs = data.flatMap((block: any) => block.logs || []);
			return { chain, count: logs.length, latestBlock: head.number };
		}),
	);

	const elapsed = Date.now() - startTime;

	subheader("Results:");
	for (const r of results) {
		info(
			r.chain,
			`${r.count} transfers (block ${r.latestBlock.toLocaleString()})`,
		);
	}

	console.log(
		`\n  ${colors.dim}Total query time: ${colors.green}${elapsed}ms${colors.reset} (parallel execution)`,
	);
}

async function demo6_Solana() {
	header("Demo 6: Solana Blockchain Queries");

	console.log(
		"The MCP server also supports Solana with full instruction filtering...\n",
	);

	tool(
		"portal_query_solana_instructions",
		"Query Solana instructions by program ID, discriminator, and account filters",
	);

	const head = await fetchPortal<{ number: number }>(
		"/datasets/solana-mainnet/head",
	);
	const fromSlot = head.number - 50;

	info("Latest Solana slot", head.number.toLocaleString());

	// Query Token Program instructions
	const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

	subheader("Querying SPL Token Program instructions...");

	const query = {
		type: "solana",
		fromBlock: fromSlot,
		toBlock: head.number,
		fields: {
			block: { number: true, timestamp: true },
			instruction: {
				programId: true,
				data: true,
				isCommitted: true,
			},
		},
		instructions: [
			{
				programId: [TOKEN_PROGRAM],
				isCommitted: true,
			},
		],
	};

	const results = await streamPortal("/datasets/solana-mainnet/stream", query);
	const allInstructions = results.flatMap(
		(block: any) => block.instructions || [],
	);

	info("Token Program instructions found", allInstructions.length);

	// Show instruction discriminator distribution
	const discriminators = new Map<string, number>();
	for (const ix of allInstructions) {
		const d1 = ix.data?.slice(0, 4) || "empty";
		discriminators.set(d1, (discriminators.get(d1) || 0) + 1);
	}

	subheader("Instruction types (by discriminator):");
	const sorted = [...discriminators.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, 5);
	for (const [disc, count] of sorted) {
		console.log(`    ${disc}: ${count} occurrences`);
	}
}

async function demo7_FinalizedOnly() {
	header("Demo 7: Finalized-Only Mode (v0.5.0)");

	console.log("Query only finalized blocks for maximum data reliability...\n");

	tool(
		"All query tools support: finalized_only=true",
		"Automatically cap queries at the finalized block to avoid reading reorg-prone data",
	);

	const [head, finalizedHead] = await Promise.all([
		fetchPortal<{ number: number }>("/datasets/ethereum-mainnet/head"),
		fetchPortal<{ number: number }>(
			"/datasets/ethereum-mainnet/finalized-head",
		),
	]);

	info("Latest block", head.number.toLocaleString());
	info("Finalized block", finalizedHead.number.toLocaleString());
	info("Unfinalized blocks", (head.number - finalizedHead.number).toString());

	console.log(
		`\n  ${colors.yellow}With finalized_only=true, queries are capped at block ${finalizedHead.number.toLocaleString()}${colors.reset}`,
	);
	console.log(
		`  ${colors.dim}This ensures you never read data that might be reorged away.${colors.reset}`,
	);
}

async function main() {
	console.log(`${colors.bright}${colors.magenta}`);
	console.log(`
   ███████╗ ██████╗ ██████╗     ██████╗  ██████╗ ██████╗ ████████╗ █████╗ ██╗
   ██╔════╝██╔═══██╗██╔══██╗    ██╔══██╗██╔═══██╗██╔══██╗╚══██╔══╝██╔══██╗██║
   ███████╗██║   ██║██║  ██║    ██████╔╝██║   ██║██████╔╝   ██║   ███████║██║
   ╚════██║██║▄▄ ██║██║  ██║    ██╔═══╝ ██║   ██║██╔══██╗   ██║   ██╔══██║██║
   ███████║╚██████╔╝██████╔╝    ██║     ╚██████╔╝██║  ██║   ██║   ██║  ██║███████╗
   ╚══════╝ ╚══▀▀═╝ ╚═════╝     ╚═╝      ╚═════╝ ╚═╝  ╚═╝   ╚═╝   ╚═╝  ╚═╝╚══════╝
  `);
	console.log(`${colors.reset}`);
	console.log(
		`${colors.bright}  MCP Server Demo - Version 0.5.0${colors.reset}`,
	);
	console.log(
		`${colors.dim}  Showcasing blockchain data access via Model Context Protocol${colors.reset}\n`,
	);

	try {
		await demo1_ListDatasets();
		await sleep(500);

		await demo2_ChainStatus();
		await sleep(500);

		await demo3_QueryLogs();
		await sleep(500);

		await demo4_QueryTransactions();
		await sleep(500);

		await demo5_MultiChainBatch();
		await sleep(500);

		await demo6_Solana();
		await sleep(500);

		await demo7_FinalizedOnly();

		header("Demo Complete!");
		console.log(
			`${colors.green}All demos executed successfully!${colors.reset}\n`,
		);
		console.log("The MCP server provides 23 tools covering:");
		console.log("  • Dataset discovery and search");
		console.log("  • Block, transaction, and log queries");
		console.log("  • Trace and state diff analysis");
		console.log("  • ERC-20/ERC-721 transfer helpers");
		console.log("  • Solana instructions, balances, and rewards");
		console.log("  • Multi-chain batch queries");
		console.log("  • Event log decoding");
		console.log("  • Address activity tracking\n");

		console.log(
			`Run ${colors.cyan}npm run inspect${colors.reset} to test tools interactively.\n`,
		);

		// Generate and open HTML report
		console.log(`${colors.dim}Generating HTML report...${colors.reset}`);
		const { execSync } = await import("child_process");
		execSync("npx tsx export-demo.ts", { stdio: "inherit" });

		// Open the HTML file
		const platform = process.platform;
		const openCmd =
			platform === "darwin"
				? "open"
				: platform === "win32"
					? "start"
					: "xdg-open";
		try {
			execSync(`${openCmd} demo-report.html`, { stdio: "ignore" });
			console.log(
				`\n${colors.green}✓ HTML report opened in browser${colors.reset}\n`,
			);
		} catch {
			console.log(
				`\n${colors.yellow}HTML report saved to: demo-report.html${colors.reset}\n`,
			);
		}
	} catch (error) {
		console.error(`${colors.red}Error: ${error}${colors.reset}`);
		process.exit(1);
	}
}

main();
