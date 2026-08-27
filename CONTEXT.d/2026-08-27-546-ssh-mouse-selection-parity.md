## 2026-08-27 -- #546: SSH mouse-selection parity with local (CLAUDE_CODE_DISABLE_MOUSE)

Text selection was dead in SSH (tmux-wrapped) Claude sessions -- dragging
produced no highlight -- while local desktop sessions selected normally.

Root cause: mouse ownership is decided by `CLAUDE_CODE_DISABLE_MOUSE` +
`CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN`. The local spawn sets both when
`classicTerminalCopyPaste` is on (default) so xterm owns the mouse
(`src/main/providers/claude/spawn.ts`). The SSH launch builds its own env prefix
(`claudeEnvVars` in `src/main/pty-manager.ts`) and never carried those two vars,
nor read `classicTerminalCopyPaste` -- so remote Claude kept SGR mouse tracking
on, xterm forwarded drags to Claude, and selection never happened.

Fix: read `classicTerminalCopyPaste` in the SSH spawn config and, when not
`false`, prepend `CLAUDE_CODE_DISABLE_MOUSE=1` +
`CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1` to `claudeEnvVars`, mirroring
`buildClaudeLocalSpawn`. Values are compile-time constants (same shape as the
existing `CLAUDE_CODE_DISABLE_MOUSE_CLICKS=1` sibling) -- no new remote-input or
injection surface; they ride inside the tmux single-quote wrap unchanged.

The tmux wrapper (`ssh-tmux.ts`) does not set `mouse on` itself, but a remote
user's own `~/.tmux.conf` with `set -g mouse on` makes tmux grab the drag before
xterm sees it -- defeating CLAUDE_CODE_DISABLE_MOUSE. So `buildTmuxLaunchCommand`
now also forces `set-option -t ccc-<sid> mouse off 2>/dev/null` for CCC's own
session (session-scoped -- overrides the user's global for OUR session only,
never touches their other sessions), on both the fresh-create pane and the
reattach branch, using only the fixed launch token + safeSid target (the #242
sink posture is unchanged). Errors are swallowed so the launch always falls
through to claude (fail-open toward running). Old tmux (<2.1, no `mouse` option)
no-ops harmlessly.

Follow-up (own ticket -- touches #242 attach/has-session semantics): tighten
every `-t ccc-<sid>` in the wrapper to the exact-match sigil `-t =ccc-<sid>` so a
lost-race set-option/attach can't prefix-match a user's own `ccc-<sid>-*`
session.

Tests: `tests/unit/pty-manager-ssh-tmux.test.ts` adds the default-on assertion;
`tests/unit/ssh-mouse-parity.test.ts` (new) covers both toggle states by
steering `readConfig('settings')` via vi.hoisted. `classic-mouse-env.test.ts`
continues to lock the local side.
