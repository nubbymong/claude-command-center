# 2026-08-21 — The #307 re-index is Codex-scoped (found by the ADR-009 pass)

The single end-of-run adversarial pass over the beta.16 substrate
(`integration/beta16-pass`) turned up a defect in #327, merged to `beta` this
morning and not yet in any shipped build:

The one-off "Codex re-index" in `src/main/tokenomics/tk-db.ts` ran `DELETE FROM
tk_events` with no provider filter, truncated the four rollup tables and rewound
EVERY file cursor, then relied on a full re-read of `~/.claude/projects` and
`~/.codex/sessions` to repopulate. Anything whose source file was gone could not
come back: Claude Code deletes transcripts past its retention window (default
30 days) and people prune the Codex tree. Every upgrading user would have lost
life-to-date Claude spend older than their window, silently, on first launch.

## The fix

Same marker, same moment, different body — one transaction:

- `DELETE FROM tk_events WHERE provider = 'codex'` — only the rows whose dedup
  keys the identity fix changed.
- Truncate the rollups and **rebuild them from the surviving events** by
  replaying them through the very upserts the live ingest uses (rowid order =
  original ingest order, so the first-config / last-model rules come out as
  they did the first time). They are pure aggregations of `tk_events`; nothing
  needs a source file.
- Rewind **only Codex cursors** (`codexSessionId <> '' OR path LIKE
  '%rollout-%'`); a Claude transcript under a directory called `rollout-…`
  merely gets re-read and its unchanged dedup keys make that a no-op.
- `better-sqlite3` refuses other statements while an `iterate()` cursor is open
  on the connection, so the replay pages by rowid (5000 a page).

## Verification

`tests/unit/native/tokenomics-reindex-307.native.test.ts` (Electron-as-Node):
a Claude row whose transcript is gone survives with its life-to-date cost; Codex
rows go; every rollup is rebuilt exactly; only the Codex cursor is rewound; a
second open changes nothing and a re-read is a dedup no-op. Mutation pass 3/3
red (old unfiltered wipe; cursor filter dropped; a rollup upsert skipped).


## Re-attack round (the single ADR-009 pass, 2026-08-21) — what it found here

One attacker on the re-index, empirically: 12 345 / 5 000 / 5 001 / 10 000 mixed events
with ~40 % Codex interleaved, dedup hits, random batch sizes and ts ties replayed
byte-identical to an oracle DB that ingested only the Claude events; Claude-only
4 999…10 001 and "every row is Codex" (zero survivors) likewise; a second marker-less
run identical; 300 k events re-indexed in 2.6 s. The Codex-scoped delete, the
single-transaction rollback and the cursor scoping all HELD. Four minors, three fixed:

- `firstIndexComplete` was left at `'1'`, so the worker's first `ready` after the
  upgrade reported a complete index over a DB whose Codex spend had just been zeroed
  (the supervisor latches that message). Cleared inside the transaction.
- `tk_daily` was rebuilt from `dayOf(ts)` at re-index time, so a zone change between
  ingest and upgrade made the rollups disagree with `tk_events.day`. The stored day is
  used (bucket is not stored, so the heatmap is recomputed with the live maths).
- A throw mid-replay rolled back correctly (verified row-for-row) but leaked the
  `Database` handle: a worker alive-but-never-ready with the file held until the next
  launch. The gate closes the handle before rethrowing.
- Not changed, recorded as a design call: Codex spend whose rollout no longer exists on
  disk is gone after the re-index (the rows were the corrupted parent/subagent mix; zero
  was preferred to wrong-but-close, and the cursor sweep only visits files that exist).

`tests/unit/native/tokenomics-reindex-307.native.test.ts` gained the three cases (the
handle proof is "the file can be renamed after the failed open", which Windows refuses
while a handle is held).
