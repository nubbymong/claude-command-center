## 2026-09-27 -- WP2: a timed-out Codex run's whole chain is killed when the process table is slow

Draft PR #625 (branch `session/beta/c4d568ce-wp2-codex`). Local commit after
`14ad7475`; not pushed.

### Problem

Windows CI at `14ad7475` failed `tests/wp1/fake-cli.test.ts` "a run past its
deadline is killed with its WHOLE tree": the sleeping fake outlived the kill
(21462 ms), then the temp folder could not be removed (EBUSY). One failure in
40 Windows runs since `60ea77be`. In the product this leaves a stopped Codex
run (a deadline or a cancel) running until the app quits: a sign-in can still
complete after the cancel, and a login server keeps listening.

### Cause

`makeCodexKillTree` in `src/main/providers/codex/cli-runner.ts`. A run still
going after 2 s starts an early background process-table read (PowerShell CIM,
30 s timeout). At the kill that read was awaited for at most 10 s. Still
running after that, it left the table undefined, neither branch used it, and
taskkill named the root (cmd.exe) alone, with no `/T`. The node and codex
processes below it were orphaned. The timing matches: 3000 + 10000 + taskkill
+ the 8000 poll. A kill made before the early read whose own 8 s read failed
also killed the root alone (the same leak).

Root alone and no `/T` were deliberate (`60ea77be`): `/T` would kill a browser
the sign-in opened, and once the root has exited nothing vouches for the pids
below it (Windows keeps a pid from reuse only while a handle to it is open,
and each member of cmd.exe -> node -> codex holds the next). Killing the root
alone first breaks that chain of handles, so it cannot be followed by a kill
of the rest.

### Fix

The kill never kills the root alone while a table may still come. An early
read still running is waited for up to its own 30 s timeout, the root left
running, and its whole chain is killed. A kill with no early read whose own
read fails reads once more with the 30 s budget. The root alone only once a
read with that budget has failed. The run still settles at its 15 s bound; a
kill still reading then carries on after the run has settled. Unchanged: no
`/T`, nothing killed by pid once the root has exited (checked right before
taskkill), and a stale early table only ever supplies its wrapper line.

### Evidence

- `tests/wp1/cli-discovery.test.ts`: four tests written first were red on
  `14ad7475` (4 failed, 88 passed) and green after (92/92): an early read
  answering after the old budget names the whole chain and nothing is killed
  before it; a root that exits while the kill waits is not killed by pid; the
  no-early-read retry, with its failure, non-list and bounded cases; the runner
  settles at its bound while the kill still waits. The old root-alone test now
  pins the longer, still bounded, wait.
- Five mutants (the old wait bound, no retry, an unguarded synchronous throw, a
  non-list answer accepted, a retry after a failed early read) each go red;
  restored byte-identically (sha checked).
- `tests/wp1/fake-cli.test.ts` (CI and VM only, not run on the host): the poll
  windows, the sign-in delay of the cancel test and the test timeouts now come
  from the kill's worst case (own read + the longer read + taskkill).
- `npm run typecheck` clean; WP1 gate pair 16/16. CI pending; spec,
  code-quality and ADR-009 reviews pending.
