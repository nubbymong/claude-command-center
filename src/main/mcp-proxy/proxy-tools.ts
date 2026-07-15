/**
 * Conductor Proxy — client-facing meta-tool surface (T4, #96).
 *
 * Registers the proxy's tools onto a per-connection McpServer (the seam in
 * conductor-mcp-server.ts `createServer`). Two exposure paths:
 *
 *  1. SEARCH (default) — a small FIXED set of meta-tools so upstream churn never
 *     changes the advertised tool list:
 *       - search_tools(query, [server], [limit])  → BM25 rows (name/server/desc)
 *       - describe_tool(name)                      → full input schema on demand
 *       - call_tool(name, [arguments])             → dispatch to the upstream
 *       - list_servers()                           → upstream online/offline state
 *
 *  2. PASSTHROUGH (opt-in per upstream) — each of that upstream's tools is ALSO
 *     advertised directly as `server__tool`. Upstream tools carry a JSON Schema;
 *     the SDK wants Zod, so we convert (best-effort — common JSON-Schema shapes;
 *     anything exotic falls back to z.any() while preserving arg names/optionality).
 *
 * This module owns NO state and never touches the SDK client — it drives the
 * supervisor (T2) + a freshly built tool-index (T3) through the injected deps,
 * so it is unit-testable with a fake `server` recorder and real zod.
 */

import { ToolIndex } from './tool-index'
import { ProxyDispatchError } from './supervisor'
import type { AggregatedTool, UpstreamRuntimeState } from './supervisor'

/** Virtual upstream id/name for the Conductor built-in tools when they are
 *  exposed through the search facade (T9, builtinExposure='search'). */
export const BUILTIN_UPSTREAM_ID = 'conductor-builtin'
export const BUILTIN_UPSTREAM_NAME = 'Conductor'

/** An in-process tool exposed through the facade (Conductor built-in). Unlike
 *  upstream tools it is invoked via its own `run`, not the supervisor. */
export interface LocalTool {
  name: string
  description: string
  inputSchema?: unknown
  run: (args: Record<string, unknown>) => Promise<{ content: unknown[]; isError?: boolean }> | { content: unknown[]; isError?: boolean }
}

/** Everything registerProxyTools needs from the supervisor — injected for tests. */
export interface ProxyToolDeps {
  /** All tools across ONLINE upstreams (supervisor.getTools). */
  getTools: () => AggregatedTool[]
  /** Per-upstream runtime state incl. exposure mode (supervisor.getState). */
  getState: () => UpstreamRuntimeState[]
  /** Route a resolved call to its upstream (supervisor.callTool). */
  callTool: (upstreamId: string, toolName: string, args: Record<string, unknown> | undefined) => Promise<unknown>
  /** In-process Conductor built-ins exposed via search (T9). Optional. */
  localTools?: LocalTool[]
  /** Subscribe to change events; return an unsubscribe fn. Optional (tests skip). */
  onChanged?: (cb: () => void) => () => void
}

function textResult(text: string, isError = false) {
  return { content: [{ type: 'text' as const, text }], isError }
}

/** Pass an upstream CallToolResult through unchanged when it already looks like
 *  MCP content; otherwise wrap it as JSON text so the client always gets a
 *  well-formed result. */
function passthroughResult(raw: unknown) {
  if (raw && typeof raw === 'object' && Array.isArray((raw as any).content)) {
    return raw as { content: unknown[]; isError?: boolean }
  }
  return textResult(JSON.stringify(raw))
}

/** Map a dispatch failure to a graceful, actionable tool result. TOOL_NOT_FOUND
 *  is the list→call race — tell the model to re-search rather than erroring hard. */
function dispatchErrorResult(err: unknown) {
  if (err instanceof ProxyDispatchError) {
    if (err.code === 'TOOL_NOT_FOUND') {
      return textResult(`${err.message}. Run search_tools again to get the current tool list.`, true)
    }
    if (err.code === 'UPSTREAM_OFFLINE') {
      return textResult(`${err.message}. Check list_servers; the server may be starting or stopped.`, true)
    }
    return textResult(err.message, true)
  }
  return textResult(`Tool call failed: ${err instanceof Error ? err.message : String(err)}`, true)
}

// ── JSON Schema → Zod (best-effort, for passthrough only) ──

/** Convert one JSON-Schema property definition to a Zod type. Unknown shapes
 *  degrade to z.any() so a call is never blocked by an untranslatable schema. */
export function jsonSchemaToZodType(def: unknown, z: any): any {
  if (!def || typeof def !== 'object') return z.any()
  const d = def as Record<string, unknown>
  if (Array.isArray(d.enum) && d.enum.length > 0 && d.enum.every((e) => typeof e === 'string')) {
    return z.enum(d.enum as [string, ...string[]])
  }
  switch (d.type) {
    case 'string':
      return z.string()
    case 'number':
    case 'integer':
      return z.number()
    case 'boolean':
      return z.boolean()
    case 'array':
      return z.array(d.items ? jsonSchemaToZodType(d.items, z) : z.any())
    case 'object':
      return z.object({}).passthrough()
    default:
      return z.any()
  }
}

/** Build a Zod raw shape (Record<string, ZodType>) from a tool's top-level
 *  JSON-Schema `properties`, honoring `required` and per-arg `description`. */
export function jsonSchemaToZodShape(inputSchema: unknown, z: any): Record<string, any> {
  const shape: Record<string, any> = {}
  if (!inputSchema || typeof inputSchema !== 'object') return shape
  const props = (inputSchema as Record<string, unknown>).properties
  if (!props || typeof props !== 'object') return shape
  const required = new Set(
    Array.isArray((inputSchema as Record<string, unknown>).required)
      ? ((inputSchema as Record<string, unknown>).required as unknown[]).filter((r) => typeof r === 'string')
      : [],
  )
  for (const [key, def] of Object.entries(props as Record<string, unknown>)) {
    let zt = jsonSchemaToZodType(def, z)
    const desc = def && typeof def === 'object' ? (def as Record<string, unknown>).description : undefined
    if (typeof desc === 'string') zt = zt.describe(desc)
    if (!required.has(key)) zt = zt.optional()
    shape[key] = zt
  }
  return shape
}

/**
 * Register the proxy tools on `server`. Returns a cleanup function that
 * unsubscribes the change listener (call it when the connection closes).
 *
 * `server` is an McpServer; `z` is the zod module. Both are passed in (matching
 * conductor-mcp-server's lazy-loaded deps) so this module needs no direct import.
 */
export function registerProxyTools(server: any, z: any, deps: ProxyToolDeps): () => void {
  const localTools = deps.localTools ?? []
  const localByName = new Map(localTools.map((t) => [t.name, t]))

  // Local (built-in) tools appear in the index as a virtual `Conductor` upstream
  // so search_tools/describe_tool/call_tool cover them uniformly with upstreams.
  const localAsAggregated: AggregatedTool[] = localTools.map((t) => ({
    upstreamId: BUILTIN_UPSTREAM_ID,
    upstreamName: BUILTIN_UPSTREAM_NAME,
    tool: { name: t.name, description: t.description, inputSchema: t.inputSchema },
  }))
  const buildIndex = () => new ToolIndex([...deps.getTools(), ...localAsAggregated])

  // search_tools ---------------------------------------------------------------
  server.tool(
    'search_tools',
    'Search the tools available across all connected MCP servers by keyword. Returns compact matches (namespaced `server__tool` name, server, one-line description). Use this to discover a tool, then describe_tool for its parameters and call_tool to run it. This is how you reach any proxied MCP tool.',
    {
      query: z.string().describe('Keywords describing the tool or capability you need (e.g. "read file", "open issue").'),
      server: z.string().optional().describe('Restrict to one server by its slug or display name.'),
      limit: z.number().optional().describe('Max results (default 10).'),
    },
    async ({ query, server: serverFilter, limit }: { query: string; server?: string; limit?: number }) => {
      const index = buildIndex()
      const rows = index.search(query, { server: serverFilter, limit })
      if (rows.length === 0) {
        return textResult(
          JSON.stringify({
            results: [],
            hint: 'No matching tools. Try broader keywords, or call list_servers to see which servers are online.',
          }),
        )
      }
      return textResult(JSON.stringify({ results: rows }))
    },
  )

  // describe_tool --------------------------------------------------------------
  server.tool(
    'describe_tool',
    'Get the full input schema (parameters) for a proxied tool by its namespaced `server__tool` name, as returned by search_tools. Call this before call_tool when you need the argument shape.',
    {
      name: z.string().describe('Namespaced tool name, e.g. "filesystem__read_file".'),
    },
    async ({ name }: { name: string }) => {
      const index = buildIndex()
      const detail = index.describe(name)
      if (!detail) {
        return textResult(`Unknown tool "${name}". Run search_tools to get valid names.`, true)
      }
      return textResult(
        JSON.stringify({
          name: detail.namespacedName,
          server: detail.server,
          description: detail.description,
          inputSchema: detail.inputSchema ?? { type: 'object', properties: {} },
        }),
      )
    },
  )

  // call_tool ------------------------------------------------------------------
  server.tool(
    'call_tool',
    'Invoke a proxied tool by its namespaced `server__tool` name (from search_tools) with its arguments. Returns the upstream tool result directly.',
    {
      name: z.string().describe('Namespaced tool name, e.g. "github__create_issue".'),
      arguments: z.record(z.any()).optional().describe('Arguments object for the tool (see describe_tool).'),
    },
    async ({ name, arguments: args }: { name: string; arguments?: Record<string, unknown> }) => {
      const index = buildIndex()
      const target = index.resolve(name)
      if (!target) {
        return textResult(`Unknown tool "${name}". Run search_tools to get current names.`, true)
      }
      try {
        // Built-ins run in-process; everything else routes to its upstream.
        if (target.upstreamId === BUILTIN_UPSTREAM_ID) {
          const local = localByName.get(target.toolName)
          if (!local) return textResult(`Unknown tool "${name}". Run search_tools to get current names.`, true)
          return await local.run(args ?? {})
        }
        const raw = await deps.callTool(target.upstreamId, target.toolName, args)
        return passthroughResult(raw)
      } catch (err) {
        return dispatchErrorResult(err)
      }
    },
  )

  // list_servers ---------------------------------------------------------------
  server.tool(
    'list_servers',
    'List the connected MCP servers behind this proxy with their online/offline status and tool counts.',
    {},
    async () => {
      const servers = deps.getState().map((s) => ({
        name: s.name,
        status: s.status,
        exposure: s.exposure,
        toolCount: s.toolCount,
        ...(s.lastError ? { lastError: s.lastError } : {}),
      }))
      if (localTools.length > 0) {
        servers.unshift({
          name: BUILTIN_UPSTREAM_NAME,
          status: 'online',
          exposure: 'search',
          toolCount: localTools.length,
        })
      }
      return textResult(JSON.stringify({ servers }))
    },
  )

  // passthrough tools ----------------------------------------------------------
  // Snapshot of each passthrough upstream's tools at connect time. Live changes
  // fire sendToolListChanged below; the client (Claude >=2.1.0) re-lists, but
  // the passthrough *set* only refreshes on reconnect (MVP limitation).
  const passthroughIds = new Set(
    deps.getState().filter((s) => s.exposure === 'passthrough' && s.status === 'online').map((s) => s.name),
  )
  if (passthroughIds.size > 0) {
    const index = new ToolIndex(deps.getTools())
    for (const row of index.all()) {
      const detail = index.describe(row.name)
      if (!detail || !passthroughIds.has(detail.server)) continue
      const target = { upstreamId: detail.upstreamId, toolName: detail.toolName }
      server.tool(
        row.name,
        detail.description || `Proxied tool from ${detail.server}`,
        jsonSchemaToZodShape(detail.inputSchema, z),
        async (args: Record<string, unknown>) => {
          try {
            return passthroughResult(await deps.callTool(target.upstreamId, target.toolName, args))
          } catch (err) {
            return dispatchErrorResult(err)
          }
        },
      )
    }
  }

  // Hot-reload: re-advertise the tool list when upstreams change. Harmless in
  // search mode (the meta-tool set is fixed); prompts a re-list for passthrough.
  if (deps.onChanged) {
    return deps.onChanged(() => {
      try { server.sendToolListChanged?.() } catch { /* connection may be closing */ }
    })
  }
  return () => {}
}
