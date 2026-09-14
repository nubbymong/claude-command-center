# 2026-08-21 — A failed config read is not an absence (the rest of the #341 latch)

Found by the single ADR-009 pass over the beta.16 substrate. Three refuter-
confirmed MAJORs, all **pre-existing in every shipped build**, and one new crash.

## What #341 left open

#341 latched writes off when `config:loadAll` **rejected**. Three failed reads
never reject:

1. **The CONFIG dir is unreachable at boot** (network drive not mounted, USB
   gone, EACCES). `loadAllConfig` caught `ensureConfigDir` and RESOLVED
   `{data:{}, needsMigration:true}` — "fresh install". The boot migrations and
   the stores then wrote defaults; once the drive was back, the user's
   settings.json and app-meta.json were replaced by defaults.
2. **A single file exists but cannot be read or parsed** (truncated, a handle
   held by a backup agent, a directory at its path). `readConfig` returned null
   for ENOENT, a read error and a parse error alike; every consumer treats null
   as "never written" and writes its defaults — with no warning, because the
   hydration notice keys on a value that is present-but-wrong, not absent.
3. **`agentLibraryStore` saved straight to `config.save`**, bypassing
   config-saver and so the latch: one Agent Library action under "your
   configuration could not be loaded" replaced agent-templates.json with the
   single new entry.

And new in this substrate: **a corrupt usage-tracking.json** (any non-object
JSON) was coerced to `{}`, which is not a valid `UsageTracking`, and the dock
(#336/#339) now calls `countUnseenTips(tracking)` synchronously in render → a
TypeError inside the app-wide ErrorBoundary on every launch, no self-heal.

## What changed

- **main** `config-manager.ts`: `loadAllConfig` returns `LoadAllResult` with
  `readFailed` (dir unreachable — and `needsMigration` is then FALSE) and
  `failedKeys` (files that exist but could not be read/parsed; their data is
  null). A missing file is still just absent. `readConfigDetailed` says why.
- **renderer** `App.tsx`: after a RESOLVED loadAll, `readFailureLockReason`
  (configHydration) turns either signal into the same latch the catch uses,
  BEFORE the migrations run; the notice names the files.
- `retireAskConfig` and `applyConfigColourMigration` return their input under
  the latch — they write through their own `config.save` calls, which the
  latch never saw. Idempotent; they run on the next healthy boot.
- `agentLibraryStore.saveTemplates` → `saveConfigNow` (latch + retry + health
  marking for free).
- `tipsStore.hydrate` normalises to a valid shape (`normaliseTracking`) and
  the readers tolerate a missing map.
- A guard test bans `electronAPI.config.save(` anywhere in `src/renderer`
  outside config-saver.ts and configHydration.ts.

## Verification

`tests/unit/main/config-manager-read-failures.test.ts` (real config-manager on
a temp dir: clean / absent / unparsable / unopenable / unreachable dir, and the
next load after the dir is back reads the untouched file),
`tests/unit/renderer/config-read-failure-latch.test.ts` (the reason, both
migrations under and not under the latch, the Agent Library under the latch,
corrupt tracking), `tests/unit/renderer/no-direct-config-save.test.ts`.
Mutation pass 8/8 red. stores/renderer/main suites 3239 green.


## Re-attack round (the single ADR-009 pass, 2026-08-21) — what it found here

One attacker on the latch. The #353 surface itself held every empirical attack: partial
failures (one key bad, others fine) hydrate the good keys and write nothing; a
`saveConfigDebounced` queued BEFORE the lock and firing after it is refused (the lock is
read at dispatch); the main-side best-effort migrations only rewrite keys that READ
fine; nothing re-calls `loadAll` after boot, so the latch is never silently released.

It then walked past the latch to the writers that do not go through it, and found the
pre-existing MAJOR: **`session:save` bypasses the latch, and `loadSessionState()`
conflated a failed read with an absent file.** Hold session-state.json open with
`FileShare.None` (what an AV scanner does to a just-written file) and load it:
`null` — the same answer as "no saved sessions"; the renderer shows no Resume prompt,
and at close writes the EMPTY session list over the two saved ones. Fixed in
`src/main/session-state.ts`: the last load's outcome is remembered; while it was a read
failure (EBUSY/EACCES/EPERM/EIO/a junction refusal) `saveSessionState` and
`clearSessionState` refuse (false, logged) until a later load succeeds — the main-process
twin of the renderer latch. A file that does not PARSE is different: its content is
unrecoverable, so it is moved aside as `session-state.json.corrupt-<ts>` and the store
starts clean (saving allowed, nothing destroyed). `tests/unit/session-state-read-failure.test.ts`.

The same null-vs-failed shape exists in the other main-side persisters the attacker
listed — cloud agents, agent teams/runs, usage snapshots, vision global config,
window-state — each needing a user action on that subsystem to bite; graded MINOR, left
for a follow-up with one shared pattern rather than five copies.

Two minors fixed here: `configHasData()` turned an UNLISTABLE directory (deny-read on
the dir, a share refusing enumeration) into "empty" → `needsMigration:true` → the
renderer re-migrated the v1 localStorage snapshot over files readable by name; it now
returns `'unknown'` and `loadAllConfig` reports `readFailed:true, needsMigration:false`
with the data it could read (`tests/unit/config-manager-unlistable-dir.test.ts`). And
the v1 localStorage keys were never removed after migration, so any later
`needsMigration:true` rolled the user back to v1; they are cleared once a migration
succeeds (`clearMigratedLocalStorage`). Plus the notice now renders the lock REASON
(which files failed) instead of static copy — the file names lived only in
console.error. Not done: the notice is inside the sidebar and invisible when the
sidebar is collapsed (the BottomBar shows only `configHealthStore.failedKeys`, which the
latch deliberately does not mark) — needs a rail-visible indicator; noted for the UI
pass.
