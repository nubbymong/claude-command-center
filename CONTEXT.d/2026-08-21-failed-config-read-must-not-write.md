# 2026-08-21 — A failed config READ must never become a config WRITE

One of the four findings carried out of the #308 ADR-009 pass, and the one that
could eat user data. Diagnosed and independently refuted-then-confirmed before
any code was touched.

## What happened

`configs.json` contains a syntactically valid array with a `null` element — the
shape a half-finished write or a hand-edit leaves. `readConfig` parses it fine.
Then `loadAllConfig` runs its two read-path migrations, and
`stripLegacySshFields` does `for (const c of configs) c.sshConfig`. On `null`
that throws. The only `try` in `loadAllConfig` wraps `ensureConfigDir`, so the
throw escapes `ipcMain.handle('config:loadAll')`, and the renderer's
`await window.electronAPI.config.loadAll()` rejects.

App's boot catch answers a rejection with `hydrateStores({})`. That is right as a
way to get a usable window and catastrophic as a place to save from:

- **commands.json ← `[]`.** `configData.commands == null`, so the list becomes
  `[...DEFAULT_COMMANDS]`, which is literally `[]`. `migrateCommandArgs` then
  returned `commands.map(...)` — a fresh array — so the caller's
  `migrated !== commands` identity check was TRUE, and it wrote the empty list
  to disk. Every custom command, gone.
- **settings.json ← 26 default keys.** `settingsStore.hydrate({})` merges to
  `DEFAULT_SETTINGS`, which has no `fontMigratedV2`, so `migrateV2Font` reports
  `changed` and persists the whole default object over the user's.
- **Everything else was deferred, not spared.** configs, groups, sections,
  magic buttons, agent templates and the rest are memory-only at hydrate — but
  the stores now hold `[]`, so the first ordinary action (add a config, drag a
  panel) persists that emptiness over files that were never damaged.

And it was silent. The "your config was reset" notice keys on
`warnings.length > 0`; `{}` produces none, because every section reads as ABSENT
rather than corrupt. The loudest failure in the app was its quietest.

## The fix, in three layers

**1. Stop the throw.** Both per-entry loops in `config-manager.ts` skip
non-objects. A primitive is passed through untouched rather than migrated:
`{ ...'abc' }` is `{0:'a',1:'b',2:'c'}` and that path PERSISTS, so the old code
would have written a char-index object back as though it were a config. We leave
alone what we cannot read. Both migration calls are additionally wrapped
best-effort — `data` is already read and is strictly better than nothing, so no
future read-path migration can ever reject `config:loadAll` again.

**2. Latch writes off when the read failed.** New `configWriteLockStore`. App's
catch locks it BEFORE hydrating; `config-saver` refuses every dispatch while it
holds, and `configHydration`'s two direct-to-IPC command writes honour it too
(they bypass config-saver, which is exactly how they got missed). Deliberately
NOT recorded in `configHealthStore`: that surface offers a Retry, and retrying is
the one thing that must not happen here.

**3. Say so, and offer the way out.** `ConfigLoadFailedNotice` states that the
app is showing defaults, that nothing has been written over the saved config, and
that quitting now loses nothing. "Start fresh anyway" releases the latch for
someone who would rather have a working app than the config they cannot load. Not
dismissible — a dismiss would leave saving latched off with nothing on screen
explaining why nothing sticks.

Also fixed while in there: `migrateCommandArgs` now returns its INPUT reference
when no command was rewritten. `map` always allocates, so the old version made
the caller rewrite commands.json on **every boot of every install** whose
commands carry no `defaultArgs`. The destructive write was not an edge case in
that code path; it was the code path.

## Verification

Full suite **6271 passed / 15 skipped**, typecheck clean.

Five guards, each mutation-tested — the mutation applied, the run watched go red,
then the original bytes restored:

| mutation | result |
| --- | --- |
| drop the null/primitive skip in `migrateConfigsToProviderShape` | 2 red |
| drop the null skip in `stripLegacySshFields` | 1 red |
| `config-saver` ignores the latch | 2 red |
| `configHydration` ignores the latch | 1 red |
| `migrateCommandArgs` returns the fresh array again | 1 red |

The fourth is worth recording: it **did not bite on the first attempt**. With
`migrateCommandArgs` fixed, `hydrateStores({})` computes no migration at all, so
there was no write for the hydration-side latch to suppress and the guard was
untestable through that door. A test was added that hands the migration real work
while latched, which is the only input that isolates it. A guard no input can
trip is worse than no guard, because it reads as protection.

## Not fixed here, deliberately

The same `{}` path still produces no user-visible warning list; the new notice
covers the failed-READ case, which is the one that loses data. And the boot catch
still cannot distinguish "config is corrupt" from "IPC died" — both latch, which
is the safe direction.
