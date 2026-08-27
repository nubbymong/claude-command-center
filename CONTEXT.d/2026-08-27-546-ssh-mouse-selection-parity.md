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

The tmux wrapper (`ssh-tmux.ts`) does not set `mouse on`, so tmux is not the
cause. If a remote user's own `~/.tmux.conf` has `set -g mouse on`, tmux grabs
the drag regardless -- remedy there is Shift+drag or turning tmux mouse off, not
a CCC change.

Tests: `tests/unit/pty-manager-ssh-tmux.test.ts` adds the default-on assertion;
`tests/unit/ssh-mouse-parity.test.ts` (new) covers both toggle states by
steering `readConfig('settings')` via vi.hoisted. `classic-mouse-env.test.ts`
continues to lock the local side.
