# 2026-08-24 — "CCC" purged from user-facing text (owner rc.1 install pass)

Owner spotted "compatible with CCC." in the Sentinel popup. Every user-facing
"CCC" is gone: Sentinel panel, Accounts remove-confirm + tooltip, Codex
settings, logs index confirms, logging consent, SSH log empty-state, new
account prompt, session dialog extra-args hint, Conductor MCP page, logs wipe
modal, the pty extraArgs validation message, vision log lines, and all 36
mentions across historical changelog.ts entries (CHANGELOG.md regenerated, in
sync). "the app" mid-sentence, "AI Code Conductor" where it stands as a name;
"CCC Sentinel" was already plain "Sentinel".

Deliberately UNTOUCHED (not user-facing, or frozen): env vars / protocol ids
(CCC_SESSION_GUARD, CCC_CMD_SECRET_*, X-CCC-Hook-Token, CCC_FORCE_SPLASH),
dir/file names (.ccc-canvas, ccc-sessions, ccc launcher), code comments, and
the agent-facing Conductor MCP instruction text (canvas-plugin/canvas-mcp-tool
— mirrors the external skill; rename there is a separate, synced change if
wanted).
