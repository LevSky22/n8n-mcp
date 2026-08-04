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

  it('lists the reader by default and omits it when disabled', async () => {
    const enabledServer = new TestableN8NMCPServer();
    const enabled = await enabledServer.testListTools();
    expect(enabled.tools.map((tool: any) => tool.name)).toContain('read_response_artifact');

    process.env.DISABLED_TOOLS = 'read_response_artifact';
    const disabledServer = new TestableN8NMCPServer();
    const disabled = await disabledServer.testListTools();
    expect(disabled.tools.map((tool: any) => tool.name)).not.toContain('read_response_artifact');
  });

  it('requires an artifact id', async () => {
    const server = new TestableN8NMCPServer();
    await expect(server.testExecuteTool('read_response_artifact', {})).rejects.toThrow(
      'artifactId is required',
    );
  });

  it('reads artifacts in the default instance scope', async () => {
    const artifact = persistResponseArtifact({ value: 'default' }, 'default-instance');
    const server = new TestableN8NMCPServer();

    const result = await server.testExecuteTool('read_response_artifact', { artifactId: artifact.id });

    expect(result.artifact_id).toBe(artifact.id);
    expect(JSON.parse(result.text)).toEqual({ value: 'default' });
  });

  it('reads artifacts in the configured tenant scope', async () => {
    const context: InstanceContext = {
      n8nApiUrl: 'https://example.n8n.cloud',
      n8nApiKey: 'api-key',
      instanceId: 'tenant-a',
    };
    const artifact = persistResponseArtifact({ value: 'tenant' }, getInstanceScopeId(context));
    const server = new TestableN8NMCPServer(context);

    const result = await server.testExecuteTool('read_response_artifact', { artifactId: artifact.id });

    expect(JSON.parse(result.text)).toEqual({ value: 'tenant' });
  });
});
