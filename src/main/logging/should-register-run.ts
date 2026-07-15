/**
 * should-register-run.ts — the single pure predicate that decides whether a PTY
 * spawn produces a logged RUN (Logs v2).
 *
 * Kept as a tiny pure function (no imports, no I/O) so it can be unit-tested in
 * isolation and called O(1) on the spawn path. The pty-manager callsite reads
 * the live per-config + global `loggingEnabled` flags (default-true semantics,
 * the same pattern as channel-permissions.ts) and passes the needed fields in.
 *
 * This consolidates the registration decision used at EVERY run-registration
 * callsite — supervisor `runStart`, transcript-binder `registerRun`, and the
 * matching `runEnd`/`endRun` on exit — so there is one source of truth and no
 * duplicated inline gating.
 *
 * Register a run iff ALL of the following hold:
 *  - provider === 'claude'              — the local Claude provider ONLY. Codex
 *                                         and any other/unknown provider never
 *                                         produce a Claude transcript to tail.
 *  - NOT shellOnly                      — plain shells + the add-account /login
 *                                         flow never produce a transcript.
 *  - NOT the SSH spawn path             — remote sessions write transcripts on
 *                                         the remote host; nothing local to tail
 *                                         (same `options.ssh` signal the OSC
 *                                         sentinel SSH statusline branch keys on).
 *  - per-config loggingEnabled !== false  — DEFAULT-TRUE (undefined => ON).
 *  - global  loggingEnabled !== false     — DEFAULT-TRUE (undefined => ON).
 *
 * No default export (project convention).
 */
export function shouldRegisterRun(
  opts: {
    provider?: 'claude' | 'codex'
    shellOnly?: boolean
    ssh?: unknown
    /** Per-config logging opt-out. DEFAULT-TRUE: only `false` disables. */
    loggingEnabled?: boolean
  },
  settings: { loggingEnabled?: boolean },
): boolean {
  // Local Claude only — codex / other providers are excluded (the `=== 'claude'`
  // check already excludes codex; the contract is spelled out for clarity).
  if (opts.provider !== 'claude') return false
  if (opts.shellOnly) return false
  if (opts.ssh) return false
  if (opts.loggingEnabled === false) return false
  if (settings.loggingEnabled === false) return false
  return true
}
