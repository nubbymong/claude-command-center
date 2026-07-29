## 2026-07-29 -- macOS/zsh: quote --model so 1M-context ids can launch (#144)

Reported from macOS: selecting any 1M-context model aborted the session launch with
`zsh: no matches found: opus[1m]` — no session started at all.

Cause: `[1m]` is a glob character class in zsh (the macOS default shell), and the
`--model` value was interpolated into the launch command string UNQUOTED, so zsh
tried to filename-match `opus[1m]`, matched nothing, and killed the ENTIRE command
line before `node`/`claude` ever ran. The adjacent `--settings`/`--mcp-config` paths
in the same command were already quoted — only the model value wasn't. bash and
PowerShell pass an unmatched glob through literally, which is why this never
reproduced on the Windows dev machine.

The mismatch was self-inflicted: the IPC guard was widened for 1M ids
(`model: z.string().regex(/^[a-zA-Z0-9._[\]-]+$/)`, comment naming `'opus[1m]'` as
legit) but the emission sites were never quoted to match. Bracketed ids are real
values that must reach the CLI, so banning them is not an option — quoting is.

- Added `quoteArgForShell(value, isWin32)` to `spawn-claude-command.ts` (the pure
  helper module), wrapping the pre-existing `escapeForCwdQuote` escaping. Single
  quotes are literal in PowerShell and POSIX sh/zsh alike.
- Applied at both `--model` sites in `pty-manager.ts`: local (`:1224`, local
  platform) and SSH (`:604`, `isWin32: false` — the REMOTE shell is always POSIX
  regardless of the local platform).
- Folded the two path sites (`--settings`, `--mcp-config`) onto the same helper and
  deleted `pty-manager`'s duplicate local `quoteForShell`, so one tested helper now
  covers all four quoted flag values.
- `--effort` / `--permission-mode` deliberately left unquoted: their IPC guards (a
  `^[a-zA-Z0-9_-]+$` charset and a fixed enum) already exclude every glob and shell
  metacharacter.
- `scripts/resume-picker.js` needed no change — it forwards argv via
  `spawnSync(cmd, args)` with `shell:false` on macOS, so there is no second shell
  parse to glob.
- Tests: `tests/unit/spawn-model-flag-quoting.test.ts` (bracketed-id quoting both
  dialects, every shipped alias round-trips verbatim, embedded-quote escaping, a
  "no unquoted `[` survives" regression sentinel, plus the companion schema guard).
  Full suite 3128 passed.

Known related hazard, NOT changed here (needs a scope call): `extraArgs` is also
interpolated unquoted and its charset guard permits `[`/`]`, so brackets typed there
would glob-break on zsh the same way. It cannot simply be wrapped in quotes (it is
meant to expand to multiple shell words), so the choice is to drop `[`/`]` from that
charset or leave it documented — flagged on #144 rather than silently narrowing a
user-facing guard.
