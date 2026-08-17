import { createHash, createHmac } from 'crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ARTIFACT_PAGE_BYTES,
  HARD_RESULT_BYTES,
  INLINE_RESULT_BYTES,
  boundToolResult,
  persistResponseArtifact,
  pruneResponseArtifacts,
  queryResponseArtifact,
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
    delete process.env.MCP_RESPONSE_CURSOR_KEY;
    delete process.env.MCP_RESPONSE_INLINE_BYTES;
    delete process.env.MCP_RESPONSE_PREVIEW_BYTES;
    delete process.env.MCP_RESPONSE_HARD_BYTES;
    delete process.env.MCP_RESPONSE_ARTIFACT_PAGE_BYTES;
    delete process.env.MCP_RESPONSE_ARTIFACT_MAX_BYTES;
    delete process.env.MCP_RESPONSE_ARTIFACT_TTL_MS;
    delete process.env.MCP_RESPONSE_ARTIFACT_QUOTA_BYTES;
    delete process.env.MCP_RESPONSE_PARSE_CACHE_TTL_MS;
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
    expect(bounded.response_meta.complete).toBe(false);
    expect(bounded.response_meta.warning).toContain('INCOMPLETE RESULT');
    expect(bounded.response_meta.artifact.byte_length).toBeGreaterThan(INLINE_RESULT_BYTES);
    expect(bounded.response_meta.artifact.query_tool).toBe('query_response_artifact');
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
      // page_count is the size of the upstream page, not a global total.
      page_count: 40,
      nextCursor: 'upstream-cursor',
      hasMore: true,
    });
    expect(bounded.data.data).not.toHaveProperty('total_count');
    expect(bounded.data.data.executions[0]).not.toHaveProperty('data');
  });

  it('rejects invalid ids and distinguishes an unknown handle from an expired one', () => {
    expect(() => readResponseArtifact('../escape', undefined, 'tenant-a')).toThrow('Invalid artifact id');
    expect(() => readResponseArtifact('a'.repeat(20), undefined, 'tenant-a')).toThrow(
      'handle is unknown',
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

    expect(() => readResponseArtifact(artifactId, undefined, 'tenant-a')).toThrow('handle expired at');
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

    // The error names the id the cursor was issued for, so a typo is self-correcting.
    expect(() => readResponseArtifact(
      secondBounded.response_meta.artifact.id,
      firstPage.response_meta.next_cursor,
      'tenant-a',
    )).toThrow('does not belong to artifactId');
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
    expect(bounded.data.data).toMatchObject({ returned: 5, page_count: 5, hasMore: false });
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

  it('queries provider-independent nested arrays with filters, projection, and cursors', () => {
    const artifact = persistResponseArtifact({
      providerPayload: {
        records: Array.from({ length: 17 }, (_, index) => ({
          id: index,
          name: `Record ${index}`,
          state: { name: index % 2 ? 'open' : 'closed' },
          score: index,
          payload: 'x'.repeat(1000),
        })),
      },
    }, 'tenant-a');

    const first = queryResponseArtifact(
      artifact.id,
      '/providerPayload/records',
      ['id', 'name', '/state/name'],
      [{ path: '/state/name', op: 'eq', value: 'open' }, { path: '/score', op: 'gte', value: 5 }],
      3,
      undefined,
      'tenant-a',
    ) as any;

    expect(first.response).toEqual([
      { id: 5, name: 'Record 5', '/state/name': 'open' },
      { id: 7, name: 'Record 7', '/state/name': 'open' },
      { id: 9, name: 'Record 9', '/state/name': 'open' },
    ]);
    expect(first.response_meta).toMatchObject({
      complete: false,
      returned_count: 3,
      total_count: 6,
      remaining_count: 3,
      truncation_reason: 'page_limit',
    });
    expect(first.response_meta.next_cursor).toBeTruthy();

    const second = queryResponseArtifact(
      artifact.id,
      '/providerPayload/records',
      ['id', 'name', '/state/name'],
      [{ path: '/state/name', op: 'eq', value: 'open' }, { path: '/score', op: 'gte', value: 5 }],
      3,
      first.response_meta.next_cursor,
      'tenant-a',
    ) as any;
    expect(second.response.map((item: any) => item.id)).toEqual([11, 13, 15]);
    expect(second.response_meta).toMatchObject({
      complete: true,
      returned_count: 3,
      total_count: 6,
      remaining_count: 0,
      next_cursor: null,
    });
  });

  it('omits unresolved projected fields, reports resolution counts, and rejects an entirely missing projection', () => {
    const artifact = persistResponseArtifact({ rows: [{ id: 1, optional: 'yes' }, { id: 2 }] }, 'tenant-a');
    const optional = queryResponseArtifact(
      artifact.id,
      '/rows',
      ['id', 'optional'],
      [{ path: '/optional', op: 'exists', value: false }],
      20,
      undefined,
      'tenant-a',
    ) as any;
    // Unresolved pointers are omitted, not nulled; fields_resolved makes the miss visible.
    expect(optional.response).toEqual([{ id: 2 }]);
    expect(optional.response_meta.fields_resolved).toEqual({ id: 1, optional: 0 });
    expect(optional.response_meta.warning).toContain('optional');

    expect(() => queryResponseArtifact(
      artifact.id,
      '/rows',
      ['unknown'],
      undefined,
      20,
      undefined,
      'tenant-a',
    )).toThrow('matched no properties');
  });

  it('infers one unambiguous array envelope when projecting from the artifact root', () => {
    const populated = persistResponseArtifact({ fields: [{ id: 'one', name: 'Example' }] }, 'tenant-a');
    const projected = queryResponseArtifact(
      populated.id, '', ['id', 'name'], undefined, 20, undefined, 'tenant-a',
    ) as any;
    expect(projected.response).toEqual([{ id: 'one', name: 'Example' }]);
    expect(projected.response_meta.inferred_response_path).toBe('/fields');
    expect(projected.response_meta.fields_resolved).toEqual({ id: 1, name: 1 });

    const empty = persistResponseArtifact({ fields: [] }, 'tenant-a');
    const emptyProjection = queryResponseArtifact(
      empty.id, '', ['id'], undefined, 20, undefined, 'tenant-a',
    ) as any;
    expect(emptyProjection.response).toEqual([]);
    expect(emptyProjection.response_meta.inferred_response_path).toBe('/fields');
    expect(emptyProjection.response_meta.fields_resolved).toEqual({ id: 0 });
  });

  it('does not infer a child when a projected root field resolves', () => {
    const artifact = persistResponseArtifact({ id: 'root', rows: [{ id: 'child' }] }, 'tenant-a');
    const projected = queryResponseArtifact(
      artifact.id, '', ['id'], undefined, 20, undefined, 'tenant-a',
    ) as any;
    expect(projected.response).toEqual({ id: 'root' });
    expect(projected.response_meta.inferred_response_path).toBeUndefined();
  });

  it('infers one array for root filtering and refuses ambiguous envelopes', () => {
    const filterable = persistResponseArtifact(
      { rows: [{ kind: 'keep' }, { kind: 'drop' }] }, 'tenant-a',
    );
    const filtered = queryResponseArtifact(
      filterable.id, '', undefined, [{ path: '/kind', op: 'eq', value: 'keep' }],
      20, undefined, 'tenant-a',
    ) as any;
    expect(filtered.response).toEqual([{ kind: 'keep' }]);
    expect(filtered.response_meta.inferred_response_path).toBe('/rows');

    const ambiguous = persistResponseArtifact(
      { rows: [{ id: 1 }], errors: [] }, 'tenant-a',
    );
    expect(() => queryResponseArtifact(
      ambiguous.id, '', ['id'], undefined, 20, undefined, 'tenant-a',
    )).toThrow('matched no properties');
  });

  it('infers below an explicit envelope path and reports the full pointer', () => {
    const artifact = persistResponseArtifact(
      { data: { executions: [{ id: 'one' }], returned: 1 } }, 'tenant-a',
    );
    const projected = queryResponseArtifact(
      artifact.id, '/data', ['id'], undefined, 20, undefined, 'tenant-a',
    ) as any;
    expect(projected.response).toEqual([{ id: 'one' }]);
    expect(projected.response_meta.inferred_response_path).toBe('/data/executions');
  });

  it('binds structured query cursors to artifact, scope, and exact view', () => {
    const firstArtifact = persistResponseArtifact({ rows: [1, 2, 3] }, 'tenant-a');
    // Distinct content: artifact ids are content-addressed per scope, so identical
    // payloads deliberately collapse to one handle (see the dedup test below).
    const secondArtifact = persistResponseArtifact({ rows: [4, 5, 6] }, 'tenant-a');
    const first = queryResponseArtifact(
      firstArtifact.id, '/rows', undefined, undefined, 1, undefined, 'tenant-a',
    ) as any;

    expect(() => queryResponseArtifact(
      secondArtifact.id, '/rows', undefined, undefined, 1, first.response_meta.next_cursor, 'tenant-a',
    )).toThrow(firstArtifact.id);
    expect(() => queryResponseArtifact(
      firstArtifact.id, '/rows', undefined, undefined, 2, first.response_meta.next_cursor, 'tenant-a',
    )).toThrow('does not match this query');
    expect(() => queryResponseArtifact(
      firstArtifact.id, '/rows', undefined, undefined, 1, undefined, 'tenant-b',
    )).toThrow('different MCP scope');
  });

  it('advances past one oversized item with a compact page', () => {
    const artifact = persistResponseArtifact({
      rows: [{ id: 1, body: 'x'.repeat(40 * 1024) }, { id: 2 }],
    }, 'tenant-a');
    const first = queryResponseArtifact(
      artifact.id, '/rows', undefined, undefined, 20, undefined, 'tenant-a',
    ) as any;
    expect(first.response[0].id).toBe(1);
    expect(first.response_meta).toMatchObject({
      returned_count: 1,
      total_count: 2,
      remaining_count: 1,
      truncation_reason: 'item_size_limit',
    });
    expect(first.response_meta.next_cursor).toBeTruthy();
    expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThan(HARD_RESULT_BYTES);
  });

  it('validates structured query bounds and filter shapes', () => {
    const artifact = persistResponseArtifact({ rows: [{ id: 1 }] }, 'tenant-a');
    expect(() => queryResponseArtifact(
      artifact.id, '/rows', undefined, undefined, 0, undefined, 'tenant-a',
    )).toThrow('pageSize');
    expect(() => queryResponseArtifact(
      artifact.id, '/rows', undefined, Array.from({ length: 11 }, () => ({ path: '/id' })), 20, undefined, 'tenant-a',
    )).toThrow('at most 10');
    expect(() => queryResponseArtifact(
      artifact.id, '/rows', undefined, [{ path: '/id', op: 'in', value: 'invalid' } as any], 20, undefined, 'tenant-a',
    )).toThrow('must be an array');
    expect(() => queryResponseArtifact(
      artifact.id, '/rows', Array.from({ length: 51 }, (_, index) => `field-${index}`), undefined, 20, undefined, 'tenant-a',
    )).toThrow('at most 50');
    expect(() => queryResponseArtifact(
      artifact.id, '/rows', undefined, [{} as any], 20, undefined, 'tenant-a',
    )).toThrow('each filter');
    expect(() => queryResponseArtifact(
      artifact.id, '/rows', undefined, [{ path: '/id', op: 'invalid' as any }], 20, undefined, 'tenant-a',
    )).toThrow('Unsupported filter operation');
    expect(() => queryResponseArtifact(
      artifact.id, '/rows', undefined, [{ path: '/id', op: 'exists', value: 'yes' }], 20, undefined, 'tenant-a',
    )).toThrow('must be boolean');
    expect(() => queryResponseArtifact(
      artifact.id, '/rows', [''], undefined, 20, undefined, 'tenant-a',
    )).toThrow('non-empty strings');
  });

  it('supports generic comparison and containment filters', () => {
    const artifact = persistResponseArtifact({
      rows: [
        { id: 1, score: 5, text: 'hello', tags: ['alpha'], metadata: { key: true } },
        { id: 2, score: 10, text: 'goodbye', tags: ['beta'], metadata: {} },
      ],
    }, 'tenant-a');
    const result = queryResponseArtifact(
      artifact.id,
      '/rows',
      ['id'],
      [
        { path: '/id', op: 'ne', value: 2 },
        { path: '/id', op: 'in', value: [1, 3] },
        { path: '/score', op: 'gt', value: 4 },
        { path: '/score', op: 'gte', value: 5 },
        { path: '/score', op: 'lt', value: 6 },
        { path: '/score', op: 'lte', value: 5 },
        { path: '/text', op: 'contains', value: 'ell' },
        { path: '/tags', op: 'contains', value: 'alpha' },
        { path: '/metadata', op: 'contains', value: 'key' },
        { path: '/missing', op: 'exists', value: false },
      ],
      20,
      undefined,
      'tenant-a',
    ) as any;
    expect(result.response).toEqual([{ id: 1 }]);
  });

  it('validates response paths and object projections', () => {
    const artifact = persistResponseArtifact({ record: { id: 1, name: 'One' } }, 'tenant-a');
    const result = queryResponseArtifact(
      artifact.id, '/record', ['id'], undefined, 20, undefined, 'tenant-a',
    ) as any;
    expect(result.response).toEqual({ id: 1 });
    expect(result.response_meta.complete).toBe(true);

    expect(() => queryResponseArtifact(
      artifact.id, 'record', undefined, undefined, 20, undefined, 'tenant-a',
    )).toThrow('RFC 6901');
    expect(() => queryResponseArtifact(
      artifact.id, '/missing', undefined, undefined, 20, undefined, 'tenant-a',
    )).toThrow('does not exist');
    expect(() => queryResponseArtifact(
      artifact.id, '/record', ['unknown'], undefined, 20, undefined, 'tenant-a',
    )).toThrow('matched no properties');
    expect(() => queryResponseArtifact(
      artifact.id, '/record', undefined, [{ path: '/id', op: 'eq', value: 1 }], 20, undefined, 'tenant-a',
    )).toThrow('select a JSON array');

    const scalar = queryResponseArtifact(
      artifact.id, '/record/id', undefined, undefined, 20, undefined, 'tenant-a',
    ) as any;
    expect(scalar.response).toBe(1);

    const arrayArtifact = persistResponseArtifact({ rows: [{ id: 2 }] }, 'tenant-a');
    const arrayScalar = queryResponseArtifact(
      arrayArtifact.id, '/rows/0/id', undefined, undefined, 20, undefined, 'tenant-a',
    ) as any;
    expect(arrayScalar.response).toBe(2);
  });

  it('treats contains on an unsupported scalar type as not matched', () => {
    const artifact = persistResponseArtifact({ rows: [{ id: 1 }] }, 'tenant-a');
    const result = queryResponseArtifact(
      artifact.id,
      '/rows',
      undefined,
      [{ path: '/id', op: 'contains', value: 1 }],
      20,
      undefined,
      'tenant-a',
    ) as any;
    expect(result.response).toEqual([]);
  });

  it('pages a large non-array structured query result by entry instead of gutting it', () => {
    const artifact = persistResponseArtifact({ record: { id: 1, body: 'x'.repeat(40 * 1024) } }, 'tenant-a');
    const first = queryResponseArtifact(
      artifact.id, '/record', undefined, undefined, 20, undefined, 'tenant-a',
    ) as any;
    expect(first.response).toEqual({ id: 1 });
    expect(first.response_meta).toMatchObject({
      complete: false,
      truncated: true,
      page_unit: 'entries',
      total_count: 2,
      returned_count: 1,
    });
    expect(first.response_meta.next_cursor).toBeTruthy();

    // A 40 KiB entry exceeds the whole budget, so it is summarized — but the reply must
    // say so and name the way to read it in full.
    const second = queryResponseArtifact(
      artifact.id, '/record', undefined, undefined, 20, first.response_meta.next_cursor, 'tenant-a',
    ) as any;
    expect(Object.keys(second.response)).toEqual(['body']);
    expect(second.response.body).toContain('40960 chars total');
    expect(second.response_meta).toMatchObject({
      truncated: true,
      truncation_reason: 'item_size_limit',
      next_cursor: null,
    });
    expect(second.response_meta.warning).toContain('read_response_artifact');
    expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThan(HARD_RESULT_BYTES);
  });

  it('deduplicates identical payloads within a scope but not across scopes', () => {
    const value = { rows: Array.from({ length: 50 }, (_, i) => ({ i, text: 'q'.repeat(1000) })) };
    const first = persistResponseArtifact(value, 'tenant-a');
    const second = persistResponseArtifact(value, 'tenant-a');
    const other = persistResponseArtifact(value, 'tenant-b');
    expect(second.id).toBe(first.id);
    expect(other.id).not.toBe(first.id);
    // Reuse must refresh the handle so a long session cannot have it expire underneath.
    expect(Date.parse(second.expires_at)).toBeGreaterThanOrEqual(Date.parse(first.expires_at));
  });

  it('rejects a filter path that resolves on no item instead of reporting a complete zero', () => {
    const artifact = persistResponseArtifact({
      data: { executions: Array.from({ length: 10 }, (_, i) => ({ id: String(i), status: 'success' })) },
    }, 'tenant-a');

    // A pointer one token wrong must raise, not report a complete zero.
    let thrown: Error | undefined;
    try {
      queryResponseArtifact(
        artifact.id, '/data/executions', undefined,
        [{ path: '/data/status', op: 'eq', value: 'error' }], 20, undefined, 'tenant-a',
      );
    } catch (error) {
      thrown = error as Error;
    }
    expect(thrown).toBeDefined();
    expect(thrown!.message).toContain('/data/status');
    expect(thrown!.message).toContain('/status');

    // The correct pointer still works, and a genuine zero-match stays a clean zero.
    const correct = queryResponseArtifact(
      artifact.id, '/data/executions', ['id'],
      [{ path: '/status', op: 'eq', value: 'success' }], 20, undefined, 'tenant-a',
    ) as any;
    expect(correct.response_meta.total_count).toBe(10);
    expect(correct.response_meta.filters_applied).toEqual([
      { path: '/status', op: 'eq', resolved_on: 10, matched: 10 },
    ]);

    const genuineZero = queryResponseArtifact(
      artifact.id, '/data/executions', ['id'],
      [{ path: '/status', op: 'eq', value: 'error' }], 20, undefined, 'tenant-a',
    ) as any;
    expect(genuineZero.response).toEqual([]);
    expect(genuineZero.response_meta).toMatchObject({ total_count: 0, complete: true });
    expect(genuineZero.response_meta.filters_applied[0]).toMatchObject({ resolved_on: 10, matched: 0 });
  });

  it('rejects a comparison whose operands are never mutually comparable', () => {
    const artifact = persistResponseArtifact({ rows: [{ ms: 10 }, { ms: 2000 }] }, 'tenant-a');
    expect(() => queryResponseArtifact(
      artifact.id, '/rows', undefined, [{ path: '/ms', op: 'gt', value: '100' }], 20, undefined, 'tenant-a',
    )).toThrow('comparable operands');
    const numeric = queryResponseArtifact(
      artifact.id, '/rows', undefined, [{ path: '/ms', op: 'gt', value: 100 }], 20, undefined, 'tenant-a',
    ) as any;
    expect(numeric.response).toEqual([{ ms: 2000 }]);
  });

  it('describes shape without emitting values so pointers do not have to be guessed', () => {
    const artifact = persistResponseArtifact({
      data: { executions: [{ id: '1', status: 'error', nested: { a: 1 } }, { id: '2', extra: true }] },
    }, 'tenant-a');
    const described = queryResponseArtifact(
      artifact.id, '/data/executions', undefined, undefined, 20, undefined, 'tenant-a', true,
    ) as any;
    expect(described.shape.type).toBe('array');
    expect(described.shape.length).toBe(2);
    // Keys merge across sampled items, so a heterogeneous array still yields usable pointers.
    const names = described.shape.item_keys.map((key: any) => key.name).sort();
    expect(names).toEqual(['extra', 'id', 'nested', 'status']);
    expect(described.shape.item_keys.find((k: any) => k.name === 'id').pointer).toBe('/id');
    expect(JSON.stringify(described)).not.toContain('error');
    expect(described.response_meta.complete).toBe(true);
    expect(described.response_meta.contract_version).toBe(2);
    expect(described.response_meta.artifact).toBeUndefined();
  });

  it('filters native n8n connection maps through generic object entries', () => {
    const connections = {
      'Source Alpha': { main: [[{ node: 'Transform Alpha', type: 'main', index: 0 }]] },
      'Source Beta': { main: [[{ node: 'Decision Beta', type: 'main', index: 0 }]] },
      'Decision Beta': { main: [[{ node: 'Sink Beta', type: 'main', index: 0 }]] },
    };
    const artifact = persistResponseArtifact({ data: { connections } }, 'tenant-a');
    const result = queryResponseArtifact(
      artifact.id,
      '/data/connections',
      ['key', '/value/main'],
      [{ path: '/key', op: 'in', value: ['Source Alpha', 'Decision Beta'] }],
      20,
      undefined,
      'tenant-a',
      false,
      'entries',
    ) as any;

    expect(result.response.map((entry: any) => entry.key)).toEqual([
      'Source Alpha',
      'Decision Beta',
    ]);
    expect(result.response_meta).toMatchObject({ contract_version: 2, total_count: 2, complete: true });
  });

  it('validates object entry mode and describe combinations', () => {
    const artifact = persistResponseArtifact({
      map: { alpha: 1 },
      rows: [{ id: 1 }],
      scalar: 42,
    }, 'tenant-a');

    expect(() => queryResponseArtifact(
      artifact.id, '/map', undefined, undefined, 20, undefined, 'tenant-a', true, 'entries',
    )).toThrow('describe cannot be combined with objectMode');
    expect(() => queryResponseArtifact(
      artifact.id, '/map', undefined, undefined, 20, undefined, 'tenant-a', false, 'other' as any,
    )).toThrow('Unsupported objectMode');
    expect(() => queryResponseArtifact(
      artifact.id, '/rows', undefined, undefined, 20, undefined, 'tenant-a', false, 'entries',
    )).toThrow('requires responsePath to select a JSON object');
    expect(() => queryResponseArtifact(
      artifact.id, '/scalar', undefined, undefined, 20, undefined, 'tenant-a', false, 'entries',
    )).toThrow('it selects number');
  });

  it('warns when an oversized scalar comes from an already truncated source', () => {
    const artifact = persistResponseArtifact({
      hasMoreData: true,
      value: 'x'.repeat(40 * 1024),
    }, 'tenant-a');

    const result = queryResponseArtifact(
      artifact.id, '/value', undefined, undefined, 20, undefined, 'tenant-a',
    ) as any;

    expect(result.response_meta).toMatchObject({
      truncated: true,
      source_truncated: true,
      truncation_reason: 'scalar_size_limit',
    });
    expect(result.response_meta.warning).toContain('reduced view');
    expect(result.response_meta.warning).toContain('read_response_artifact');
  });

  it('describes scalar, empty-array, and child-array shapes', () => {
    const artifact = persistResponseArtifact({
      text: 'alpha',
      empty: [],
      record: { children: [1, 2, 3] },
    }, 'tenant-a');

    const scalar = queryResponseArtifact(
      artifact.id, '/text', undefined, undefined, 20, undefined, 'tenant-a', true,
    ) as any;
    expect(scalar.shape).toEqual({ type: 'string', length: 5 });

    const empty = queryResponseArtifact(
      artifact.id, '/empty', undefined, undefined, 20, undefined, 'tenant-a', true,
    ) as any;
    expect(empty.shape).toMatchObject({ type: 'array', length: 0, item_type: null });

    const record = queryResponseArtifact(
      artifact.id, '/record', undefined, undefined, 20, undefined, 'tenant-a', true,
    ) as any;
    expect(record.shape.keys).toContainEqual(expect.objectContaining({ name: 'children', length: 3 }));
  });

  it('compacts valid and malformed workflow connection groups within the edge limit', async () => {
    vi.resetModules();
    process.env.MCP_RESPONSE_ARTIFACT_ROOT = root;
    process.env.MCP_RESPONSE_CURSOR_KEY = 'coverage-test-connections-key';
    process.env.MCP_RESPONSE_PREVIEW_BYTES = String(64 * 1024);
    const fresh = await import('../../../src/services/mcp-response-bounding');
    const targets = Array.from({ length: 402 }, (_, index) => ({
      node: `S${index}`,
      type: 'main',
      index,
    }));
    const connections: Record<string, unknown> = {
      'Source Alpha': { main: [targets] },
      'Source Beta': { main: 'invalid-groups' },
      'Source Gamma': { main: [null] },
      'Source Delta': null,
      'Source Epsilon': { main: [[null, { node: 'Sink Epsilon' }]] },
      'Source Zeta': { main: [[{ node: 'Sink Zeta', index: 1 }]] },
    };
    const value = {
      success: true,
      data: {
        id: 'workflow-connections',
        name: 'Connection coverage',
        nodes: [{ id: 'node-1', name: 'Source Alpha', type: 'n8n-nodes-base.code' }],
        connections,
        filler: 'x'.repeat(40 * 1024),
      },
    };

    const bounded = fresh.boundToolResult('n8n_get_workflow', value, 'tenant-a') as any;
    expect(bounded.data.data.connections).toHaveLength(400);
    expect(bounded.data.data.connections_omitted).toBe(4);
    expect(bounded.response_meta.artifact.primary_paths).toContain('/data/connections');
  });

  it('supports deterministic configuration and rejects signed invalid cursor states', async () => {
    vi.resetModules();
    process.env.MCP_RESPONSE_ARTIFACT_ROOT = root;
    process.env.MCP_RESPONSE_CURSOR_KEY = 'coverage-test-cursor-key';
    process.env.MCP_RESPONSE_INLINE_BYTES = 'invalid';
    process.env.MCP_RESPONSE_PREVIEW_BYTES = '4096';
    process.env.MCP_RESPONSE_HARD_BYTES = '131072';
    process.env.MCP_RESPONSE_ARTIFACT_PAGE_BYTES = '4096';
    const fresh = await import('../../../src/services/mcp-response-bounding');

    expect(fresh.INLINE_RESULT_BYTES).toBe(32 * 1024);
    expect(fresh.PREVIEW_RESULT_BYTES).toBe(4096);

    const artifact = fresh.persistResponseArtifact({ rows: [1, 2, 3] }, 'tenant-a');
    const scopedOwner = createHash('sha256').update('tenant-a').digest('hex');
    const otherOwner = createHash('sha256').update('tenant-b').digest('hex');
    const sign = (state: Record<string, unknown>, version = 2): string => {
      const payload = Buffer.from(JSON.stringify({ v: version, ...state }));
      const signature = createHmac('sha256', 'coverage-test-cursor-key').update(payload).digest();
      return Buffer.concat([payload, signature]).toString('base64url');
    };

    expect(() => fresh.readResponseArtifact(
      artifact.id, sign({ artifactId: artifact.id, offset: 0, owner: scopedOwner }, 1), 'tenant-a',
    )).toThrow('unsupported response contract version');
    expect(() => fresh.readResponseArtifact(
      artifact.id, sign({ artifactId: artifact.id, offset: 0, owner: otherOwner }), 'tenant-a',
    )).toThrow('different MCP scope');
    expect(() => fresh.readResponseArtifact(
      artifact.id, sign({ artifactId: artifact.id, offset: 1_000_000, owner: scopedOwner }), 'tenant-a',
    )).toThrow('past the end');

    const queryState = {
      artifactId: artifact.id,
      owner: scopedOwner,
      viewHash: 'wrong-view',
      offset: 0,
    };
    expect(() => fresh.queryResponseArtifact(
      artifact.id, '/rows', undefined, undefined, 1, sign({ ...queryState, owner: otherOwner }), 'tenant-a',
    )).toThrow('different MCP scope');
    expect(() => fresh.queryResponseArtifact(
      artifact.id, '/rows', undefined, undefined, 1, sign(queryState), 'tenant-a',
    )).toThrow('does not match this query');
  });

  it('enforces deliberately restrictive configured response budgets', async () => {
    vi.resetModules();
    process.env.MCP_RESPONSE_ARTIFACT_ROOT = root;
    process.env.MCP_RESPONSE_CURSOR_KEY = 'coverage-test-budget-key';
    process.env.MCP_RESPONSE_INLINE_BYTES = '1024';
    process.env.MCP_RESPONSE_PREVIEW_BYTES = '1';
    process.env.MCP_RESPONSE_HARD_BYTES = '64';
    const fresh = await import('../../../src/services/mcp-response-bounding');

    expect(() => fresh.boundToolResult(
      'additional_large_tool', { value: 'x'.repeat(2048) }, 'tenant-a',
    )).toThrow('hard serialized-size limit');

    const artifact = fresh.persistResponseArtifact({ rows: [{ id: 1 }] }, 'tenant-a');
    expect(() => fresh.queryResponseArtifact(
      artifact.id, '/rows', undefined, undefined, 20, undefined, 'tenant-a',
    )).toThrow('hard serialized-size limit');
  });

  it('pages object shape keys with absolute pointers and binds the cursor to the view', () => {
    const artifact = persistResponseArtifact({ data: { map: { 'a/b': 1, 'c~d': 2, third: 3 } } }, 'tenant-a');
    const first = queryResponseArtifact(
      artifact.id, '/data/map', undefined, undefined, 2, undefined, 'tenant-a', true,
    ) as any;
    expect(first.shape.keys.map((key: any) => key.pointer)).toEqual(['/data/map/a~1b', '/data/map/c~0d']);
    expect(first.response_meta.next_cursor).toBeTruthy();

    const second = queryResponseArtifact(
      artifact.id, '/data/map', undefined, undefined, 2, first.response_meta.next_cursor, 'tenant-a', true,
    ) as any;
    expect(second.shape.keys.map((key: any) => key.pointer)).toEqual(['/data/map/third']);
    expect(second.response_meta.complete).toBe(true);
    expect(() => queryResponseArtifact(
      artifact.id, '/data/map', ['third'], undefined, 2, undefined, 'tenant-a', true,
    )).toThrow('describe cannot be combined');
  });

  it('uses compact JSON for the inline threshold and caps artifact previews separately', () => {
    const value = {
      rows: Array.from({ length: 440 }, (_, index) => ({ id: index, label: `row-${index}`, active: true })),
    };
    expect(Buffer.byteLength(JSON.stringify(value))).toBeLessThan(INLINE_RESULT_BYTES);
    expect(Buffer.byteLength(JSON.stringify(value, null, 2))).toBeGreaterThan(INLINE_RESULT_BYTES);
    expect(boundToolResult('additional_large_tool', value, 'tenant-a')).toEqual(value);

    const oversized = { rows: Array.from({ length: 80 }, (_, index) => ({ index, payload: 'x'.repeat(1000) })) };
    const bounded = boundToolResult('additional_large_tool', oversized, 'tenant-a') as any;
    expect(bounded.response_meta.artifact).toBeTruthy();
    expect(Buffer.byteLength(JSON.stringify(bounded))).toBeLessThanOrEqual(8 * 1024);
  });

  it('marks truncated arrays and preserves scalars at every depth', () => {
    // The generic compact path runs for tools without a bespoke preview.
    const value = {
      rows: Array.from({ length: 9 }, (_, i) => i),
      deep: { two: { three: { count: 42, flag: false, name: 'kept' } } },
      filler: 'y'.repeat(40 * 1024),
    };
    const bounded = boundToolResult('additional_large_tool', value, 'tenant-a') as any;

    // A sliced array must carry a remainder marker.
    expect(Array.isArray(bounded.data.rows)).toBe(true);
    expect(bounded.data.rows[bounded.data.rows.length - 1]).toEqual({ _omitted_items: 6 });

    // Scalars must survive depth clipping.
    const three = bounded.data.deep?.two?.three;
    expect(three).toEqual({ count: 42, flag: false, name: 'kept' });
  });

  it('advertises artifact paths that actually resolve on the stored payload', () => {
    const value = {
      success: true,
      data: { executions: Array.from({ length: 60 }, (_, i) => ({ id: String(i), blob: 'z'.repeat(1000) })) },
    };
    const bounded = boundToolResult('n8n_executions', value, 'tenant-a') as any;
    const paths: string[] = bounded.response_meta.artifact.primary_paths;
    expect(paths).toContain('/data/executions');
    // Every advertised pointer must resolve against the stored payload.
    for (const pointer of paths) {
      expect(() => queryResponseArtifact(
        bounded.response_meta.artifact.id, pointer, undefined, undefined, 1, undefined, 'tenant-a', true,
      )).not.toThrow();
    }
    expect(() => queryResponseArtifact(
      bounded.response_meta.artifact.id, '/data/data/executions', undefined, undefined, 1, undefined, 'tenant-a',
    )).toThrow('JSON pointer does not exist');
  });

  it('keeps a usable cursor when JSON escaping inflates an artifact page past the budget', () => {
    // Embedded JSON-in-JSON: escaping inflates a 24 KiB raw page past the budget.
    const embedded = JSON.stringify({ nested: 'q"\\'.repeat(20_000) });
    const value = { records: Array.from({ length: 12 }, (_, i) => ({ i, payload: embedded })) };
    const bounded = boundToolResult('additional_large_tool', value, 'tenant-a') as any;
    const artifactId = bounded.response_meta.artifact.id as string;

    let cursor: string | undefined;
    let pages = 0;
    let text = '';
    do {
      const page = readResponseArtifact(artifactId, cursor, 'tenant-a') as any;
      expect(Buffer.byteLength(JSON.stringify(page, null, 2))).toBeLessThanOrEqual(INLINE_RESULT_BYTES);
      expect(page.response_meta.returned_count).toBeGreaterThan(0);
      text += page.text;
      cursor = page.response_meta.next_cursor ?? undefined;
      pages += 1;
      expect(pages).toBeLessThan(500);
    } while (cursor);

    // Concatenated pages must reconstruct the stored artifact exactly.
    expect(JSON.parse(text)).toEqual(value);
  });

  it('rejects an artifact whose stored body is no longer valid JSON', () => {
    const artifact = persistResponseArtifact({ rows: [] }, 'tenant-a');
    writeFileSync(path.join(root, `response-${artifact.id}.json`), '{invalid');
    expect(() => queryResponseArtifact(
      artifact.id, '', undefined, undefined, 20, undefined, 'tenant-a',
    )).toThrow('valid JSON');
  });
});
