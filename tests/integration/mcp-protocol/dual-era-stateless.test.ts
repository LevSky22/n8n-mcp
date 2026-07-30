import { afterEach, describe, expect, it } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createDualEraStatelessMcpHandler } from '../../../src/http-server-single-session';

describe('dual-era stateless MCP handler', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  async function connect(mode: 'legacy' | 'modern') {
    const dualEraHandler = createDualEraStatelessMcpHandler();
    const client = new Client(
      { name: `n8n-mcp-${mode}-test`, version: '1.0.0' },
      mode === 'modern'
        ? { versionNegotiation: { mode: { pin: '2026-07-28' } } }
        : {}
    );
    const transport = new StreamableHTTPClientTransport(
      new URL('http://n8n-mcp.test/mcp'),
      {
        fetch: (url, init) => dualEraHandler.handler.fetch(new Request(url, init)),
      }
    );

    cleanups.push(async () => {
      await client.close();
      await dualEraHandler.close();
    });
    await client.connect(transport);
    return client;
  }

  it('serves initialize-era clients without a session', async () => {
    const client = await connect('legacy');
    const result = await client.listTools();
    const callResult = await client.callTool({
      name: 'tools_documentation',
      arguments: { topic: 'overview', depth: 'essentials' },
    });

    expect(client.getProtocolEra()).toBe('legacy');
    expect(result.tools.some((tool) => tool.name === 'search_nodes')).toBe(true);
    expect(callResult.content[0]?.type).toBe('text');
  });

  it('serves MCP 2026-07-28 clients on the same handler', async () => {
    const client = await connect('modern');
    const result = await client.listTools();
    const callResult = await client.callTool({
      name: 'tools_documentation',
      arguments: { topic: 'overview', depth: 'essentials' },
    });

    expect(client.getProtocolEra()).toBe('modern');
    expect(result.tools.some((tool) => tool.name === 'search_nodes')).toBe(true);
    expect(callResult.content[0]?.type).toBe('text');
  });
});
