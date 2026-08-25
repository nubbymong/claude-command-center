## 2026-08-25 -- #487 round-1 adversarial review: rotation race, attachment-reap false positives, coverage gaps

Round-1 adversarial review of the #487 logging/disk fix (969bad1b) found the
rotation fix and the attachment reaper each had a real remaining hole, plus
three coverage gaps where existing correct behavior had no dedicated test.
Fixed all in the same branch (fix/487-logging-epipe-loop), all in
src/main/debug-logger.ts and src/main/channel-attachments.ts:

- BLOCKER -- rotation still defeated by a synchronous write burst: the
  original fix rotated by ending the stream and letting the NEXT write's
  openStream() re-derive the decision from fs.statSync(). That stat lags the
  prior stream's async flush; a tight loop with no `await` could cross
  MAX_LOG_SIZE many times before the OS ever wrote anything out, so
  statSync() kept seeing a small/pre-flush size, skipped rotation, AND
  reseeded `streamBytes` from that same stale number -- the counter never
  reached the cap again. Root fix: an in-process `mustRotate` flag, set the
  instant the byte counter crosses the cap, honoured UNCONDITIONALLY on the
  next open (never re-derived from a stat). Also had to open the log file's
  fd SYNCHRONOUSLY (fs.openSync, handed to createWriteStream) instead of
  letting the stream open it asynchronously -- otherwise, in a truly
  synchronous burst (zero yields), the file might not exist on disk yet when
  the rotate step ran, making the rename a silent no-op and converging every
  "rotated" stream instance back onto the same growing file.
- MINOR -- a single formatted record bigger than the whole cap
  (logError('y'.repeat(50MB))) used to write in full before the running-total
  check ever ran. Added a 256KB single-record cap (truncate + marker) applied
  before the record reaches the stream.
- BLOCKER -- channel-attachments.ts reapAttachments() still deleted
  non-timestamp files: the whole-string base36 guard let any all-base36 stem
  ("logo", "note", "icon", "README", and case-insensitively "Thumbs.db")
  parse via parseInt(stem, 36) into a small 1970-ish number, so `ts < cutoff`
  was true and it got deleted -- guaranteed real-world victim on Windows:
  Thumbs.db. Added a round-trip check (`ts.toString(36) === stem.toLowerCase()`)
  and a plausible-epoch bound (>= 2020-01-01, <= now); a stem failing either
  check is skipped, never deleted.
- Coverage gap -- the existing reentrancy-guard test only drove reentry
  through the NON-suppressed branch (console.error on a non-EPIPE error),
  which never actually exercises the guard against the SUPPRESSED (EPIPE)
  branch's own write path recursing. Removing the guard didn't fail that
  test. Added a test that drives a reentrant EPIPE through
  writeToLog()->stream.write() itself; it fails when the guard is removed
  (confirmed by reverting on a scratch copy).
- Coverage gap -- the log stream's own 'error' listener (nulls the cached
  stream so the next write reopens) had no direct test. Added one; confirmed
  it fails when that listener is removed.
- Coverage gap -- codex-review-mcp-tool.ts's per-call tmpDir cleanup
  (try/finally rmSync) had tests only for error paths that happened to
  exercise it incidentally, not a direct assertion. Added a success-path and
  an error-return-path test that each capture the actual tmpDir the tool
  created and assert it's gone afterward; confirmed both fail when the
  finally block's rmSync is removed.

Deferred (unchanged from the original fix's note): rotateLedgers() is still
never called anywhere in production -- reapAttachments() is unit-tested
directly instead, per the round-1 review's own instruction not to wire that
dead path up as part of this fix.

Verification: every new/changed regression test was confirmed to FAIL against
a scratch revert of its corresponding fix (statSync-based rotation restored,
record-cap removed, reapAttachments' round-trip/epoch checks removed, the
reentrancy guard's `if (inUncaughtExceptionHandler) return` removed, the
stream 'error' listener removed, and the codex-review finally block's rmSync
removed) before being confirmed to PASS against the fixed code. `npm run
typecheck` clean; full `npx vitest run` (734 files, 8357 tests): 8326 passed,
29 skipped, 2 todo, 0 failed.
