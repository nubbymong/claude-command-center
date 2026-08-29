## 2026-08-29 -- #25: 2nd concurrent SSH session drops to a bare shell (trust-prompt race)

Reported: opening a 2nd session to the same host while the first runs — the 2nd
connects and gets a terminal, but claude/tmux never launches (bare shell).

Root cause (live-confirmed on p-aai-se01): the remote folder is UNtrusted
(`~/.claude.json` projects[<path>].hasTrustDialogAccepted=false), so EVERY claude
launch shows the first-run "trust this folder?" prompt (default "No, exit"). Two
concurrent sessions to the same untrusted folder both show the prompt, and the
concurrent claude/config/tmux activity disrupts one session's prompt (its
selection resets to "No, exit" and claude exits) → bare shell. Pre-trusting the
folder made 6/6 concurrent runs succeed; untrusted, ~3/6 dropped the first-spawned
session. Distinct from #24 (per-session `-R` port) — the ports were already
distinct here.

Fix (both, per owner decision):
1. **Pre-trust the configured folder** (`ssh-shim.ts` generateRemoteSetupScript):
   during setup, set `projects[<resolved remotePath>].hasTrustDialogAccepted=true`
   in `~/.claude.json` (both the resolved and realpath keys, since claude keys by
   cwd realpath), written BEFORE claude launches, idempotent, fully fail-open. The
   user explicitly configured this host+path, so trusting exactly it is intent.
   remotePath threaded generateRemoteSetupScript ← getRemoteSetupCommand.
2. **Fix the false-green latch** (`ui-detection.ts` + `pty-manager.ts`): the SSH
   idle-fallback latched `claude-running` even when claude had exited to a bare
   shell. New `looksLikeShellPromptTail` (conservative: last ANSI-stripped line
   ends in `$`/`#` and carries NO claude glyph `❯`/box-drawing) gates the
   fallback — on a bare shell it sets state `failed` ("claude exited to shell")
   instead of a false `claude-running`.

Validation: after the fix, from a COLD untrusted state, 5/5 concurrent runs →
both sessions reach a running claude, zero bare-shells. Unit tests:
ui-detection.test.ts (looksLikeShellPromptTail), ssh-shim-mcp-port.test.ts
(pre-trust bake). Live regression harness: tests/live/ssh-multisession-repro.live.ts
(asserts the PANE, not the false-green state).

Note: pre-trust auto-accepts claude's trust gate for the CCC-configured folder
only. Windows-remote setup (prototype) not wired for pre-trust — Linux is the
real path.
