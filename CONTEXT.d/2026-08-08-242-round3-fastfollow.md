## 2026-08-08 -- #242 fast-follow round 3: split-sentinel loss, unnonced latch, wire-path removal

This fragment SUPERSEDES a stale claim in
`CONTEXT.d/2026-08-08-242-ssh-tmux-persistence.md`: that entry says tier 1/2
"keeps `isPinnedTmuxPath` as a validate-then-trust gate." As of this round
that function does not exist. Tier 1/2 now pick the launch token from a
fixed, host-side literal table (`ON_PATH_TMUX_BIN_EXPR` / `STAGED_TMUX_BIN_EXPR`
in `ssh-tmux.ts`), keyed only by the CLASS (`path|home|none`) the setup
sentinel reports -- never by a path read off the wire. Per CARP, the earlier
fragment is not edited; this entry is the correction of record.

Five findings closed this round, all in `pty-manager.ts` / `ssh-tmux.ts` /
`ssh-shim.ts`:

- **I1 (the one that mattered): a sentinel split across two PTY chunks
  silently lost tmux persistence.** The `setup ok` completion latch used to
  fire off a bare substring check against the CURRENT chunk alone; a real SSH
  link routinely segments that line, so chunk 2 (carrying the resolved tmux
  class) was never re-parsed once the latch had already fired on chunk 1.
  Fails closed (bare launch, no wedge) but silently disabled the whole
  feature on any link that segments the line. Fixed by mirroring the existing
  `sshOscBuffers`/`extractSshOscSentinels` pattern: a per-session
  `bufferSetupLine` accumulates the partial line, capped at 4096 bytes
  (`MAX_SETUP_LINE_BUFFER`) so a remote that never emits a newline can't grow
  it unbounded, cleared in `cleanupSessionResources` alongside the other
  per-session maps. This fix has TWO call sites in `launchClaude`'s data
  handler -- the host setup-ok latch (~line 1914) and the container/postCommand
  setup-ok latch (~line 1935), which reruns the identical script with the
  identical nonce and sentinel shape. Both are now covered: the host branch by
  the pre-existing 'sentinel split across PTY chunks' describe block, the
  container branch by a new test added this round
  (`tests/unit/pty-manager-ssh-tmux.test.ts`, 'container-flow sentinel split
  across PTY chunks') that drives the real container scaffolding
  (spawnPty with postCommand -> inner-shell prompt -> launchClaude ->
  writeContainerSetupCmd) and feeds the sentinel split mid-value across two
  chunks. Mutation-proven: reverting the container call site's `combined =
  bufferSetupLine(sessionId, data)` back to `combined = data` fails the new
  test (claude write assertion: `expected undefined to be defined`) while
  leaving the rest of the 4068-test suite green -- exactly the blind spot the
  round-2 review flagged.
- **I2: the setupDone latch was unnonced.** A write-only attacker (no tty
  read access) could feed the literal string "setup ok" and latch completion
  early with no usable tmux class ever recorded -- silently losing
  persistence AND forcing an unwanted tier-3 staging attempt (network fetch +
  write into `~/.claude/bin`) on a host that already had tmux. Fixed by
  gating the completion latch on the SAME nonce-bearing match
  `parseTmuxSentinel` already uses for the class read, instead of a separate
  bare substring check.
- **I3 (architectural): tier 1/2 no longer send or trust a wire path at
  all.** `generateRemoteSetupScript` now emits a CLASS (`tmux=path|home|none`),
  never a path. The launch token for tier 1 (`$(command -v tmux)`) and tier 2
  (the same `STAGED_TMUX_BIN_EXPR` tier 3/4 already used) is picked from a
  fixed, host-side literal table keyed only by that class -- both resolve in
  the authenticated user's own remote shell, so nothing off the wire reaches
  the launch-command sink. This makes the previous defense-in-depth-only path
  validation obsolete, so it was deleted rather than left as dead code:
  `isPinnedTmuxPath`, `assertPinnedTmuxPath` and `assertSafeTmuxBin` -- all
  three module-private in `ssh-tmux.ts` -- along with their unit tests. Only
  historical doc-comments referencing the old names remain, explaining why
  they're gone.

  (An earlier commit body on this branch placed `assertSafeTmuxBin` in
  `ssh-tmux-stage.ts`. It was in `ssh-tmux.ts` with the other two. That commit
  no longer exists -- the branch was squashed before the rebase below -- so this
  line survives only to stop the same misattribution being re-derived from the
  doc-comments that still name the deleted helpers.)
- **I1 was only HALF closed on the first attempt, and the review caught it.**
  The buffer was applied to the two setup-ok latches only, leaving the tier-3/4
  stage sentinel and the tier-4 arch probe still parsing the raw chunk -- so the
  bug stayed live on exactly the tiers a tmux-less remote depends on, which is
  what a desktop test against a real remote exercises. Proven by driving the
  real flow: a split `ok path=` never resolves and the flow stalls to the 20s
  STAGE_TIMEOUT before silently falling back to a bare launch; a split arch
  probe leaves detectedArch null, making tier 4 unreachable on any segmenting
  link. All four sentinel sites now parse accumulated text.

  Each sentinel kind gets its OWN buffer, because the arch probe and the stage
  result are emitted by the same remote fragment and can interleave -- sharing
  one buffer would let whichever resolved first discard the other's partial
  line. Tier 4 deliberately reuses the 'stage' buffer, since it only runs after
  tier 3 resolved and cleared it and both emit the identical sentinel shape.

  The lesson worth keeping: every existing test fed its sentinel as ONE chunk,
  so the whole class was invisible to a green suite. A parser that reads from a
  stream needs at least one test that splits its input at a hostile boundary,
  or it is only ever tested against the happy framing.
- **I4: `buildTmuxBinPatchCommand`'s `CCC_TMUX_BIN` splice had no charset
  guard**, unlike its sibling in `generateRemoteSetupScript` which re-checks
  the identical class of value (`os.homedir()`-derived, not wire-controlled,
  but still a potential space/shell-metacharacter source) against
  `/^[A-Za-z0-9_./-]+$/` right before the same `statusLine.command` sink.
  Fixed by applying the same guard remotely and skipping the whole patch
  (leaving the statusline unset) rather than splicing a broken value in.
- **I5: the tier-3 stage sentinel's path/reason captures were uncapped**
  (`\S+`). I3 removed the tier-1/2 wire capture entirely, so this only
  applied to the still-present tier-3 stage sentinel capture in
  `parseTmuxStageSentinel` -- now bounded to `\S{1,4096}`
  (`MAX_TMUX_STAGE_CAPTURE_LEN`), charset-safe so not injection, but a
  multi-kilobyte value was resource/log noise regardless.

Full suite green (448 files / 4068 tests) and typecheck clean after this
round. Not desktop-tested against a real remote yet -- I1 was blocking that
test (a real SSH link segmenting the sentinel line would have made the test
report "tmux persistence is broken" when the ladder was fine, or silently
never engage tmux while appearing to pass); that blocker is now closed.
