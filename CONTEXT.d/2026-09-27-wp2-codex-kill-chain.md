## 2026-09-27 -- WP2: a timed-out Codex run's whole chain is killed when the process table is slow

Draft PR #625 (branch `session/beta/c4d568ce-wp2-codex`). First fix `8a6b83d5`,
round-2 review fixes `040ad456` (both pushed), round-3 review fixes in the
commit after it (local, not pushed).

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

- The kill never kills the root alone while a table may still come. An early
  read still running is waited for up to its own 30 s timeout, the root left
  running.
- Every table, whichever read gave it, is used whole only while it can be no
  older than a kill-time read may be (8 s from the start of its read). An
  older one gives only the wrapper line (cmd.exe -> node -> codex), which the
  running root vouches for; a helper codex has reaped may have handed its pid
  on.
- A failed read gets one bounded retry: after a failed early read, the kill's
  own 8 s read; after a failed kill-time read, an early read that finished
  earlier stands in, one that failed means the root alone, and with no early
  read at all one 30 s read. A throw or an answer that is not a list is a
  failed read; the kill never rejects with nothing killed. The root alone
  only when every read failed.
- The run still settles at its 15 s bound. A kill still reading carries on,
  at most 44 s from the stop (`CODEX_KILL_WORST_MS`, with a 1 s margin for a
  taskkill ended by its own timeout), and the result carries
  `killSettled`. The realm lock and browser slot (sign-in, sign-out, status),
  the review lease, the Claude reviewer's profile hold and discovery's
  throwaway home are held until it resolves; the caller still hears back at
  the bound. A cancelled sign-in returns signed-out then, but its login may
  live up to that worst case after the cancel, and a browser sign-in finished
  in that window still signs the realm in; the status check the sign-in flow
  runs when it finishes or is abandoned reconciles it.
- At app quit, kills still reading kill at once what they know: an earlier
  table's wrapper line, else the root alone (`flushPendingCodexKills`, from
  the quit teardown through the composition root), in one synchronous
  taskkill bounded at 5 s; a kill whose read lands after it kills nothing
  more. Best effort.
- Unchanged: no `/T`; nothing killed by pid once the root has exited.

Residual: a quit while a kill knows no finished early table (its early read,
own read or retry still running) kills the root alone, so node and codex can
outlive the app; a quit-time taskkill that fails or passes its 5 s bound falls
back to each root alone.

### Evidence

- First fix: four cli-discovery tests red on `14ad7475` (4 failed, 88 passed),
  green after (92/92); five mutants red.
- Review fixes: tests written first were red on `8a6b83d5` (17 failed, 221
  passed over cli-discovery, codex-auth-adapter, claude-reviewer and
  codex-review-mcp-tool), green after (239/239). 23 mutants over the runner,
  the auth operations, discovery, both reviewers and the review tool each go
  red; one survived at first and got a test. Sources restored byte-identically.
- Round-3 fixes: tests written first were red on `040ad456` (10 failed, 234
  passed over the same four files), green after (244/244); 11 mutants red,
  restored byte-identically. The reported busy status in the real-process
  cancel test cannot happen (a status check is a reader and runs beside a
  sign-in's hold); a unit test pins that instead of a retry loop.
- `tests/wp1/fake-cli.test.ts` (CI and VM only, not run on the host): after a
  stopped run returns, the sleep tests wait for `killSettled`, then 8 s; the
  cancel test keeps its 3 s window unless the run returned at the settle
  bound. Timeouts and the sign-in delay come from `CODEX_KILL_WORST_MS`.
- `npm run typecheck` clean; WP1 gate pair 16/16. CI pending; confirmation
  review pending.
