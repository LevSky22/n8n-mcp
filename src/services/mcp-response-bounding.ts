import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, readdirSync } from 'fs';
import path from 'path';

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
  truncation_reason: string | null;
  returned_count: number | null;
  total_count: number | null;
  next_cursor: string | null;
  serialized_bytes: number;
  artifact: ArtifactReference | null;
}

export interface ArtifactReference {
  id: string;
  media_type: string;
  byte_length: number;
  sha256: string;
  expires_at: string;
  read_tool: 'read_response_artifact';
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
  return { id, ...metadata, read_tool: 'read_response_artifact' };
}

export function readResponseArtifact(artifactId: string, cursor: string | undefined, owner: string): unknown {
  const target = paths(artifactId);
  if (!existsSync(target.data) || !existsSync(target.meta)) throw new Error('Response artifact was not found or has expired');
  const metadata = JSON.parse(readFileSync(target.meta, 'utf8')) as Record<string, unknown>;
  if (metadata.owner !== safeOwner(owner)) throw new Error('Response artifact belongs to a different MCP scope');
  if (Date.parse(String(metadata.expires_at)) <= Date.now()) {
    unlinkSync(target.data);
    unlinkSync(target.meta);
    throw new Error('Response artifact has expired');
  }
  let offset = 0;
  if (cursor) {
    const decoded = decodeCursor(cursor) as { artifactId: string; offset: number; owner: string };
    if (decoded.artifactId !== artifactId || decoded.owner !== safeOwner(owner)) throw new Error('Invalid artifact cursor');
    offset = decoded.offset;
  }
  const content = readFileSync(target.data);
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
    } satisfies ResponseMeta,
  };
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
    } satisfies ResponseMeta,
    guidance: `The full ${toolName} result is stored outside model context. Use read_response_artifact with the artifact id.`,
  };
  while (encode(bounded).length > INLINE_RESULT_BYTES && bounded.data && typeof bounded.data === 'object') {
    bounded.data = compact(bounded.data, 3);
  }
  bounded.response_meta.serialized_bytes = encode(bounded).length;
  if (encode(bounded).length > HARD_RESULT_BYTES) throw new Error('Bounded MCP result exceeded its hard serialized-size limit');
  return bounded;
}
