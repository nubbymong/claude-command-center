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
 *   - codex `model`: an invalid one is DROPPED; the session launches on the
 *     CLI's default model.
 *   - codex `reasoningEffort`: one off CODEX_EFFORTS is DROPPED; the session
 *     launches on its model's default effort (P3.8).
 *   - codex `extraArgs`: a value codexExtraArgsProblem refuses is DROPPED; the
 *     session launches without them (P3.11). This runs on every pty:spawn.
 *
 * Every other field is left untouched and still strict-parses downstream. Pure and
 * dependency-injected for logging so it unit-tests without the Electron ABI (and
 * without pulling node-pty through pty-manager). Returns a shallow copy; never
 * mutates the input.
 */
import { UUID_RE } from './logging/transcript-discovery'
import { CODEX_MODEL_ID_MAX, CODEX_MODEL_ID_RE } from '../shared/model-registry'
import { claudeExtraArgsProblem, codexExtraArgsProblem } from '../shared/extra-args'

/** The Codex permission presets. 'plan' (P3.8, L2; round 2, PM1) is Claude's
 *  Plan mode launch option: it launches read-only, as 'read-only' does, then
 *  Codex's own /plan is typed into its first ready prompt. */
export const CODEX_PRESETS = ['read-only', 'standard', 'auto', 'unrestricted', 'plan'] as const

// ── The spawn schema's own rules for the two persisted claude fields ─────────
// Exported and consumed by spawnOptionsSchema (pty-handlers) so the sanitizer
// and the strict parse can NEVER drift: what this module drops is exactly what
// the schema would reject (#413 review, S2). Values and comments live with the
// schema's fields — see pty-handlers for why each rule exists.

export const PERMISSION_MODES = ['default', 'acceptEdits', 'auto', 'plan', 'dontAsk', 'bypassPermissions', 'manual'] as const

/** A Codex model id (`gpt-5.5`, `gpt-oss:20b`, `provider/model`), bounded and
 *  charset-limited like the Claude model: it becomes a launch argument. The
 *  first character is alphanumeric, so the value can never read as a flag.
 *  '' means "no override", as for Claude. One definition, shared with the
 *  Codex picker (P3.8 round 1): it offers only ids that pass. */
export const CODEX_MODEL_MAX = CODEX_MODEL_ID_MAX
export const CODEX_MODEL_RE = CODEX_MODEL_ID_RE

/** The Codex CLI's reasoning efforts (its ReasoningEffort values, 0.153.4),
 *  the only values `-c model_reasoning_effort=<value>` is built from (P3.8,
 *  row 40). 'none' means "no override" to the spawn, as it always has. */
export const CODEX_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const

// The extra CLI arguments rules (both assistants) live in src/shared/extra-args.ts,
// so the session dialog reads the same rule; re-exported here for main.
export {
  EXTRA_ARGS_MAX,
  EXTRA_ARGS_CHARSET_RE,
  extraArgsBaseProblem,
  extraArgsRefineOk,
  claudeExtraArgsProblem,
  codexExtraArgWords,
  codexExtraArgsProblem,
} from '../shared/extra-args'

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
  // A non-Codex session never reads codexOptions, but the strict parse still
  // checks it: a malformed leftover (not an object, or no valid preset) is
  // dropped rather than left to wedge the session.
  if (out.provider !== 'codex' && out.codexOptions !== undefined
      && (!out.codexOptions || typeof out.codexOptions !== 'object' || !(CODEX_PRESETS as readonly string[]).includes(out.codexOptions.permissionsPreset))) {
    log('[pty] #397: dropping unusable Codex options left on a non-Codex session')
    out.codexOptions = undefined
  }
  // Whatever the provider: the strict parse bounds codexOptions.model for
  // every session, so a stale value left on a restored Claude session would
  // otherwise wedge it too.
  if (out.codexOptions && typeof out.codexOptions === 'object') {
    const model = out.codexOptions.model
    if (model !== undefined && model !== '' && !(typeof model === 'string' && model.length <= CODEX_MODEL_MAX && CODEX_MODEL_RE.test(model))) {
      log('[pty] #397: dropping an invalid persisted Codex model; the session launches with the default model')
      out.codexOptions = { ...out.codexOptions, model: undefined }
    }
    // P3.8: the same for the effort, which the strict parse holds to
    // CODEX_EFFORTS; dropped, the session starts on its model's own default.
    const effort = out.codexOptions.reasoningEffort
    if (effort !== undefined && !(CODEX_EFFORTS as readonly unknown[]).includes(effort)) {
      log('[pty] dropping an invalid persisted Codex reasoning effort; the session launches with the model default')
      out.codexOptions = { ...out.codexOptions, reasoningEffort: undefined }
    }
    // P3.11 (row 62): extra CLI arguments the strict parse refuses are
    // dropped; the session launches without them.
    const extraArgs = out.codexOptions.extraArgs
    if (extraArgs !== undefined && codexExtraArgsProblem(extraArgs) !== null) {
      log('[pty] dropping invalid persisted Codex extra CLI arguments; the session launches without them')
      out.codexOptions = { ...out.codexOptions, extraArgs: undefined }
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
    // The cap, charset, trailing backslash and managed-flag refine the schema
    // applies (claudeExtraArgsProblem, src/shared/extra-args.ts).
    const ok = claudeExtraArgsProblem(out.extraArgs) === null
    if (!ok) {
      log('[pty] #397: dropping invalid persisted extraArgs; the session launches without them')
      out.extraArgs = undefined
    }
  }

  return out as T
}
