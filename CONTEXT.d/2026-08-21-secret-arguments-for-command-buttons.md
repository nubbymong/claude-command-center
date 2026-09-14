# 2026-08-21 — Secret arguments for command buttons

Backlog item 21, against canvas `Commands uplift and partner browser` v3 and the
owner's own review note on it: *"We should add the ability to store arguments as
secrets like we did in the session configs."*

## Why it cannot be done the obvious way

A command button TYPES text into a running shell. Every submitted line is
recorded by that shell's persistent history — PSReadLine writes
`ConsoleHost_history.txt` on Windows — so a token typed as an argument is on
disk, forever, in plaintext. Masking it in the dialog changes nothing about
that. The only fix is the one terminal configs already use: the **value** goes
to the OS keychain, main puts it in the shell's **environment when the shell
starts**, and the button types only a **reference** the shell expands. The value
never enters the command line, so it never enters the history.

Two consequences follow, and the dialog states both:

- The value is only present in shells started **after** the secret was saved. A
  shell that is already open needs a restart to see it — there is no way to
  change a running process's environment from outside, and typing
  `$env:X = 'value'` into it would put the value in history, which is the thing
  being avoided.
- It is only ever placed in **shell** spawns. A reference typed into Claude's
  TUI is just text to Claude, so the option exists only for the "run a command"
  kind.

## The contract, in one shared module

`src/shared/command-secret.ts` is pure and dependency-free so both processes
build the same names:

| piece | value |
| --- | --- |
| placeholder the user writes | `{secret}` — `-Token {secret}` |
| env var main sets | `CCC_CMD_SECRET_<commandId>` |
| what the button types | `$env:CCC_CMD_SECRET_<id>` (Windows) / `"$CCC_CMD_SECRET_<id>"` (POSIX) |
| keychain key | `<commandId>_cmdsecret` |

The id is the app's own 24-hex, but it becomes part of a variable name, so the
shape is **checked rather than trusted** — `commandSecretEnvName` returns null
for anything outside `[A-Za-z0-9]{1,64}`, and both main (`collectCommandSecrets`)
and the spawn builder refuse such ids independently.

`buildCommandLine(prompt, args, secretRef)` is now THE rule for what a button
types — `CommandBar.buildFullCommand` and the dialog's preview both call it, so
#346's "the preview cannot drift from the bar" claim is now enforced by a shared
function rather than by two copies of one line. Without a reference the token is
left alone: a command with no stored secret types `{secret}` literally, which is
visible and harmless, rather than silently typing nothing where a value was
meant.

## Where the value lives and moves

- **Renderer → keychain:** the dialog hands the typed value to `CommandBar` as a
  second argument to `onConfirm`, exactly as `SessionDialog` hands `argSecret`
  up; the bar writes it under `commandSecretKey(id)`. The value is never part of
  the command record. Edit with nothing typed keeps what is stored; switching
  the secret off deletes it; deleting the command deletes it too.
- **Keychain → env, in main only:** the `pty:spawn` handler strips any
  `commandSecrets` the renderer may have sent (same posture as
  `terminalSecret`), and for a `shellOnly` spawn with a `configId` rebuilds the
  map from the **commands file on disk** plus the keychain. The renderer's copy
  of the commands list is never consulted, because it could name any id it
  liked. Only commands that say `hasSecretArg: true` and are visible to that
  config (global, or scoped to exactly it) are looked up at all.
- **Env:** `buildClaudeLocalSpawn` sets one variable per command, shell-only
  spawns only, re-validating the id on the way in — the last line of defence
  before the environment.

A command's TARGET is deliberately not consulted when deciding which shell gets
which secret: the env var is inert if nothing types its name, and "the spawn is
a shell" is already the condition that matters.

## Verification

Full suite green, typecheck clean. Tests at every layer: the shared contract
(names, refs, the one build rule), the collector (scope, shape, id validation,
missing vault entries), the spawn env (set for shell, not for Claude, bad ids
refused, value never in argv), the bar (types the reference, never the token,
leaves the token alone without a stored secret), and the dialog (offered for
shell only, cannot submit a secret with no value, hands the value up separately,
preview shows the reference not the value, edit keeps/replaces/deletes).

Mutations are recorded in the PR. This is ADR-009 territory — keychain, env,
argv — and belongs to the end-of-run adversarial pass; nothing here is claimed
as reviewed.
