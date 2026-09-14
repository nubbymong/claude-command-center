# ADR-006: Per-config Claude launch parameters — validated dropdown plus a charset-guarded escape hatch

- **Status:** Accepted (2026-07-28)
- **Deciders:** @nubbymong (owner)
- **Related:** CONTEXT.d/2026-07-28-74-claude-launch-parameters.md, #74, #92,
  src/main/ipc/pty-handlers.ts, src/main/pty-manager.ts,
  src/renderer/components/SessionDialog.tsx

## Context

A saved Claude config could pin a model, effort level, agents and working
directory, but not its **permission posture**. Every Claude session launched
under the CLI's own default, so the only way to change permission mode was by
hand inside the running session — which does not persist with the config and
makes it easy to run the wrong posture in the wrong directory. Codex configs
already had a per-config `permissionsPreset`, so the two providers were
asymmetric.

Beyond permission mode, there was no per-config way to pass **any** launch flag
to the Claude CLI. Every new upstream flag would otherwise require a bespoke
control in the config editor, and power users had no escape hatch in the
meantime.

The constraint that shapes this decision: CCC builds its launch command as a
**shell command string** (a `cd` followed by `claude <flags>`, for local via the
platform shell and for SSH via the remote shell), and existing options such as
`--model` / `--effort` are interpolated into it **unquoted**. Anything new that
reaches that string is a shell-injection surface.

## Decision

**Ship both a validated structured control and an unstructured escape hatch, and
make the IPC Zod schema the single injection boundary for both.**

1. `ClaudeOptions.permissionMode` — surfaced as a dropdown over the existing
   `PERMISSION_MODES` list, emitted as `--permission-mode <mode>`. `undefined` /
   `'default'` / `''` emit **no flag**, so the CLI keeps its own default and a
   config that never touched the control persists nothing (the established
   `loggingEnabled` / `enableCodexReview` pattern).
2. `ClaudeOptions.extraArgs` — a collapsed "Advanced" free-text field appended
   verbatim after the structured flags.
3. Validation lives at the **IPC seam** (`spawnOptionsSchema` in
   `pty-handlers.ts`), not in the renderer, because the renderer is not a trust
   boundary and `pty-manager` interpolates unquoted:
   - `permissionMode` is a `z.enum` of the CLI's own `--permission-mode` choices
     (`acceptEdits, auto, plan, dontAsk, bypassPermissions, manual`) plus
     `default`/`''`. An arbitrary string can never reach the shell.
   - `extraArgs` is length-capped and **charset-guarded** — only
     `[A-Za-z0-9 _\-=./\\:@,+[\]]` is admitted, which excludes every shell
     metacharacter (`; | & $ \` ( ) < > ' " * ? ~ ! % ^`) and newlines — and a
     `refine` rejects **CCC-managed flags** (`--model`, `--effort`,
     `--permission-mode`, `--settings`, `--mcp-config`, `--agents`, `--resume`).
   - This mirrors the pre-existing `effortLevel` and `resume.uuid` guards, so the
     spawn path has one consistent rule: *the schema is the boundary.*
4. Flags are emitted at **both** launch sites — local (`extraFlags`) and SSH
   (`claudeFlags`) — so the setting is not silently local-only.
5. Precedence is resolved structurally rather than by warning: `extraArgs`
   **cannot** contain `--permission-mode` at all, so the dropdown and the text box
   can never conflict.

Rejected alternatives: **free-text only** (fastest, but the common case deserves
validation and it is an unguarded injection footgun); **dropdown only** (safest,
but every new upstream flag then blocks on a CCC release); **shell-quoting
`extraArgs`** — quoting correctly across PowerShell, POSIX `sh` and an SSH remote
shell is three different escaping problems on one string, and getting it wrong is
exactly the injection we are trying to prevent.

## Consequences

- One saved config can run `bypassPermissions` while another runs `dontAsk`,
  `acceptEdits` or `plan`; the posture travels with the config instead of being
  re-set by hand per session. `/permissions` inside a running session still works.
- **`extraArgs` cannot carry quoted paths containing spaces** — a direct,
  accepted cost of refusing to solve cross-shell quoting. The field hint says so.
  Flags that need a path with spaces must wait for a structured control.
- A rejected value fails **loudly**: `spawnOptionsSchema.parse` throws
  `Invalid parameters: ...` back over IPC and the session does not spawn. It never
  degrades to a partially-applied command line.
- The Zod enum is a **superset** of the dropdown (it accepts `manual`, which the
  UI does not offer). Adding a mode to the UI list needs no schema change;
  removing one from the CLI does.
- `bypassPermissions` is now reachable from a *saved* config, which is by design a
  sharper tool than the per-session toggle: a config pinned to a directory will
  keep launching with every prompt skipped until someone changes it. The
  dropdown label ("Bypass — skip every permission prompt") is the only guardrail;
  CCC deliberately does not second-guess the operator's choice.
- If the Claude CLI renames or drops `--permission-mode`, the enum is the single
  place to update; the flag/value set was confirmed against `claude --help` at
  implementation time rather than inferred.
