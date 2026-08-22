# 2026-08-22 — a closed session's browser profile does not outlive it

Second of the #371 follow-ups from the ADR-009 pass before beta.16.

## What was left on disk

Every browser pane runs in its own Electron partition, `persist:webview-<sessionId>`,
which Chromium turns into a profile directory under
`sessionData/Partitions/webview-<id>` holding that pane's cookies, localStorage,
IndexedDB, service workers and HTTP cache. That per-session isolation is the point
(#348) — what was missing is the other end of the lifecycle.

Nothing ever removed one. Session ids are minted per tile and never reused, so a closed
tile's profile stayed on disk for the life of the install: logged-in cookies for whatever
had been browsed in that pane, unreachable through the app (no tile owns that id any
more), invisible in it, and growing by one directory per closed tab. `clearStorageData`
appears in this repo only on the account-web partitions; the pane path never called it.

The renderer half leaked too: `webviewStore.reset(sessionId)`, commented *"Wipe state for
a session — e.g. on session removal"*, had **no callers at all**.

## The distinction that shaped the fix

Closing a session and deleting one are the same act here — there is no separate delete
path, and the tile is gone from the saved-tile file either way. So the wipe belongs on
close.

But it must NOT be wired into `sessionStore.removeSession`, which looks like the obvious
place: the Restart button, an in-tile account switch (`useSwitchAccount` → `restart`) and
`askConductor`'s re-use all call `removeSession` followed by `addSession` with **the same
id**. Wiping there would sign the user out of every site in the pane on every restart —
a new bug wearing the fix's clothes.

The wipe therefore hangs off the deliberate-close funnels: `requestCloseSession`,
`endRemoteAndClose`, `leaveRunningAndClose`, the six sidebar bulk-close loops, and the
launch-gate cancel. A unit test drives `removeSession` + `addSession` directly and
asserts nothing is wiped, so pointing the call at the store action turns it red.

## Shape

- `forgetWebviewProfile(sessionId)` in `webview-manager.ts` — same path-safety gate as
  `openWebview` (the id names an on-disk partition), destroys the live view FIRST so the
  wipe cannot race a WebContents still writing to the jar, then `clearStorageData()` and
  `clearCache()`. Clearing storage without the cache would leave page content behind.
- Both calls are timeout-wrapped at 5 s and the whole thing is best-effort: the
  account-web sign-out already learned that a `clearStorageData()` which never settles
  leaves the caller stuck forever, and a tab close must never be blocked by a profile
  that will not clear.
- New channel `webview:forget`, distinct from `webview:close` (which only destroys the
  view — a hidden tab, a restart and an account switch all use that and keep their
  cookies).

## Verification

Mutation-tested both halves: the path-safety gate forced open (1 test red) and the
renderer wipe made a no-op (3 tests red), each restored byte-for-byte. Coverage includes
a wipe that rejects, one that never settles (fake timers, must give up rather than hang),
a sibling session's partition left untouched, and a session whose pane was never opened
this run — the profile from a previous run still has to go.

Full suite on the branch: 7088 passed, 15 skipped, 2 todo (663 files); typecheck clean.

## Scope: what ships, and what is deferred

**Ships:** `forgetWebviewProfile` on the deliberate-close funnels. That is exactly #371
item 2 — *"per-session `persist:webview-<id>` browser profiles cleared on session
delete"* — and it is safe because it acts on ONE id the user just closed. No inference.

**Deferred:** reclaiming profiles orphaned BEFORE this change. A startup sweep for those
was built and then removed, after three separate data-loss findings in review:

1. it deleted on a partial/empty live set (fixed by failing closed on the oracle);
2. the resources directory could be repointed, so one root's session list judged another
   root's partitions (a marker was added);
3. the marker was re-recorded on mismatch, which only deferred the wipe one launch (the
   marker was made write-once) — and then the MIRROR direction was still open: running
   under the original root A after browsing under B deletes B's jars, because they are
   absent from A's session list.

The pattern is the point. A sweep decides "orphan" by ABSENCE from one root's session
list, and absence is not evidence when the list and the partitions can come from
different roots. Each fix closed the reported case and left an adjacent one, because the
inference itself is unsound — not because the guards were sloppy.

Making it safe needs **per-partition provenance**: each `webview-<id>` directory
recording which config root minted it, so orphanhood is judged against the root that
owns it rather than whichever one happens to be configured now. That is a real change to
how partitions are created, and it belongs in its own issue rather than bolted onto this
one. Filed as #415.

Until then a pre-existing orphaned profile stays on disk. That is a known, bounded leak
of the user's own data on their own machine — strictly better than a mechanism that has
signed people out of every browser pane three different ways.
