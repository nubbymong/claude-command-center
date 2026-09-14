## 2026-08-08 -- Five-tier SSH tmux persistence; the loop's COMMIT GATING did not catch what its review did (#242)

Landed a five-tier ladder for keeping a remote `claude` session alive across SSH drops: tier
1/2 detect an existing tmux/`~/.claude/bin` and launch straight into it; tier 3 has the
remote curl/wget its own tmux binary when neither is found; tier 4 pushes a pre-downloaded,
sha256-verified archive down the live PTY as base64 when the remote has no egress for tier
3's curl; tier 5 carries `--continue` across a reconnect so a respawned session doesn't lose
context. `ssh-shim.ts`, `pty-manager.ts`, `ssh-tmux-stage.ts` and the matching unit tests are
the diff.

Not selling this as a clean five-for-five. Tiers 3 and 4 were each REJECTED three times by
review before this branch -- and still ended up committed anyway, not because they earned
acceptance on attempt four, but because an orchestration bug in the loop advanced the commit
step regardless of the review verdict. The gating that was supposed to block a commit on a
REJECTED verdict did not fire. That is the fact worth keeping: the adversarial review did its
job and caught real, dangerous defects; the mechanism meant to act on that verdict did not.

Three of the findings from that review were not stylistic:

- **Unbounded download wedged the session.** `downloadAndCacheTmuxArchive` (tier 4) had no
  timeout on the HTTPS request or its redirect hop, and no cap on the response body. A
  stalled connection or a hostile/misbehaving host serving an unbounded body left the flow
  with no way out -- `attemptTmuxPush`'s own doc comment had promised tier 4 would never be
  "a NEW way for the flow to get stuck with claude never launched," and this broke exactly
  that promise. Fixed with a 20s per-request timeout (both hops), a 45s download-phase
  ceiling armed the instant the push attempt starts, and an 8 MB cap checked on the wire in
  the `data` handler (`res.destroy()`, not `resume()`, so the socket actually stops).

- **An unterminated single quote swallowed the recovery write and the claude fallback.**
  When a tier-4 push aborts mid-transfer, the last bytes actually delivered can be an
  arbitrary mid-line slice of an `echo '<base64...` chunk -- the opening quote landed, the
  closing one did not, so the remote shell's line discipline is sitting inside a still-open
  string. Writing the recovery text (restore echo, drop the partial file) straight after that
  became literal content inside the open quote, and so did `writeClaudeCmd`'s `claude
  ...\r` a moment later: the session hangs at a `>` continuation prompt with echo still off,
  instead of falling through to the bare launch it was supposed to guarantee. Fixed by
  sending `\x03` (Ctrl-C) as its own write FIRST, so the remote discards the dangling partial
  line before the recovery command is ever typed.

- **A staging timer outlived teardown and wrote into a killed PTY.** `stagingTimeoutHandle`
  was the one timer on the ladder never cleared in `destroy()`. Unguarded, it fired after
  session teardown and drove a full claude-launch write into a PTY that `destroy()` had
  already torn down -- proved empirically by the reviewer's probe logging "WRITES AFTER
  DESTROY" from exactly this timer. `pushTimeoutHandle` and the new `downloadTimeoutHandle`
  had the identical unguarded shape. Fixed two ways: a `destroyed` flag flipped at the TOP of
  `destroy()` so any write callback still reachable bails before ever touching `ptyProcess`,
  and all three timer handles now cleared in `destroy()` alongside the two that already were.

Two of these three (the unterminated quote and the leaked staging timer) could kill the
Electron main process outright, not just wedge a session -- a write into a torn-down PTY or
an unhandled state after `destroy()` are exactly the shape that turns into an uncaught
exception on main, not merely a stuck remote shell.

Smaller findings closed in the same pass, for completeness: the tier-3 remote curl URL and
the tier-4 host-side download URL were built from independently-typed literals that could
silently drift apart (F6) -- now share one set of constants
(`tmuxStageAssetUrl`/`tmuxReleaseBaseUrl` in `ssh-tmux-stage.ts`); a doc comment on both
`ssh-shim.ts` and `ssh-tmux-stage.ts` claimed `stty -echo` hides the base64/setup-script
line's OWN echo, which is false (it's the first statement of that same line, so the tty has
already echoed the whole thing by the time it takes effect) -- corrected in place, with the
real protection (base64 opacity) stated instead (F7); and a sink-side charset guard now runs
on `TMUX_STAGE_TAG`/`TMUX_STAGE_SHA256`/`TMUX_STAGE_SENTINEL_PREFIX` before they're
interpolated into remote shell text or a `RegExp` constructor, in case a future edit widens
any of them to a configurable or remote-derived value (F8).

Gate: unit tests and typecheck run clean on this branch (`npx vitest run --no-cache`,
`npm run typecheck`). Not desktop-tested against a real remote exercising tier 3 or tier 4 --
that remains the acceptance check, same caveat as #241's ControlMaster fix.

ADR-009 adversarial review (round 5), run before this branch's tier-3/4 path handling
landed, found a BLOCKER: a remote able only to WRITE BYTES TO THE TTY -- no shell, no
filesystem access beyond what its own SSH session already has -- could spoof the "setup
ok"/stage-sentinel line CCC's PTY parser reads back. The gate on that sentinel's path field
was charset-only (`isSafeTmuxBin`) plus a suffix check (`isPinnedTmuxPath`, "ends with
/.claude/bin/tmux") -- satisfiable from an attacker-writable directory (`mkdir -p
/tmp/.claude/bin`), with no nonce and no provenance check tying the line back to this
session's actual spawn. A spoofed sentinel reporting that attacker-controlled path would
have had `buildTmuxLaunchCommand` wrap the claude launch around it: CCC executing a binary
of the remote SSH user's choosing, not the tool it thinks it staged.

Closed with path-pinning as the durable control: for a staged tier (3/4),
`buildTmuxLaunchCommand` no longer reads the wire-reported path at all -- it always embeds a
fixed, host-authored `"$HOME"/.claude/bin/tmux` literal (`STAGED_TMUX_BIN_EXPR`), expanded by
the remote shell itself, so there is no attacker-controllable operand in the sink for that
tier. Tier 1/2 (detecting a pre-existing tmux, which by definition can be anywhere) keeps
`isPinnedTmuxPath` as a validate-then-trust gate, with its doc comment corrected to stop
claiming the ends-with check proves the path is really under $HOME -- it doesn't; it only
keeps garbage out of logs. A per-session nonce (host-generated via `randomId()`, baked into
every setup/stage/push script, required immediately after the sentinel prefix on every
parse) is the second layer, documented plainly as defeated by a tty-READER, since the
nonce's own echo is not suppressed and can be copied verbatim. The BLOCKER's threat model is
a tty-WRITER, so the nonce narrows that window; the path-pin is what actually holds.

Two MAJORs closed in the same pass:

- F2: `sessionIdSchema` (pty-handlers.ts) had no charset guard, even though `sessionId`
  reaches `ssh-shim.ts`'s `statusLine.command` -- a string `sh -c`'d on every statusline
  refresh -- while the other fields on the same IPC surface (`effortLevel`, `model`) already
  had one. Fixed with `.regex(/^[A-Za-z0-9_-]+$/)`; real ids (`randomId()`'s 24
  lowercase-hex chars) already satisfy it, so the guard only ever rejects something a real
  id could never be.
- F3: `buildTmuxBinPatchCommand` (the follow-up write that patches `CCC_TMUX_BIN` into the
  already-written settings file after a stage/push `ok`) took a `tmuxBin` parameter sourced
  from that same remote-reported path -- so even after the launch-command sink stopped
  trusting it (F1a), this second call site would have baked the spoofed path into the
  settings file, reopening the identical hole one level down. Fixed the same way: the patch
  script computes the fixed path itself, remotely, via `os.homedir()`.

Gate on the round-5 fixes: unit tests and typecheck clean. Not desktop-tested against a real
remote exercising tier 3/4 with a hostile tty-writer present -- same caveat as above.

## 2026-08-13 -- rebased onto beta (2.1.0-beta.9); #241 was superseded upstream

The branch sat for five days while `beta` moved 26 commits. Two things had changed
underneath it.

**#241 was implemented upstream, independently, while this branch was out.** Commit
370c16d2 ("beta.9 quick wins") carries `fix(ssh): force ControlMaster/ControlPath off for
win32 ssh sessions (#241)` and cites the issue. The maintainer arrived at the same design
-- a new pure `src/main/ssh-args.ts`, win32-only `-o ControlMaster=no -o ControlPath=none`
-- so the three commits on this branch's `fix/241-...` base were dropped in the rebase
rather than replayed. Nothing was lost that upstream does not already have, because
nothing had been pushed.

What upstream's version does NOT carry is the hardening the #241 adversarial pass added on
top, and that is still a live gap on `beta`:

- `host` / `username` are still `z.string().min(1)` at the IPC boundary, with no charset
  gate, so an option-like username (`-oProxyCommand=...`) still reaches argv[0]. The
  exploit does not complete today only because consuming argv[0] leaves ssh with no
  destination -- an accident of the argv shape, not a control.
- `buildSshArgs` has no sink-side guard at all.
- `sessionIdSchema` is still `z.string().min(1).max(200)` with no charset regex.
- No test pins that pty-manager actually CALLS the builder, so a revert to an inline argv
  array would keep the suite green.

That work needs its own issue and its own branch off `beta`; it is deliberately NOT folded
into this one. #242 carries only the sessionId half (finding F2), because the tmux
statusline sink forced it.

**The rebase itself.** Nine reviewed commits were squashed to one first: replaying them
individually meant resolving `pty-manager.ts` nine times against 26 upstream commits, with
intermediate states that would not build. Six conflict hunks in three files, all
mechanical -- `ssh-args.ts` auto-merged cleanly, folding this branch's `ServerAlive*`
additions into upstream's `buildSshArgs` signature.

Two upstream changes had to be absorbed into this branch's tests rather than merged: the
per-session MCP token (`mcpSessionToken`, GHSA-q83v) now needs stubbing in the statusline
test's mock, and the remote settings/mcp writes gained `{mode:0o600,flag:'wx'}` exclusive
create (GHSA-phr3-g5qh-q4v5), which the shim tests assert on.

Gate after rebase: 4367 unit tests pass, typecheck clean, changelog in sync. Still never
desktop-tested against a real remote -- that remains the standing acceptance gate.

## 2026-08-17 -- rebased again onto beta.12; #265 now merged upstream too

Second rebase, beta having moved another 118 commits to 2.1.0-beta.12. The notable change:
**#265 -- the SSH-argv hardening this branch's own adversarial pass surfaced -- was implemented
upstream** (f8e0cc46, "harden the SSH argv boundary … (#265)"), the same pattern as #241. So for
the second time our filed issue landed via the maintainer while our branch was out.

That put upstream's #265 and this branch's #242-F2 on a collision course, and they had converged on
the *same* fix: `sessionIdSchema` gained an identical `/^[A-Za-z0-9_-]+$/` regex on both sides, and
`ssh-shim.ts`'s statusLine command switched to `safeSid` on both sides. Resolution kept upstream's
version of each (its comments are the canonical #265 reference) while preserving the one piece only
#242 has: the `CCC_TMUX_BIN=<tmuxPath>` bake-in in that same statusLine command (F3), which the
tmux statusline needs. Net: no #242 security work was lost, and the duplicate sessionId guard
collapsed to one.

Also absorbed two upstream hardening changes into #242's tests: the remote shim write gained
`{mode:0o755,flag:'wx'}` + an `rmSync` prefix (GHSA-phr3-g5qh-q4v5), so the runtime-harness's shim
extractor now matches that shape; and two upstream #265 tests asserted the pre-tmux `<sid> node`
adjacency in the statusLine command, updated to allow the `CCC_TMUX_BIN=` insertion between.

The worktree's junctioned node_modules was too stale for beta.12 (missing axe-core /
dom-accessibility-api, added by the Agent Canvas work), so it was replaced with a real per-worktree
`npm ci`. Gate after rebase: typecheck clean (3 tsconfigs), 5552 unit tests pass, changelog in sync.
Still never desktop-tested against a real remote -- that remains the standing acceptance gate.
