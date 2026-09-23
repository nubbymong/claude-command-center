// WP1 provider core: the realm environment patch (owner decisions D1/D3).
//
// A provider package turns a bound realm into a patch. The launch path applies
// it LAST, after removing every ambient authentication variable that could
// override the selected CLI's bound realm. For interactive PTYs the base is
// the inherited developer environment (terminal-wrapper fidelity); for
// setup/auth/status/logout subprocesses the base is a strict allowlist (later
// slice). This module is pure so both bases share one rule and one test.
//
// The result is an ENVIRONMENT OBJECT for a spawn call. It is never
// interpolated into a shell prefix (`NAME=value cmd`, `set NAME=value&&`):
// the value validation here rejects only what an env object cannot carry, not
// shell metacharacters. A launch path that must build a shell prefix from it
// re-validates against the shell it targets.

export interface RealmEnvPatch {
  /** Variables set last, exactly as given. */
  set: Readonly<Record<string, string>>
  /** Variables removed before `set` is applied (in addition to the ambient list). */
  unset?: readonly string[]
}

export interface RealmEnvPolicy {
  /** Ambient authentication variables removed from every managed launch (D3). */
  ambientAuthVariables: readonly string[]
  /** Variables the provider's realm patch may SET, spelled exactly as the
   *  provider declares them. A patch naming anything else is rejected: another
   *  provider's realm, a loader or search variable, or an ambient credential
   *  the removal pass has just stripped.
   *
   *  The ambient list is NOT implicitly settable. That union was the hole the
   *  round-2 review found: it let a Claude patch set `CLAUDE_CONFIG_DIR` (the
   *  exact mechanism D1 forbids) or re-add `ANTHROPIC_API_KEY` one line after
   *  the removal pass deleted it. A variable that must be both removed and
   *  re-set for a bound realm -- Codex's `CODEX_HOME` -- is declared in BOTH
   *  lists, deliberately and visibly. */
  ownedVariables: readonly string[]
}

// There is deliberately NO "host-managed control" slot here any more. Slice 2
// first applied `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST=1` last on every managed
// launch, as the one proven control against settings-sourced redirection.
// Gate A1 then measured that the pinned CLI reads NO stored login under that
// flag -- it is Claude Desktop's mode, in which the host supplies the token --
// so a managed session could not sign in at all (evidence Part 7). The owner's
// correction (2026-09-22) removes the flag rather than making this app a
// credential host: the realm is the USERPROFILE/HOME redirect plus the realm
// roots, the app-owned settings copy is sanitised, ambient authority is
// removed, and repository-owned settings that carry authority REFUSE the
// launch before it starts (the project gate). What this cannot prevent --
// mid-session edits, remote/organisation settings, another process of the
// same OS user -- is recorded as a boundary, not claimed.

/** Variables that decide which executable or library a child process loads.
 *  A provider package may never own one: a realm patch able to rewrite them
 *  chooses the binaries the CLI runs, which is not realm isolation.
 *
 *  PATH composition for a managed launch stays in the launch path -- the
 *  existing `withProfileHome` APPENDS `<home>/.local/bin` to the inherited
 *  PATH, so a system binary still wins -- and is deliberately outside the
 *  realm-patch contract, which can only replace a variable wholesale.
 *  Enforced here and again at registration (`packageRegistrationProblem`). */
export const NEVER_OWNED_LAUNCH_VARIABLES: readonly string[] = [
  'PATH', 'PATHEXT', 'COMSPEC', 'SYSTEMROOT', 'WINDIR', 'SHELL', 'BASH_ENV', 'ENV',
  'NODE_OPTIONS', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'LD_AUDIT',
  'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH', 'DYLD_FALLBACK_LIBRARY_PATH',
  'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_SSH_COMMAND', 'GIT_EXEC_PATH',
]

/** Whole FAMILIES of the same kind, so the backstop does not depend on anyone
 *  remembering every variant: DYLD_FRAMEWORK_PATH and NODE_PATH are siblings of
 *  listed names and were reachable while the list was an enumeration alone. A
 *  git config file is a command-execution primitive (core.pager, core.sshCommand,
 *  alias.*, filter.*), and an .npmrc sets script-shell, so both config-file
 *  pointers belong here too. */
const NEVER_OWNED_PATTERNS: readonly RegExp[] = [
  /^(LD|DYLD)_/i,
  /^NODE_/i,
  /^(PYTHON|PERL5)/i,
  /^NPM_CONFIG_/i,
  /^GIT_(CONFIG|SSH|EXEC|PAGER|EDITOR|EXTERNAL)/i,
]
const NEVER_OWNED = new Set(NEVER_OWNED_LAUNCH_VARIABLES.map((n) => n.toLowerCase()))

/** Case-insensitive, because Windows resolves `Path` and `PATH` to the same
 *  variable and a declaration must not dodge the rule by spelling. */
export function isNeverOwnedLaunchVariable(name: string): boolean {
  if (typeof name !== 'string') return false
  return NEVER_OWNED.has(name.toLowerCase()) || NEVER_OWNED_PATTERNS.some((re) => re.test(name))
}

/** A patch variable name. Deliberately strict: providers author these, and a
 *  name outside this shape is a mistake rather than a requirement. Base keys
 *  are NOT held to it (see below). */
const PATCH_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Fold a variable name to the form removal compares on.
 *
 *  NFKC first, then lower case. The case fold is the load-bearing half: Windows
 *  resolves `Path` and `PATH` to one variable, so a name differing only by case
 *  from a known ambient authority variable IS that variable and is never
 *  trusted. The NFKC fold closes the spelling gap the case fold leaves -- a
 *  fullwidth or compatibility-form character folds onto its ASCII counterpart,
 *  so `ANTHROPIC＿API＿KEY` is removed rather than carried through as an
 *  unrecognised name.
 *
 *  Folding wider than the OS does can only REMOVE more, never keep more, so it
 *  cannot open a hole: the worst case is discarding an oddly-spelled variable
 *  that was not the one it resembles.
 *
 *  SCOPE, stated exactly, because the earlier wording did not. NFKC folds
 *  COMPATIBILITY forms -- fullwidth characters and the like. It does NOT fold
 *  cross-script confusables: a Cyrillic-A `АNTHROPIC_API_KEY` survives this
 *  pass unchanged (adversarial round 4). That is not a hole, and the reason is
 *  the OS rather than this function -- environment names match byte-exactly on
 *  POSIX and with an ASCII case-fold on Windows, so the surviving entry is not
 *  the variable it resembles and nothing reads it, neither the CLI nor any
 *  child. The claim this supports is "a COMPATIBILITY spelling of an authority
 *  variable is never trusted", not "anything that looks like one". */
function foldName(name: string): string {
  try { return name.normalize('NFKC').toLowerCase() } catch { return name.toLowerCase() }
}

/** Remove every variable whose folded name matches one of `names`. */
function removeCaseInsensitive(env: Record<string, string>, names: readonly string[]): void {
  const folded = new Set(names.map(foldName))
  for (const key of Object.keys(env)) if (folded.has(foldName(key))) delete env[key]
}

export function applyRealmEnvPatch(
  base: Readonly<Record<string, string | undefined>>,
  patch: RealmEnvPatch,
  policy: RealmEnvPolicy,
): Record<string, string> {
  // Ownership is matched EXACTLY, not case-insensitively. Accepting
  // `codex_home` for a declared `CODEX_HOME` would write the variant spelling
  // while the case-insensitive removal pass deletes the canonical one; on
  // Linux and macOS the CLI would then find no realm at all and fall back to
  // the shared default home -- i.e. another account's credentials. That fails
  // OPEN, and Windows (where env names are case-insensitive) would not show it.
  const settable = new Set(policy.ownedVariables)
  const removable = new Set([...policy.ownedVariables, ...policy.ambientAuthVariables])
  const checkName = (k: string): void => {
    if (!PATCH_NAME.test(k)) throw new Error(`realm env patch: invalid variable name ${JSON.stringify(k)}`)
    if (isNeverOwnedLaunchVariable(k)) throw new Error(`realm env patch: ${k} decides what the child process executes and is never a realm variable`)
  }
  for (const k of Object.keys(patch.set)) {
    checkName(k)
    if (!settable.has(k)) throw new Error(`realm env patch: ${k} is not a variable this provider owns`)
  }
  for (const k of patch.unset ?? []) {
    checkName(k)
    if (!removable.has(k)) throw new Error(`realm env patch: ${k} is not a variable this provider owns`)
  }
  // Base keys pass through as the developer environment spells them. Windows
  // carries `ProgramFiles(x86)` and `CommonProgramFiles(x86)`, which MSVC and
  // node-gyp probes read; dropping them would break the terminal-wrapper
  // fidelity D3 asks for. Only what an env object cannot carry is rejected.
  // A key carrying '=', NUL, CR or LF is not addressable as an environment
  // variable and is the classic injection primitive for anything that
  // serialises an env to text (this repo builds remote `export` lines over
  // SSH); a NUL in a value truncates in the native APIs. Those are dropped.
  // Everything else is carried verbatim.
  //
  // VALUES are held to the same CR/LF rule as the names, and as the patch
  // values below. A value carrying a newline cannot survive the
  // `export NAME=value` serialisation this repo builds for remote launches: it
  // ends the statement and everything after it is read as the next one. The
  // patch path REFUSES such a value, because a provider authored it and a
  // provider getting it wrong is a bug; a base entry is INHERITED rather than
  // authored, so it is dropped in the same way an unrepresentable name is
  // (adversarial review, MINOR).
  const env: Record<string, string> = Object.create(null)
  for (const [k, v] of Object.entries(base)) {
    if (typeof v !== 'string' || !k) continue
    if (/[=\0\r\n]/.test(k) || /[\0\r\n]/.test(v)) continue
    env[k] = v
  }
  removeCaseInsensitive(env, policy.ambientAuthVariables)
  if (patch.unset?.length) removeCaseInsensitive(env, patch.unset)
  // Remove any case-variant of a variable the patch sets, then set the
  // declared spelling last.
  removeCaseInsensitive(env, Object.keys(patch.set))
  for (const [k, v] of Object.entries(patch.set)) {
    if (typeof v !== 'string') throw new Error(`realm env patch: ${k} must be a string`)
    if (/[\0\r\n]/.test(v)) throw new Error(`realm env patch: invalid value for ${k}`)
    env[k] = v
  }
  // Nothing after this line writes to `env`.
  // Returned with the null prototype it was built with: Node enumerates a
  // spawn env with `for...in` and deliberately includes prototype properties,
  // so re-attaching Object.prototype here would let anything that polluted it
  // in the main process reach the child. `{ ...env }` did exactly that.
  return env
}
