#!/usr/bin/env node
/**
 * KFC China MCP server (stdio).
 *
 * Hermes Agent config:
 *   mcp_servers:
 *     kfc_cn:
 *       command: node
 *       args: ["/abs/path/to/kfc-cn-mcp/dist/index.js"]
 *
 * All diagnostics go to stderr; stdout is the MCP transport.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { KfcClient, loadConfig } from './client.js';
import { createServer } from './tools.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const client = new KfcClient(config);
  await client.load();

  const server = createServer(client);
  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.stderr.write(
    `[kfc-cn-mcp] ready (state=${config.stateDir}, city=${config.cityCode})\n`,
  );

  let closing = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (closing) return;
    closing = true;
    process.stderr.write(`[kfc-cn-mcp] shutting down (${signal})\n`);
    try {
      await server.close();
    } catch {
      // ignore
    }
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`[kfc-cn-mcp] fatal: ${message}\n`);
  process.exit(1);
});
