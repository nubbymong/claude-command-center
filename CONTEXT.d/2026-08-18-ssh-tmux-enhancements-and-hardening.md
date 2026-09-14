## 2026-08-18 -- SSH tmux persistence: the enhancement batch, and the five majors the follow-up pass found in the substrate (#295)

Two things landed together here. The first is the agreed enhancement backlog on top of #295's
five-tier tmux ladder -- a "Detachable" config toggle (default on, and it never silently installs
tmux), Windows client support, a true End-vs-Leave-running close path, the reconnect cascade
(no host = fail intact, live remote = reattach, gone = resume or fresh), the fix for the silent
blank chat on `--continue`, resume-outcome messaging, a persistence pill, and the remote account
surfaced in the session header. That batch was built and real-host tested before this branch
existed: x86_64 Linux, an aarch64 Pi, Hyper-V (as both remote and client) and macOS (both), which
is also where its one bug was found and fixed -- the close path missed a Homebrew tmux on macOS
because a non-login shell does not carry Homebrew's PATH.

The second is the remediation of the pre-merge adversarial pass on #295 itself. That pass ran three
independent lenses against #295's head. The injection / command-sink / argv lens came back clean and
proven: a spoofed valid-nonce stage sentinel still produced the fixed `"$HOME"/.claude/bin/tmux`
token, `singleQuote()` survived quote/`$()`/backtick/20k-char/unicode payloads through a real shell
as exactly one argv element, and a write-only attacker could not latch completion. The round-3
wire-path removal holds. What the other two lenses found was a different failure class entirely --
five majors, none of them a boundary bypass, all of them "the feature makes claude fail to launch,
or lies about what it did":

- **The terminfo smoke test never tested terminfo.** Both the stage and push scripts smoke-test the
  binary they install with `tmux -V` followed by `tmux new-session -d`, and both doc comments claim
  that surfaces "missing or unsuitable terminal". It cannot: a DETACHED new-session never opens a
  client tty, so terminfo is never consulted, and the pinned static build carries no compiled-in
  fallback entries. On a remote with no terminfo database for `$TERM` -- the minimal container this
  tier exists to serve -- staging reports `ok`, the ATTACHED launch dies, and the tier-2 probe
  re-selects the same binary on every later connect. Nothing recovers: claude never started and
  Launch Claude is inert once `claudeSent` latched.
- **The tier-1 launch token broke under a shell alias.** Detection runs `command -v tmux` through
  `execSync` -- a non-interactive `sh -c`, where aliases do not exist -- but the launch token
  `"$(command -v tmux)"` is expanded by the INTERACTIVE login shell, where `command -v` prints an
  alias definition rather than a path. Quoted as a single word that is exit 127. Same class: a login
  shell that auto-attaches tmux makes `new-session -A` fail with "sessions should be nested with
  care", on every connect.
- **The remote fetch was unbounded against a 20 s host-side deadline.** No `--connect-timeout` or
  `--max-time` on curl, no `-T`/`-t` on wget, so a host whose egress is DROPped rather than rejected
  blocks for minutes. The host gives up at `STAGE_TIMEOUT_MS` and writes the claude launch into a
  tty whose foreground pipeline is still running with echo off -- the line is queued invisibly, and
  a user's Ctrl-C flushes it, leaving an echo-less shell and no claude. Because the script never
  printed `fail=download`, tier 4 -- the tier that exists precisely for a host with no egress --
  was never attempted.
- **The `destroyed` invariant was enforced on the writes but not on the emits.** Destroying a flow
  mid-tier and then feeding the stage sentinel drove a settings-patch write into the torn-down PTY
  and re-armed the idle fallback; destroying during the tier-4 download let the resolving promise
  emit onto `ssh:flowState:<sessionId>` -- the channel a RESPAWNED session with the same id is
  already subscribed to, so a dead flow could paint the new session's overlay and falsely latch
  "reached claude-running" on it (which then adds `--continue` with nothing to continue).
- **The host-side downloader's guards had no failing test.** Raising `TMUX_ARCHIVE_MAX_BYTES` to
  `Number.MAX_SAFE_INTEGER`, and separately deleting the https-only redirect refusal, both left the
  entire targeted suite green. This is the function whose unbounded body was a round-4 BLOCKER; it
  is module-private and every test stubs the archive resolver above it.

The fixes, in the same order. The smoke test is not taught to predict every way a remote can refuse
to run tmux -- instead a short watchdog watches the PTY after a WRAPPED launch and falls back to the
bare launch the moment the remote says it failed (`open terminal failed`, `sessions should be
nested`, `exec format error`, `command not found`, ...). That is safe precisely because a failed
wrap means nothing is running: the pane is back at a shell prompt. The window closes the instant
claude latches, so it can never fire against claude's own output. It also covers the wrong-arch and
truncated-binary cases the smoke test would have to enumerate. `ON_PATH_TMUX_BIN_EXPR` becomes
`command tmux` -- alias- and function-proof, still a compile-time literal with no wire-reported
operand, still resolved by the authenticated user's own shell -- and the probe reports `none` when
`$TMUX` is already set, so the user's own outer tmux is left to do the persisting. The fetch is
bounded at 5 s connect / 15 s total, with the wget leg written twice because GNU wget needs `-t 1`
to stay inside the budget while busybox wget (Alpine, OpenWrt -- exactly these hosts) has no `-t` at
all and would exit on a usage error. `destroyed` now bails at the top of `setFlowState`,
`armIdleFallback` and `writeClaudeCmd`, and in the onData handler immediately after the renderer
data forward, so terminal bytes still reach xterm while every latch, parse and write below stops.
The downloader is exported for tests. The tier-2 probe now actually EXECUTES its candidate (`-V`,
bounded) instead of trusting `access(X_OK)`, which was satisfied by a zero-byte file, a half-written
download, a wrong-arch binary and even a directory named `tmux`.

Two things worth keeping from how this went. The first: every one of these majors lived in a code
path whose doc comment asserted the opposite, and each doc comment was written in good faith after a
previous adversarial round closed a real bug at the same spot. A comment describing a guarantee is
not evidence the guarantee holds, and the more rounds a file has survived the more confidently wrong
its comments can be. The second: the tests for the tier-1 token compared the generated command
against the imported constant, so changing the constant changed both sides and every test stayed
green -- a self-referential assertion is indistinguishable from no assertion. The new tests pin the
literal text and were each mutation-proven by breaking the source and watching them fail.

Gate: typecheck clean across the three projects, full suite 5744 passing. The watchdog's live
behaviour against a genuinely terminfo-less remote is unit-simulated, not host-confirmed -- that
joins the standing acceptance check the ladder has carried since #242.
