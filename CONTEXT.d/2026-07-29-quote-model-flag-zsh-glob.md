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
- Added `modelFlag(model, isWin32)` returning the ENTIRE `--model 'value'` flag, and
  used it at both sites: local (local platform) and SSH (`isWin32: false` — the
  REMOTE shell is always POSIX regardless of the local platform). Returning the whole
  flag rather than just the escaped value is deliberate; see the adversarial note.
- Folded the two path sites (`--settings`, `--mcp-config`) onto the same helper and
  deleted `pty-manager`'s duplicate local `quoteForShell`, so one tested helper now
  covers all four quoted flag values.
- `--effort` / `--permission-mode` deliberately left unquoted: their IPC guards (a
  `^[a-zA-Z0-9_-]+$` charset and a fixed enum) already exclude every glob and shell
  metacharacter.

A related scope call on the `extraArgs` escape hatch is tracked separately and
privately. Deliberately not described here: this file is tracked and the repo is
public (SECURITY.md, "Embargo"). The earlier revision of this fragment carried that
description; it has been cut.

ADVERSARIAL PASS -- injection lens, plus platform-parity / blast-radius lens.

- MAJOR, in scope: the original regression guard was VACUOUS. Reverting BOTH emission
  sites to the pre-fix raw interpolation left the suite green — 3239 passed, typecheck
  clean, no lint error. It tested only the pure helper, and typecheck could not catch
  the revert because `quoteArgForShell` stayed imported for the path flags. Third
  vacuous guard in this repo. Fixed two ways: `modelFlag()` returns the entire flag so
  a call site has nothing left to get wrong, and
  `tests/unit/spawn-model-flag-emission.test.ts` asserts at SOURCE level that no site
  interpolates the model value raw, plus the inverse (that both sites still call
  `modelFlag`, so the check cannot be silenced by deleting the flag). Verified by
  reverting both sites: both new assertions fail.
- MINOR, in scope: the IPC guard comment said the value is interpolated UNQUOTED and
  carried stale line numbers. That comment was the sole recorded justification for the
  charset guard, so a reader would either relax it as redundant or harden the wrong
  layer. Corrected, and the line numbers dropped rather than re-stated — they were
  wrong once already.

Guarantees that HELD under attack. 23 payloads across four real shells (sh, bash,
pwsh 7, PowerShell 5.1): every one parsed as a single argument, no breakout, no marker
file written. Both escape dialects are correct and complete. Argument injection is
closed too — the model charset admits no space, so a value can never become two argv
words. The folded path flags are byte-identical to the deleted local helper across 24
cases (spaces, apostrophes, UNC paths, trailing backslash, dollar signs).
`--effort` / `--permission-mode` were verified safe unquoted against the REAL Zod
schema rather than the commit message, including the JS-versus-Python difference in
whether `$` matches before a trailing newline. The SSH `isWin32:false` choice is
unobservable for this flag (20,020 fuzzed values, zero divergence between dialects),
and a Windows SSH remote is unreachable by construction.

Two PRE-EXISTING findings on the same launch-shell surface were surfaced by the pass
and routed privately per SECURITY.md. They are not described here, and neither is
introduced by this change.
