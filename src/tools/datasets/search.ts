import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getDatasets } from "../../cache/datasets.js";
import { formatResult } from "../../helpers/format.js";

// ============================================================================
// Tool: Search Datasets
// ============================================================================

export function registerSearchDatasetsTool(server: McpServer) {
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
}
