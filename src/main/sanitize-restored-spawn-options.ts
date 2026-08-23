/**
 * sanitize-restored-spawn-options.ts — fail-open repair of a RESTORED session's
 * persisted spawn fields (#397 Group 5).
 *
 * A relaunched session's spawn options come straight out of session-state.json.
 * When that file is corrupt (or was written by an older schema), two fields can be
 * invalid, and the strict spawnOptionsSchema parse in pty-handlers would reject the
 * WHOLE spawn on any of them — so the session never launches, defeating the goal
 * that a session on disk is always restartable.
 *
 * Repair them fail-OPEN, before the strict parse:
 *   - `resume` ({uuid,cwd}): an invalid uuid or cwd is DROPPED, and the spawn falls
 *     back to the resume picker. Dropping — never ACCEPTING — an invalid uuid keeps
 *     the charset guard that stops shell injection at the unquoted interpolation
 *     site; this helper only ever removes or floors, it never widens what the
 *     strict schema would accept.
 *   - codex `permissionsPreset`: a missing/invalid preset is floored to the
 *     least-privilege 'read-only' so the codex session still launches.
 *
 * Every other field is left untouched and still strict-parses downstream. Pure and
 * dependency-injected for logging so it unit-tests without the Electron ABI (and
 * without pulling node-pty through pty-manager). Returns a shallow copy; never
 * mutates the input.
 */
import { UUID_RE } from './logging/transcript-discovery'

export const CODEX_PRESETS = ['read-only', 'standard', 'auto', 'unrestricted'] as const

// ── The spawn schema's own rules for the two persisted claude fields ─────────
// Exported and consumed by spawnOptionsSchema (pty-handlers) so the sanitizer
// and the strict parse can NEVER drift: what this module drops is exactly what
// the schema would reject (#413 review, S2). Values and comments live with the
// schema's fields — see pty-handlers for why each rule exists.

export const PERMISSION_MODES = ['default', 'acceptEdits', 'auto', 'plan', 'dontAsk', 'bypassPermissions', 'manual'] as const

export const EXTRA_ARGS_MAX = 512
export const EXTRA_ARGS_CHARSET_RE = /^[A-Za-z0-9 _\-=.\/\\:@,+]*$/

/** The managed-flag refine, on a backslash-collapsed copy, plus the trailing-
 *  backslash ban — byte-identical to the schema's refine (see pty-handlers for
 *  the shell-expansion analysis behind it). */
export function extraArgsRefineOk(v: string): boolean {
  return (
    !v.endsWith('\\') &&
    !/(^|\s)--(model|effort|permission-mode|settings|mcp-config|agents|resume)\b/.test(v.replace(/\\/g, ''))
  )
}

export function sanitizeRestoredSpawnOptions<T>(
  options: T,
  log: (msg: string) => void = () => {},
): T {
  const o = options as any
  if (!o || typeof o !== 'object') return options
  const out: any = { ...o }

  if (out.resume) {
    const r = out.resume
    const okUuid = r && typeof r.uuid === 'string' && UUID_RE.test(r.uuid)
    const okCwd = r && typeof r.cwd === 'string' && r.cwd.length >= 1 && r.cwd.length <= 4096
    if (!okUuid || !okCwd) {
      log('[pty] #397: dropping an invalid persisted resume target; falling back to the resume picker')
      out.resume = undefined
    }
  }

  if (out.provider === 'codex') {
    if (!out.codexOptions || typeof out.codexOptions !== 'object') {
      log('[pty] #397: restored codex session had no codexOptions; defaulting to read-only')
      out.codexOptions = { permissionsPreset: 'read-only' }
    } else if (!(CODEX_PRESETS as readonly string[]).includes(out.codexOptions.permissionsPreset)) {
      log('[pty] #397: restored codex session had an invalid permissionsPreset; defaulting to read-only')
      out.codexOptions = { ...out.codexOptions, permissionsPreset: 'read-only' }
    }
  }

  // Phase 5 started PERSISTING these two, so a corrupt-but-parseable file can
  // now carry values the strict parse rejects — which would wedge the whole
  // spawn this helper exists to rescue (#413 review, S2). Dropped, never
  // coerced: an absent value means "emit no flag", the least-privilege shape,
  // and dropping preserves this helper's only-removes-or-floors property.
  if (out.permissionMode !== undefined) {
    const ok =
      out.permissionMode === '' || (PERMISSION_MODES as readonly string[]).includes(out.permissionMode)
    if (!ok) {
      log('[pty] #397: dropping an invalid persisted permissionMode; the session launches with the default')
      out.permissionMode = undefined
    }
  }
  if (out.extraArgs !== undefined) {
    const ok =
      typeof out.extraArgs === 'string' &&
      out.extraArgs.length <= EXTRA_ARGS_MAX &&
      EXTRA_ARGS_CHARSET_RE.test(out.extraArgs) &&
      extraArgsRefineOk(out.extraArgs)
    if (!ok) {
      log('[pty] #397: dropping invalid persisted extraArgs; the session launches without them')
      out.extraArgs = undefined
    }
  }

  return out as T
}
