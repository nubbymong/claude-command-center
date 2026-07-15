/**
 * Conductor Proxy — auto-adopt / import + take-over (T6, #98).
 *
 * Discovers MCP servers already configured in the user's clients (Claude CLI
 * `~/.claude.json`, Claude Desktop `claude_desktop_config.json`, Codex
 * `~/.codex/config.toml`), imports them into the proxy registry (T1), and can
 * optionally "take over" — remove the entry from the client config, leaving the
 * proxy the single instance. Take-over backs up the removed raw entries so it is
 * reversible.
 *
 * The parsers/transforms are PURE and fail closed: a config that can't be parsed
 * yields no discoveries and is NEVER rewritten (so a malformed client file is
 * never clobbered). File IO is injected (see FileIo) so the orchestration is
 * unit-testable without touching the real home directory.
 */

import * as os from 'os'
import * as path from 'path'
import * as fs from 'fs'
import { logInfo, logWarn, logError } from '../debug-logger'
import { readConfig, saveConfig } from '../config-manager'
import { listUpstreams, addUpstream } from './upstream-registry'
import type { McpUpstreamTransport } from '../../shared/types'
import type { McpUpstreamInput } from './upstream-registry'

export type AdoptSource = 'claude' | 'claude-desktop' | 'codex'

/** A server found in a client config, ready to import. */
export interface DiscoveredUpstream {
  source: AdoptSource
  input: McpUpstreamInput
  /** True if an equivalent upstream (same name + transport) is already in the registry. */
  existing: boolean
}

// ── pure: map a Claude/Desktop mcpServers entry to a transport ──

function mcpServerEntryToTransport(entry: unknown): McpUpstreamTransport | null {
  if (!entry || typeof entry !== 'object') return null
  const e = entry as Record<string, unknown>
  if (typeof e.command === 'string' && e.command.trim()) {
    const t: McpUpstreamTransport = { kind: 'stdio', command: e.command }
    if (Array.isArray(e.args)) t.args = e.args.filter((a): a is string => typeof a === 'string')
    if (e.env && typeof e.env === 'object' && !Array.isArray(e.env)) {
      const env: Record<string, string> = {}
      for (const [k, v] of Object.entries(e.env as Record<string, unknown>)) if (typeof v === 'string') env[k] = v
      if (Object.keys(env).length) t.env = env
    }
    return t
  }
  if (typeof e.url === 'string' && e.url.trim()) {
    // 'streamable-http' / 'http' -> http; 'sse' -> sse; default http.
    const kind = e.type === 'sse' ? 'sse' : 'http'
    const t: McpUpstreamTransport = { kind, url: e.url }
    if (e.headers && typeof e.headers === 'object' && !Array.isArray(e.headers)) {
      const headers: Record<string, string> = {}
      for (const [k, v] of Object.entries(e.headers as Record<string, unknown>)) if (typeof v === 'string') headers[k] = v
      if (Object.keys(headers).length) t.headers = headers
    }
    return t
  }
  return null
}

/** Parse a `{ mcpServers: {...} }` object (Claude CLI / Claude Desktop share it). */
export function parseMcpServersObject(parsed: unknown): Array<{ name: string; transport: McpUpstreamTransport }> {
  if (!parsed || typeof parsed !== 'object') return []
  const servers = (parsed as Record<string, unknown>).mcpServers
  if (!servers || typeof servers !== 'object') return []
  const out: Array<{ name: string; transport: McpUpstreamTransport }> = []
  for (const [name, entry] of Object.entries(servers as Record<string, unknown>)) {
    const transport = mcpServerEntryToTransport(entry)
    if (transport) out.push({ name, transport })
  }
  return out
}

// ── pure: minimal Codex TOML reader for [mcp_servers.NAME] tables ──

function parseTomlString(raw: string): string | null {
  const m = /^"(.*)"$/.exec(raw.trim()) || /^'(.*)'$/.exec(raw.trim())
  return m ? m[1] : null
}

function parseTomlStringArray(raw: string): string[] {
  const inner = raw.trim().replace(/^\[/, '').replace(/\]$/, '')
  const out: string[] = []
  for (const part of inner.split(',')) {
    const s = parseTomlString(part)
    if (s !== null) out.push(s)
  }
  return out
}

/** Parse Codex `[mcp_servers.NAME]` tables. Only command/args/url are read
 *  (the shapes the proxy supports); anything else is ignored. Tolerant of
 *  surrounding user config. */
export function parseCodexMcpServers(content: string): Array<{ name: string; transport: McpUpstreamTransport }> {
  const lines = content.split('\n')
  const sections = new Map<string, Record<string, string>>()
  let current: string | null = null
  for (const line of lines) {
    const trimmed = line.trim()
    const header = /^\[mcp_servers\.([^\]]+)\]$/.exec(trimmed)
    if (header) {
      current = header[1].replace(/^"|"$/g, '')
      sections.set(current, {})
      continue
    }
    if (trimmed.startsWith('[')) { current = null; continue } // left the table
    if (!current) continue
    const kv = /^([A-Za-z0-9_]+)\s*=\s*(.+)$/.exec(trimmed)
    if (kv) sections.get(current)![kv[1]] = kv[2].trim()
  }

  const out: Array<{ name: string; transport: McpUpstreamTransport }> = []
  for (const [name, kv] of sections) {
    if (kv.command !== undefined) {
      const command = parseTomlString(kv.command)
      if (!command) continue
      const t: McpUpstreamTransport = { kind: 'stdio', command }
      if (kv.args) t.args = parseTomlStringArray(kv.args)
      out.push({ name, transport: t })
    } else if (kv.url !== undefined) {
      const url = parseTomlString(kv.url)
      if (url) out.push({ name, transport: { kind: 'http', url } })
    }
  }
  return out
}

// ── pure: removal transforms for take-over ──

/** Remove named servers from a parsed Claude/Desktop object. Returns the new
 *  object and the removed raw entries (for backup/restore). */
export function removeServersFromObject(
  parsed: Record<string, unknown>,
  names: string[],
): { next: Record<string, unknown>; removed: Record<string, unknown> } {
  const removed: Record<string, unknown> = {}
  const servers = parsed.mcpServers
  if (!servers || typeof servers !== 'object') return { next: parsed, removed }
  const nextServers = { ...(servers as Record<string, unknown>) }
  for (const name of names) {
    if (name in nextServers) {
      removed[name] = nextServers[name]
      delete nextServers[name]
    }
  }
  const next = { ...parsed, mcpServers: nextServers }
  return { next, removed }
}

// ── IO layer (injectable) ──

export interface FileIo {
  read: (p: string) => string | null
  write: (p: string, content: string) => boolean
  exists: (p: string) => boolean
}

const realIo: FileIo = {
  read: (p) => {
    try { return fs.readFileSync(p, 'utf-8') } catch { return null }
  },
  write: (p, content) => {
    // Strict atomic: tmp + rename; abort (leave original intact) on failure.
    const tmp = `${p}.tmp.${process.pid}`
    try {
      fs.writeFileSync(tmp, content, 'utf-8')
      fs.renameSync(tmp, p)
      return true
    } catch (err) {
      try { fs.unlinkSync(tmp) } catch { /* ignore */ }
      logError(`[mcp-adopt] atomic write failed for ${p}: ${String(err)}`)
      return false
    }
  },
  exists: (p) => fs.existsSync(p),
}

export function claudeJsonPath(): string {
  return path.join(os.homedir(), '.claude.json')
}
export function codexTomlPath(): string {
  return path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex'), 'config.toml')
}
export function claudeDesktopPath(): string {
  const home = os.homedir()
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json')
  }
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
  }
  return path.join(home, '.config', 'Claude', 'claude_desktop_config.json')
}

function signature(t: McpUpstreamTransport): string {
  return t.kind === 'stdio' ? `stdio:${t.command}:${(t.args ?? []).join(' ')}` : `${t.kind}:${t.url}`
}

// ── orchestration ──

/** Discover servers across all known client configs. Never throws; a source
 *  that is missing or unparseable simply contributes nothing. */
export function discoverAll(io: FileIo = realIo): DiscoveredUpstream[] {
  const existing = new Set(listUpstreams().map((u) => `${u.name}|${signature(u.transport)}`))
  const results: DiscoveredUpstream[] = []

  const addAll = (source: AdoptSource, found: Array<{ name: string; transport: McpUpstreamTransport }>) => {
    for (const { name, transport } of found) {
      results.push({
        source,
        input: { name, transport, enabled: true, exposure: 'search', autostart: false },
        existing: existing.has(`${name}|${signature(transport)}`),
      })
    }
  }

  const claudeRaw = io.read(claudeJsonPath())
  if (claudeRaw) {
    try { addAll('claude', parseMcpServersObject(JSON.parse(claudeRaw))) }
    catch { logWarn('[mcp-adopt] ~/.claude.json parse failed; skipping') }
  }
  const desktopRaw = io.read(claudeDesktopPath())
  if (desktopRaw) {
    try { addAll('claude-desktop', parseMcpServersObject(JSON.parse(desktopRaw))) }
    catch { logWarn('[mcp-adopt] claude_desktop_config.json parse failed; skipping') }
  }
  const codexRaw = io.read(codexTomlPath())
  if (codexRaw) {
    try { addAll('codex', parseCodexMcpServers(codexRaw)) }
    catch { logWarn('[mcp-adopt] ~/.codex/config.toml parse failed; skipping') }
  }
  return results
}

/** Import the given discovered servers into the registry, skipping ones that
 *  already exist. Returns the number added. */
export function importDiscovered(items: DiscoveredUpstream[]): number {
  let added = 0
  for (const item of items) {
    if (item.existing) continue
    if (addUpstream(item.input)) added++
  }
  if (added > 0) logInfo(`[mcp-adopt] imported ${added} upstream(s)`)
  return added
}

/**
 * Take over the named servers in a client config: remove them from the client
 * file so the proxy is the single instance. Backs up removed entries to
 * CONFIG/mcp-adopt-backup.json for reversibility. Fails closed — a source whose
 * file can't be parsed is left untouched. Only JSON sources (claude,
 * claude-desktop) are supported here; codex take-over is deferred.
 */
export function takeOver(
  source: Extract<AdoptSource, 'claude' | 'claude-desktop'>,
  names: string[],
  io: FileIo = realIo,
): { ok: boolean; removed: number; error?: string } {
  const filePath = source === 'claude' ? claudeJsonPath() : claudeDesktopPath()
  const raw = io.read(filePath)
  if (raw === null) return { ok: false, removed: 0, error: 'Config file not found' }
  let parsed: Record<string, unknown>
  try {
    const p = JSON.parse(raw)
    if (!p || typeof p !== 'object') throw new Error('not an object')
    parsed = p as Record<string, unknown>
  } catch {
    // Fail closed: never rewrite a file we couldn't parse.
    return { ok: false, removed: 0, error: 'Config file is not valid JSON; left untouched' }
  }
  const { next, removed } = removeServersFromObject(parsed, names)
  const removedNames = Object.keys(removed)
  if (removedNames.length === 0) return { ok: true, removed: 0 }

  if (!io.write(filePath, JSON.stringify(next, null, 2))) {
    return { ok: false, removed: 0, error: 'Failed to write config file' }
  }

  // Back up removed entries so take-over is reversible.
  const backup = readConfig<Record<string, Record<string, unknown>>>('mcpAdoptBackup') ?? {}
  backup[source] = { ...(backup[source] ?? {}), ...removed }
  saveConfig('mcpAdoptBackup', backup)

  logInfo(`[mcp-adopt] took over ${removedNames.length} server(s) from ${source}: ${removedNames.join(', ')}`)
  return { ok: true, removed: removedNames.length }
}
