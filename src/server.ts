import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { VERSION } from "./constants/index.js";
import { registerSchemaResource } from "./resources/schema.js";
import { registerAllTools } from "./tools/index.js";

// ============================================================================
// Server Factory
// ============================================================================

export function createPortalServer(): McpServer {
  const server = new McpServer({
    name: "sqd-portal-mcp-server",
    version: VERSION,
  });

  // Register resources
  registerSchemaResource(server);

  // Register all tools
  registerAllTools(server);

  return server;
}
