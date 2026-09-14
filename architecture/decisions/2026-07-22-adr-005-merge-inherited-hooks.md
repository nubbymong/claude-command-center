# ADR-005: Per-session settings merge inherited hooks instead of replacing them

- **Status:** Accepted (2026-07-22)
- **Deciders:** @nubbymong (owner)
- **Related:** CONTEXT.d/2026-07-22-merge-inherited-hooks.md, #137, src/main/hooks/session-hooks-writer.ts, src/main/hooks/per-session-settings.ts

## Context

CCC launches Claude with a per-session `--settings <file>` whose `hooks` key it
sets to **only** CCC's HTTP gateway hooks (`injectHooks` did
`settings.hooks = buildHooksBlock(...)`). Claude Code treats a `--settings`
`hooks` key as an **override**, not a concatenating array (verified against the
docs: `hooks` is absent from the documented merge-able-array list; empirically a
project hook stops firing under `--settings`). Result: user- and project-level
hooks are shadowed — a project `.claude/settings.json` command hook (e.g.
`carp-hook.ps1`) fires in a direct `claude` session but **never** in a
CCC-launched one. `per-session-settings.ts` compounded it by cloning only the
*user* `~/.claude/settings.json`, never the project settings.

Goal: a CCC session should do everything a plain `claude` would in the same
folder, **plus** CCC's gateway hooks.

## Decision

**CCC resolves the hooks Claude would inherit for the session's launch cwd and
merges them with its own hooks before writing the `--settings` file** (Option A —
pre-merge; the alternative of relying on Claude to merge is impossible given the
override semantics).

- `resolveInheritedHooks(cwd, homeDir)` reads and concatenates hooks, low→high
  precedence: user `~/.claude/settings.json`, project `<root>/.claude/settings.json`,
  project-local `<root>/.claude/settings.local.json`. The project root is found by
  walking up from cwd to the nearest `.claude`, **bounded by the home dir** (so
  `~/.claude` is only ever the user source, never a "project", and the walk never
  escapes home into other users/system).
- `injectHooks` sets `settings.hooks = concat(inherited, cccGatewayHooks)` —
  inherited entries keep their order; CCC's http entries (unique per-session URL)
  are appended. Byte-identical entries are de-duplicated as a guard against
  double-firing.
- `homeDir` is an injectable seam (defaults to `os.homedir()`) purely so unit
  tests are hermetic; `os.homedir()` is not overridable via env on macOS.

## Consequences

- CCC sessions now run inherited user/project/local hooks **and** the CCC gateway
  hooks. The reported `carp-hook.ps1` case works.
- FAIL-SAFE throughout: missing/unparseable settings contribute nothing and never
  block session spawn (matches the rest of the hooks pipeline).
- **Enterprise "managed" settings** outrank `--settings` regardless, so folding
  them in wouldn't change Claude's resolution — left to Claude (out of scope).
- **SSH remote sessions are NOT covered.** `ssh-shim.ts` builds the hooks literal
  against a *remote* filesystem the main process can't read at settings-write
  time; merging remote-inherited hooks there is a separate follow-up.
- If Claude ever changes `hooks` to a concatenating array, our pre-merge would
  risk double-adding project hooks — the byte-identical dedupe guards the common
  case, and this ADR records the assumption to revisit.
