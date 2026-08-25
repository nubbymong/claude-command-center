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

**Ref:** #480.
