import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { logInfo, logError } from '../../debug-logger'

/**
 * Codex MCP TOML injection -- conductor config.toml support.
 *
 * Codex stores MCP server config in `[mcp_servers.<name>]` tables in
 * `~/.codex/config.toml` (or `$CODEX_HOME/config.toml`). The same HTTP/SSE
 * MCP endpoint Claude consumes via ~/.claude.json is exposed to Codex
 * via this file -- Codex speaks the same MCP protocol.
 *
 * P7.7.5: server identifier renamed from 'conductor-vision' to 'conductor'.
 * The strip path now matches BOTH names so re-injection cleans up any
 * legacy block in addition to the current one.
 *
 * Spec: docs/superpowers/specs/2026-04-29-codex-integration-design.md sec 12.2.
 */

const MARKER_SECTION = '[mcp_servers.conductor]'
const LEGACY_MARKER_SECTION = '[mcp_servers.conductor-vision]'
const MARKER_COMMENT = '# Managed by Claude Command Center -- do not edit directly.'

function getCodexHome(): string {
  return process.env.CODEX_HOME ?? join(homedir(), '.codex')
}

function getCodexConfigPath(): string {
  return join(getCodexHome(), 'config.toml')
}

/**
 * Strip our managed block (current OR legacy section header) from a TOML
 * string. Walks line-by-line so user-authored sections surrounding the
 * block are left untouched. Idempotent -- runs the strip pass once per
 * known section header so a config holding both gets cleaned in one call.
 *
 * Shared by inject (to allow re-emission with a fresh port -- mirrors
 * Claude's overwrite-on-write JSON semantics) and remove.
 */
function stripOne(content: string, header: string): string {
  if (!content.includes(header)) return content

  const lines = content.split('\n')
  const sectionIdx = lines.findIndex((l) => l.trim() === header)
  if (sectionIdx < 0) return content

  // Walk the start backwards over our managed-by comment and a single
  // blank line before it, if present. Anything else above is user content.
  let blockStart = sectionIdx
  if (blockStart > 0 && lines[blockStart - 1].trim() === MARKER_COMMENT) {
    blockStart -= 1
  }
  if (blockStart > 0 && lines[blockStart - 1].trim() === '') {
    blockStart -= 1
  }

  // Walk forward through the section body until the next [section] header
  // or EOF. The section body is everything between `[...]` and the next
  // `[...]`.
  let blockEnd = sectionIdx + 1
  while (blockEnd < lines.length && !lines[blockEnd].trim().startsWith('[')) {
    blockEnd += 1
  }

  const newLines = [...lines.slice(0, blockStart), ...lines.slice(blockEnd)]
  // Collapse the run of blank lines our removal may have produced; trim a
  // run of leading blank lines so re-injection lands cleanly.
  return newLines.join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '')
}

function stripManagedBlock(content: string): string {
  // Strip both names so a re-injection picks up the new port AND clears any
  // legacy conductor-vision block left behind by an older CCC build.
  let next = stripOne(content, MARKER_SECTION)
  next = stripOne(next, LEGACY_MARKER_SECTION)
  return next
}

/**
 * Remove the conductor block (current AND legacy conductor-vision) from
 * the Codex config.toml. No-op when the file or block is absent.
 */
export function removeConductorVisionFromCodexConfig(): void {
  const tomlPath = getCodexConfigPath()
  if (!existsSync(tomlPath)) return

  let content: string
  try {
    content = readFileSync(tomlPath, 'utf-8')
  } catch (err: any) {
    logError(`[codex-mcp] failed to read ${tomlPath}: ${err?.message}`)
    return
  }

  if (!content.includes(MARKER_SECTION) && !content.includes(LEGACY_MARKER_SECTION)) return

  const stripped = stripManagedBlock(content)
  try {
    writeFileSync(tomlPath, stripped, 'utf-8')
    logInfo(`[codex-mcp] removed conductor from ${tomlPath}`)
  } catch (err: any) {
    logError(`[codex-mcp] failed to write ${tomlPath}: ${err?.message}`)
  }
}
