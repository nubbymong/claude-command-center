## 2026-08-25 -- #480 durable, cross-safe session->conversation tracking

**Problem.** When several cards run in one repo directory, an in-session Restart
could resume a SIBLING card's Claude conversation. Root cause: the transcript
binder's heuristic fallback (`transcript-discovery.ts` `bindOnce`) scans the
shared mangled-cwd project folder and picks the newest `.jsonl`, which can belong
to another live card; `getLatestTranscriptPath` then fed that into the restart
resume in `pty-manager.ts`. Evidence: one run was attributed three overlapping
transcripts (two written concurrently) -- impossible for a single session.

**Fix (fix-forward, four parts).**

1. Exact-only resume. New `binder.getExactResumeTarget(sessionId)` returns the
   bound path ONLY when the bind is EXACT (authenticated hook / statusline).
   `pty-manager` restart capture now uses it instead of `getLatestTranscriptPath`
   -- a heuristic guess is never a resume source. No exact bind => `resume=none`
   (fresh start), which is safer than reopening a stranger.
2. Ownership guard. The binder keeps a uuid->sessionId reverse index for exact
   binds. A second LIVE session cannot steal a uuid another live session owns
   (the bind is refused); the reservation releases on `endRun` / on a /clear
   rotation so a genuine handoff still re-binds.
3. Heuristic exclusion. `bindOnce` takes an `excludeUuids` set; the binder passes
   the uuids owned by OTHER live sessions so the newest-file scan skips them.
4. Durable map. New `session_conversation(sessionId PK, uuid, path, confidence,
   updatedAt)` table in `transcripts.db`, upserted on every exact bind via a new
   worker message. `resume-handlers` `getResumeTarget` now reads the durable
   record first, then the live exact bind -- one crash-durable source for both
   the close-all relaunch path and in-session restart.

**Not changed.** The app-relaunch resume via persisted `resumeUuid`
(`buildSessionStateWithResumeTargets`) already worked; it now shares the same
exact-only source.

**Tests.** New `transcript-binder-ownership.test.ts` (exact-only, ownership
guard, handoff, heuristic exclusion, /clear rotation); discovery exclusion cases;
`transcripts-db.native.test.ts` durable-map cases. Existing binder + resume-IPC
tests updated for the new `bindOnce` arg and the durable-first handler.

**Gates.** Touches PTY resume + IPC -> /adversarial-review required before merge
(ADR-009). Human approval + desktop test before merge.

### Adversarial review (round 1) -- verdict PASS after fixes

Four independent attacker lenses (injection, cross/ownership, blast-radius,
design/coverage/platform). Injection: NONE (uuid triple-validated by anchored
UUID_RE before argv; cwd quote-escaped + existence-gated; SQL parameterized).

One MAJOR found and fixed: the durable table accumulated one row per session and
was read on resume keyed only by sessionId, so after an app restart two cards
could both resume the same uuid. Fix: `upsertSessionConversation` runs in a
transaction that evicts every OTHER session's row for the same uuid first --
one uuid maps to at most one durable session (handoff transfers ownership).

Two LOW fixes: (1) the ownership-refusal check now runs BEFORE `cancelHeuristic`,
so a refused bind keeps its heuristic fallback armed; (2) `getResumeTarget`
prefers the LIVE exact bind and falls back to the durable record only after a
restart, closing a /clear-then-quit staleness window.

Intended trade-off (documented, not fixed): a session that NEVER received an
exact hook bind (hooks disabled / gateway bind failure) loses app-relaunch resume
-- the heuristic net is deliberately removed from the resume path because it is
the exact source of the cross. Default config (hooks on) is unaffected.

Re-attack (round 2, two fresh lenses): PASS -- MAJOR proven closed (attacker
reverted the eviction, saw the guard test fail, restored), reorder proven to hold
rotation / dedupe / refusal / heuristic invariants. Regression tests added for
every fix (fail-on-revert verified).

### Hooks-off fallback + adversarial round 2 (BLOCKER + MAJOR)

Added a fallback (user-requested): when hooks are OFF no exact bind can arrive,
so the resume paths fall back to the heuristic bind AND warn -- best-effort
resume for a config with no authenticated source. Gated by a new
`isExactBindSourceActive()` in `src/main/hooks/index.ts`.

A focused attacker on that gate found two holes, both fixed:

- BLOCKER: a SECOND enrichment path (`session-resume-enrich.ts`, wired in
  `index.ts`, the `session:save` / exit-flush choke point) still stamped
  resumeUuid from the heuristic `getLatestTranscriptPath` with NO gate, and
  OVERWROTE the renderer's gated value -- so the same-repo cross survived on the
  relaunch path even with hooks on. Fix: route that path through
  `getExactResumeTarget` + the same gated heuristic fallback.
- MAJOR: `isExactBindSourceActive()` keyed on the live `gateway.listening` flag,
  which blips false during gateway startup / crash-backoff / manual restart, so
  the fallback unlocked in the default (hooks-on) config during those windows.
  Fix: key ONLY on the `hooksEnabled` SETTING.

Round-2 re-attack after the fixes: PASS. One MINOR (documented, by design): a
permanently-failed gateway with hooks ON gives fresh resume rather than a
heuristic guess -- fails safe, and the durable table still recovers any session
that achieved an exact bind once. Regression tests: `exact-bind-gate.test.ts`,
`enrich-cross-attack-480.test.ts`, plus hooks-on/off cases in
`session-resume-enrich.test.ts` and `resume-ipc-handlers.test.ts`.

**Ref:** #480.
