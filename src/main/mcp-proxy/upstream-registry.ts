/**
 * Conductor Proxy — upstream MCP server registry (T1, #93).
 *
 * The persisted list of upstream MCP servers the proxy supervises. This module
 * is ONLY the data model + persistence: it does not connect to, spawn, or
 * otherwise touch a real MCP server (that is the supervisor, T2/#94). Keeping
 * validation pure and side-effect-free here means the whole schema contract is
 * unit-testable without Electron or a live process.
 *
 * Persistence: a single `mcp-upstreams.json` under CONFIG/, via config-manager's
 * `readConfig`/`saveConfig` ('mcpUpstreams' key). The stored shape is a bare
 * array of McpUpstream; a corrupt/partial entry is dropped on read rather than
 * throwing, so one bad hand-edit can never take the whole registry offline.
 */

import { randomUUID } from 'node:crypto'
import { readConfig, saveConfig } from '../config-manager'
import { logWarn } from '../debug-logger'
import type {
  McpUpstream,
  McpUpstreamExposure,
  McpUpstreamTransport,
} from '../../shared/types'

const CONFIG_KEY = 'mcpUpstreams' as const

const VALID_EXPOSURES: readonly McpUpstreamExposure[] = ['search', 'passthrough']

/** Fields a caller supplies when creating an upstream. `id` is minted for them;
 *  the booleans/exposure fall back to safe defaults when omitted. */
export interface McpUpstreamInput {
  name: string
  transport: McpUpstreamTransport
  enabled?: boolean
  exposure?: McpUpstreamExposure
  autostart?: boolean
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0
}

/** Optional `Record<string,string>` — accept only a plain object of string
 *  values; anything else normalizes to undefined rather than corrupting the
 *  spawn env / request headers with non-strings. */
function normalizeStringMap(v: unknown): Record<string, string> | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined
  const out: Record<string, string> = {}
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === 'string') out[k] = val
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/** Validate + normalize a raw transport. Returns null if the transport is not
 *  a usable stdio/http/sse descriptor (the whole upstream is then dropped). */
export function normalizeTransport(raw: unknown): McpUpstreamTransport | null {
  if (!raw || typeof raw !== 'object') return null
  const t = raw as Record<string, unknown>

  if (t.kind === 'stdio') {
    if (!isNonEmptyString(t.command)) return null
    const args = Array.isArray(t.args)
      ? t.args.filter((a): a is string => typeof a === 'string')
      : undefined
    const env = normalizeStringMap(t.env)
    const out: McpUpstreamTransport = { kind: 'stdio', command: t.command }
    if (args && args.length > 0) out.args = args
    if (env) out.env = env
    return out
  }

  if (t.kind === 'http' || t.kind === 'sse') {
    if (!isNonEmptyString(t.url)) return null
    const headers = normalizeStringMap(t.headers)
    const out: McpUpstreamTransport = { kind: t.kind, url: t.url }
    if (headers) out.headers = headers
    return out
  }

  return null
}

/** Validate + normalize one raw registry entry into a full McpUpstream.
 *  Returns null (caller drops it) when required fields are missing/invalid.
 *  Pure — safe to call on untrusted JSON. */
export function normalizeUpstream(raw: unknown): McpUpstream | null {
  if (!raw || typeof raw !== 'object') return null
  const u = raw as Record<string, unknown>

  if (!isNonEmptyString(u.id)) return null
  if (!isNonEmptyString(u.name)) return null

  const transport = normalizeTransport(u.transport)
  if (!transport) return null

  const exposure: McpUpstreamExposure =
    VALID_EXPOSURES.includes(u.exposure as McpUpstreamExposure)
      ? (u.exposure as McpUpstreamExposure)
      : 'search'

  return {
    id: u.id,
    name: u.name,
    transport,
    // Absent booleans default ON for enabled (an entry in the list is meant to
    // be used) and OFF for autostart (connect lazily unless asked).
    enabled: u.enabled !== false,
    exposure,
    autostart: u.autostart === true,
  }
}

/** Validate a raw persisted array into a clean McpUpstream[]. Non-array input
 *  yields []; individual bad entries are dropped (and logged), never thrown. */
export function normalizeUpstreams(raw: unknown): McpUpstream[] {
  if (!Array.isArray(raw)) return []
  const out: McpUpstream[] = []
  const seen = new Set<string>()
  for (const entry of raw) {
    const u = normalizeUpstream(entry)
    if (!u) {
      logWarn('[mcp-proxy] Dropping invalid upstream entry from registry')
      continue
    }
    if (seen.has(u.id)) {
      logWarn(`[mcp-proxy] Dropping duplicate upstream id: ${u.id}`)
      continue
    }
    seen.add(u.id)
    out.push(u)
  }
  return out
}

/** Build a full McpUpstream from caller input, minting an id and filling
 *  defaults. Throws if the transport is invalid (a create-time programmer error
 *  the UI should have prevented — unlike read-time entries, which are dropped). */
export function buildUpstream(input: McpUpstreamInput): McpUpstream {
  const transport = normalizeTransport(input.transport)
  if (!transport) {
    throw new Error('Cannot create upstream: invalid transport')
  }
  if (!isNonEmptyString(input.name)) {
    throw new Error('Cannot create upstream: name is required')
  }
  return {
    id: randomUUID(),
    name: input.name,
    transport,
    enabled: input.enabled !== false,
    exposure: VALID_EXPOSURES.includes(input.exposure as McpUpstreamExposure)
      ? (input.exposure as McpUpstreamExposure)
      : 'search',
    autostart: input.autostart === true,
  }
}

// ── Persistence CRUD ──

/** All upstreams, cleaned. Empty array when nothing is stored. */
export function listUpstreams(): McpUpstream[] {
  return normalizeUpstreams(readConfig(CONFIG_KEY))
}

export function getUpstream(id: string): McpUpstream | null {
  return listUpstreams().find((u) => u.id === id) ?? null
}

function persist(upstreams: McpUpstream[]): boolean {
  return saveConfig(CONFIG_KEY, upstreams)
}

/** Create a new upstream from input and persist it. Returns the created entry,
 *  or null if the write failed. */
export function addUpstream(input: McpUpstreamInput): McpUpstream | null {
  const created = buildUpstream(input)
  const next = [...listUpstreams(), created]
  return persist(next) ? created : null
}

/** Merge a partial patch into an existing upstream by id and persist. The id
 *  and transport-kind are preserved unless the patch supplies a valid new
 *  transport. Returns the updated entry, or null if not found / write failed. */
export function updateUpstream(
  id: string,
  patch: Partial<McpUpstreamInput>,
): McpUpstream | null {
  const current = listUpstreams()
  const idx = current.findIndex((u) => u.id === id)
  if (idx < 0) return null

  const existing = current[idx]
  const merged: McpUpstream = {
    ...existing,
    ...(patch.name !== undefined && isNonEmptyString(patch.name)
      ? { name: patch.name }
      : {}),
    ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
    ...(patch.autostart !== undefined ? { autostart: patch.autostart } : {}),
    ...(patch.exposure !== undefined &&
    VALID_EXPOSURES.includes(patch.exposure)
      ? { exposure: patch.exposure }
      : {}),
  }
  if (patch.transport !== undefined) {
    const t = normalizeTransport(patch.transport)
    if (t) merged.transport = t
  }

  const next = [...current]
  next[idx] = merged
  return persist(next) ? merged : null
}

/** Remove an upstream by id. Returns true if an entry was removed and the
 *  write succeeded; false if the id was absent or the write failed. */
export function removeUpstream(id: string): boolean {
  const current = listUpstreams()
  const next = current.filter((u) => u.id !== id)
  if (next.length === current.length) return false
  return persist(next)
}
