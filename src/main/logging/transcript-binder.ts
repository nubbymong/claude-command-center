/**
 * transcript-binder.ts — the single debounced sink that both transcript
 * discovery sources feed (Logs v2, Task 8 / spec F2).
 *
 * Two sources call `notifyTranscriptPath(sessionId, rawPath)`:
 *   1. The hooks gateway (earliest + exact): lifts `transcript_path` from every
 *      hook POST (incl. SessionStart) BEFORE redaction.
 *   2. The statusline bridge (continuous + exact): the per-session status JSON
 *      now carries `transcriptPath`, fanned out by statusline-watcher.
 *
 * Both are "exact" sources. Per session this module:
 *   - debounces rapid duplicate notifications (coalesce a burst into one bind);
 *   - canonicalizes the path (Task 3 — rewrites profile fake-HOME junctions /
 *     retired account-homes paths to the real ~/.claude/projects) and drops
 *     non-transcript paths (canonicalize -> null);
 *   - dedupes against the path it has already bound for the session (no churn);
 *   - calls `supervisor.bindTranscript(sessionId, canonicalPath, 'exact')`;
 *   - REBINDS when the same session later reports a DIFFERENT path (the /clear
 *     rotation case — the worker stores `ord+1` + a clear divider).
 *
 * Heuristic fallback (spec F14, bind-once): pty-manager calls
 * `registerRun(sessionId, cwd, startedAtMs)` at spawn. If no exact bind has
 * arrived `heuristicDelayMs` (~20 s) later, the Task-3 heuristic binder scans
 * the project dir for the newest matching JSONL and, if found, binds it with
 * confidence 'heuristic'. An EXACT bind always supersedes a heuristic one: a
 * later exact notification rebinds even for a session that already had a
 * heuristic bind (and cancels a still-pending heuristic timer).
 *
 * `getLatestTranscriptPath(sessionId)` exposes the latest canonical path per
 * session for T8b (respawn with `--resume <uuid>`).
 *
 * No Electron imports — pure node + injected deps, so it unit-tests without any
 * Electron ABI. No default export (project convention).
 */
import { canonicalizeTranscriptPath, makeHeuristicBinder } from './transcript-discovery'
import type { DiscoveryBinding } from './transcript-discovery'

/** The minimal supervisor surface the binder needs (LogSupervisor satisfies it). */
export interface TranscriptBinderSupervisor {
  bindTranscript(sessionId: string, path: string, confidence: 'exact' | 'heuristic', sourceVersion?: string): void
}

/** The heuristic-binder surface (makeHeuristicBinder() satisfies it). */
export interface TranscriptHeuristicBinder {
  bindOnce(sessionId: string, cwd: string, startedAtMs: number): DiscoveryBinding | null
}

export interface TranscriptBinderDeps {
  supervisor: TranscriptBinderSupervisor
  /** Defaults to Task 3's canonicalizeTranscriptPath. Returns null for non-transcript paths. */
  canonicalize?: (p: string) => string | null
  /** Defaults to a fresh makeHeuristicBinder() over the real ~/.claude/projects. */
  heuristicBinder?: TranscriptHeuristicBinder
  /** Injectable timer (tests). Defaults to global setTimeout (returns an opaque handle). */
  setTimer?: (cb: () => void, ms: number) => unknown
  /** Injectable timer-clear (tests). Defaults to global clearTimeout. */
  clearTimer?: (handle: unknown) => void
  /** Coalesce window for rapid duplicate notifications. Default 250 ms. */
  debounceMs?: number
  /** Heuristic fallback delay after registerRun with no exact bind. Default 20 000 ms. */
  heuristicDelayMs?: number
}

const DEFAULT_DEBOUNCE_MS = 250
const DEFAULT_HEURISTIC_DELAY_MS = 20_000

/** Per-session binder state. */
interface SessionState {
  /** The canonical path currently bound (null until first successful bind). */
  boundPath: string | null
  /** The confidence of the current bind. */
  boundConfidence: 'exact' | 'heuristic' | null
  /** Debounce timer for a pending exact notification + its target raw path. */
  debounceHandle: unknown | null
  pendingRaw: string | null
  /** Heuristic fallback timer (cleared once an exact bind lands or the run ends). */
  heuristicHandle: unknown | null
}

export interface TranscriptBinder {
  /** A discovery source reports a transcript path for a session (exact). */
  notifyTranscriptPath(sessionId: string, rawPath: string): void
  /** pty-manager: a run started — arm the heuristic fallback timer. */
  registerRun(sessionId: string, cwd: string, startedAtMs: number): void
  /** pty-manager: a run ended — cancel timers + clear per-session bind state. */
  endRun(sessionId: string): void
  /** Latest canonical transcript path bound for the session, or null. (T8b) */
  getLatestTranscriptPath(sessionId: string): string | null
}

export function makeTranscriptBinder(deps: TranscriptBinderDeps): TranscriptBinder {
  const supervisor = deps.supervisor
  const canonicalize = deps.canonicalize ?? canonicalizeTranscriptPath
  const heuristicBinder = deps.heuristicBinder ?? makeHeuristicBinder()
  const setTimer = deps.setTimer ?? ((cb: () => void, ms: number) => setTimeout(cb, ms))
  const clearTimer = deps.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>))
  const debounceMs = deps.debounceMs ?? DEFAULT_DEBOUNCE_MS
  const heuristicDelayMs = deps.heuristicDelayMs ?? DEFAULT_HEURISTIC_DELAY_MS

  const sessions = new Map<string, SessionState>()

  function getOrCreate(sessionId: string): SessionState {
    let s = sessions.get(sessionId)
    if (!s) {
      s = { boundPath: null, boundConfidence: null, debounceHandle: null, pendingRaw: null, heuristicHandle: null }
      sessions.set(sessionId, s)
    }
    return s
  }

  /** Cancel a pending heuristic fallback timer for the session (idempotent). */
  function cancelHeuristic(s: SessionState): void {
    if (s.heuristicHandle !== null) {
      clearTimer(s.heuristicHandle)
      s.heuristicHandle = null
    }
  }

  /** Apply an exact bind for a session once the debounce settles. */
  function commitExact(sessionId: string): void {
    const s = sessions.get(sessionId)
    if (!s) return
    s.debounceHandle = null
    const raw = s.pendingRaw
    s.pendingRaw = null
    if (!raw) return

    const canonical = canonicalize(raw)
    if (!canonical) return   // non-transcript path — ignore

    // An exact source always wins. Cancel any still-pending heuristic fallback so
    // it can't later re-bind on top of the exact path.
    cancelHeuristic(s)

    // Dedupe: identical path already bound at the SAME confidence -> no churn.
    // (A heuristic-confidence prior bind to the same path is still upgraded to
    // exact below, so we only short-circuit when confidence also matches.)
    if (s.boundPath === canonical && s.boundConfidence === 'exact') return

    s.boundPath = canonical
    s.boundConfidence = 'exact'
    supervisor.bindTranscript(sessionId, canonical, 'exact')
  }

  return {
    notifyTranscriptPath(sessionId: string, rawPath: string): void {
      if (!rawPath || typeof rawPath !== 'string') return
      const s = getOrCreate(sessionId)
      // Coalesce a burst: latest raw path wins; reset the debounce window.
      s.pendingRaw = rawPath
      if (s.debounceHandle !== null) clearTimer(s.debounceHandle)
      s.debounceHandle = setTimer(() => commitExact(sessionId), debounceMs)
    },

    registerRun(sessionId: string, cwd: string, startedAtMs: number): void {
      const s = getOrCreate(sessionId)
      // Re-arm a fresh heuristic fallback timer (clear any stale one first).
      cancelHeuristic(s)
      s.heuristicHandle = setTimer(() => {
        const cur = sessions.get(sessionId)
        if (!cur) return
        cur.heuristicHandle = null
        // An exact bind may have arrived during the window — never downgrade.
        if (cur.boundConfidence === 'exact') return
        const binding = heuristicBinder.bindOnce(sessionId, cwd, startedAtMs)
        if (!binding) return   // nothing found; a later exact notification can still bind
        // Don't re-emit an identical heuristic bind.
        if (cur.boundPath === binding.path && cur.boundConfidence === 'heuristic') return
        cur.boundPath = binding.path
        cur.boundConfidence = 'heuristic'
        supervisor.bindTranscript(sessionId, binding.path, 'heuristic')
      }, heuristicDelayMs)
    },

    endRun(sessionId: string): void {
      const s = sessions.get(sessionId)
      if (!s) return
      if (s.debounceHandle !== null) clearTimer(s.debounceHandle)
      cancelHeuristic(s)
      // Drop ALL per-session state so a reused sessionId (restart) binds fresh
      // rather than being deduped against a stale prior bind.
      sessions.delete(sessionId)
    },

    getLatestTranscriptPath(sessionId: string): string | null {
      return sessions.get(sessionId)?.boundPath ?? null
    },
  }
}
