## 2026-07-22 -- CCC merges inherited hooks into per-session --settings (#137)

Decision recorded in architecture/decisions/2026-07-22-adr-005-merge-inherited-hooks.md.

Bug: CCC-launched sessions didn't run hooks a plain `claude` would in the same
folder. `injectHooks` set `settings.hooks = buildHooksBlock(...)` (CCC HTTP hooks
ONLY), and Claude treats a `--settings` `hooks` key as an OVERRIDE (not a
concatenating array — confirmed via docs + the user's empirical carp-hook case).
So project `.claude/settings.json` hooks (e.g. carp-hook.ps1) were shadowed.

- `session-hooks-writer.ts`: added `resolveInheritedHooks(cwd, homeDir)` — reads
  + concatenates hooks from user (~/.claude/settings.json), project
  (<root>/.claude/settings.json), and project-local (settings.local.json). Project
  root found by walking up from cwd to the nearest `.claude`, bounded by the home
  dir (so ~/.claude is only the user source, and the walk never escapes home).
  `injectHooks` now writes `concat(inherited, cccHooks)` with byte-identical
  dedupe. `injectHooks` gained a `cwd` arg (pty-manager passes `claudeCwd`).
- `homeDir` param is a test seam (default os.homedir()); os.homedir() isn't
  env-overridable on macOS, and — noted during testing — in the sandboxed agent
  env os.homedir() is a profile dir while os.tmpdir() is not under it, which is
  why the walk must be bounded by the passed homeDir, not the real home.
- Scope: LOCAL sessions only. SSH (ssh-shim.ts) resolves against a remote FS —
  separate follow-up. Enterprise "managed" settings outrank --settings anyway.
- Tests: tests/unit/hooks/session-hooks-writer.test.ts — merge of project+CCC,
  user+project+local ordering, nested-cwd walk-up, dedupe, fail-safe empty. 13/13;
  broader hooks + per-session suites 90/90; node typecheck clean.
