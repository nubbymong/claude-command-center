## 2026-07-28 -- Per-config Claude permission mode + extra CLI args (#74)

Decision recorded in architecture/decisions/2026-07-28-adr-006-claude-launch-parameters.md.

Saved Configs could pin a model, agents and cwd, but a Claude config had no way
to fix its permission posture — every Claude session launched under the CLI's
default, so you could not keep one config that always runs `bypassPermissions`
(trusted scratch workspace) next to one that runs `dontAsk`. Asymmetric with
Codex, which already had a per-config `permissionsPreset`. `PERMISSION_MODES`
existed in `src/renderer/lib/claude-cli-options.ts` but nothing consumed it.

- `ClaudeOptions` (src/shared/types.ts) gained `permissionMode?: string` and
  `extraArgs?: string`, carried through sessionStore -> useLaunchConfig ->
  App.tsx -> TerminalView -> preload -> pty-handlers, same path as
  `model`/`effortLevel`.
- Flag emission at BOTH launch sites: local (pty-manager.ts, the `extraFlags`
  block) and SSH (the `claudeFlags` array). `default`/`''` emit no flag, so the
  CLI keeps its own default and clean configs stay clean (`undefined` persisted,
  matching the loggingEnabled/enableCodexReview pattern).
- SessionDialog: wired the existing `PERMISSION_MODES` dropdown plus a
  collapsed `<details>` "Advanced: extra CLI args" free-text field.
- Both values are shell-interpolated UNQUOTED at spawn, so the IPC Zod schema is
  the injection boundary (same posture as the existing `resume.uuid` guard):
  `permissionMode` is a `z.enum` of the CLI's own `--permission-mode` choices;
  `extraArgs` is charset-guarded and a refine rejects CCC-managed flags. Rejection
  throws `Invalid parameters: ...` back over IPC, so a bad value fails the spawn
  loudly rather than reaching a shell.
- Known limitation, stated in the field hint: because metacharacters are blocked,
  `extraArgs` cannot carry quoted paths containing spaces. The dropdown covers the
  safe common case; the text box is best-effort for simple flags.
- Flag/value set confirmed against the installed CLI's `claude --help`, not
  guessed. The Zod enum also accepts `manual` (a CLI mode the dropdown does not
  offer) so the schema is a superset of the UI.
- Verification on the rebase: `npm run typecheck` clean; `npx vitest run`
  3091 passed / 4 skipped / 0 failed, incl. tests/unit/pty-spawn-permission-args.test.ts
  (6 cases: enum acceptance, injection rejection, managed-flag rejection).
- Landing note: PR #92 was opened 2026-07-15, before the protect-beta ruleset and
  before CARP adoption (#126). It sat blocked because the test matrix is
  label-gated on `ci-run` and the PR carried no labels, so the required
  `Test (windows-2025)` / `Test (macos-latest)` contexts never reported. Rebased
  onto beta (clean, after #133 and #138 touched the same spawn path) and labelled
  to land.
