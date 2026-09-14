## 2026-08-24 -- #487 debug-logger EPIPE crash-loop + unbounded app.log growth

Confirmed both premises against src/main/debug-logger.ts before touching it:

- A) the uncaughtException handler called logError() BEFORE the EPIPE/EIO
  check, so a broken stdout/stderr pipe could re-enter the handler.
- B) getStream() only rotated on stream CREATION, never re-checking size on an
  already-open stream, so a hot logger grew app.log past MAX_LOG_SIZE (10MB)
  without bound (matches the observed 68GB app.log.1, 2h19m of identical
  EPIPE lines).

Fixes, all in src/main/debug-logger.ts:

- Reordered the uncaughtException handler: EPIPE/EIO is checked FIRST and
  writes straight to the file stream (never console), before any logError
  call. Added a re-entrancy guard (`inUncaughtExceptionHandler`) so the
  handler cannot recurse into itself even if something inside it re-triggers
  uncaughtException.
- Mirrored the same EPIPE/EIO-first suppression in unhandledRejection (it had
  none at all -- a second, unguarded entry point into the same class of bug).
- Wrapped every console.* call in logInfo/logWarn/logError in try/catch, and
  added no-op 'error' handlers on process.stdout/stderr, so a broken pipe
  degrades to a silent no-op instead of feeding the exception machinery.
- Replaced the stream-creation-only rotation check with a running byte
  counter (`streamBytes`, tracked in-process rather than via
  WriteStream.bytesWritten, which lags actual writes) checked on every write;
  crossing MAX_LOG_SIZE ends the stream so the next write reopens through the
  existing rotateIfNeeded() path.
- Added an 'error' listener on the log stream itself so a write failure
  (ENOSPC/EBADF/permission loss) can no longer surface as an unhandled
  'error' event -> uncaughtException -> another failing write (a second,
  distinct crash-loop entry point the audit found).

Also fixed, same audit pass (all confirmed against current code, not audit
text alone):

- tests/e2e/helpers/electron-app.ts: closeIsolatedApp now tree-kills the
  Electron process (taskkill /T /F on Windows; process group SIGKILL
  elsewhere) before removing its temp data dir, since a plain root-process
  kill leaves node-pty's shell (+ conhost) alive holding handles inside that
  dir -- the actual mechanism behind the 68GB leak surviving cleanup. rmSync
  now retries (maxRetries/retryDelay) and warns with the leaked path + size
  on final failure instead of a silent catch. Added a best-effort sweep of
  stale ccc-e2e-* temp dirs (>1h old) at the start of each run so a leak
  survives at most one run.
- tests/e2e/session-dialog-permutations.spec.ts: the PTY-launching spec's
  probeDir cleanup moved from mid-test (racing the still-live shell that owns
  it as cwd) to afterAll, after closeIsolatedApp's tree-kill.
- src/main/codex-review-mcp-tool.ts: the per-review mkdtemp tmpDir was never
  removed on ANY path, including every early-return error path. Wrapped in
  try/finally with rmSync in the finally.
- src/main/channel-attachments.ts / channel-ledger.ts: attachments/ had no
  retention while the ledger already rotated at 30 days. Added
  reapAttachments() (age derived from the base-36-timestamp filename, no
  stat() needed) and wired it into rotateLedgers() on the same window.

Deferred (confirmed in-audit but out of scope for this fix -- separate
tickets): the ssh-shim remote trace-log cap (needs a remote redeploy);
rotateLedgers() itself is still never called anywhere (a pre-existing dead
retention path, unrelated to the attachments fix above); screenshot
auto-delete defaulting to "keep forever"; tokenomics tk_files/tk_events
retention; Logs v2 transcript DB retention; insights archive pruning; vision
CDP profile dir cleanup; tokenomics worker postMessage try/catch;
tests/e2e/desktop-import.spec.ts's own rmSync hardening (that file exists
only on feat/209-desktop-chat-import, not yet on beta -- nothing to fix here
until it lands).

Tests: tests/unit/main/debug-logger-epipe-loop.test.ts (new) covers both
premises directly -- a throwing/reentrant console.error is bounded to one
real invocation, and a >15MB write burst on one long-lived stream rotates
(current file stays under the cap, a .1 file appears). Also added
tests/unit/channel-attachments.test.ts for reapAttachments, and updated
tests/unit/channel-ledger.test.ts's channel-storage mock for the new
channelsDir() call rotateLedgers now makes.

Note while testing: a vi.mock(path, async () => vi.importActual(...)) wrapper
memoizes its result independent of vi.resetModules() -- a second dynamic
import() in a later test silently returns the FIRST test's already-
initialized module instance. Use vi.unmock() instead when a suite needs a
truly fresh module per test.
