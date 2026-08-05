import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, readdirSync } from 'fs';
import path from 'path';
import { isDeepStrictEqual } from 'util';

export const INLINE_RESULT_BYTES = 32 * 1024;
export const HARD_RESULT_BYTES = 128 * 1024;
export const ARTIFACT_PAGE_BYTES = 24 * 1024;
export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;
const DEFAULT_ARTIFACT_MAX_BYTES = 50 * 1024 * 1024;
const DEFAULT_ARTIFACT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_ARTIFACT_QUOTA_BYTES = 1024 * 1024 * 1024;
const cursorKey = process.env.MCP_RESPONSE_CURSOR_KEY || randomBytes(32).toString('hex');

export interface ResponseMeta {
  truncated: boolean;
  complete: boolean;
  truncation_reason: string | null;
  returned_count: number | null;
  total_count: number | null;
  remaining_count: number | null;
  next_cursor: string | null;
  serialized_bytes: number;
  artifact: ArtifactReference | null;
  warning: string | null;
}

export interface ArtifactReference {
  id: string;
  media_type: string;
  byte_length: number;
  sha256: string;
  expires_at: string;
  read_tool: 'read_response_artifact';
  query_tool: 'query_response_artifact';
  response_root: '/';
}

export const responseArtifactTool = {
  name: 'read_response_artifact',
  description: 'Read one bounded page from a large MCP result artifact. Continue with response_meta.next_cursor until it is null.',
  inputSchema: {
    type: 'object',
    properties: {
      artifactId: { type: 'string', description: 'Opaque artifact id returned in response_meta.artifact.id' },
      cursor: { type: 'string', description: 'Opaque next cursor from the previous artifact page' },
    },
    required: ['artifactId'],
  },
  annotations: { title: 'Read Response Artifact', readOnlyHint: true, idempotentHint: true, openWorldHint: false },
};

const FILTER_OPERATIONS = ['eq', 'ne', 'in', 'contains', 'lt', 'lte', 'gt', 'gte', 'exists'] as const;
type FilterOperation = typeof FILTER_OPERATIONS[number];

export interface ResponseFilter {
  path: string;
  op?: FilterOperation;
  value?: unknown;
}

export const queryResponseArtifactTool = {
  name: 'query_response_artifact',
  description: 'Query structured JSON in a large MCP result artifact without loading the full artifact into context. responsePath uses RFC 6901. fields accepts root names such as id or pointers such as /status/name. If response_meta.complete is false, follow next_cursor until it is null. Artifact handles expire after 24 hours.',
  inputSchema: {
    type: 'object',
    properties: {
      artifactId: { type: 'string', description: 'Opaque artifact id returned in response_meta.artifact.id' },
      responsePath: { type: 'string', description: 'RFC 6901 pointer selecting the value or array to query; use an empty string for the artifact root' },
      fields: {
        type: 'array',
        maxItems: 50,
        items: { type: 'string' },
        description: 'Optional root property names (id) or RFC 6901 pointers (/status/name) projected from each selected item',
      },
      filters: {
        type: 'array',
        maxItems: 10,
        description: 'Optional provider-independent predicates applied to a selected array',
        items: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'RFC 6901 pointer relative to each item' },
            op: { type: 'string', enum: FILTER_OPERATIONS, default: 'eq' },
            value: {},
          },
          required: ['path'],
        },
      },
      pageSize: { type: 'integer', minimum: 1, maximum: MAX_PAGE_SIZE, default: DEFAULT_PAGE_SIZE },
      cursor: { type: 'string', description: 'Opaque next cursor from the previous query page' },
    },
    required: ['artifactId', 'responsePath'],
  },
  annotations: { title: 'Query Response Artifact', readOnlyHint: true, idempotentHint: true, openWorldHint: false },
};

const MISSING = Symbol('missing');

function encode(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value));
}

function rootPath(): string {
  return process.env.MCP_RESPONSE_ARTIFACT_ROOT || '/tmp/n8n-mcp-artifacts';
}

function safeOwner(owner: string): string {
  return createHash('sha256').update(owner).digest('hex');
}

function encodeCursor(state: Record<string, unknown>): string {
  const payload = Buffer.from(JSON.stringify(state));
  const signature = createHmac('sha256', cursorKey).update(payload).digest();
  return Buffer.concat([payload, signature]).toString('base64url');
}

function decodeCursor(cursor: string): Record<string, any> {
  const raw = Buffer.from(cursor, 'base64url');
  if (raw.length <= 32) throw new Error('Invalid artifact cursor');
  const payload = raw.subarray(0, raw.length - 32);
  const supplied = raw.subarray(raw.length - 32);
  const expected = createHmac('sha256', cursorKey).update(payload).digest();
  if (!timingSafeEqual(supplied, expected)) throw new Error('Invalid artifact cursor');
  return JSON.parse(payload.toString('utf8')) as Record<string, any>;
}

function pointer(value: unknown, jsonPointer: string): unknown {
  if (jsonPointer === '') return value;
  if (!jsonPointer.startsWith('/')) {
    throw new Error('responsePath and filter paths must use RFC 6901 JSON pointers');
  }
  let current = value;
  for (const rawToken of jsonPointer.slice(1).split('/')) {
    const token = rawToken.replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(current) && /^\d+$/.test(token) && Number(token) < current.length) {
      current = current[Number(token)];
    } else if (current && typeof current === 'object' && Object.prototype.hasOwnProperty.call(current, token)) {
      current = (current as Record<string, unknown>)[token];
    } else {
      throw new Error(`JSON pointer does not exist: ${jsonPointer}`);
    }
  }
  return current;
}

function fieldPointer(field: string): string {
  if (typeof field !== 'string' || field.length === 0) {
    throw new Error('fields entries must be non-empty strings');
  }
  if (field.startsWith('/')) return field;
  return `/${field.replace(/~/g, '~0').replace(/\//g, '~1')}`;
}

function projectItem(item: unknown, fields: string[]): { value: Record<string, unknown>; matched: number } {
  const value: Record<string, unknown> = {};
  let matched = 0;
  for (const field of fields) {
    try {
      value[field] = pointer(item, fieldPointer(field));
      matched += 1;
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith('JSON pointer does not exist:')) throw error;
      value[field] = null;
    }
  }
  return { value, matched };
}

function projectSelection(selected: unknown, fields: string[]): unknown {
  if (Array.isArray(selected)) {
    const projected = selected.map(item => projectItem(item, fields));
    if (selected.length > 0 && !projected.some(item => item.matched > 0)) {
      throw new Error("fields matched no properties; use root names such as 'id' or RFC 6901 pointers such as '/status/name'");
    }
    return projected.map(item => item.value);
  }
  const projected = projectItem(selected, fields);
  if (projected.matched === 0) {
    throw new Error("fields matched no properties; use root names such as 'id' or RFC 6901 pointers such as '/status/name'");
  }
  return projected.value;
}

function contains(actual: unknown, expected: unknown): boolean {
  if (typeof actual === 'string') return typeof expected === 'string' && actual.includes(expected);
  if (Array.isArray(actual)) return actual.some(value => isDeepStrictEqual(value, expected));
  if (actual && typeof actual === 'object' && typeof expected === 'string') {
    return Object.prototype.hasOwnProperty.call(actual, expected);
  }
  return false;
}

function matchesFilters(item: unknown, filters: ResponseFilter[]): boolean {
  return filters.every(filter => {
    const op = filter.op ?? 'eq';
    let actual: unknown = MISSING;
    try {
      actual = pointer(item, filter.path);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith('JSON pointer does not exist:')) throw error;
    }
    if (op === 'exists') {
      const shouldExist = filter.value === undefined ? true : filter.value;
      if (typeof shouldExist !== 'boolean') throw new Error('exists filter value must be boolean when provided');
      return (actual !== MISSING) === shouldExist;
    }
    if (actual === MISSING) return false;
    if (op === 'eq') return isDeepStrictEqual(actual, filter.value);
    if (op === 'ne') return !isDeepStrictEqual(actual, filter.value);
    if (op === 'in') {
      if (!Array.isArray(filter.value)) throw new Error('in filter value must be an array');
      return filter.value.some(value => isDeepStrictEqual(actual, value));
    }
    if (op === 'contains') return contains(actual, filter.value);
    if ((typeof actual !== 'number' && typeof actual !== 'string') ||
        (typeof filter.value !== 'number' && typeof filter.value !== 'string')) return false;
    if (op === 'lt') return actual < filter.value;
    if (op === 'lte') return actual <= filter.value;
    if (op === 'gt') return actual > filter.value;
    return actual >= filter.value;
  });
}

function completionMetadata(
  truncated: boolean,
  returnedCount: number | null,
  totalCount: number | null,
  offset = 0,
): Pick<ResponseMeta, 'complete' | 'remaining_count' | 'warning'> {
  return {
    complete: !truncated,
    remaining_count: totalCount !== null && returnedCount !== null
      ? Math.max(totalCount - offset - returnedCount, 0)
      : null,
    warning: truncated
      ? 'INCOMPLETE RESULT: do not treat the visible response as exhaustive; follow next_cursor until it is null or query the response artifact.'
      : null,
  };
}

function utf8PageEnd(content: Buffer, offset: number): number {
  const tentativeEnd = Math.min(offset + ARTIFACT_PAGE_BYTES, content.length);
  if (tentativeEnd === content.length) return tentativeEnd;

  let end = tentativeEnd;
  while (end > offset && (content[end] & 0xc0) === 0x80) end -= 1;
  return end;
}

function compact(value: unknown, depth = 0): unknown {
  if (depth >= 4) return '[nested value omitted]';
  if (Array.isArray(value)) return value.slice(0, 3).map(item => compact(item, depth + 1));
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    const result: Record<string, unknown> = {};
    for (const [key, child] of entries.slice(0, 20)) result[key] = compact(child, depth + 1);
    if (entries.length > 20) result._omitted_fields = entries.length - 20;
    return result;
  }
  if (typeof value === 'string' && value.length > 1000) return `${value.slice(0, 1000)}…`;
  return value;
}

function compactToolValue(toolName: string, value: unknown): unknown {
  if (toolName === 'n8n_get_workflow' && value && typeof value === 'object') {
    const response = value as Record<string, any>;
    const workflow = response.data?.workflow ?? response.data;
    if (workflow && typeof workflow === 'object') {
      return {
        success: response.success ?? true,
        data: {
          id: workflow.id,
          name: workflow.name,
          active: workflow.active,
          nodeCount: Array.isArray(workflow.nodes) ? workflow.nodes.length : 0,
          nodes: Array.isArray(workflow.nodes)
            ? workflow.nodes.slice(0, MAX_PAGE_SIZE).map((node: Record<string, unknown>) => ({
                id: node.id, name: node.name, type: node.type, typeVersion: node.typeVersion, disabled: node.disabled,
              }))
            : [],
          connections: compact(workflow.connections, 2),
        },
      };
    }
  }
  if (toolName === 'n8n_executions' && value && typeof value === 'object') {
    const response = value as Record<string, any>;
    const data = response.data;
    if (Array.isArray(data?.executions)) {
      return {
        success: response.success ?? true,
        data: {
          executions: data.executions.slice(0, DEFAULT_PAGE_SIZE).map((execution: Record<string, unknown>) => ({
            id: execution.id,
            workflowId: execution.workflowId,
            status: execution.status,
            mode: execution.mode,
            startedAt: execution.startedAt,
            stoppedAt: execution.stoppedAt,
            finished: execution.finished,
          })),
          returned: Math.min(data.executions.length, DEFAULT_PAGE_SIZE),
          total_count: data.executions.length,
          nextCursor: data.nextCursor,
          hasMore: data.executions.length > DEFAULT_PAGE_SIZE || Boolean(data.nextCursor),
        },
      };
    }
  }
  return compact(value);
}

function paths(artifactId: string): { data: string; meta: string } {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(artifactId)) throw new Error('Invalid artifact id');
  const root = rootPath();
  return { data: path.join(root, `response-${artifactId}.json`), meta: path.join(root, `response-${artifactId}.meta.json`) };
}

function atomicWrite(destination: string, content: Buffer): void {
  const temporary = `${destination}.${process.pid}.${randomBytes(4).toString('hex')}.part`;
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    writeFileSync(fd, content);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, destination);
}

interface ArtifactMetadata {
  owner: string;
  media_type: string;
  byte_length: number;
  sha256: string;
  expires_at: string;
}

function artifactReference(artifactId: string, metadata: ArtifactMetadata): ArtifactReference {
  return {
    id: artifactId,
    media_type: metadata.media_type,
    byte_length: metadata.byte_length,
    sha256: metadata.sha256,
    expires_at: metadata.expires_at,
    read_tool: 'read_response_artifact',
    query_tool: 'query_response_artifact',
    response_root: '/',
  };
}

function loadArtifact(artifactId: string, owner: string): { content: Buffer; metadata: ArtifactMetadata } {
  const target = paths(artifactId);
  if (!existsSync(target.data) || !existsSync(target.meta)) throw new Error('Response artifact was not found or has expired');
  const metadata = JSON.parse(readFileSync(target.meta, 'utf8')) as ArtifactMetadata;
  if (metadata.owner !== safeOwner(owner)) throw new Error('Response artifact belongs to a different MCP scope');
  if (Date.parse(metadata.expires_at) <= Date.now()) {
    unlinkSync(target.data);
    unlinkSync(target.meta);
    throw new Error('Response artifact has expired');
  }
  return { content: readFileSync(target.data), metadata };
}

export function pruneResponseArtifacts(now = Date.now()): void {
  const root = rootPath();
  if (!existsSync(root)) return;
  const candidates = readdirSync(root)
    .filter(name => name.startsWith('response-'))
    .map(name => ({ name, file: path.join(root, name) }))
    .filter(entry => !entry.name.endsWith('.meta.json'))
    .map(entry => ({ ...entry, stat: statSync(entry.file) }))
    .sort((a, b) => a.stat.mtimeMs - b.stat.mtimeMs);
  let total = candidates.reduce((sum, entry) => sum + entry.stat.size, 0);
  for (const entry of candidates) {
    if (entry.stat.mtimeMs < now - DEFAULT_ARTIFACT_TTL_MS || total > DEFAULT_ARTIFACT_QUOTA_BYTES) {
      unlinkSync(entry.file);
      const meta = entry.file.replace(/\.json$/, '.meta.json');
      if (existsSync(meta)) unlinkSync(meta);
      total -= entry.stat.size;
    }
  }
}

export function persistResponseArtifact(value: unknown, owner: string): ArtifactReference {
  const content = encode(value);
  if (content.length > DEFAULT_ARTIFACT_MAX_BYTES) {
    throw new Error(`MCP result exceeds the ${DEFAULT_ARTIFACT_MAX_BYTES}-byte artifact limit`);
  }
  const root = rootPath();
  mkdirSync(root, { recursive: true, mode: 0o700 });
  pruneResponseArtifacts();
  const id = randomUUID().replace(/-/g, '') + randomBytes(8).toString('hex');
  const target = paths(id);
  const expiresAt = new Date(Date.now() + DEFAULT_ARTIFACT_TTL_MS).toISOString();
  const metadata = {
    owner: safeOwner(owner),
    media_type: 'application/json',
    byte_length: content.length,
    sha256: createHash('sha256').update(content).digest('hex'),
    expires_at: expiresAt,
  };
  atomicWrite(target.data, content);
  atomicWrite(target.meta, encode(metadata));
  return artifactReference(id, metadata);
}

export function readResponseArtifact(artifactId: string, cursor: string | undefined, owner: string): unknown {
  const { content, metadata } = loadArtifact(artifactId, owner);
  let offset = 0;
  if (cursor) {
    const decoded = decodeCursor(cursor) as { artifactId: string; offset: number; owner: string };
    if (decoded.artifactId !== artifactId || decoded.owner !== safeOwner(owner)) throw new Error('Invalid artifact cursor');
    offset = decoded.offset;
  }
  const chunk = content.subarray(offset, utf8PageEnd(content, offset));
  const nextOffset = offset + chunk.length;
  const nextCursor = nextOffset < content.length
    ? encodeCursor({ artifactId, offset: nextOffset, owner: safeOwner(owner) })
    : null;
  return {
    artifact_id: artifactId,
    media_type: metadata.media_type,
    offset,
    text: chunk.toString('utf8'),
    response_meta: {
      truncated: nextCursor !== null,
      truncation_reason: nextCursor ? 'artifact_page' : null,
      returned_count: chunk.length,
      total_count: content.length,
      next_cursor: nextCursor,
      serialized_bytes: chunk.length,
      artifact: null,
      ...completionMetadata(nextCursor !== null, chunk.length, content.length, offset),
    } satisfies ResponseMeta,
  };
}

export function queryResponseArtifact(
  artifactId: string,
  responsePath: string,
  fields: string[] | undefined,
  filters: ResponseFilter[] | undefined,
  pageSize: number,
  cursor: string | undefined,
  owner: string,
): unknown {
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
    throw new Error(`pageSize must be an integer between 1 and ${MAX_PAGE_SIZE}`);
  }
  if (fields && fields.length > 50) throw new Error('fields accepts at most 50 entries');
  if (filters && filters.length > 10) throw new Error('filters accepts at most 10 predicates');
  for (const filter of filters ?? []) {
    if (!filter || typeof filter !== 'object' || typeof filter.path !== 'string') {
      throw new Error('each filter must be an object with an RFC 6901 path');
    }
    if (filter.op !== undefined && !FILTER_OPERATIONS.includes(filter.op)) {
      throw new Error(`Unsupported filter operation: ${filter.op}`);
    }
  }

  const { content, metadata } = loadArtifact(artifactId, owner);
  let document: unknown;
  try {
    document = JSON.parse(content.toString('utf8'));
  } catch {
    throw new Error('Response artifact does not contain valid JSON');
  }
  let selected = pointer(document, responsePath);
  if (filters?.length) {
    if (!Array.isArray(selected)) throw new Error('filters require responsePath to select a JSON array');
    selected = selected.filter(item => matchesFilters(item, filters));
  }
  if (fields?.length) selected = projectSelection(selected, fields);

  const viewHash = createHash('sha256').update(encode({
    artifactId,
    responsePath,
    fields: fields ?? null,
    filters: filters ?? null,
    pageSize,
  })).digest('hex');
  let offset = 0;
  if (cursor) {
    const decoded = decodeCursor(cursor) as {
      artifactId: string;
      owner: string;
      viewHash: string;
      offset: number;
    };
    if (decoded.artifactId !== artifactId || decoded.owner !== safeOwner(owner) || decoded.viewHash !== viewHash) {
      throw new Error('Artifact query cursor does not match this artifact, scope, or query');
    }
    offset = decoded.offset;
  }

  const reference = artifactReference(artifactId, metadata);
  if (!Array.isArray(selected)) {
    const oversized = encode(selected).length > INLINE_RESULT_BYTES;
    const response = oversized ? compact(selected) : selected;
    const result = {
      artifact_id: artifactId,
      response_path: responsePath,
      response,
      response_meta: {
        truncated: oversized,
        truncation_reason: oversized ? 'size_limit' : null,
        returned_count: null,
        total_count: null,
        next_cursor: null,
        serialized_bytes: 0,
        artifact: reference,
        ...completionMetadata(oversized, null, null),
      } satisfies ResponseMeta,
    };
    result.response_meta.serialized_bytes = encode(result).length;
    if (encode(result).length > HARD_RESULT_BYTES) throw new Error('Bounded artifact query exceeded its hard serialized-size limit');
    return result;
  }

  const totalCount = selected.length;
  let page = selected.slice(offset, offset + pageSize);
  let reason: string | null = null;
  const build = (response: unknown[], returnedCount: number, nextCursor: string | null, truncationReason: string | null) => {
    const truncated = nextCursor !== null || truncationReason !== null;
    return {
      artifact_id: artifactId,
      response_path: responsePath,
      response,
      response_meta: {
        truncated,
        truncation_reason: truncationReason,
        returned_count: returnedCount,
        total_count: totalCount,
        next_cursor: nextCursor,
        serialized_bytes: 0,
        artifact: reference,
        ...completionMetadata(truncated, returnedCount, totalCount, offset),
      } satisfies ResponseMeta,
    };
  };

  while (page.length > 0) {
    const tentativeOffset = offset + page.length;
    const tentativeCursor = tentativeOffset < totalCount
      ? encodeCursor({ artifactId, owner: safeOwner(owner), viewHash, offset: tentativeOffset })
      : null;
    const tentativeReason = tentativeCursor
      ? (page.length === pageSize ? 'page_limit' : 'size_limit')
      : null;
    if (encode(build(page, page.length, tentativeCursor, tentativeReason)).length <= INLINE_RESULT_BYTES) break;
    page.pop();
  }
  if (page.length === 0 && offset < totalCount) {
    page = [compact(selected[offset])];
    reason = 'item_size_limit';
  }
  const nextOffset = offset + page.length;
  const nextCursor = nextOffset < totalCount
    ? encodeCursor({ artifactId, owner: safeOwner(owner), viewHash, offset: nextOffset })
    : null;
  reason = reason ?? (nextCursor ? (page.length === pageSize ? 'page_limit' : 'size_limit') : null);
  const result = build(page, page.length, nextCursor, reason);
  result.response_meta.serialized_bytes = encode(result).length;
  if (encode(result).length > HARD_RESULT_BYTES) throw new Error('Bounded artifact query exceeded its hard serialized-size limit');
  return result;
}

export function boundToolResult(toolName: string, value: unknown, owner: string): unknown {
  const raw = encode(value);
  if (raw.length <= INLINE_RESULT_BYTES) return value;
  const artifact = persistResponseArtifact(value, owner);
  const bounded = {
    success: typeof value === 'object' && value !== null && 'success' in value
      ? Boolean((value as Record<string, unknown>).success)
      : true,
    data: compactToolValue(toolName, value),
    response_meta: {
      truncated: true,
      truncation_reason: 'size_limit',
      returned_count: null,
      total_count: null,
      next_cursor: null,
      serialized_bytes: 0,
      artifact,
      ...completionMetadata(true, null, null),
    } satisfies ResponseMeta,
    guidance: `The visible ${toolName} summary is incomplete. Prefer query_response_artifact for structured JSON; use read_response_artifact only as a raw fallback.`,
  };
  while (encode(bounded).length > INLINE_RESULT_BYTES && bounded.data && typeof bounded.data === 'object') {
    bounded.data = compact(bounded.data, 3);
  }
  bounded.response_meta.serialized_bytes = encode(bounded).length;
  // The compaction loop targets 32 KiB, so reaching the 128 KiB guard would
  // violate the invariant above. Keep this as defense in depth without
  // manufacturing a test-only path that weakens the production limits.
  /* v8 ignore next */
  if (encode(bounded).length > HARD_RESULT_BYTES) throw new Error('Bounded MCP result exceeded its hard serialized-size limit');
  return bounded;
}
