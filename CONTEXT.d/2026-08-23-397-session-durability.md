# 2026-08-23 — #397 session-state durability + fail-open restore (PR #413)

**What changed.** Sessions restart no matter how the app closes. A durability
core (`src/main/session-durability.ts`) makes `session:save` the single choke
point: every renderer writer is enriched in main with each Claude session's
exact resume target from the live transcript binder, cached, and persisted —
so every file on disk is resumable, not only the graceful close. The cache is
flushed on every exit path (`before-quit`, SIGTERM, powerMonitor shutdown) and
dropped on an intentional clear so a flush can never resurrect a discarded
set. Loading is crash-safe: a `.bak` previous-good mirror recovers external
corruption of the primary (shape-corrupt JSON included — never coerced into an
invented empty set), corrupt files are moved aside rather than destroyed, and
migration is guarded per entry. Restoring is fail-open: corrupt persisted
spawn fields (`resume`, codex preset, `permissionMode`, `extraArgs`) are
dropped or floored by `sanitize-restored-spawn-options.ts` before the strict
spawn parse, whose enum/charset/refine now live in that module so the
sanitizer and the parse cannot drift. `permissionMode`/`extraArgs` round-trip
through persistence, and the restore saves the live set instead of clearing —
no gap where a crash lost everything.

**Deliberate non-goal.** No flush inside main's `uncaughtException` handler
(#397 Group 2 names it): synchronous atomic-write retries inside a dying
handler risk more than the bounded loss — the on-disk file is already the
last enriched save, so only the exit-time re-enrichment is lost.

**Review.** ADR-009 adversarial PASS recorded on #397 (3 rounds, SSBN build);
after the 66-commit rebase onto beta, an independent review round found and
fixed an exit-flush/GitHub-writer clobber (R3), sanitizer coverage for the two
newly persisted fields (S2), and the shape-corruption coercion (R4); the
verification round PASSed with the schema extraction proven value-identical
(byte comparison + 972-case fuzz). Security delta since the ADR-009 PASS:
none — no new argv construction, no widened guard.
