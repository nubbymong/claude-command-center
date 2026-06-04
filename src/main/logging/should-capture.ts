/**
 * should-capture.ts — pure settings gate for the SQLite logging capture path.
 *
 * Kept as a tiny pure function (no imports, no I/O) so it can be unit-tested in
 * isolation and called O(1) on the PTY spawn path. The caller reads the live
 * `loggingEnabled` flag from the 'settings' config (default-true semantics, the
 * same pattern as channel-permissions.ts / pty-manager.ts) and passes it in.
 *
 * Capture iff:
 *  - logging is not explicitly disabled (loggingEnabled !== false → default ON), AND
 *  - the session is not shell-only (plain shells + the add-account /login flow
 *    never produce a Claude transcript worth logging).
 *
 * No default export (project convention).
 */
export function shouldCapture(
  opts: { shellOnly?: boolean },
  settings: { loggingEnabled?: boolean },
): boolean {
  return settings.loggingEnabled !== false && !opts.shellOnly
}
