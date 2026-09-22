## 2026-09-20 -- aicc_planning #85: wheel scrollback for SSH/tmux sessions

Governing ticket: nubbymong/aicc_planning#85. Lands on `beta`, folds into the
pending 2.1.1-beta.1 release.

### The bug

In an SSH Persistent session the mouse wheel did not scroll -- it typed arrow
keys at the remote claude. Chain, confirmed against `beta`:

- CCC runs claude inside `tmux new-session` (#242), and a tmux CLIENT always
  puts the outer terminal into the ALTERNATE screen.
- xterm.js's alternate buffer has no scrollback, and `@xterm/xterm` 6.0.0's
  wheel listener answers that case by emitting `ESC [ A` / `ESC [ B` via
  `triggerDataEvent` (`!this.buffer.hasScrollback` branch, confirmed in the
  shipped bundle).
- `ssh-tmux.ts` forces `mouse off` on CCC's tmux session (#546), so tmux never
  receives the wheel either. Neither side scrolls; the remote app gets arrows.

Not just a missing feature: a full-screen TUI reads those arrows as input.

### Decision -- option 1 from the ticket (intercept locally, drive tmux)

`mouse on` would restore scrolling and regress #546 (tmux captures the drag and
native text selection dies). So `mouse off` stays and the wheel is claimed in
the renderer via xterm's `attachCustomWheelEventHandler`, which is consulted
BEFORE the arrow-key fallback. Each notch writes a private key to the PTY that
tmux consumes as a copy-mode scroll; claude never sees it.

Keys (ctrl+alt+F10/F11/F12, the standard xterm modifier form): leave / down /
up. Bound server-side by `buildTmuxWheelBindings` (src/main/ssh-tmux.ts);
the bytes are shared with the renderer via `src/shared/tmux-wheel.ts`.

Out-of-band `ssh exec` of `tmux send-keys` was rejected: an SSH spawn per wheel
notch, with password/sudo prompt handling, for a scroll.

### Four things only a live tmux would have told us (tmux 3.4, this session)

1. A `;` reaching tmux unescaped does not bind -- it ENDS the bind-key command
   and runs the rest immediately (`not in a mode`). So every binding is a
   SINGLE tmux command, and the renderer sends the up-key twice on the first
   notch (root binding enters copy-mode, it does not also scroll).
2. Hoisting the bindings ahead of the has-session conditional silently does
   nothing: a tmux server with no sessions exits with its last client, taking
   the bindings with it. They have to run where a session exists -- three
   copies on the launch line, which is why they ride one invocation with tmux's
   short aliases (the line is read in canonical mode, ~4 KiB ceiling).
3. `set-option -w -t =ccc-<sid>` fails with "no such window" -- a session name
   is not a window target, and the error is swallowed, so `mode-keys emacs`
   silently did not land on the attach branch and the wheel stopped scrolling
   there. Fixed to `-t =ccc-<sid>:` (same `=`-exact session, its current
   window), and both copy-mode tables are bound anyway so the fix no longer
   depends on that option landing at all.
4. tmux resolves at most TWO escape sequences out of one read at the default
   `escape-time` of 500: six up-keys in one write scrolled 6 lines instead of
   18, the same six spaced 20ms apart scrolled all 18. The renderer therefore
   paces keys one per 25ms. Lowering the remote's `escape-time` would fix it in
   one command and was not done -- it is a server option, i.e. reaching into
   the user's other tmux sessions to change a setting they tuned.

### Verification

End-to-end against tmux 3.4, driving the EXACT generated launch command through
a real pty client:

- fresh-create branch: first notch enters copy-mode at scroll_position 3, two
  more -> 9, one down -> 6, a keystroke leaves copy-mode and reaches the shell
  with no escape bytes in the pane.
- attach branch: with every binding unbound and `mode-keys` forced to `vi`
  first, the attach re-established all of them, corrected mode-keys, and
  scrolled.
- both copy-mode tables (emacs and vi) scroll identically, key by key.
- the root-table down/leave keys are inert outside copy-mode.

Unit: `tests/unit/tmux-wheel-scroll.test.ts` (renderer state machine, pacer),
`tests/unit/ssh-tmux.test.ts` (binding shape, both branches, target exactness).

### Adversarial review (2026-09-20) -- FINDINGS, then fixed

Four independent attackers (injection/evasion, blast-radius/fail-open,
design+coverage+mutation, platform/tmux-version parity), all exercising real
tmux 3.4. The #242 injection posture held everywhere -- safeSid, the `\;`
quoting through both shell levels, and the `=`-exact targeting all survived
direct attack, and one attacker showed the `=` is load-bearing (dropping it
made `-t ccc-a:` land on `ccc-ab`). What did not hold:

1. BLOCKER -- a remote `~/.tmux.conf` with `set -g key-table <custom>` means
   tmux never consults the `root` table, so every wheel key was forwarded to
   the pane as raw escape bytes: the original bug, on the hosts whose owner
   customised tmux most. Fixed by forcing `key-table root` on CCC's own
   session (session-scoped). Re-verified under that exact hostile config.
2. BLOCKER -- copy-mode is PANE state and survives a dropped connection and a
   relaunch, while the renderer's belief starts false in a new process. A user
   who scrolled up, then dropped the link, reattached into a pane that ate
   every keystroke with the status bar off and nothing on screen to explain it.
   #85 is what made this the normal case (the wheel opens copy-mode where it
   used to take a deliberate `C-b [`). Fixed by `send-keys -X cancel` on the
   attach branch, before the attach. Re-verified.
3. MAJOR -- ctrl+wheel was handed BACK to xterm, straight into the arrow-key
   fallback. A trackpad pinch reports as ctrl+wheel on every platform, so a
   pinch typed Up/Down at claude. Now consumed, scrolling nothing.
4. MAJOR -- the launch line. The bindings ride it three times; with a full flag
   set plus `--extra-args` at its 512-char maximum it measured 4473 bytes, past
   the 4096 canonical-mode truncation. Truncation lands mid-line and hangs the
   remote shell at a `> ` prompt, which neither tmux-launch-failure regex in
   pty-manager matches -- so nothing recovers it. Fixed with a budget
   (TMUX_LAUNCH_LINE_BUDGET): over it, the bindings are dropped and the session
   launches with pre-#85 wheel behaviour instead of not launching.
5. MAJOR -- a `\;` list runs until the FIRST failure and keeps what already
   ran, so an old tmux rejecting one command left a partial binding set: either
   nothing bound (keys leak to the pane) or root-bound-with-no-exit (stranded
   in copy-mode). Fixed by ordering: every key is silenced in the root table
   first, each copy-mode table gets its leave key before its scroll keys, and
   the one command that can OPEN copy-mode runs last. Every prefix is now safe.
6. MAJOR -- the wheel stayed armed over a dead PTY (post-mortem scrollback
   became unscrollable) and through a Restart (writing tmux keys at a login
   shell or password prompt). Fixed via `ptyExited` in the arming condition and
   clearing `sshTmuxPersistent` in useRestartSession.
7. MAJOR -- copy-mode SWALLOWS input, and every programmatic write bypassed the
   leave-key: command buttons, the status strip's slash commands, `/login`,
   image paste, and -- worst -- the watchdog's rate-limit retry, which would
   have left the session never resuming. Renderer sinks now go through
   `writeSessionInput`; main's two line-submitting sinks through
   `writeSubmittedLine`, which prepends the leave key for a tmux-wrapped
   session (inert outside copy-mode, by the root no-op binding).
8. MAJOR -- the remote app may itself want the wheel (CC's clickable questions
   turn SGR reporting on). Now declined when `isMouseTracking`.
9. MINOR -- `copy-mode -e`'s auto-exit made the first notch of an up-down-up
   gesture dead. The renderer now counts lines up and down and drops the belief
   at zero, which is sound: it can only over-estimate, never under.
10. MINOR -- the byte<->keyname contract was asserted tautologically (both test
    files interpolate the constants), so four constant mutants survived the
    whole suite. `tests/unit/tmux-wheel-keys.test.ts` pins the encoding itself.

Accepted, not fixed: `bind-key` is SERVER-scoped, so the three bindings outlive
CCC's session for the life of the remote tmux server and are visible to the
user's other sessions there. tmux has no session-scoped binding table (the
`key-table` option REPLACES root rather than adding to it), the keys are
ctrl+alt+F10/F11/F12, and nothing else binds them.

Rejected fix: lowering the remote's `escape-time`. It is a server option --
reaching into the user's other tmux sessions to change a setting they tuned,
for our convenience. The renderer paces instead.

Rejected refactor: deduplicating the twice-emitted fresh-create argument via a
shell variable. It would have bought ~1.3 KiB of headroom, but it rewrites the
shape of a #242-sensitive sink and churned a dozen existing assertions about
that shape. The budget guard covers the risk this change introduced, which is
the risk that was ours to fix.

### Still owed before merge

`src/main/ssh-tmux.ts` is in the SSH statusline blast radius: `npm run
test:live:ssh` one combo at a time, matrix reported in the PR. Adversarial
review (PTY argv construction). Desktop test on an SSH Persistent session.
