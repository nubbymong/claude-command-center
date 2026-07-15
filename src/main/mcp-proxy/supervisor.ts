/**
 * Conductor Proxy — upstream supervisor (T2, #94).
 *
 * The engine. Owns ONE shared connection per upstream MCP server and fans it
 * out to every CCC session (local + SSH) — so N Claude/Codex instances share a
 * single process/connection per MCP instead of each spawning its own. Tracks
 * online/offline state, caches each upstream's tool list, re-lists on the
 * upstream's `tools/list_changed`, and dispatches `call_tool`.
 *
 * All MCP SDK usage is isolated in `defaultConnectionFactory`; the supervisor
 * logic itself is transport-agnostic and unit-testable with an injected fake
 * factory (see supervisor.test.ts) — no child process or socket required.
 *
 * This module has NO client-facing MCP surface: it does not register tools on
 * the conductor endpoint. The tool-index (T3/#95) reads `getTools()`, and the
 * proxy meta-tools (T4/#96) call `callTool()`.
 */

import { listUpstreams } from './upstream-registry'
import { emitInternal } from '../internal-events'
import { logInfo, logWarn, logError } from '../debug-logger'
import type { McpUpstream } from '../../shared/types'

export type UpstreamStatus = 'offline' | 'connecting' | 'online' | 'error'

/** A tool as reported by an upstream's `tools/list`. `inputSchema` is the raw
 *  JSON Schema object; the tool-index (T3) and describe_tool (T4) consume it. */
export interface UpstreamToolInfo {
  name: string
  description?: string
  inputSchema?: unknown
}

/** One tool tagged with the upstream that owns it. Namespacing to `server__tool`
 *  is the tool-index's job (T3), not the supervisor's. */
export interface AggregatedTool {
  upstreamId: string
  upstreamName: string
  tool: UpstreamToolInfo
}

/** Serialisable per-upstream runtime state for the UI (T5) and `list_servers`. */
export interface UpstreamRuntimeState {
  id: string
  name: string
  status: UpstreamStatus
  exposure: McpUpstream['exposure']
  toolCount: number
  lastError?: string
}

/** Hooks the supervisor wires into a live connection. */
export interface ConnectionHooks {
  /** Upstream sent `notifications/tools/list_changed`; re-list its tools. */
  onToolsChanged: () => void
  /** Transport closed or errored; the connection is dead. */
  onClosed: (err?: Error) => void
}

/** The transport-agnostic connection contract the supervisor drives. The real
 *  implementation wraps an MCP SDK Client; tests supply a fake. */
export interface UpstreamConnection {
  connect(hooks: ConnectionHooks): Promise<void>
  listTools(): Promise<UpstreamToolInfo[]>
  callTool(name: string, args: Record<string, unknown> | undefined): Promise<unknown>
  close(): Promise<void>
}

export type ConnectionFactory = (u: McpUpstream) => UpstreamConnection

/** Error carrying a machine-readable code so T4 can map to a clean tool result. */
export class ProxyDispatchError extends Error {
  constructor(
    public readonly code:
      | 'UPSTREAM_NOT_FOUND'
      | 'UPSTREAM_OFFLINE'
      | 'TOOL_NOT_FOUND',
    message: string,
  ) {
    super(message)
    this.name = 'ProxyDispatchError'
  }
}

interface Entry {
  upstream: McpUpstream
  status: UpstreamStatus
  conn: UpstreamConnection | null
  tools: UpstreamToolInfo[]
  lastError?: string
}

export interface SupervisorDeps {
  /** Build a connection for an upstream. Defaults to the real MCP SDK factory. */
  connectionFactory?: ConnectionFactory
  /** Source of the registry. Defaults to the persisted registry (T1). */
  loadUpstreams?: () => McpUpstream[]
  /** Broadcast a state change. Defaults to the `mcp-proxy:changed` internal event. */
  emitChanged?: (reason: string) => void
}

export class McpProxySupervisor {
  private readonly entries = new Map<string, Entry>()
  private readonly factory: ConnectionFactory
  private readonly loadUpstreams: () => McpUpstream[]
  private readonly emitChanged: (reason: string) => void

  constructor(deps: SupervisorDeps = {}) {
    this.factory = deps.connectionFactory ?? defaultConnectionFactory
    this.loadUpstreams = deps.loadUpstreams ?? listUpstreams
    this.emitChanged =
      deps.emitChanged ?? ((reason) => emitInternal('mcp-proxy:changed', { reason }))
  }

  /**
   * Reconcile the in-memory entries with the current registry, then connect
   * every enabled upstream flagged `autostart`. Called once at app boot.
   */
  async start(): Promise<void> {
    this.sync()
    const toStart = [...this.entries.values()].filter(
      (e) => e.upstream.enabled && e.upstream.autostart && e.status === 'offline',
    )
    await Promise.allSettled(toStart.map((e) => this.startUpstream(e.upstream.id)))
  }

  /**
   * Reconcile entries with the registry WITHOUT connecting: add new upstreams
   * (offline), update config on existing ones, and stop+drop removed ones.
   * Idempotent. Safe to call after any registry mutation (T5 UI).
   */
  sync(): void {
    const desired = new Map(this.loadUpstreams().map((u) => [u.id, u]))

    // Drop entries no longer in the registry (close first).
    for (const id of [...this.entries.keys()]) {
      if (!desired.has(id)) {
        void this.stopUpstream(id)
        this.entries.delete(id)
      }
    }
    // Add or update.
    for (const [id, u] of desired) {
      const existing = this.entries.get(id)
      if (existing) {
        existing.upstream = u
      } else {
        this.entries.set(id, { upstream: u, status: 'offline', conn: null, tools: [] })
      }
    }
  }

  /** Connect one upstream and cache its tools. No-op if already online. */
  async startUpstream(id: string): Promise<void> {
    const entry = this.entries.get(id)
    if (!entry) throw new ProxyDispatchError('UPSTREAM_NOT_FOUND', `No upstream ${id}`)
    if (!entry.upstream.enabled) return
    if (entry.status === 'online' || entry.status === 'connecting') return

    entry.status = 'connecting'
    entry.lastError = undefined
    this.emitChanged(`connecting:${id}`)

    const conn = this.factory(entry.upstream)
    try {
      await conn.connect({
        onToolsChanged: () => void this.refreshTools(id),
        onClosed: (err) => this.handleClosed(id, err),
      })
      entry.conn = conn
      entry.tools = await conn.listTools()
      entry.status = 'online'
      logInfo(`[mcp-proxy] upstream online: ${entry.upstream.name} (${entry.tools.length} tools)`)
      this.emitChanged(`online:${id}`)
    } catch (err) {
      entry.status = 'error'
      entry.lastError = err instanceof Error ? err.message : String(err)
      entry.conn = null
      entry.tools = []
      try { await conn.close() } catch { /* best effort */ }
      logWarn(`[mcp-proxy] upstream failed to connect: ${entry.upstream.name}: ${entry.lastError}`)
      this.emitChanged(`error:${id}`)
    }
  }

  /** Close one upstream's connection and mark it offline. */
  async stopUpstream(id: string): Promise<void> {
    const entry = this.entries.get(id)
    if (!entry) return
    const conn = entry.conn
    entry.conn = null
    entry.tools = []
    entry.status = 'offline'
    entry.lastError = undefined
    if (conn) {
      try { await conn.close() } catch (err) { logWarn(`[mcp-proxy] close error ${id}: ${String(err)}`) }
    }
    this.emitChanged(`offline:${id}`)
  }

  async restartUpstream(id: string): Promise<void> {
    await this.stopUpstream(id)
    await this.startUpstream(id)
  }

  /** Close every connection. Called at app quit. */
  async stopAll(): Promise<void> {
    await Promise.allSettled([...this.entries.keys()].map((id) => this.stopUpstream(id)))
  }

  /** Serialisable state for every known upstream (for `list_servers` + the UI). */
  getState(): UpstreamRuntimeState[] {
    return [...this.entries.values()].map((e) => ({
      id: e.upstream.id,
      name: e.upstream.name,
      status: e.status,
      exposure: e.upstream.exposure,
      toolCount: e.tools.length,
      lastError: e.lastError,
    }))
  }

  /** Every tool across ONLINE upstreams, tagged with its owner (input to T3). */
  getTools(): AggregatedTool[] {
    const out: AggregatedTool[] = []
    for (const e of this.entries.values()) {
      if (e.status !== 'online') continue
      for (const tool of e.tools) {
        out.push({ upstreamId: e.upstream.id, upstreamName: e.upstream.name, tool })
      }
    }
    return out
  }

  /** Tools for one upstream (empty if offline/unknown). */
  getUpstreamTools(id: string): UpstreamToolInfo[] {
    const e = this.entries.get(id)
    return e && e.status === 'online' ? [...e.tools] : []
  }

  /**
   * Dispatch a tool call to its upstream. Throws {@link ProxyDispatchError}
   * with a code T4 maps to a graceful tool result — in particular TOOL_NOT_FOUND
   * covers the list→call race where a tool vanished after being searched.
   */
  async callTool(
    upstreamId: string,
    toolName: string,
    args: Record<string, unknown> | undefined,
  ): Promise<unknown> {
    const entry = this.entries.get(upstreamId)
    if (!entry) {
      throw new ProxyDispatchError('UPSTREAM_NOT_FOUND', `No upstream ${upstreamId}`)
    }
    if (entry.status !== 'online' || !entry.conn) {
      throw new ProxyDispatchError(
        'UPSTREAM_OFFLINE',
        `Upstream ${entry.upstream.name} is ${entry.status}`,
      )
    }
    if (!entry.tools.some((t) => t.name === toolName)) {
      throw new ProxyDispatchError(
        'TOOL_NOT_FOUND',
        `Tool ${toolName} is no longer offered by ${entry.upstream.name}`,
      )
    }
    return entry.conn.callTool(toolName, args)
  }

  // ── internal ──

  private async refreshTools(id: string): Promise<void> {
    const entry = this.entries.get(id)
    if (!entry || entry.status !== 'online' || !entry.conn) return
    try {
      entry.tools = await entry.conn.listTools()
      this.emitChanged(`tools-changed:${id}`)
    } catch (err) {
      logWarn(`[mcp-proxy] re-list failed for ${id}: ${String(err)}`)
    }
  }

  private handleClosed(id: string, err?: Error): void {
    const entry = this.entries.get(id)
    if (!entry) return
    // Ignore a close for a connection we already replaced/tore down.
    if (!entry.conn) return
    entry.conn = null
    entry.tools = []
    entry.status = err ? 'error' : 'offline'
    entry.lastError = err?.message
    logWarn(`[mcp-proxy] upstream connection closed: ${entry.upstream.name}${err ? ` (${err.message})` : ''}`)
    this.emitChanged(`closed:${id}`)
  }
}

// ── real MCP SDK connection factory ──
//
// Isolated here so the supervisor stays testable. The SDK is require()'d lazily
// (not imported) to match conductor-mcp-server's loadMcpDeps pattern and to keep
// it out of the unit-test import graph when a fake factory is injected.

function defaultConnectionFactory(u: McpUpstream): UpstreamConnection {
  let client: any = null
  return {
    async connect(hooks: ConnectionHooks): Promise<void> {
      const { Client } = require('@modelcontextprotocol/sdk/client/index.js')
      const { ToolListChangedNotificationSchema } = require('@modelcontextprotocol/sdk/types.js')
      const transport = buildClientTransport(u)
      transport.onclose = () => hooks.onClosed()
      transport.onerror = (e: Error) => hooks.onClosed(e)
      client = new Client({ name: 'conductor-proxy', version: '1.0.0' }, { capabilities: {} })
      client.setNotificationHandler(ToolListChangedNotificationSchema, () => hooks.onToolsChanged())
      await client.connect(transport)
    },
    async listTools(): Promise<UpstreamToolInfo[]> {
      const res = await client.listTools()
      const tools = Array.isArray(res?.tools) ? res.tools : []
      return tools.map((t: any) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      }))
    },
    async callTool(name: string, args: Record<string, unknown> | undefined): Promise<unknown> {
      return client.callTool({ name, arguments: args ?? {} })
    },
    async close(): Promise<void> {
      try { await client?.close() } catch { /* already closed */ }
      client = null
    },
  }
}

function buildClientTransport(u: McpUpstream): any {
  const t = u.transport
  if (t.kind === 'stdio') {
    const { StdioClientTransport, getDefaultEnvironment } = require('@modelcontextprotocol/sdk/client/stdio.js')
    return new StdioClientTransport({
      command: t.command,
      args: t.args ?? [],
      // Merge user-supplied env over the SDK's safe-default set rather than
      // replacing it, so servers keep PATH/HOME etc.
      env: { ...getDefaultEnvironment(), ...(t.env ?? {}) },
    })
  }
  if (t.kind === 'sse') {
    const { SSEClientTransport } = require('@modelcontextprotocol/sdk/client/sse.js')
    return new SSEClientTransport(new URL(t.url), t.headers ? { requestInit: { headers: t.headers } } : undefined)
  }
  // http (Streamable HTTP)
  const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js')
  return new StreamableHTTPClientTransport(new URL(t.url), t.headers ? { requestInit: { headers: t.headers } } : undefined)
}

// ── global singleton (mirrors vision-manager / conductor-mcp-server) ──

let _supervisor: McpProxySupervisor | null = null

export function getProxySupervisor(): McpProxySupervisor {
  if (!_supervisor) _supervisor = new McpProxySupervisor()
  return _supervisor
}

/** Start the shared supervisor at app boot. Never throws — a bad upstream must
 *  not block launch; it surfaces as an `error` state in the UI. */
export async function startProxySupervisor(): Promise<void> {
  try {
    await getProxySupervisor().start()
  } catch (err) {
    logError(`[mcp-proxy] supervisor start failed: ${String(err)}`)
  }
}

/** For tests: replace/reset the singleton. */
export function __setProxySupervisorForTest(s: McpProxySupervisor | null): void {
  _supervisor = s
}
