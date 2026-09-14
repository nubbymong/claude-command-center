// src/shared/ssh-tmux-persistence.ts
//
// #242 tier 5: the SSH tmux-persistence ladder (tiers 1-4, main process:
// ssh-tmux.ts / ssh-tmux-stage.ts / ssh-tmux-push.ts) already threads its
// failure reason onto the `running-claude` flow state's `info` field, over
// the EXISTING `ssh:flowState:<sessionId>` IPC channel (emitSshFlowState in
// pty-manager.ts) -- that part shipped with tiers 1-4. What was missing is
// this module + SshFlowOverlay.tsx actually SHOWING it: the reason reached
// the renderer already, but the renderer silently dropped it on the floor
// and rendered "Launching Claude..." either way. That silent drop -- not a
// missing wire -- is the "failing silently" this tier closes.
//
// Pure + dependency-free so both the main process (which produces the
// reasons) and the renderer (which recognises and formats them) import the
// SAME literals rather than each hand-typing its own copy that can drift.
// No default export (project convention).

/**
 * Reasons pty-manager's tmux ladder can hand to `running-claude`'s `info`
 * field once every tier has given up and the launch falls through to a
 * bare (unwrapped) claude command:
 *   - `probe=none` -- writeClaudeCmd resolved with no explicit reason AND
 *     no usable tmux binary was ever detected for this session (defence-in-
 *     depth default; see pty-manager.ts's writeClaudeCmd doc comment).
 *   - `tmux-stage-fail:<reason>` -- tier 3 (curl/wget staging,
 *     ssh-tmux-stage.ts) failed; `<reason>` is one of
 *     arch/download/digest/extract/terminfo/timeout/build-error.
 *   - `tmux-push-fail:<reason>` -- tier 4 (base64 push over the PTY,
 *     ssh-tmux-push.ts) failed; same reason vocabulary plus `aborted`.
 * `terminfo` (a binary that installed but can't open a terminal — no
 * terminfo database on the remote) is the one reason both tiers 3 and 4
 * can report, called out separately in the #242 plan because it is the
 * likeliest real-world hit on egress-less minimal containers, not because
 * it needs different handling here.
 */
export const SSH_PERSISTENCE_PROBE_NONE = 'probe=none'
const SSH_PERSISTENCE_FAIL_PREFIXES = ['tmux-stage-fail:', 'tmux-push-fail:'] as const

/**
 * Whether a `running-claude` flow state's `info` string names a tmux-
 * persistence failure the overlay should surface, as opposed to `info`
 * being unset (persistence succeeded, tmux is in play) or carrying some
 * OTHER stage's info value (e.g. `'inner'` on `awaiting-claude`, which this
 * predicate must not mistake for a failure).
 */
export function isSshPersistenceFailureReason(info: string | undefined): boolean {
  if (!info) return false
  if (info === SSH_PERSISTENCE_PROBE_NONE) return true
  return SSH_PERSISTENCE_FAIL_PREFIXES.some((prefix) => info.startsWith(prefix))
}

/**
 * The one-line message SshFlowOverlay renders in place of silently showing
 * nothing when `isSshPersistenceFailureReason(info)` is true. `reason` is
 * the raw `info` string verbatim -- it is main-process-controlled (never
 * renderer/user input), so no escaping/formatting is applied beyond the
 * template itself.
 *
 * M6 (adversarial review round 5): `terminfo` (a tmux binary that installed
 * but can't open a terminal — no terminfo database on the remote) gets
 * plain-language treatment rather than the raw token verbatim. #242's own
 * plan called this the likeliest real-world hit on egress-less minimal
 * containers, not because it needs different LOGIC here (the failure is
 * handled identically to any other reason upstream), but because
 * "tmux-stage-fail:terminfo" / "tmux-push-fail:terminfo" means nothing to a
 * user who has never heard of a terminfo database.
 */
export function formatPersistenceUnavailableMessage(reason: string): string {
  if (reason === 'tmux-stage-fail:terminfo' || reason === 'tmux-push-fail:terminfo') {
    return `persistent session unavailable: the remote host has no terminfo database, so tmux can't open a terminal there — conversation will resume via --continue on reconnect`
  }
  return `persistent session unavailable: ${reason} — conversation will resume via --continue on reconnect`
}

/**
 * pty-manager's writeClaudeCmd (ssh branch) calls this to resolve what
 * `running-claude`'s `info` field should carry. `explicitReason` is
 * whatever a tier-3/4 sentinel handler already determined
 * (`tmux-stage-fail:<reason>` / `tmux-push-fail:<reason>`) -- always used
 * verbatim when present, REGARDLESS of `tmuxInPlay` (a stage/push failure
 * reason is meaningful even in the -- currently impossible, but not
 * guaranteed forever -- case where some future tier still wraps in tmux
 * after reporting one). When there is no explicit reason, `tmuxInPlay`
 * decides: `true` means detection actually succeeded (no failure to
 * report, `undefined`); `false` defaults to `probe=none` rather than
 * silently emitting `running-claude` with no info at all. Extracted as a
 * pure function (not left inline in writeClaudeCmd) so both directions of
 * that default are independently unit-testable.
 */
export function resolveRunningClaudeInfo(
  explicitReason: string | undefined,
  tmuxInPlay: boolean,
): string | undefined {
  return explicitReason ?? (tmuxInPlay ? undefined : SSH_PERSISTENCE_PROBE_NONE)
}
