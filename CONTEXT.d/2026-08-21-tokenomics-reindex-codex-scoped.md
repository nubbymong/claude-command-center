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
