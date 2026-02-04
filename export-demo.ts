#!/usr/bin/env npx tsx

/**
 * Export demo results to HTML file
 */

import { writeFileSync } from "fs";

const PORTAL_URL = "https://portal.sqd.dev";

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

async function streamPortal(endpoint: string, body: unknown): Promise<unknown[]> {
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
  return text.trim().split("\n").map(line => JSON.parse(line));
}

interface DemoResult {
  title: string;
  tool: string;
  why: string;
  content: string[];
}

async function runDemos(): Promise<DemoResult[]> {
  const results: DemoResult[] = [];

  // Demo 1: List Datasets
  {
    const datasets = await fetchPortal<Array<{ dataset: string; aliases?: string[]; real_time?: boolean }>>("/datasets");
    const evmChains = ["ethereum-mainnet", "base-mainnet", "arbitrum-one", "optimism-mainnet", "polygon-mainnet"];
    const content: string[] = [
      `<strong>Total datasets available:</strong> ${datasets.length}`,
      `<strong>Real-time datasets:</strong> ${datasets.filter(d => d.real_time).length}`,
      `<br><strong>Sample EVM Chains:</strong>`,
    ];
    for (const chain of evmChains) {
      const found = datasets.find(d => d.dataset === chain);
      if (found) {
        content.push(`✓ ${chain} ${found.real_time ? '<span class="tag">real-time</span>' : ''}`);
      }
    }
    content.push(`<br><strong>Sample Solana Networks:</strong>`);
    const solanaChains = datasets.filter(d => d.dataset?.includes("solana")).slice(0, 2);
    for (const chain of solanaChains) {
      content.push(`✓ ${chain.dataset} ${chain.real_time ? '<span class="tag">real-time</span>' : ''}`);
    }
    results.push({
      title: "Demo 1: Discover Available Datasets",
      tool: "portal_list_datasets",
      why: "Get all available blockchain networks in one call",
      content,
    });
  }

  // Demo 2: Chain Status
  {
    const chains = ["ethereum-mainnet", "base-mainnet", "arbitrum-one"];
    const content: string[] = [];
    for (const chain of chains) {
      const [head, finalizedHead] = await Promise.all([
        fetchPortal<{ number: number; hash: string }>(`/datasets/${chain}/head`),
        fetchPortal<{ number: number; hash: string }>(`/datasets/${chain}/finalized-head`).catch(() => null),
      ]);
      content.push(`<strong>${chain}</strong>`);
      content.push(`&nbsp;&nbsp;Latest block: <span class="number">${head.number.toLocaleString()}</span>`);
      if (finalizedHead) {
        content.push(`&nbsp;&nbsp;Finalized block: <span class="number">${finalizedHead.number.toLocaleString()}</span>`);
        content.push(`&nbsp;&nbsp;Blocks to finality: <span class="number">${(head.number - finalizedHead.number)}</span>`);
      }
      content.push(`&nbsp;&nbsp;Latest hash: <code>${head.hash.slice(0, 18)}...</code>`);
      content.push(`<br>`);
    }
    results.push({
      title: "Demo 2: Real-time Chain Status",
      tool: "portal_get_block_number",
      why: "Get current chain head and finalized block for reorg safety",
      content,
    });
  }

  // Demo 3: Query Logs
  {
    const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
    const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
    const head = await fetchPortal<{ number: number }>("/datasets/ethereum-mainnet/head");
    const fromBlock = head.number - 100;

    const query = {
      type: "evm",
      fromBlock,
      toBlock: head.number,
      fields: {
        block: { number: true, timestamp: true },
        log: { address: true, topics: true, data: true, transactionHash: true },
      },
      logs: [{ address: [USDC], topic0: [TRANSFER_TOPIC] }],
    };

    const data = await streamPortal("/datasets/ethereum-mainnet/stream", query);
    const allLogs = data.flatMap((block: any) => block.logs || []);
    
    const content: string[] = [
      `<strong>Block range:</strong> ${fromBlock.toLocaleString()} to ${head.number.toLocaleString()}`,
      `<strong>Contract:</strong> USDC (<code>${USDC.slice(0, 14)}...</code>)`,
      `<strong>Event:</strong> Transfer(address,address,uint256)`,
      `<br><strong>Found <span class="number">${allLogs.length.toLocaleString()}</span> USDC transfers!</strong>`,
      `<br>`,
    ];

    const significantTransfers = allLogs.filter((log: any) => {
      try { return BigInt(log.data) > BigInt(10 * 10 ** 6); } catch { return false; }
    }).slice(0, 3);

    for (const log of significantTransfers) {
      const rawAmount = BigInt(log.data);
      const dollars = Number(rawAmount / BigInt(10 ** 4)) / 100;
      const from = "0x" + log.topics[1].slice(26);
      const to = "0x" + log.topics[2].slice(26);
      content.push(`<div class="transfer">`);
      content.push(`<strong>Transfer</strong>`);
      content.push(`&nbsp;&nbsp;From: <code>${from.slice(0, 10)}...${from.slice(-8)}</code>`);
      content.push(`&nbsp;&nbsp;To: <code>${to.slice(0, 10)}...${to.slice(-8)}</code>`);
      content.push(`&nbsp;&nbsp;Amount: <span class="amount">$${dollars.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDC</span>`);
      content.push(`</div>`);
    }

    results.push({
      title: "Demo 3: Query ERC-20 Transfer Events",
      tool: "portal_query_logs",
      why: "Query event logs filtered by contract address and topic signatures",
      content,
    });
  }

  // Demo 4: Query Transactions
  {
    const UNISWAP_ROUTER = "0xe592427a0aece92de3edee1f18e0157c05861564";
    const head = await fetchPortal<{ number: number }>("/datasets/ethereum-mainnet/head");
    const fromBlock = head.number - 50;

    const query = {
      type: "evm",
      fromBlock,
      toBlock: head.number,
      fields: {
        block: { number: true, timestamp: true },
        transaction: { hash: true, from: true, to: true, value: true, gasUsed: true, effectiveGasPrice: true, sighash: true },
      },
      transactions: [{ to: [UNISWAP_ROUTER] }],
    };

    const data = await streamPortal("/datasets/ethereum-mainnet/stream", query);
    const allTxs = data.flatMap((block: any) => block.transactions || []);

    const content: string[] = [
      `<strong>Router:</strong> Uniswap V3 SwapRouter`,
      `<strong>Block range:</strong> ${fromBlock.toLocaleString()} - ${head.number.toLocaleString()}`,
      `<br><strong>Found <span class="number">${allTxs.length}</span> Uniswap transactions!</strong>`,
      `<br>`,
    ];

    for (const tx of allTxs.slice(0, 3)) {
      content.push(`<div class="transaction">`);
      content.push(`<code>${tx.hash.slice(0, 18)}...</code>`);
      content.push(`&nbsp;&nbsp;From: <code>${tx.from.slice(0, 12)}...</code>`);
      content.push(`&nbsp;&nbsp;Sighash: <code>${tx.sighash}</code>`);
      content.push(`</div>`);
    }

    results.push({
      title: "Demo 4: Query Uniswap Router Transactions",
      tool: "portal_query_transactions",
      why: "Query transactions by sender/recipient address and function sighash",
      content,
    });
  }

  // Demo 5: Multi-chain Batch
  {
    const chains = ["ethereum-mainnet", "base-mainnet", "arbitrum-one"];
    const WETH_ADDRESSES: Record<string, string> = {
      "ethereum-mainnet": "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
      "base-mainnet": "0x4200000000000000000000000000000000000006",
      "arbitrum-one": "0x82af49447d8a07e3bd95bd0d56f35241523fbab1",
    };
    const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

    const startTime = Date.now();
    const batchResults = await Promise.all(
      chains.map(async (chain) => {
        const head = await fetchPortal<{ number: number }>(`/datasets/${chain}/head`);
        const fromBlock = head.number - 100;
        const query = {
          type: "evm",
          fromBlock,
          toBlock: head.number,
          fields: { block: { number: true }, log: { address: true, topics: true, data: true } },
          logs: [{ address: [WETH_ADDRESSES[chain]], topic0: [TRANSFER_TOPIC] }],
        };
        const data = await streamPortal(`/datasets/${chain}/stream`, query);
        const logs = data.flatMap((block: any) => block.logs || []);
        return { chain, count: logs.length, latestBlock: head.number };
      })
    );
    const elapsed = Date.now() - startTime;

    const content: string[] = [
      `Querying WETH transfers across 3 chains simultaneously...`,
      `<br><strong>Results:</strong>`,
    ];
    for (const r of batchResults) {
      content.push(`&nbsp;&nbsp;${r.chain}: <span class="number">${r.count.toLocaleString()}</span> transfers (block ${r.latestBlock.toLocaleString()})`);
    }
    content.push(`<br><strong>Total query time: <span class="highlight">${elapsed}ms</span></strong> (parallel execution)`);

    results.push({
      title: "Demo 5: Multi-Chain Batch Query",
      tool: "portal_batch_query",
      why: "Execute identical queries across multiple chains in parallel",
      content,
    });
  }

  // Demo 6: Solana
  {
    const head = await fetchPortal<{ number: number }>("/datasets/solana-mainnet/head");
    const fromSlot = head.number - 50;
    const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

    const query = {
      type: "solana",
      fromBlock: fromSlot,
      toBlock: head.number,
      fields: {
        block: { number: true, timestamp: true },
        instruction: { programId: true, data: true, isCommitted: true },
      },
      instructions: [{ programId: [TOKEN_PROGRAM], isCommitted: true }],
    };

    const data = await streamPortal("/datasets/solana-mainnet/stream", query);
    const allInstructions = data.flatMap((block: any) => block.instructions || []);

    const discriminators = new Map<string, number>();
    for (const ix of allInstructions) {
      const d1 = ix.data?.slice(0, 4) || "empty";
      discriminators.set(d1, (discriminators.get(d1) || 0) + 1);
    }

    const content: string[] = [
      `<strong>Latest Solana slot:</strong> <span class="number">${head.number.toLocaleString()}</span>`,
      `<strong>Token Program instructions found:</strong> <span class="number">${allInstructions.length.toLocaleString()}</span>`,
      `<br><strong>Instruction types (by discriminator):</strong>`,
    ];

    const sorted = [...discriminators.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    for (const [disc, count] of sorted) {
      content.push(`&nbsp;&nbsp;<code>${disc}</code>: ${count.toLocaleString()} occurrences`);
    }

    results.push({
      title: "Demo 6: Solana Blockchain Queries",
      tool: "portal_query_solana_instructions",
      why: "Query Solana instructions by program ID, discriminator, and account filters",
      content,
    });
  }

  // Demo 7: Finalized Only
  {
    const [head, finalizedHead] = await Promise.all([
      fetchPortal<{ number: number }>("/datasets/ethereum-mainnet/head"),
      fetchPortal<{ number: number }>("/datasets/ethereum-mainnet/finalized-head"),
    ]);

    const content: string[] = [
      `<strong>Latest block:</strong> <span class="number">${head.number.toLocaleString()}</span>`,
      `<strong>Finalized block:</strong> <span class="number">${finalizedHead.number.toLocaleString()}</span>`,
      `<strong>Unfinalized blocks:</strong> <span class="number">${(head.number - finalizedHead.number)}</span>`,
      `<br><div class="note">With <code>finalized_only=true</code>, queries are capped at block ${finalizedHead.number.toLocaleString()}</div>`,
      `<div class="note dim">This ensures you never read data that might be reorged away.</div>`,
    ];

    results.push({
      title: "Demo 7: Finalized-Only Mode (v0.5.0)",
      tool: "All query tools support: finalized_only=true",
      why: "Automatically cap queries at the finalized block to avoid reading reorg-prone data",
      content,
    });
  }

  return results;
}

function generateHTML(results: DemoResult[]): string {
  const timestamp = new Date().toISOString();
  
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SQD Portal MCP Server Demo</title>
  <style>
    :root {
      --bg: #0d1117;
      --card-bg: #161b22;
      --border: #30363d;
      --text: #e6edf3;
      --text-dim: #8b949e;
      --accent: #58a6ff;
      --green: #3fb950;
      --purple: #a371f7;
      --yellow: #d29922;
      --cyan: #39c5cf;
    }
    
    * { box-sizing: border-box; margin: 0; padding: 0; }
    
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.6;
      padding: 2rem;
    }
    
    .container { max-width: 900px; margin: 0 auto; }
    
    header {
      text-align: center;
      margin-bottom: 3rem;
      padding: 2rem;
      background: linear-gradient(135deg, #1a1f35 0%, #0d1117 100%);
      border-radius: 12px;
      border: 1px solid var(--border);
    }
    
    .logo {
      font-family: monospace;
      font-size: 0.7rem;
      color: var(--purple);
      white-space: pre;
      margin-bottom: 1rem;
    }
    
    h1 {
      font-size: 1.8rem;
      background: linear-gradient(90deg, var(--accent), var(--purple));
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      margin-bottom: 0.5rem;
    }
    
    .subtitle { color: var(--text-dim); font-size: 1rem; }
    .timestamp { color: var(--text-dim); font-size: 0.8rem; margin-top: 1rem; }
    
    .demo {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 12px;
      margin-bottom: 1.5rem;
      overflow: hidden;
    }
    
    .demo-header {
      background: linear-gradient(90deg, rgba(88, 166, 255, 0.1), transparent);
      padding: 1rem 1.5rem;
      border-bottom: 1px solid var(--border);
    }
    
    .demo-title {
      font-size: 1.2rem;
      color: var(--accent);
      margin-bottom: 0.5rem;
    }
    
    .tool-info {
      display: flex;
      align-items: flex-start;
      gap: 0.5rem;
      padding: 0.75rem 1rem;
      background: rgba(163, 113, 247, 0.1);
      border-radius: 8px;
      margin-top: 0.75rem;
    }
    
    .tool-icon { font-size: 1.2rem; }
    
    .tool-name {
      font-family: monospace;
      color: var(--purple);
      font-weight: 600;
      font-size: 0.95rem;
    }
    
    .tool-why {
      color: var(--text-dim);
      font-size: 0.85rem;
    }
    
    .demo-content {
      padding: 1.5rem;
    }
    
    .demo-content > * { margin-bottom: 0.4rem; }
    
    code {
      font-family: 'SF Mono', Monaco, 'Courier New', monospace;
      background: rgba(110, 118, 129, 0.2);
      padding: 0.2rem 0.4rem;
      border-radius: 4px;
      font-size: 0.85em;
      color: var(--cyan);
    }
    
    .number { color: var(--green); font-weight: 600; }
    .amount { color: var(--green); font-weight: 700; font-size: 1.1em; }
    .highlight { color: var(--yellow); font-weight: 700; }
    
    .tag {
      display: inline-block;
      background: var(--cyan);
      color: var(--bg);
      font-size: 0.7rem;
      padding: 0.15rem 0.5rem;
      border-radius: 10px;
      font-weight: 600;
      margin-left: 0.5rem;
    }
    
    .transfer, .transaction {
      background: rgba(63, 185, 80, 0.1);
      border-left: 3px solid var(--green);
      padding: 0.75rem 1rem;
      margin: 0.75rem 0;
      border-radius: 0 8px 8px 0;
    }
    
    .transfer > *, .transaction > * { display: block; margin-bottom: 0.25rem; }
    
    .note {
      padding: 0.75rem 1rem;
      background: rgba(210, 153, 34, 0.1);
      border-radius: 8px;
      color: var(--yellow);
    }
    
    .note.dim { color: var(--text-dim); background: transparent; }
    
    footer {
      text-align: center;
      padding: 2rem;
      color: var(--text-dim);
      font-size: 0.9rem;
    }
    
    .tools-list {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 0.5rem;
      margin-top: 1rem;
      text-align: left;
    }
    
    .tools-list li {
      list-style: none;
      padding-left: 1.5rem;
      position: relative;
    }
    
    .tools-list li::before {
      content: "•";
      position: absolute;
      left: 0.5rem;
      color: var(--accent);
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div class="logo">███████╗ ██████╗ ██████╗     ██████╗  ██████╗ ██████╗ ████████╗ █████╗ ██╗     
██╔════╝██╔═══██╗██╔══██╗    ██╔══██╗██╔═══██╗██╔══██╗╚══██╔══╝██╔══██╗██║     
███████╗██║   ██║██║  ██║    ██████╔╝██║   ██║██████╔╝   ██║   ███████║██║     
╚════██║██║▄▄ ██║██║  ██║    ██╔═══╝ ██║   ██║██╔══██╗   ██║   ██╔══██║██║     
███████║╚██████╔╝██████╔╝    ██║     ╚██████╔╝██║  ██║   ██║   ██║  ██║███████╗
╚══════╝ ╚══▀▀═╝ ╚═════╝     ╚═╝      ╚═════╝ ╚═╝  ╚═╝   ╚═╝   ╚═╝  ╚═╝╚══════╝</div>
      <h1>MCP Server Demo - Version 0.5.0</h1>
      <p class="subtitle">Showcasing blockchain data access via Model Context Protocol</p>
      <p class="timestamp">Generated: ${timestamp}</p>
    </header>

    ${results.map(r => `
    <div class="demo">
      <div class="demo-header">
        <div class="demo-title">${r.title}</div>
        <div class="tool-info">
          <span class="tool-icon">🔧</span>
          <div>
            <div class="tool-name">${r.tool}</div>
            <div class="tool-why">${r.why}</div>
          </div>
        </div>
      </div>
      <div class="demo-content">
        ${r.content.join('\n        ')}
      </div>
    </div>
    `).join('')}

    <footer>
      <strong>The MCP server provides 23 tools covering:</strong>
      <ul class="tools-list">
        <li>Dataset discovery and search</li>
        <li>Block, transaction, and log queries</li>
        <li>Trace and state diff analysis</li>
        <li>ERC-20/ERC-721 transfer helpers</li>
        <li>Solana instructions, balances, rewards</li>
        <li>Multi-chain batch queries</li>
        <li>Event log decoding</li>
        <li>Address activity tracking</li>
      </ul>
    </footer>
  </div>
</body>
</html>`;
}

async function main() {
  console.log("Running demos and generating HTML...\n");
  
  try {
    const results = await runDemos();
    const html = generateHTML(results);
    
    writeFileSync("demo-report.html", html);
    console.log("✓ Demo report exported to: demo-report.html");
    console.log("\nOpen in browser to view the styled report.");
  } catch (error) {
    console.error("Error:", error);
    process.exit(1);
  }
}

main();
