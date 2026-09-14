# 2026-08-21 — Canvas plan mode (P4/P5) and its authoring skill (P6)

Backlog items 30 and 31. The design was already settled on canvas
`.ccc-canvas/plan-mode.html` (2026-08-20) and its own claim was that plan mode is
"no new plumbing: a mode stamp on the version for the chip and the right skill,
and the review loop is unchanged". That turned out to be exactly right, and this
is what it looks like implemented.

## The one design decision

`CanvasVersion` already carried **two** fields that had always been equal:
`mode` and `source.mode`. Plan mode is the change that makes them differ.

- `source.mode` is **how it is stored and served** — `'design' | 'uat'`. A plan
  is an agent-authored standalone document exactly as a mockup is, so a plan
  version's source says `'design'` and it is written to the same per-version
  directory, admitted by the same path check and reader and size cap, and served
  by the same code.
- `version.mode` is **what the page is** — `'design' | 'plan' | 'uat'`. It drives
  the chip and tells the agent which authoring skill wrote it.

The consequence is the point: **no serving or validation path gains a branch.**
The surface an attacker can reach through plan mode is byte-for-byte the surface
design mode already had. A third mode later (a migration, an incident timeline)
costs a skill and a chip and nothing else.

`renderVersion` therefore has one branch for `'design' | 'plan'`, and the only
difference inside it is which value is stamped on `version.mode`.

## What the reserved scaffolding already gave us

`CanvasMode` already included `'plan'`, and `AnchorRef` already had a
`'plan-step'` kind that `canvas-handlers.ts` validated and `canvas-review-store`
accepted. In practice plan pages anchor by `data-ux-id="step-1"` like everything
else, so `plan-step` stays reserved and unused — worth knowing before someone
"finishes" it.

An existing test in `canvas-mcp-tool.test.ts` asserted that `'plan'` was
**refused**, with a comment explaining it was a mode the spec had and the store
did not. That test was right when written and is now wrong; it has been replaced
by a positive test plus `'PLAN'` (wrong case) kept in the refusal list.

## Two things fixed on the way

**`versionKind` and `canvasModeBadge` keyed on `source.mode`.** For a plan that
says `'design'`, so both would have called a plan a Mockup. They read
`version.mode` now. The badge's own comment had already anticipated "a mockup,
the live site, and in time a plan".

**The plugin's integrity listing was a third hand-maintained copy.**
`treeIsPristine` held a literal directory listing beside `OWNED_FILES` and
`OWNED_DIRS`. Adding a second skill meant editing three places, and forgetting
the third fails silently in one of two bad ways: the tree is judged impure on
every spawn (a wipe and rebuild before every session, for the life of the app),
or — if the literal were the more permissive one — an unexpected entry is
tolerated in a directory whose whole purpose is that nothing unexpected lives
there. `expectedListing()` now derives it, so writer, verifier and listing cannot
disagree.

## P6 — the authoring skill

A second skill in the canvas plugin, `skills/canvas-plan/SKILL.md`. It does not
repeat the review loop (that is `agent-canvas`); it says what a plan PAGE
contains — the six parts — and the behavioural rules: the plan accompanies the
conversation rather than replacing it, open questions do not block, an approved
plan stays up as the record, a changed plan is a new version and never a
renumbered step. `PLUGIN_VERSION` bumped to 1.1.0.

**Four design questions on the mockup were never answered by the owner.** They
were built on the mockup's own stated assumptions, which is recorded here so it
is visible rather than implied: plan accompanies the markdown; Approve marks the
version approved and work starts; the flow (steps with a parallel branch) is the
spine; open questions do not block.

## Verification

Full suite **6239 passed / 15 skipped**, typecheck clean.

`tests/unit/main/canvas-plan-mode.test.ts` drives the real store — renders land
on disk and are read back — rather than asserting the shape of a literal written
in the test, which would pass whatever the store did. Both new guards were
mutation-tested:

| mutation | tests failed |
| --- | --- |
| `ver.mode` validation removed from `isKeepableVersion` | 1 |
| `renderVersion` always stamps `mode: 'design'` | 2 |

Two of that file's own failures during development were harness bugs worth
recording: the shared size cap is **8 MiB** (not 6), and the record MAC is
computed over the record **without** its own `mac` field — recomputing over the
stale one produces a record that fails tamper detection before it ever reaches
the shape check, which made a "drops a bad mode" test pass for the wrong reason.

ADR-009: this touches `canvas-mcp-tool.ts`, which is part of the Conductor MCP
server and on the sensitive-path table. Per the owner's call (2026-08-21) there
is no per-PR pass; **one adversarial pass runs over the merged substrate before
beta.16 is cut.** The argument to put to it is the `source.mode` / `version.mode`
split above.
