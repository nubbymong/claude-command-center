import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { getConductorMcpPort, getConductorMcpSecret } from '../conductor-mcp-server'
import { buildStatuslineSetting } from '../providers/claude/statusline-command'
import { atomicWriteSecure, mkdirSecure, hardenCredentialDir } from '../account-profiles'
import { logWarn } from '../debug-logger'

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
  /** U2: when provided, inject the CCC statusLine command per-session (pointing
   *  at `<resourcesDir>/scripts/claude-multi-statusline.js`) instead of writing
   *  it into the user's global ~/.claude/settings.json. Overrides any statusLine
   *  inherited from the shared-settings clone. */
  resourcesDir?: string
  /** 2026-08-14 (SEC-BATCH FLAG): union CCC's own Agent Canvas tools into
   *  permissions.allow so the render->review loop doesn't stall in approval
   *  prompts. Additive only — the user's deny/ask lists are never touched and
   *  a deny still wins under Claude's permission semantics. */
  allowCanvasTools?: boolean
}

/**
 * Canvas tools that may skip the approval prompt.
 *
 * ONLY the two READS, and only because they read CCC's own state: the snapshot
 * of a page this app rendered, and the notes the user wrote in this app's own
 * UI. Neither takes a path or any other argument that widens what it can touch.
 *
 * `canvas_render` is deliberately NOT here. It accepts `htmlPath`, an absolute
 * path the MODEL supplies, read with the app's privileges. Pre-allowing it
 * removed the last human gate on that read — adversarial review (2026-08-14)
 * drove it to a private key with no prompt and nothing on screen. The read is
 * now confined to the session's project directory (resolveInsideCanvasRoot),
 * but confinement and prompt-suppression should not land in the same change:
 * the prompt costs one keypress per render and it is the thing that would have
 * caught that. The UX problem it was added for — a 37 KB document flooding the
 * approval prompt — is already fixed by `htmlPath` being one line.
 */
const CANVAS_TOOL_PERMISSIONS = ['mcp__conductor__canvas_snapshot', 'mcp__conductor__canvas_review']

export function writeLocalSessionSettings(sessionId: string, opts: WriteSessionSettingsOptions = {}): string {
  const claudeDir = path.join(os.homedir(), '.claude')
  // ~/.claude is created securely inside atomicJsonWrite (mkdirSecure + 0700) at
  // write time -- no plain mkdir here, which would silently accept a pre-planted
  // junction. The settings.json read below fails closed if the dir is absent.

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

  // U2: deliver the statusLine PER-SESSION rather than via a global
  // ~/.claude/settings.json write. Overrides any statusLine inherited from the
  // shared clone so external `claude` runs outside CCC keep their native line.
  if (opts.resourcesDir) {
    sesCfg.statusLine = buildStatuslineSetting(opts.resourcesDir)
  }

  // Union the canvas tools into permissions.allow, preserving everything the
  // user already has there. Shape-defensive: a malformed permissions value in
  // the shared file is left exactly as it was (never "repaired" into shape).
  if (opts.allowCanvasTools) {
    const permissions = sesCfg.permissions
    if (permissions === undefined) {
      sesCfg.permissions = { allow: [...CANVAS_TOOL_PERMISSIONS] }
    } else if (permissions && typeof permissions === 'object' && !Array.isArray(permissions)) {
      const perm = { ...(permissions as Record<string, unknown>) }
      const allow = Array.isArray(perm.allow) ? perm.allow : perm.allow === undefined ? [] : null
      if (allow !== null) {
        const merged = [...allow]
        for (const tool of CANVAS_TOOL_PERMISSIONS) if (!merged.includes(tool)) merged.push(tool)
        perm.allow = merged
        sesCfg.permissions = perm
      }
    }
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
export function writeLocalSessionMcpConfig(sessionId: string, includeConductor = true): string {
  const mcpPort = getConductorMcpPort()
  const mcpServers: Record<string, unknown> = {}
  // includeConductor=false (conductorToolsEnabled master off) writes an empty
  // mcpServers object -- same shape as the port-0 fallback -- so the session
  // launches with no built-in tools instead of a dangling endpoint.
  if (mcpPort > 0 && includeConductor) {
    const encodedSid = encodeURIComponent(sessionId)
    // R-DEC-3: &token=<secret> authenticates this session against the gated
    // MCP server. The SSE transport preserves the query on its /messages
    // endpoint, so follow-up POSTs carry it too.
    mcpServers['conductor'] = {
      type: 'sse',
      url: `http://localhost:${mcpPort}/sse?cccSessionId=${encodedSid}&token=${getConductorMcpSecret()}`,
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

/**
 * Write a per-session file under ~/.claude atomically and owner-only.
 *
 * mcp-<sid>.json carries the Conductor MCP bearer token (`?token=<secret>`) --
 * the sole gate on the loopback MCP server, and thus on `vision_eval` (arbitrary
 * JS in the embedded browser). Written with no file mode it landed 0644 on
 * POSIX: any other local user could read the token and drive the server. So
 * create ~/.claude through mkdirSecure (refuse a pre-planted reparse point) +
 * hardenCredentialDir (0700), stage-and-rename via atomicWriteSecure with an
 * explicit 0600, and do NOT fall back to a plain writeFileSync -- the old
 * fallback followed a planted symlink at the target and dropped the mode. Fail
 * closed: leave the previous file, log, and never throw (this runs on the spawn
 * path).
 */
function atomicJsonWrite(filePath: string, data: unknown): string {
  const dir = path.dirname(filePath)
  try {
    mkdirSecure(dir)
    hardenCredentialDir(dir)
    atomicWriteSecure(filePath, JSON.stringify(data, null, 2), 0o600)
  } catch (err) {
    logWarn(`[per-session] secure write of ${path.basename(filePath)} failed (${String(err)}); left the previous file`)
  }
  return filePath
}
