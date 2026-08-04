import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ARTIFACT_PAGE_BYTES,
  HARD_RESULT_BYTES,
  INLINE_RESULT_BYTES,
  boundToolResult,
  readResponseArtifact,
} from '../../../src/services/mcp-response-bounding';

describe('MCP response bounding', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'n8n-mcp-response-'));
    process.env.MCP_RESPONSE_ARTIFACT_ROOT = root;
  });

  afterEach(() => {
    delete process.env.MCP_RESPONSE_ARTIFACT_ROOT;
  });

  it('preserves compact results for backward compatibility', () => {
    const value = { success: true, data: { id: 'workflow-1', name: 'Small' } };
    expect(boundToolResult('n8n_get_workflow', value, 'tenant-a')).toBe(value);
  });

  it('stores large results and returns a compact workflow structure', () => {
    const value = {
      success: true,
      data: {
        id: 'workflow-1',
        name: 'Large workflow',
        active: true,
        nodes: Array.from({ length: 40 }, (_, index) => ({
          id: `node-${index}`,
          name: `Node ${index}`,
          type: 'n8n-nodes-base.code',
          parameters: { jsCode: 'x'.repeat(3000) },
        })),
        connections: {},
      },
    };

    const bounded = boundToolResult('n8n_get_workflow', value, 'tenant-a') as any;
    expect(bounded.response_meta.truncated).toBe(true);
    expect(bounded.response_meta.artifact.byte_length).toBeGreaterThan(INLINE_RESULT_BYTES);
    expect(bounded.data.data.nodes).toHaveLength(40);
    expect(Buffer.byteLength(JSON.stringify(bounded))).toBeLessThan(HARD_RESULT_BYTES);
    const artifact = readFileSync(
      path.join(root, `response-${bounded.response_meta.artifact.id}.json`),
      'utf8',
    );
    expect(JSON.parse(artifact)).toEqual(value);
  });

  it('pages artifact reads and binds them to the instance scope', () => {
    const value = { records: Array.from({ length: 100 }, (_, i) => ({ i, text: 'z'.repeat(1000) })) };
    const bounded = boundToolResult('additional_large_tool', value, 'tenant-a') as any;
    const first = readResponseArtifact(bounded.response_meta.artifact.id, undefined, 'tenant-a') as any;
    expect(Buffer.byteLength(first.text)).toBeLessThanOrEqual(ARTIFACT_PAGE_BYTES + 3);
    expect(first.response_meta.next_cursor).toBeTruthy();
    expect(() => readResponseArtifact(bounded.response_meta.artifact.id, undefined, 'tenant-b')).toThrow(
      'different MCP scope',
    );
  });

  it('rejects a tampered artifact cursor', () => {
    const value = { records: Array.from({ length: 100 }, (_, i) => ({ i, text: 'z'.repeat(1000) })) };
    const bounded = boundToolResult('n8n_executions', value, 'tenant-a') as any;
    const first = readResponseArtifact(bounded.response_meta.artifact.id, undefined, 'tenant-a') as any;
    const cursor = first.response_meta.next_cursor as string;
    const midpoint = Math.floor(cursor.length / 2);
    const tampered = `${cursor.slice(0, midpoint)}${cursor[midpoint] === 'A' ? 'B' : 'A'}${cursor.slice(midpoint + 1)}`;
    expect(() => readResponseArtifact(bounded.response_meta.artifact.id, tampered, 'tenant-a')).toThrow(
      'Invalid artifact cursor',
    );
  });
});
