## 2026-07-19 -- Cross-account resume: recover orphaned per-profile projects dirs (#131)

Session transcripts are meant to be SHARED across accounts: each profile's
`.claude/projects` is a junction into the shared `~/.claude/projects`, so discovery
(which scans `os.homedir()/.claude/projects`) already sees every account's sessions
and resume works cross-account. The bug: the junction can silently fail to establish.

`ensureLink` (account-profiles.ts) only replaced an EMPTY dir or an existing link. If
a REAL, non-empty `projects` dir already existed at the link path — Claude wrote
transcripts there before the junction was set up — `rmdirSync` threw ENOTEMPTY
(swallowed) and `symlinkSync` threw EEXIST, so the junction never formed and that
account's sessions were orphaned in an isolated real folder, invisible to every other
account. Observed on the dev machine: one of four profiles had a real `projects` dir
with 170 `.jsonl` transcripts that existed nowhere else.

Fix (merge + repair, scoped to `projects` — uuid filenames are union-safe):
- `ensureLink(target, link, mergeOrphans=true)` for the `projects` junction now
  union-moves an orphaned real dir into the shared store before junctioning
  (`mergeTreeInto`), keeping the LARGER file on a name collision (a transcript only
  grows, so larger = more complete → history never lost). If the dir can't be fully
  drained (e.g. a cross-volume copy failed), it skips junctioning that pass rather
  than lose data (`removeTreeIfDrained` returns false → bail).
- `repairSharedProjectJunctions()` runs at startup (index.ts, beside
  `migrateProfilesToHomeLayout`) across ALL profiles, so existing orphans are
  recovered at launch, not only when that account is next spawned. Idempotent + best
  effort; per-profile failures don't abort the sweep.
- Deliberately NOT applied to `memory` (curated MEMORY.md index is not union-safe) or
  the synced config dirs (agents/skills/commands/plugins) — only `projects`.
- Tests: `tests/unit/account-profiles-orphan-repair.test.ts` (merge, keep-larger both
  directions, cross-profile sweep, idempotency). Full account-profiles suite green.
