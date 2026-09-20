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

### Still owed before merge

`src/main/ssh-tmux.ts` is in the SSH statusline blast radius: `npm run
test:live:ssh` one combo at a time, matrix reported in the PR. Adversarial
review (PTY argv construction). Desktop test on an SSH Persistent session.
