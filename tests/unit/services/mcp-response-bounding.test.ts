import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ARTIFACT_PAGE_BYTES,
  HARD_RESULT_BYTES,
  INLINE_RESULT_BYTES,
  boundToolResult,
  persistResponseArtifact,
  pruneResponseArtifacts,
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
    rmSync(root, { recursive: true, force: true });
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

  it('reconstructs unicode artifact JSON exactly across page boundaries', () => {
    const value = { text: '🐝é'.repeat(20_000) };
    const expected = JSON.stringify(value);
    const bounded = boundToolResult('additional_large_tool', value, 'tenant-a') as any;
    const artifactId = bounded.response_meta.artifact.id as string;
    let cursor: string | undefined;
    let reconstructed = '';

    do {
      const page = readResponseArtifact(artifactId, cursor, 'tenant-a') as any;
      reconstructed += page.text;
      cursor = page.response_meta.next_cursor ?? undefined;
    } while (cursor);

    expect(reconstructed).toBe(expected);
    expect(JSON.parse(reconstructed)).toEqual(value);
  });

  it('summarizes oversized execution lists while retaining pagination metadata', () => {
    const value = {
      success: true,
      data: {
        executions: Array.from({ length: 40 }, (_, index) => ({
          id: String(index),
          workflowId: 'workflow-1',
          status: 'success',
          mode: 'manual',
          startedAt: '2026-08-04T00:00:00.000Z',
          stoppedAt: '2026-08-04T00:00:01.000Z',
          finished: true,
          data: 'x'.repeat(1000),
        })),
        nextCursor: 'upstream-cursor',
      },
    };

    const bounded = boundToolResult('n8n_executions', value, 'tenant-a') as any;
    expect(bounded.data.data.executions).toHaveLength(20);
    expect(bounded.data.data).toMatchObject({
      returned: 20,
      total_count: 40,
      nextCursor: 'upstream-cursor',
      hasMore: true,
    });
    expect(bounded.data.data.executions[0]).not.toHaveProperty('data');
  });

  it('rejects invalid and missing artifact identifiers', () => {
    expect(() => readResponseArtifact('../escape', undefined, 'tenant-a')).toThrow('Invalid artifact id');
    expect(() => readResponseArtifact('a'.repeat(20), undefined, 'tenant-a')).toThrow(
      'not found or has expired',
    );
  });

  it('deletes expired artifacts when they are read', () => {
    const value = { records: Array.from({ length: 100 }, (_, i) => ({ i, text: 'z'.repeat(1000) })) };
    const bounded = boundToolResult('additional_large_tool', value, 'tenant-a') as any;
    const artifactId = bounded.response_meta.artifact.id as string;
    const dataPath = path.join(root, `response-${artifactId}.json`);
    const metaPath = path.join(root, `response-${artifactId}.meta.json`);
    const metadata = JSON.parse(readFileSync(metaPath, 'utf8'));
    metadata.expires_at = '2000-01-01T00:00:00.000Z';
    writeFileSync(metaPath, JSON.stringify(metadata));

    expect(() => readResponseArtifact(artifactId, undefined, 'tenant-a')).toThrow('has expired');
    expect(existsSync(dataPath)).toBe(false);
    expect(existsSync(metaPath)).toBe(false);
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

  it('rejects a valid cursor used for another artifact', () => {
    const firstValue = { records: Array.from({ length: 100 }, (_, i) => ({ i, text: 'a'.repeat(1000) })) };
    const secondValue = { records: Array.from({ length: 100 }, (_, i) => ({ i, text: 'b'.repeat(1000) })) };
    const firstBounded = boundToolResult('additional_large_tool', firstValue, 'tenant-a') as any;
    const secondBounded = boundToolResult('additional_large_tool', secondValue, 'tenant-a') as any;
    const firstPage = readResponseArtifact(
      firstBounded.response_meta.artifact.id,
      undefined,
      'tenant-a',
    ) as any;

    expect(() => readResponseArtifact(
      secondBounded.response_meta.artifact.id,
      firstPage.response_meta.next_cursor,
      'tenant-a',
    )).toThrow('Invalid artifact cursor');
  });

  it('rejects a cursor that is too short to contain a signature', () => {
    const artifact = persistResponseArtifact({ value: 'small' }, 'tenant-a');
    expect(() => readResponseArtifact(artifact.id, 'short', 'tenant-a')).toThrow(
      'Invalid artifact cursor',
    );
  });

  it('uses the default temporary artifact root when no override is configured', () => {
    delete process.env.MCP_RESPONSE_ARTIFACT_ROOT;
    const artifact = persistResponseArtifact({ value: 'default-root' }, 'tenant-a');
    const defaultRoot = '/tmp/n8n-mcp-artifacts';
    const dataPath = path.join(defaultRoot, `response-${artifact.id}.json`);
    const metaPath = path.join(defaultRoot, `response-${artifact.id}.meta.json`);

    try {
      expect(existsSync(dataPath)).toBe(true);
      expect(existsSync(metaPath)).toBe(true);
    } finally {
      rmSync(dataPath, { force: true });
      rmSync(metaPath, { force: true });
      process.env.MCP_RESPONSE_ARTIFACT_ROOT = root;
    }
  });

  it('returns immediately when pruning a missing artifact root', () => {
    process.env.MCP_RESPONSE_ARTIFACT_ROOT = path.join(root, 'missing');
    expect(() => pruneResponseArtifacts()).not.toThrow();
  });

  it('prunes expired artifact data and tolerates missing metadata', () => {
    const artifact = persistResponseArtifact({ value: 'expired' }, 'tenant-a');
    const dataPath = path.join(root, `response-${artifact.id}.json`);
    const metaPath = path.join(root, `response-${artifact.id}.meta.json`);
    unlinkSync(metaPath);
    const old = new Date(Date.now() - (25 * 60 * 60 * 1000));
    utimesSync(dataPath, old, old);

    pruneResponseArtifacts();

    expect(existsSync(dataPath)).toBe(false);
    expect(existsSync(metaPath)).toBe(false);
  });

  it('prunes expired artifact data together with its metadata sidecar', () => {
    const artifact = persistResponseArtifact({ value: 'expired-with-metadata' }, 'tenant-a');
    const dataPath = path.join(root, `response-${artifact.id}.json`);
    const metaPath = path.join(root, `response-${artifact.id}.meta.json`);
    const old = new Date(Date.now() - (25 * 60 * 60 * 1000));
    utimesSync(dataPath, old, old);

    pruneResponseArtifacts();

    expect(existsSync(dataPath)).toBe(false);
    expect(existsSync(metaPath)).toBe(false);
  });

  it('rejects artifacts above the individual size limit', () => {
    const value = { text: 'x'.repeat(50 * 1024 * 1024) };
    expect(() => persistResponseArtifact(value, 'tenant-a')).toThrow('artifact limit');
  });

  it('uses safe workflow fallbacks when success and nodes are absent', () => {
    const value = {
      data: {
        id: 'workflow-no-nodes',
        name: 'No nodes',
        connections: { payload: 'x'.repeat(40_000) },
      },
    };

    const bounded = boundToolResult('n8n_get_workflow', value, 'tenant-a') as any;
    expect(bounded.data).toMatchObject({
      success: true,
      data: { id: 'workflow-no-nodes', nodeCount: 0, nodes: [] },
    });
  });

  it('reports a short execution page without an upstream cursor as complete', () => {
    const value = {
      data: {
        executions: Array.from({ length: 5 }, (_, index) => ({
          id: String(index),
          workflowId: 'workflow-1',
          status: 'success',
          data: 'x'.repeat(8_000),
        })),
      },
    };

    const bounded = boundToolResult('n8n_executions', value, 'tenant-a') as any;
    expect(bounded.data.success).toBe(true);
    expect(bounded.data.data).toMatchObject({ returned: 5, total_count: 5, hasMore: false });
  });

  it('compacts oversized summaries until the inline budget is met', () => {
    const value = {
      success: true,
      data: {
        id: 'workflow-wide-summary',
        name: 'Wide summary',
        nodes: Array.from({ length: 100 }, (_, index) => ({
          id: `node-${index}`,
          name: `Node ${index} ${'x'.repeat(2_000)}`,
          type: 'n8n-nodes-base.code',
          parameters: { jsCode: 'y'.repeat(2_000) },
        })),
        connections: {},
      },
    };

    const bounded = boundToolResult('n8n_get_workflow', value, 'tenant-a') as any;
    expect(bounded.response_meta.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(bounded))).toBeLessThanOrEqual(INLINE_RESULT_BYTES);
    expect(bounded.response_meta.artifact).toBeTruthy();
  });

  it('reports omitted fields when compacting wide objects', () => {
    const value = {
      payload: 'x'.repeat(40_000),
      wide: Object.fromEntries(Array.from({ length: 25 }, (_, index) => [`field_${index}`, index])),
    };

    const bounded = boundToolResult('additional_large_tool', value, 'tenant-a') as any;

    expect(bounded.data.wide._omitted_fields).toBe(5);
    expect(Object.keys(bounded.data.wide)).toHaveLength(21);
  });
});
