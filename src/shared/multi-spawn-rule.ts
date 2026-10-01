// Allow Multi Spawn: THE rule, and the words for it, shared by the renderer's
// launch surfaces and main's launch gate (P3.13, row 72).
//
// A saved config that is not a Multi Spawn config runs ONE copy at a time: it
// cannot start while another session of it is live. The renderer asks the rule
// so a button can say why it is disabled (hooks/useLaunchConfig.ts); main asks
// it at pty:spawn (src/main/launch-one-at-a-time.ts), so a renderer that forgot
// to ask, a stale render or a second path cannot start the second copy either.
// One definition, so the two cannot drift.

/**
 * True when a launch is refused: another copy of the config is live and the
 * config is not a Multi Spawn config.
 *
 * Deliberately `!== true`: the stored field is tri-state (undefined: never
 * chosen; false: declined; true: on), and every state but `true` -- a
 * hand-edited "yes" included -- runs one at a time. Only the startup migration
 * tells undefined from false (renderer/utils/multiSpawn.ts).
 */
export function isOneAtATimeBlocked(allowMultiSpawn: unknown, otherLiveCopies: number): boolean {
  return otherLiveCopies > 0 && allowMultiSpawn !== true
}

/** Popover copy for a launch refused by the rule (bold head + body). */
export function alreadyRunningCopy(label: string): { headline: string; body: string } {
  return {
    headline: `${label} is already running.`,
    body: "It isn't a Multi Spawn config, so it runs one at a time.",
  }
}

/** What main says when it refuses a launch for this rule: the popover's words,
 *  then what to do. A terminal tab shows it as "Not started. <this, without its
 *  last full stop>, then Restart this tab." (refusedTabText). */
export function alreadyRunningRefusalMessage(label: string): string {
  const copy = alreadyRunningCopy(label)
  return `${copy.headline} ${copy.body} Close the other copy, or turn on Allow Multi Spawn for it.`
}

/** The partner terminal of a session is a plain shell started under its own
 *  PTY id, `<session id>` plus this: the renderer names it (App.tsx,
 *  useRestartSession.ts, ptyTracker.ts) and main recognises it, so the shell
 *  of a config's session is never counted as another copy of the config. */
export const PARTNER_PTY_SUFFIX = '-partner'

export function isPartnerPtyId(sessionId: string): boolean {
  return sessionId.endsWith(PARTNER_PTY_SUFFIX)
}
