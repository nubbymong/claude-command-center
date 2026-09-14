/**
 * The SSH flow's container-entry outcomes, as they cross the main -> renderer
 * seam on `ssh:flowState:<sessionId>` (rc.15 review R1, aicc_planning#45).
 *
 * One module for both processes so the overlay's copy and buttons can never
 * drift from what main emits (quality review: three literals in main and three
 * constants in the renderer, with nothing pinning them equal -- a rename in one
 * would have silently fallen through to the wrong button).
 */
export const SSH_ENTRY = {
  /** awaiting-claude info: the entry was PROVEN by this attempt's sentinel. */
  INNER: 'inner',
  /** awaiting-claude info: the post-command finished but nothing could prove
   *  which shell -- or which machine -- is attached (a `start -ai` attach, a
   *  free-text command with no recognised container shape). Launching is the
   *  user's explicit, warned choice and never reads as a verified entry. */
  UNVERIFIED: 'unverified',
  /** running-setup info: a launch guard is out -- the attached shell is being
   *  asked for this attempt's nonce before anything ordinary is typed (the
   *  container setup first; the claude command after `setup ok`). */
  VERIFYING: 'verifying the container shell',
  /** failed info: the container was never entered (no sentinel came back; the
   *  engine or sudo refused; the host prompt returned). Run again re-enters. */
  FAILED: 'container entry failed',
  /** failed info: a proven entry was lost again -- the container shell exited
   *  or the launch-time guard found a different shell attached. Nothing was
   *  launched. Run again re-enters. */
  LEFT: 'left the container',
} as const

export type SshEntryFailureReason = typeof SSH_ENTRY.FAILED | typeof SSH_ENTRY.LEFT
