# SQD Portal MCP Server

MCP server wrapping the SQD Portal API.

## Tools

| Tool | Endpoint |
|------|----------|
| `portal_list_datasets` | GET /datasets |
| `portal_get_metadata` | GET /datasets/{dataset}/metadata |
| `portal_get_head` | GET /datasets/{dataset}/head |
| `portal_get_finalized_head` | GET /datasets/{dataset}/finalized-head |
| `portal_block_at_timestamp` | GET /datasets/{dataset}/timestamps/{timestamp}/block |
| `portal_stream` | POST /datasets/{dataset}/stream |
| `portal_finalized_stream` | POST /datasets/{dataset}/finalized-stream |

## Setup

```bash
npm install
npm run build
```

## Test with MCP Inspector

```bash
npm run inspect
```

## Use with Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "sqd-portal": {
      "command": "node",
      "args": ["/path/to/sqd-portal-mcp/dist/index.js"]
    }
  }
}
```
