import {
  PORTAL_URL,
  MAX_RECOMMENDED_BLOCK_RANGE,
} from "../constants/index.js";
import type { Dataset, DatasetMetadata, BlockHead } from "../types/index.js";
import { portalFetch } from "../helpers/fetch.js";

// ============================================================================
// Dataset Cache
// ============================================================================

const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
let datasetsCache: { data: Dataset[]; timestamp: number } | null = null;

export async function getDatasets(): Promise<Dataset[]> {
  if (datasetsCache && Date.now() - datasetsCache.timestamp < CACHE_TTL) {
    return datasetsCache.data;
  }
  const data = await portalFetch<Dataset[]>(`${PORTAL_URL}/datasets`);
  datasetsCache = { data, timestamp: Date.now() };
  return data;
}

export async function validateDataset(dataset: string): Promise<void> {
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

export async function getDatasetMetadata(dataset: string): Promise<{
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
