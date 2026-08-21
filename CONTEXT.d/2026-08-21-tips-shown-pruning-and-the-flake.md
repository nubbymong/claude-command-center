# 2026-08-21 — Tips: shown means seen, dead rows pruned, dead gates wired; and the flaky test identified

Backlog items 13, 14, 15 and 44.

## 13 — "shown" did not mean seen

`pickNextTip` stamped `tipsShown[id]` at the moment it CHOSE a tip: about two
seconds after launch, whether or not anything drew it. A stamped tip does not
come back for seven days. Launch onto a page tab, or with the sidebar collapsed,
and the tip was spent without a pixel of it reaching the screen — and the next
launch spent the next one the same way.

Picking is now separate from showing. `pickNextTip` sets `currentTipId` and
writes nothing; the new `markTipShown(id)` does the stamping and is called from
the dock row's render effect, which is as close to "the user could see it" as the
renderer can honestly get. It is idempotent and keeps the FIRST timestamp — it
runs on every remount, and refreshing the stamp would keep pushing the seven-day
window out so the tip never rotated away.

This is the bug the "N new" count added in #336 was going to make obvious.

## 15 — the gates nothing recorded

**The book's item 15 named the wrong tips, and so did my first audit.** Worth
recording both errors because the method matters.

The book said six tips had "never once been shown". A grep for `trackUsage('…')`
suggested ten feature ids were never recorded and two tips were structurally
unreachable. Both were wrong: `App.tsx` has a **view → feature map** (now moved
into the store) that records six ids through a variable, which a literal-string
grep cannot see. The real usage file on this machine settled it — it contained
`memory.memory-page`, `tokenomics.dashboard`, `vision.toggle-vision` and
`agents.cloud-agent-dispatch`, all of which the grep had called dead.

**Reading the actual data was what corrected it.** The real list of ids nothing
recorded is six, and no tip was ever structurally unreachable — the damage was
that six tips could never switch to their "you have already found this" variant,
so they kept introducing features the user had been using for months:

| id | now recorded when |
| --- | --- |
| `sessions.effort-level` | a config is SAVED with an effort level |
| `sessions.session-type` | a config is SAVED as SSH |
| `commands.ctrl-click-args` | you Ctrl+click a command to edit its args |
| `productivity.statusline-config` | you change what the status line shows |
| `github.ai-usage-enabled` | the Copilot credit meter is turned ON (not off) |
| `agents.agent-teams` | a team run actually STARTS (not on save) |

The last one was found by the test, not by me — see below.

## 14 — pruning by rule, not by list

The book listed nine retired features by name. Their ids are not recoverable from
the source, and I started to write them out from the names. That is precisely the
trap in `adv-review-mutation-method`: **a guessed id that never existed makes a
prune that cannot fire, and reads as though it were doing something.**

Replaced with a rule: drop any `features` row whose id this build cannot record.
`knownFeatureIds()` is the recordable set; anything else is a row for a feature
that no longer exists. Checkable against real data — on this machine it drops
exactly one row, `hooks.gateway-seen`, and leaves the other thirteen alone. That
case is now a test.

### The unfailable test I nearly shipped

The first `knownFeatureIds()` folded in every id the tips library gates on. The
test "every requires/excludes id is one this build can record" then asserted
membership in a set built from those very ids — **true by construction, and it
passed on the first run.** Removing the library from the set made it a real
check, and it immediately failed on `tip.agent-teams -> agents.agent-teams`,
which is how that sixth missing call site was found.

The library is CHECKED against the recordable set, so it must not be a member of
it. Six unfailable tests in one session is a documented failure mode here
(`feedback-verify-the-verifier`); this was nearly the seventh.

## 44 — the flaky test, identified

**It was never one test.** `vitest.config.ts` had `testTimeout: 10_000`. A handful
of main-process suites do real filesystem work and shell out to `icacls` to apply
and read back Windows DACLs — `harden-dir-acl-windows`, `canvas-plugin`, the
`account-profiles` group. Every icacls call is a process spawn, they serialise on
the filesystem, and one can take seconds on a busy machine.

Measured, on this box, with another session's suite running concurrently
(25 node processes):

| run | timeout | failures | wall |
| --- | --- | --- | --- |
| quiet | 10s | 0 | 44s |
| loaded | 10s | **36** | 121s |
| loaded | 10s | 8 | 58s |
| very loaded | 30s | 1 | 104s |
| quiet | 30s | **0** | 39s |

`canvas-plugin.test.ts` alone takes ~41s for eleven tests and passes every time.
No assertion ever failed — a stopwatch did. Raised to 30s: a budget a real,
passing test cannot meet on a busy machine does not measure correctness, it
measures what else was running, and it costs someone an investigation every time
it fires.

## Verification

Full suite **6250 passed / 15 skipped**, typecheck clean, on a quiet run.

Mutation-tested:

| mutation | tests failed |
| --- | --- |
| `pickNextTip` stamps shown again (the original bug) | 3 |
| `markTipShown` overwrites instead of keeping the first stamp | 1 |
| library folded back into `knownFeatureIds` | (made the orphan test unfailable — caught by inspection, then by the real orphan it found) |
