# 2026-08-21 — A session object outlives its process, and nothing said so

Second of the carried #308 ADR-009 findings. Diagnosed, then independently
attacked to refute it; the refutation failed on every link in the chain.

## The chain

1. You open Ask Conductor. It is a real session with `kind: 'ask'`.
2. The Claude process ends — `/exit`, Ctrl+D, a crash, the CLI returning after a
   `/login`. Main deletes the PTY, clears its `pendingWrites`, and sends
   `pty:exit`.
3. The renderer's only subscriber for that event wrote `[Process exited with
   code N]` into the terminal **and nothing else**. The session stayed in the
   list, `status` untouched, the spawn tracker still marking the id as spawned.
4. You ask another question — Feature Guide, or Discuss on a tip.
5. `findAskSession` matches on `kind === 'ask'` and returns the dead session.
   There is no liveness term anywhere in the function.
6. `pty.write(existing.id, …)` — which is `ipcRenderer.send`, so it is
   fire-and-forget and cannot report anything.
7. Main's `writePty` finds no live PTY and pushes the bytes into
   `pendingWrites`. Only a spawn drains that map, and `spawnPty` **clears it
   first** (`killPty` → `cleanupSessionResources`). Even an explicit Restart
   discards it, because `forceRemount` reuses the same session id.
8. The renderer got a truthy id back, so it cleared the input box and navigated
   you to a tab showing `[Process exited]`.

The question was not delayed. It was destroyed, and the UI reported success.

## The fix

`ptyExited` on `Session` — ephemeral, like `effortLive`/`fastMode`, and
deliberately not in `session-persistence`'s field allowlist. TerminalView's exit
handler sets it and calls `clearSpawned`, so a remount is allowed to respawn the
id. `forceRemount` clears it, because the whole point of a remount is that a new
PTY is about to exist.

`findAskSession` keeps its meaning — "is there an Ask tab", which is what stops a
second one being opened. The new `askSessionIsLive` answers the different
question the launch path was actually asking. When the session is dead,
`handOverTo` **revives** it: same id, bumped `createdAt` (which changes the
TerminalView key and forces the remount), `askPrompt` set so the question rides
the respawn as `CCC_ASK_PROMPT` — the same route a first launch uses, so
delivery goes through the path that is already tested rather than a second one.
The account gate is marked predetermined, matching what restart does, so a
revive does not re-pop the picker.

The dock's green dot now reads liveness rather than existence; it was promising
"go to the open session" for a tab showing nothing but `[Process exited]`.

## The half no behavioural test can reach

`askSessionIsLive` is only worth anything if something SETS `ptyExited`, and that
lives inside TerminalView — a component that builds an xterm terminal, a WebGL
addon and a ResizeObserver on mount, none of which exist in jsdom. Deleting those
two lines leaves every behavioural test green while the fix is inert in the
running app.

So `session-pty-exit-recorded.test.ts` reads the source: it brace-matches the
`pty.onExit` callback and asserts the body records `ptyExited` and clears the
spawn tracker. A weak form of test, and the right one here — it pins the exact
invariant the diagnosis showed was missing, and it goes red when either line is
removed. Both mutations were run.

## Verification

Full suite **6280 passed / 15 skipped**, typecheck clean.

| mutation | result |
| --- | --- |
| `askSessionIsLive` returns `!!session` (the original bug) | 3 red |
| exit handler no longer records `ptyExited` | 1 red |
| exit handler no longer calls `clearSpawned` | 1 red |

One note for whoever runs the suite next: a loaded run reported three skipped
FILES and 26 skipped tests where a quiet run reports two and fifteen. Same code,
same commit. Consistent with the shared-box behaviour recorded for the timeout
flake — check `Get-Process node` before believing an odd count.
