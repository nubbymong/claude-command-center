# 2026-08-22 — one shared null-vs-failed pattern for the main-side persisters

First of the #371 follow-ups the ADR-009 pass before beta.16 left noted rather than
fixed. That pass fixed the shape for saved sessions (#353) and wrote down where else it
lived: *"the same null-vs-failed shape in five other main-side persisters (one shared fix
later, not five copies)"*. This is that fix.

## The shape

A failed READ is not an absence. A file can be there and unreadable for a moment — an AV
scanner holding a just-written file (EBUSY), a permissions hiccup, a network share that
blinked — and every one of these loaders answered `null` for that exactly as it answered
for "no file". The caller then did the ordinary thing with the empty store it was handed
(added an item, swept a stuck entry, saved the form the user had just opened) and wrote
it over the file it had never managed to read.

Nothing failed loudly. The user's cloud agents, team library, usage history, vision
settings or window geometry were simply gone.

## The five, and how each one reached the write

| Persister | The write that lost it |
| --- | --- |
| `cloud-agent-manager.ts` | dispatching an agent persisted a one-element array over the history |
| `team-manager.ts` (teams + runs) | the next `saveTeam()` wrote one team over the whole library; the boot stuck-run sweep wrote over the run history |
| `usage/usage-snapshots.ts` | every caller rebuilds the whole map and saves it back, so one bad read dropped every OTHER profile's snapshot |
| `ipc/vision-handlers.ts` | `getConfig` → null → the form rendered defaults → the user touched one control → `saveConfig` wrote defaults over the real config |
| `index.ts` window geometry | a bare `catch { /* ignore */ }` returned the hardcoded 3200x1800 default, and the close handler wrote it back over the real geometry |

Vision was doubly quiet: the handler discarded `writeConfig`'s boolean and returned
`{ ok: true }` unconditionally, so a failed save was reported to the user as a
successful one too. Window state was the only one of the five that bypassed
`config-manager` entirely, so it also never had the atomic write.

## The pattern

`src/main/persist-latch.ts` — one latch, applied five times, never copied:

- `config-manager.readConfigChecked()` answers with an OUTCOME, not just a value.
  Three ways to get nothing, not one: **absent** (an empty store is the truth),
  **unparseable** (content unrecoverable — moved aside to `<name>.corrupt-<ts>`, never
  silently destroyed, writes stay allowed because there is nothing left to protect), and
  **failed** (the file could not be read).
- `createReadFailureLatch(name)` remembers the last load's outcome. While it was
  `failed`, `saveConfigLatched` refuses and logs why. A later successful load clears it.

The failure signal rides on the latch, never on the return value, so every caller keeps
its existing shape and only has to consult the latch before it WRITES.

The asymmetry is what makes this safe to apply everywhere: a refused write costs one
unsaved change, which the next successful load un-refuses. An un-refused write costs the
file.

Two files means two latches (`team-manager`), never one shared: one file's read failure
says nothing about the other's, and sharing would latch writes off for a file that read
perfectly well.

## What was deliberately NOT changed

The renderer's bulk load (`loadAllConfig` → `readConfigDetailed`) keeps its own contract
from #353: a renderer config file that exists and cannot be read OR parsed latches
renderer writes, and nothing is moved aside. That path is a separate boundary
(GHSA-m8p2) and an unparseable renderer config is recoverable by hand — the latch is what
stops defaults being written over it. `readConfigDetailed` now delegates to the same
reader with `quarantineUnparseable: false`, so there is one implementation and no
behaviour change.

Window geometry moved out of `index.ts` into `src/main/window-state.ts`. It is a
persister like the others and needed the same latch plus a unit test, and it now goes
through the shared `windowState` config key — which resolves to exactly the path it used
to build by hand (`<CONFIG>/window-state.json`), so upgrading installs keep their
geometry with no migration, and it picks up the atomic write it never had.

## Verification

Every latch was mutation-tested: `refuses()` forced to return false, the suites watched
go red (10 tests across four files), the guard restored byte-for-byte.

That mutation is also what caught a test that could not fail — the first cut of the
cloud-agent case asserted "nothing was written" after a failed load, which is true
whatever the latch does, because a failed load leaves an empty list and the boot sweep
has nothing to change and never reaches `persist()`. Dispatching an agent is the only
persist path reachable while latched, so that is what the test now drives. The
unreachable case is kept beside it with a comment saying it is not a latch assertion, so
the next reader does not mistake it for one.

Full suite on the branch: 7111 passed, 15 skipped, 2 todo (663 files); typecheck clean.
