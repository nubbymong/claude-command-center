/**
 * partition-revocation.ts — a decoupling seam (#439 adversarial A9).
 *
 * When a claude.ai account partition is wiped (sign-out, account delete, a
 * cancelled/revoked sign-in) two things must follow: the web-session record is
 * forgotten and the account's pane surfaces are closed. The wipe lives in
 * sign-in.ts, whose header deliberately keeps a NARROW module graph — importing
 * session-store and account-pane there drags their heavy transitive graph
 * (channel-storage -> setup-handlers -> pty-manager -> …) into it, the exact
 * hazard sign-in.ts's own comment warns about.
 *
 * So sign-in.ts EMITS here (importing only this zero-dependency module) and the
 * owners subscribe at app bootstrap (see index.ts). Handlers run synchronously
 * back-to-back, so no async recording can interleave between them.
 *
 * No default export (project convention).
 */
type RevocationHandler = (profileId: string) => void

const handlers = new Set<RevocationHandler>()

/** Subscribe a handler (idempotent for the same function reference). */
export function onPartitionRevoked(handler: RevocationHandler): void {
  handlers.add(handler)
}

/** Notify every subscriber that this account's partition was wiped. */
export function notifyPartitionRevoked(profileId: string): void {
  for (const handler of [...handlers]) {
    try { handler(profileId) } catch { /* one handler must not stop the rest */ }
  }
}

/** Tests only: drop all subscribers. */
export function _resetPartitionRevocationForTest(): void {
  handlers.clear()
}
