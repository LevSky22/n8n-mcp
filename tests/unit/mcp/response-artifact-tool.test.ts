import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { N8NDocumentationMCPServer } from '../../../src/mcp/server';
import { persistResponseArtifact } from '../../../src/services/mcp-response-bounding';
import { getInstanceScopeId, type InstanceContext } from '../../../src/types/instance-context';

vi.mock('../../../src/database/database-adapter');
vi.mock('../../../src/database/node-repository');
vi.mock('../../../src/templates/template-service');
vi.mock('../../../src/utils/logger');

class TestableN8NMCPServer extends N8NDocumentationMCPServer {
  public async testExecuteTool(name: string, args: any): Promise<any> {
    return (this as any).executeTool(name, args);
  }

  public async testListTools(): Promise<any> {
    const handler = (this as any).server._requestHandlers?.get('tools/list');
    if (!handler) throw new Error('tools/list handler not registered');
    return handler({ method: 'tools/list', params: {} }, {});
  }

  public testFindToolSchema(name: string): any {
    return (this as any).findToolSchema(name);
  }

  public async testCallTool(name: string, args: Record<string, unknown>): Promise<any> {
    const handler = (this as any).server._requestHandlers?.get('tools/call');
    if (!handler) throw new Error('tools/call handler not registered');
    // SDK v2 wraps tools/call (and prompts/get, resources/read) in an
    // input-required-capable handler that reads ctx.mcpReq.requestState()
    // before invoking the registered handler. Our own handler ignores ctx,
    // but the SDK wrapper still requires the accessor to exist.
    return handler(
      { method: 'tools/call', params: { name, arguments: args } },
      { mcpReq: { requestState: () => undefined } }
    );
  }
}

describe('response artifact MCP tool', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'n8n-mcp-artifact-tool-'));
    process.env.MCP_RESPONSE_ARTIFACT_ROOT = root;
    process.env.NODE_DB_PATH = path.join(root, 'nodes.db');
  });

  afterEach(() => {
    delete process.env.MCP_RESPONSE_ARTIFACT_ROOT;
    delete process.env.NODE_DB_PATH;
    delete process.env.DISABLED_TOOLS;
    rmSync(root, { recursive: true, force: true });
  });

  it('lists only the semantic artifact query and omits it when disabled', async () => {
    const enabledServer = new TestableN8NMCPServer();
    const enabled = await enabledServer.testListTools();
    expect(enabled.tools.map((tool: any) => tool.name)).not.toContain('read_response_artifact');
    expect(enabled.tools.map((tool: any) => tool.name)).toContain('query_response_artifact');

    process.env.DISABLED_TOOLS = 'query_response_artifact';
    const disabledServer = new TestableN8NMCPServer();
    const disabled = await disabledServer.testListTools();
    expect(disabled.tools.map((tool: any) => tool.name)).not.toContain('read_response_artifact');
    expect(disabled.tools.map((tool: any) => tool.name)).not.toContain('query_response_artifact');
  });

  it('resolves the structured artifact query schema as a built-in tool', () => {
    const server = new TestableN8NMCPServer();
    expect(server.testFindToolSchema('query_response_artifact')).toMatchObject({
      name: 'query_response_artifact',
      inputSchema: { required: ['artifactId'], additionalProperties: false },
      annotations: { readOnlyHint: true, idempotentHint: true },
    });
  });

  it('queries artifacts in the configured tenant scope', async () => {
    const context: InstanceContext = {
      n8nApiUrl: 'https://example.n8n.cloud',
      n8nApiKey: 'api-key',
      instanceId: 'tenant-a',
    };
    const artifact = persistResponseArtifact(
      { rows: [{ id: 1, payload: 'large' }, { id: 2, payload: 'large' }] },
      getInstanceScopeId(context),
    );
    const server = new TestableN8NMCPServer(context);

    const response = await server.testCallTool('query_response_artifact', {
      artifactId: artifact.id,
      responsePath: '/rows',
      fields: ['id'],
      pageSize: 20,
    });
    const result = JSON.parse(response.content[0].text);

    expect(result.response).toEqual([{ id: 1 }, { id: 2 }]);
    expect(result.responseMeta).toMatchObject({
      complete: true,
      returnedCount: 2,
      totalCount: 2,
      remainingCount: 0,
    });
  });

  it('requires an artifact id and defaults an omitted response path to the artifact root', async () => {
    const server = new TestableN8NMCPServer();
    await expect(server.testExecuteTool('query_response_artifact', {})).rejects.toThrow(
      'artifactId is required',
    );
    const artifact = persistResponseArtifact('root text', 'default-instance');
    const result = await server.testExecuteTool('query_response_artifact', { artifactId: artifact.id }) as any;
    expect(result).toMatchObject({ artifactId: artifact.id, responsePath: '', response: 'root text' });
    await expect(server.testExecuteTool('query_response_artifact', {
      artifactId: artifact.id,
      responsePath: 42,
    })).rejects.toThrow('responsePath must be an RFC 6901 string');
  });
});
