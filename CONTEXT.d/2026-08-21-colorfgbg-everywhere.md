# 2026-08-21 — Light mode reaches SSH and Codex sessions (COLORFGBG everywhere)

Backlog item 34: "`COLORFGBG` is only set on the local Claude path. SSH and
Codex sessions never get it."

## What was wrong

`buildClaudeLocalSpawn` stamped `COLORFGBG` (`0;15` light / `15;0` dark) into
the spawned shell's env so Claude's startup theme detection matched CCC. That
was the ONLY place. A Codex spawn built its own env without it; an SSH session
runs `ssh.exe` locally, whose env never reaches the remote, and the remote
launch line carried every other CCC env flag (`CLAUDE_CODE_DISABLE_MOUSE_CLICKS=1`
…) but not this one. A light-mode SSH or Codex session came up dark.

## What changed

- **One definition**: `src/main/providers/host-color-scheme.ts` —
  `resolveHostColorScheme` (moved, re-exported from the Claude provider so
  callers and tests are unchanged), `colorFgBgValue(scheme)`, and
  `colorFgBgEnvToken(scheme, 'posix' | 'windows-cmd')`.
- **Codex**: `buildCodexSpawn` stamps `env.COLORFGBG` when `hostColorScheme` is
  given; pty-manager's Codex branch now resolves and passes it exactly as the
  local Claude branch does.
- **SSH**: pty-manager's SSH branch appends the token to `claudeEnvVars`, the
  list that becomes the `X=Y … claude` prefix on POSIX and `set "X=Y"&&` on a
  Windows remote. The value carries a `;` — so the POSIX token is
  single-quoted (`COLORFGBG='0;15'`), the Windows token bare (the `set "…"`
  wrapper already covers it). The tmux wrap single-quotes the whole inner
  command and escapes embedded quotes, so the token arrives as
  `COLORFGBG='\''0;15'\''` and the remote sh unwraps it.

## Verification

Typecheck clean. `tests/unit/providers/host-color-scheme.test.ts` (values, both
token forms, the Windows builder, the tmux escape), Codex spawn cases
(light/dark/absent + "same encoding as Claude"), and the SSH pty-manager drive
now asserts the token on the bare line and the escaped token inside the tmux
wrap. One existing SSH test used "no single quote anywhere" as its proxy for
"not tmux-wrapped"; that proxy is no longer true of a bare line and was
tightened to the wrap's actual marks (a leading quote / the `'\''` escape).
Mutation pass in `mutate3.py`.

## Not changed

A theme flip never reaches a RUNNING session (book item 35) — Claude reads
this once at startup; the owner took 35 off the list.
