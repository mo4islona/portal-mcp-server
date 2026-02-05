import {
  PORTAL_URL,
  MAX_RECOMMENDED_BLOCK_RANGE,
} from "../constants/index.js";
import type { Dataset, DatasetMetadata, BlockHead } from "../types/index.js";
import { portalFetch } from "../helpers/fetch.js";

// ============================================================================
// Dataset Cache & Request Deduplication
// ============================================================================

const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const HEAD_CACHE_TTL = 30 * 1000; // 30 seconds (blocks change every 2-12s)

let datasetsCache: { data: Dataset[]; timestamp: number } | null = null;
let headCache = new Map<string, { head: BlockHead; timestamp: number }>();
let metadataCache = new Map<string, { data: { start_block: number; head: BlockHead; finalized_head?: BlockHead }; timestamp: number }>();

// Request deduplication: prevent concurrent requests for same resource
const pendingRequests = new Map<string, Promise<any>>();

/**
 * Deduplicate concurrent requests to the same resource.
 * Multiple callers get the same Promise, avoiding duplicate API calls.
 */
function dedupe<T>(key: string, fn: () => Promise<T>): Promise<T> {
  if (!pendingRequests.has(key)) {
    const promise = fn().finally(() => pendingRequests.delete(key));
    pendingRequests.set(key, promise);
  }
  return pendingRequests.get(key) as Promise<T>;
}

export async function getDatasets(): Promise<Dataset[]> {
  if (datasetsCache && Date.now() - datasetsCache.timestamp < CACHE_TTL) {
    return datasetsCache.data;
  }

  return dedupe('datasets', async () => {
    const data = await portalFetch<Dataset[]>(`${PORTAL_URL}/datasets`);
    datasetsCache = { data, timestamp: Date.now() };
    return data;
  });
}

// Common chain name aliases
const CHAIN_ALIASES: Record<string, string[]> = {
  "hyperliquid-mainnet": ["hyperevm", "hyperl", "hyper"],
  "arbitrum-one": ["arbitrum", "arb"],
  "optimism-mainnet": ["optimism", "op"],
  "polygon-mainnet": ["polygon", "matic"],
  "avalanche-mainnet": ["avalanche", "avax"],
  "binance-mainnet": ["bsc", "bnb", "binance"],
  "base-mainnet": ["base"],
  "ethereum-mainnet": ["ethereum", "eth"],
};

/**
 * Resolve a dataset name or alias to the canonical dataset name.
 * Supports fuzzy matching for common shortcuts like "polygon" -> "polygon-mainnet"
 */
export async function resolveDataset(dataset: string): Promise<string> {
  const datasets = await getDatasets();

  // Exact match
  const exactMatch = datasets.find(
    (d) => d.dataset === dataset || d.aliases.includes(dataset),
  );
  if (exactMatch) {
    return exactMatch.dataset;
  }

  // Fuzzy match: prefer mainnet if user provides just the chain name
  const lowerDataset = dataset.toLowerCase();

  // Check common aliases first
  for (const [canonicalName, aliases] of Object.entries(CHAIN_ALIASES)) {
    if (aliases.some((a) => a === lowerDataset || lowerDataset.includes(a) || a.includes(lowerDataset))) {
      return canonicalName;
    }
  }

  // Try "{name}-mainnet" first
  const mainnetMatch = datasets.find(
    (d) => d.dataset === `${lowerDataset}-mainnet`
  );
  if (mainnetMatch) {
    return mainnetMatch.dataset;
  }

  // Try partial match on dataset name
  const partialMatches = datasets.filter(
    (d) =>
      d.dataset.toLowerCase().startsWith(lowerDataset) ||
      d.dataset.toLowerCase().includes(`-${lowerDataset}-`) ||
      (lowerDataset.includes("-") && d.dataset.toLowerCase().includes(lowerDataset))
  );

  // If multiple matches, prefer mainnet
  if (partialMatches.length > 0) {
    const preferredMatch = partialMatches.find((d) => d.dataset.includes("-mainnet")) || partialMatches[0];
    return preferredMatch.dataset;
  }

  // No match found - provide suggestions
  const suggestions = datasets
    .filter(
      (d) =>
        d.dataset.toLowerCase().includes(lowerDataset) ||
        lowerDataset.includes(d.dataset.split("-")[0].toLowerCase()),
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

export async function validateDataset(dataset: string): Promise<void> {
  // Just call resolveDataset and ignore the result - will throw if invalid
  await resolveDataset(dataset);
}

/**
 * Get block head with caching (30s TTL).
 * Blocks are produced every 2-12s depending on chain, so 30s cache is safe.
 */
export async function getBlockHead(dataset: string, finalized = false): Promise<BlockHead> {
  const cacheKey = `${dataset}:${finalized ? 'finalized' : 'head'}`;
  const cached = headCache.get(cacheKey);

  if (cached && Date.now() - cached.timestamp < HEAD_CACHE_TTL) {
    return cached.head;
  }

  return dedupe(cacheKey, async () => {
    const endpoint = finalized ? 'finalized-head' : 'head';
    const head = await portalFetch<BlockHead>(`${PORTAL_URL}/datasets/${dataset}/${endpoint}`);
    headCache.set(cacheKey, { head, timestamp: Date.now() });
    return head;
  });
}

export async function getDatasetMetadata(dataset: string): Promise<{
  start_block: number;
  head: BlockHead;
  finalized_head?: BlockHead;
}> {
  // Check cache first (30s TTL for metadata too)
  const cached = metadataCache.get(dataset);
  if (cached && Date.now() - cached.timestamp < HEAD_CACHE_TTL) {
    return cached.data;
  }

  return dedupe(`metadata:${dataset}`, async () => {
    const [metadata, head, finalizedHead] = await Promise.all([
      portalFetch<DatasetMetadata>(`${PORTAL_URL}/datasets/${dataset}/metadata`),
      getBlockHead(dataset, false),
      getBlockHead(dataset, true).catch(() => undefined),
    ]);

    const result = {
      start_block: metadata.start_block,
      head,
      finalized_head: finalizedHead,
    };

    metadataCache.set(dataset, { data: result, timestamp: Date.now() });
    return result;
  });
}

export async function validateBlockRange(
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

  // Warn about large block ranges (informational only, not an error)
  // Based on real Portal API benchmarks: 10k blocks = ~500ms, 5k blocks = ~100ms
  const blockRange = validatedToBlock - fromBlock;
  if (blockRange > MAX_RECOMMENDED_BLOCK_RANGE.LOGS) {
    console.warn(
      `WARNING: LARGE RANGE: ${blockRange.toLocaleString()} blocks (${fromBlock} → ${validatedToBlock}).\n` +
        `   For fast responses (<1-3s), use smaller ranges:\n` +
        `   - Logs: <${MAX_RECOMMENDED_BLOCK_RANGE.LOGS.toLocaleString()} blocks (~500ms)\n` +
        `   - Transactions: <${MAX_RECOMMENDED_BLOCK_RANGE.TRANSACTIONS.toLocaleString()} blocks (~100ms)\n` +
        `   - Traces: <${MAX_RECOMMENDED_BLOCK_RANGE.TRACES.toLocaleString()} blocks (expensive)\n` +
        `   Large ranges may take >15s or timeout.`,
    );
  }

  return {
    validatedToBlock,
    head:
      finalizedOnly && meta.finalized_head ? meta.finalized_head : meta.head,
  };
}
