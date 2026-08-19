import { ToolDocumentation } from '../types';

/**
 * The artifact wrappers are registered by the response-bounding layer
 * (src/services/mcp-response-bounding.ts) rather than by src/mcp/tools.ts, so they were
 * absent from this catalogue while being fully callable — tools_documentation({topic:
 * 'query_response_artifact'}) answered "not found" for a tool that works. Keep this
 * entry in step with the inputSchema in that service.
 */

export const queryResponseArtifactDoc: ToolDocumentation = {
  name: 'query_response_artifact',
  category: 'system',
  essentials: {
    description:
      'Query structured JSON inside a large tool-result artifact without loading it into context. Start with describe=true to learn the real shape.',
    keyParameters: ['artifactId', 'responsePath', 'describe'],
    example:
      'query_response_artifact({artifactId: "a1b2c3", responsePath: "", describe: true})',
    performance: 'Fast - reads a stored artifact from disk, no n8n API call',
    tips: [
      'Call with describe=true first. The inline preview you just read is a reshaped summary, so a pointer copied out of it may not exist in the artifact.',
      'response_meta.artifact.primary_paths lists pointers that do resolve — prefer those over guessing.',
      'Use responsePath: "" for the artifact root.',
      'Request another semantic page only when the current page did not answer the question.',
      'An unknown artifactId means the handle expired or the server restarted — re-run the tool that produced it.'
    ]
  },
  full: {
    description: `Queries structured JSON held in a large MCP result artifact, so a response too big for context can still be read precisely.

When a tool result exceeds the inline budget, the response-bounding layer stores the full payload as an artifact and returns a bounded preview plus a handle in response_meta.artifact. This tool navigates that stored payload.

The important failure mode is pointer drift. When filters or fields shaped the inline preview, that preview is a summary with its own keys — not a window onto the artifact's structure. Pointers copied from it can fail with "JSON pointer does not exist". Two mechanisms exist to avoid guessing:

- describe=true returns the shape at responsePath (types, key names, array lengths) instead of values, with a usable pointer on each entry.
- response_meta.artifact.primary_paths lists pointers already known to resolve.

Arrays page by element and objects page by entry.`,
    parameters: {
      artifactId: {
        type: 'string',
        required: true,
        description: 'Opaque artifact id returned in response_meta.artifact.id'
      },
      responsePath: {
        type: 'string',
        required: true,
        description: 'RFC 6901 pointer selecting the value to query; use an empty string for the artifact root'
      },
      describe: {
        type: 'boolean',
        required: false,
        default: false,
        description: 'Return the shape at responsePath (types, key names, array lengths) instead of values. Use this first when the structure is unknown.'
      },
      fields: {
        type: 'array',
        required: false,
        description: 'Root property names (id) or RFC 6901 pointers (/status/name) projected from each selected item, max 50. Fields that do not resolve are omitted rather than returned as null; check response_meta.fields_resolved.'
      },
      filters: {
        type: 'array',
        required: false,
        description: 'Provider-independent predicates applied to a selected array, max 10. Each entry takes path (pointer relative to the item), op (eq, ne, in, contains, lt, lte, gt, gte, exists; default eq) and value.'
      },
      objectMode: {
        type: 'string',
        required: false,
        description: 'Set to entries for keyed objects, exposing {key,value} rows that can be filtered and projected.'
      },
      textSearch: {
        type: 'object',
        required: false,
        description: 'Bounded literal search across strings beneath responsePath: {query, caseSensitive?}. Returns at most 20 matches with 240 characters of context.'
      },
      pageSize: {
        type: 'integer',
        required: false,
        default: 20,
        description: 'Elements or entries per page, 1-100'
      },
      cursor: {
        type: 'string',
        required: false,
        description: 'Opaque next cursor from the previous query page'
      }
    },
    returns:
      'The selected value (or its shape when describe=true) plus response_meta carrying next_cursor, counts, fields_resolved, and an artifact block with id, expiry and primary_paths.',
    examples: [
      'query_response_artifact({artifactId: "a1b2c3", responsePath: "", describe: true}) - discover the top-level shape',
      'query_response_artifact({artifactId: "a1b2c3", responsePath: "/data", describe: true}) - array length and item shape before paging',
      'query_response_artifact({artifactId: "a1b2c3", responsePath: "/data", fields: ["id", "/status/name"], pageSize: 50}) - project two fields per element',
      'query_response_artifact({artifactId: "a1b2c3", responsePath: "/data", filters: [{path: "/status/name", op: "eq", value: "error"}]}) - select failing entries only',
      'query_response_artifact({artifactId: "a1b2c3", responsePath: "/data", textSearch: {query: "timeout"}}) - find a literal inside large strings without returning the full payload'
    ],
    useCases: [
      'Inspect a large execution payload without paging the whole thing into context',
      'Pull a handful of fields out of a long list result',
      'Filter a large array down to the entries that matter',
      'Search large string values while keeping the full payload out of model context',
      'Recover from "JSON pointer does not exist" by describing the shape instead of guessing again'
    ],
    performance: 'Fast - local artifact read; cost scales with the selected page, not the artifact size',
    errorHandling:
      '"JSON pointer does not exist" means responsePath is not present in the artifact: re-run with describe=true, or use a pointer from response_meta.artifact.primary_paths. An unknown artifactId means the handle expired (24 hour ceiling) or the MCP server restarted; re-run the originating tool to mint a new one.',
    bestPractices: [
      'describe=true before the first real query against an unfamiliar payload',
      'Prefer primary_paths over pointers copied from an inline preview',
      'Request another page only when more matching results are needed',
      'Narrow with filters and fields rather than paging everything'
    ],
    pitfalls: [
      'A pointer that worked against the inline preview may not exist in the artifact when filters or fields reshaped that preview',
      'Artifact handles do not survive an MCP server restart even inside the 24 hour window',
      'Treating one page as the full result: check response_meta before summarising',
      'Artifacts are scoped to the caller that created them'
    ],
    relatedTools: ['n8n_executions', 'n8n_get_workflow']
  }
};
