import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { getConductorMcpPort } from '../conductor-mcp-server'

/**
 * Path to the local-session settings file. Mirrors the SSH remote layout
 * (~/.claude/settings-<sid>.json) so boot-cleanup can purge stale entries
 * from one place regardless of session type.
 */
export function getLocalSessionSettingsPath(sessionId: string): string {
  const safeSid = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')
  return path.join(os.homedir(), '.claude', `settings-${safeSid}.json`)
}

/**
 * Path to the local-session MCP config file. Distinct from the settings
 * file because claude.exe reads MCP server config from `--mcp-config` only,
 * NOT from `--settings`.
 */
export function getLocalSessionMcpConfigPath(sessionId: string): string {
  const safeSid = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')
  return path.join(os.homedir(), '.claude', `mcp-${safeSid}.json`)
}

/**
 * Seed a local-session settings file as a full clone of the user's
 * ~/.claude/settings.json. Used for hooks/statusLine overrides only --
 * NOT for mcpServers (claude.exe ignores mcpServers in --settings files).
 *
 * Claude Code's `--settings` flag may either REPLACE user settings entirely
 * or MERGE onto them; both assumptions live in the codebase comments and
 * the docs are ambiguous. Copying every top-level key (not just the keys
 * CCC cares about) is safe under both semantics.
 */
export interface WriteSessionSettingsOptions {
  /** v1.5.12: when true, force `disableWorkflows: true` into the per-session
   *  settings so Claude Code's dynamic-workflow feature is disabled at boot.
   *  Caller (pty-manager) reads the CCC AppSettings.disableClaudeWorkflows
   *  flag and passes it through. */
  disableWorkflows?: boolean
}

export function writeLocalSessionSettings(sessionId: string, opts: WriteSessionSettingsOptions = {}): string {
  const claudeDir = path.join(os.homedir(), '.claude')
  try {
    fs.mkdirSync(claudeDir, { recursive: true })
  } catch {
    /* directory may already exist */
  }

  let shared: Record<string, unknown> = {}
  try {
    const sharedPath = path.join(claudeDir, 'settings.json')
    const raw = fs.readFileSync(sharedPath, 'utf-8')
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === 'object') {
      shared = parsed as Record<string, unknown>
    }
  } catch {
    /* shared settings may not exist yet (fresh install) -- start empty */
  }

  // Clone every top-level key from shared so injectHooks can overlay the
  // `hooks` key without dropping the user's outputStyle, permissions, etc.
  const sesCfg: Record<string, unknown> = { ...shared }

  // v1.5.12: opt-in disable of CC's dynamic workflows feature. Overrides any
  // existing value in the shared settings.json -- the CCC toggle is the
  // authoritative source for newly spawned sessions. Set to undefined would
  // leave the shared value alone, which is what we want for the off path.
  if (opts.disableWorkflows) {
    sesCfg.disableWorkflows = true
  }

  const sesPath = getLocalSessionSettingsPath(sessionId)
  return atomicJsonWrite(sesPath, sesCfg)
}

/**
 * Write a per-session MCP config file containing the conductor entry
 * pointed at THIS CCC instance's MCP server port. Passed to claude.exe via
 * `--mcp-config <path>` so it overrides the global ~/.claude.json entry
 * (which may be stale due to dev/prod CCC instance race).
 *
 * Schema mirrors `claude mcp add --transport sse` output:
 *   { mcpServers: { 'conductor': { type: 'sse', url: '...' } } }
 *
 * P7.7.10: bake `cccSessionId=<sid>` into the URL query string so the
 * server can resolve the CCC session from the MCP transport itself
 * (rather than trusting an LLM-supplied tool arg, which Claude has been
 * observed to cache stale from prior conversations). Global
 * ~/.claude.json entries do NOT include the query (so external `claude`
 * invocations outside CCC fail closed -- codex_review returns a clean
 * "no session bound" error rather than dispatching against a stranger's
 * session id).
 *
 * Returns the path even if mcpPort is 0 (MCP server not yet bound) so the
 * caller can still pass --mcp-config; the file simply has an empty
 * mcpServers object in that case.
 */
export function writeLocalSessionMcpConfig(sessionId: string): string {
  const claudeDir = path.join(os.homedir(), '.claude')
  try {
    fs.mkdirSync(claudeDir, { recursive: true })
  } catch { /* may exist */ }

  const mcpPort = getConductorMcpPort()
  const mcpServers: Record<string, unknown> = {}
  if (mcpPort > 0) {
    const encodedSid = encodeURIComponent(sessionId)
    mcpServers['conductor'] = {
      type: 'sse',
      url: `http://localhost:${mcpPort}/sse?cccSessionId=${encodedSid}`,
    }
  }
  const cfg = { mcpServers }
  const cfgPath = getLocalSessionMcpConfigPath(sessionId)
  return atomicJsonWrite(cfgPath, cfg)
}

export function removeLocalSessionSettings(sessionId: string): void {
  try {
    fs.unlinkSync(getLocalSessionSettingsPath(sessionId))
  } catch {
    /* file may already be gone or never written */
  }
}

export function removeLocalSessionMcpConfig(sessionId: string): void {
  try {
    fs.unlinkSync(getLocalSessionMcpConfigPath(sessionId))
  } catch {
    /* file may already be gone or never written */
  }
}

function atomicJsonWrite(filePath: string, data: unknown): string {
  const tmp = `${filePath}.tmp.${process.pid}`
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8')
  try {
    fs.renameSync(tmp, filePath)
  } catch {
    try { fs.unlinkSync(tmp) } catch { /* ignore */ }
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8')
  }
  return filePath
}
