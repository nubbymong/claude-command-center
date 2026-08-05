## 2026-08-04 -- The flaky insights suite was a Windows rename race, not test ordering (#213)

#213 was filed as "the unit suite is order/timing dependent under load", with a hypothesis
that `insights-cross-account-run.test.ts` leaked in-flight runs across test boundaries via
`insights-runner`'s module state, and a suggested fix of awaiting quiescence in `afterEach`
plus `vi.resetModules()`. The evidence contradicts that hypothesis. None of it was needed.

Reproduced on the first full-suite run, then made repeatable by running the file under eight
CPU burners: 2 of 6 runs red. A temporary diagnostic `afterEach` that dumped the catalogue
whenever a test failed produced the same error every time, in whichever test happened to be
running:

    EPERM: operation not permitted, rename
      '...\resources\insights\catalogue.json.tmp' -> '...\resources\insights\catalogue.json'

`saveCatalogue` writes a staging file then `renameSync`s it over the target. On Windows that
rename fails with EPERM/EACCES/EBUSY while ANY other process holds a handle on either path,
and Defender, the Search indexer and backup agents all open a file briefly right after it is
written. The window is a few milliseconds, so it is invisible on an idle machine and common
under load. That is why a different test failed each run, and why running the file alone
always passed.

Where the throw lands was measured rather than assumed, by injecting a single EPERM at the
Nth catalogue write of a two-account roll-up and sweeping N (a throwaway test, since a real
scanner will not hold still). Three distinct outcomes, and the first guess was the rarest:

- N = 1, the aggregate's opening `publish()`: rejects outright AND strands the lock (below).
- N = 2..11, any write inside a member's `runInsights`: that member is caught by its own
  handler and marked failed, so the roll-up legitimately refuses with "Only 1 of 2 accounts
  produced KPIs". This is the common case and it matches the observed test failures exactly
  -- `expected 'failed' to be 'complete'`, with the EPERM nowhere in the assertion.
- N = 12, a write inside the aggregate's own try: caught at the bottom of
  `runCrossAccountInsights`, roll-up marked failed with the EPERM text as its error.

Only the last of those is "publish() threw and the roll-up caught it", which is what the
commit message for the first pass claimed. The member path is what actually bit.

Cross-test leakage was ruled out rather than assumed: every catalogue path is synchronous
(`readFileSync`/`writeFileSync`/`renameSync`), so two `upsertRun` calls cannot interleave,
and each test gets its own `mkdtemp` resources dir, so no catalogue outlives its test.

This is a production bug, not a test bug. On a Defender-managed Windows box a real insights
run can be reported failed purely because a scanner held `catalogue.json` for a few
milliseconds. The test suite was the messenger.

Fixed in `saveCatalogue`:

- `renameWithRetry` retries EPERM/EACCES/EBUSY on a 5/10/20/40/80ms backoff (six attempts,
  ~155ms worst case) and unlinks the staging file before giving up. Any other errno still
  throws on the first attempt -- a retry cannot fix ENOSPC.
- The staging file is now `<file>.<pid>.<seq>.tmp` instead of a fixed `<file>.tmp`. A write
  that dies between `writeFileSync` and the rename leaves its staging file behind, and a
  fixed name lets the next write adopt those stale bytes. `github/cache/cache-store.ts`
  already used a unique staging name for the same reason.

The sync backoff uses `Atomics.wait` on a throwaway `SharedArrayBuffer`: `saveCatalogue` is
synchronous and called from synchronous code, so the wait has to block rather than yield.

Evidence: 2/6 red before the fix under eight burners; 0/8 after, under the same load. Full
suite 3/3 green idle plus 1/1 green under four burners; 3822 tests (4 new), typecheck clean,
changelog in sync.

New guard `tests/unit/insights-catalogue-write.test.ts` mocks `fs.renameSync` to fail with
injected errnos and drives `saveCatalogue` through `cleanupStuckRuns`. It covers: retry then
land the write, give up after the budget, refuse to retry a non-transient errno, and stage
each write under a distinct name. Verified to fail against the old code -- 4 of 4 cases red
when the fixed `.tmp` name and bare `renameSync` are restored.

Worth keeping: the first version of that guard asserted exact rename-attempt counts and
promptly flaked under load itself, because a REAL Defender EPERM added an attempt the test
had not injected. It now asserts that the injected failures were consumed and that the set of
distinct staging paths is right, never the attempt count. Writing a retry-tolerant fix
deserves a retry-tolerant assertion.

## A second, worse bug the sweep exposed: the stranded lock

The N = 1 case is not a variant of the same failure, it is a separate defect. Both run
entry points take their lock, then do disk work, and only THEN enter the try whose `finally`
releases it:

    inFlight.add(key)
    ensureDir(archiveDir)      // can throw: EACCES, ENOSPC
    upsertRun(run)             // can throw: the rename race above
    try { ... } finally { inFlight.delete(key) }

Anything that throws in that gap strands the key in `inFlight` for the life of the process.
The user then gets "Insights already running for this account" -- or "A cross-account report
is already being generated" -- forever, with nothing running and no way out but restarting
the app. The retry above makes the rename race far less likely to trigger it, but `ensureDir`
on a full or locked disk reaches it just as well, so the retry is not a fix for this.

Fixed by moving `ensureDir` and the opening `upsertRun`/`publish()` inside the existing try
in both `runInsights` and `runCrossAccountInsights`. The lock is still taken immediately
before the try, so the guard itself is unchanged; only the unprotected gap closes.

`tests/unit/insights-lock-release.test.ts` injects a non-retryable ENOSPC at a chosen write
and asserts the lock is clear afterwards, for the per-account lock, the aggregate lock, and a
failure mid-fan-out. Verified to fail 3 of 3 against the old ordering. ENOSPC deliberately,
not EPERM: EPERM is now retried, and a guard that the fix above quietly satisfies would not
be testing this at all.

Follow-up, not done here: the same fixed-`.tmp`-plus-bare-`renameSync` shape appears in
roughly a dozen other main-process modules (`config-manager.ts`, `session-state.ts`,
`account-profiles.ts`, `model-registry-service.ts`, `sentinel/sentinel-state.ts`,
`hooks/per-session-settings.ts`, `channel-storage.ts`, `codex-review-usage.ts` and others).
Every one of them can lose the same race; `config-manager.ts` losing it means a dropped
config save. A shared atomic-write helper is the right fix and is out of scope for #213.
