import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { N8NDocumentationMCPServer } from '../../../src/mcp/server';
import { n8nFriendlyDescriptions } from '../../../src/mcp/tools-n8n-friendly';

vi.mock('../../../src/database/database-adapter');
vi.mock('../../../src/database/node-repository');
vi.mock('../../../src/templates/template-service');
vi.mock('../../../src/utils/logger');

class TestableN8NMCPServer extends N8NDocumentationMCPServer {
  public async simulateToolListRequest(clientName: string): Promise<any> {
    (this as any).clientInfo = { name: clientName, version: '1.0.0' };

    const handler = (this as any).server._requestHandlers?.get('tools/list');
    if (!handler) {
      throw new Error('tools/list handler not registered');
    }

    return handler({ method: 'tools/list', params: {} }, {});
  }
}

describe('n8n-friendly tool descriptions', () => {
  beforeEach(() => {
    process.env.NODE_DB_PATH = ':memory:';
  });

  afterEach(() => {
    delete process.env.NODE_DB_PATH;
    delete process.env.N8N_MODE;
  });

  it.each([
    { mode: 'true', clientName: 'generic-mcp-client', expected: true },
    { mode: 'false', clientName: 'n8n-mcp-client', expected: true },
    { mode: 'false', clientName: 'langchain-client', expected: true },
    { mode: 'false', clientName: 'generic-mcp-client', expected: false },
  ])('applies descriptions when N8N_MODE=$mode for $clientName', async ({ mode, clientName, expected }) => {
    process.env.N8N_MODE = mode;
    const server = new TestableN8NMCPServer();

    const result = await server.simulateToolListRequest(clientName);
    const searchNodes = result.tools.find((tool: { name: string }) => tool.name === 'search_nodes');

    expect(searchNodes).toBeDefined();
    expect(searchNodes.description === n8nFriendlyDescriptions.search_nodes.description).toBe(expected);
  });
});
