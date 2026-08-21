# 2026-08-21 — Secret values PowerShell 5.1 cannot carry are refused at the dialog

From the single ADR-009 pass over the beta.16 substrate. Reported MAJOR,
verified MINOR (the only "attacker" is the user pasting a string into their
own secret field; nothing crosses a boundary) — but a real correctness defect
on a path that promised otherwise.

## What was wrong

`shared/command-secret.ts` said a value referenced as `$env:X` "stays one
argument; PowerShell does not word-split `$env:X`". Measured on
`powershell.exe` 5.1.26100.9202 (the shell the app starts) against the REAL
builders: a value containing `"` flips the child's quote parity (the rest of
the line is swallowed into the token); a value ending in `\` escapes the
closing quote; a space-before-quote value injects extra native arguments; and
through an npm `.cmd` shim — the shape of every npm-installed CLI on Windows —
cmd.exe re-parses `&`, `|`, `^` in an unquoted token. The terminal config's
`CCC_ARG_SECRET` (shipped in beta.15) has the identical mechanism. The POSIX
reference `"$X"` stayed one argument for every value. This is the
[[windows-env-var-is-not-one-argument]] class from the #308 pass; `askPromptEnvValue`
fixed it for the Ask prompt by REWRITING the value, which a secret cannot be.

## What changed

- `secretValueProblem(value, isWindows)` in `shared/command-secret.ts` — one
  rule for both dialogs: a line break is refused everywhere; on Windows a
  double quote, a trailing backslash, and `& | ^ < > %` are refused, each
  named. The doc comment on `commandSecretRef` now states the truth.
- `CommandDialog`: the problem blocks submit and shows under the field
  (`aria-invalid`), with a Windows note in the helper text.
- `SessionDialog` (terminal-only secret argument): the same rule joins the
  existing `validationMsg` gate.
- Not changed: the env value itself. A value that passes arrives intact; the
  longer-term fix (spawn `pwsh` 7 with `$PSNativeCommandArgumentPassing =
  'Standard'` when present) is a separate decision.

## Verification

`tests/unit/shared/command-secret-value.test.ts` (the table, both platforms);
`tests/unit/renderer/command-dialog-secret-value.test.tsx` (blocked + reason on
win32; unblocked by a clean value; accepted on POSIX and handed to onConfirm
unchanged). A line break cannot reach a dialog (an `<input>` strips newlines
by spec), so that case lives only in the shared-rule test.
