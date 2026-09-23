# Claude settings-source isolation -- executable probe record

Owner ruling of 2026-09-20 (item 6): environment stripping alone is insufficient
for Claude, because the CLI can reapply env entries from settings after launch and
the app copies shared `settings.json` into every managed profile. This record
establishes, by running the pinned CLI, which settings sources can inject a
provider/authentication override and what stops them.

**Nothing here is derived from string presence in the binary.** Every row is an
executed command with an observed result.

## Environment

| Item | Value |
| --- | --- |
| CLI | Claude Code `2.1.278`, native, commit `809c980662e3` (`claude doctor`) |
| CLI path | `C:\Users\nicho\.local\bin\claude.exe` |
| OS | Windows 11 Pro 10.0.26220, `win32-x64` |
| Date | 2026-09-21 |
| Codex CLI | `0.153.4` installed; D7 pins `0.155.1` as the reference -- the Codex list is re-derived against 0.155.1 before the candidate |
| Harness | `scratchpad/probe/matrix.mjs`, `matrix2.mjs`, `apikeyhelper.mjs`, `apikeyhelper2.mjs` (scratchpad only, not committed) |

Every run used a disposable fixture tree: a scratch `USERPROFILE`/`HOME`, a scratch
project directory, a seeded `.claude.json` (`hasCompletedOnboarding`,
`hasTrustDialogAccepted`) so the CLI runs non-interactively, and the dummy key
`sk-ant-probe-dummy`. No real credential was used and the real `~/.claude` was
never read or written.

## Command

Rounds 1-2 (settings `env` injection) each run:

```
cd <fixture>/proj && USERPROFILE=<fixture>/home HOME=<fixture>/home [extra env] claude doctor
```

`doctor` is used there because it performs a credential-bearing request and
reports the outcome in parseable text. `claude -p` was tried first and rejected
for those rounds: against the REAL endpoint it hangs with no output on a fresh
profile, with or without a settings fixture, so it discriminated nothing.

Round 3 (`apiKeyHelper`) had to leave `doctor`, which excludes apiKeyHelper from
its own path. It runs:

```
cd <fixture>/proj && USERPROFILE=... ANTHROPIC_BASE_URL=http://127.0.0.1:<port> [extra env] claude -p "say ok"
```

`claude -p` works there precisely because the loopback capture server answers
instantly with a 401 instead of the real endpoint's retry/backoff -- which is also
the explanation for the round-1/2 hang.

## Observables, calibrated before any negative was read

Two independent observables, each calibrated with a positive and a negative control
so that a null result means something.

**Observable 1 -- did `ANTHROPIC_BASE_URL` reach the effective config?**

| Doctor line | Meaning |
| --- | --- |
| `Managed settings (remote): fetch failed ... (authentication rejected (401))` | NOT applied |
| `Managed settings (remote): not fetched -- not available with a custom ANTHROPIC_BASE_URL` | APPLIED |

Calibration: `C0` (nothing set) = NOT applied; `C1` (`ANTHROPIC_BASE_URL` in the
real spawn env) = APPLIED.

**Observable 2 -- was a credential resolved at all?**

| Doctor line | Meaning |
| --- | --- |
| `not fetched -- no usable credentials for the settings fetch` | no credential resolved |
| `fetch failed ... (authentication rejected (401))` | a credential WAS resolved |

Calibration: `K0` (no credential anywhere) = none; `K1` (ambient
`ANTHROPIC_API_KEY`) = resolved.

## Results

### Which settings scope can inject a provider override?

| ID | Fixture | Observable | Result |
| --- | --- | --- | --- |
| `S1` | USER settings `<home>/.claude/settings.json` -> `env.ANTHROPIC_BASE_URL` | 1 | **APPLIED** |
| `M5` | same, re-run | 1 | **APPLIED** (confirms S1) |
| `E1` | USER settings -> `env.ANTHROPIC_API_KEY`, no ambient key | 2 | **credential resolved** |
| `S2` | PROJECT settings `.claude/settings.json` -> `env.ANTHROPIC_BASE_URL` | 1 | not applied |
| `E2` | PROJECT settings -> `env.ANTHROPIC_API_KEY`, no ambient key | 2 | no credential |
| `S3` | LOCAL settings `.claude/settings.local.json` -> `env.ANTHROPIC_BASE_URL` | 1 | not applied |
| `E3` | LOCAL settings -> `env.ANTHROPIC_API_KEY`, no ambient key | 2 | no credential |
| `S4` | PROJECT settings -> `env.CLAUDE_CODE_USE_BEDROCK` + `env.CLAUDE_CODE_USE_ANTHROPIC_AWS` | 1 | not applied |

**Finding 1. The USER scope reaches the CLI, and it is the scope the app writes
to.** `account-profiles.ts` copies the shared `settings.json` into each managed
profile's `.claude/settings.json` and re-copies it after shared edits. That file
is the USER scope. An `env` block in it reaches the CLI -- proven twice, with two
different variables (`ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY`).

Read as of the probe date, and closed by Part 2 in the SAME commit this record
ships in: the app's copy is sanitised at both writers and the host control is
applied on every managed launch. Part 1's present tense describes the CLI's
behaviour, which is unchanged; not the app's, which is not.

**Finding 2. PROJECT and LOCAL scope env blocks do NOT reach the CLI.** Proven with
the same two variables under both observables. This is not "doctor ignores project
settings": doctor's own help states it reads settings files in the current
directory, and the binary carries a `projectScopeDropWarned` filter. Repository-owned
settings therefore cannot inject a provider override **through an `env` block**
in this version.

Do NOT generalise this to "repository-owned settings are safe". Finding 7 below
shows the same two scopes DO execute `apiKeyHelper`. The scope filter is
per-key, not per-scope.

### Does the host mechanism stop it?

| ID | Fixture | Observable | Result |
| --- | --- | --- | --- |
| `M5` | USER settings `env.ANTHROPIC_BASE_URL`, **no** host flag | 1 | APPLIED |
| `M4` | USER settings `env.ANTHROPIC_BASE_URL` + `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST=1` | 1 | **BLOCKED** |
| `E1` | USER settings `env.ANTHROPIC_API_KEY`, **no** host flag, no ambient key | 2 | credential resolved |
| `M7` | USER settings `env.ANTHROPIC_API_KEY` + host flag, no ambient key | 2 | **BLOCKED** (no credential) |

**Finding 3. `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST=1` blocks user-scope settings
env injection.** Two clean A/B pairs on identical fixtures, two different variables,
two different observables. This is the enforcement mechanism.

It matches the binary's own structure: settings env is filtered through a pipeline
ending in `...providerStripContext, hostManagedDropWarned), hostSpawnEnvKeys)`, i.e.
the CLI already refuses to let settings override provider keys under host management.

### apiKeyHelper -- resolved by a third probe (round 3)

Round 2 could not answer this: `doctor` prints `apiKeyHelper keys are not used
for it`, so the helper could not have fired on that path whatever the isolation.
Round 3 therefore drives an ACTUAL request path (`claude -p`) with
`ANTHROPIC_BASE_URL` pointed at a **loopback capture server** that records the
credential the CLI puts on the wire and answers 401 so nothing retries. No request
left the machine; every key is a syntactically-shaped fake; the sentinel is a file
write.

Harness: `scratchpad/probe/apikeyhelper.mjs`, `apikeyhelper2.mjs`.
Command: `claude -p "say ok"` with `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>`.

| ID | Fixture | Host flag | Sentinel fired | Credential on the wire |
| --- | --- | --- | --- | --- |
| `X0` | host env key only, no helper (calibration) | no | no | **HOST key** |
| `X1` | `apiKeyHelper` in USER settings, no ambient key | no | **YES** | **HELPER key** |
| `X4` | `apiKeyHelper` in PROJECT settings, no ambient key | no | **YES** | **HELPER key** |
| `Y2` | `apiKeyHelper` in LOCAL settings, no ambient key | no | **YES** | **HELPER key** |
| `X2` | `apiKeyHelper` in USER settings + host key | **yes** | no | HOST key |
| `Y1` | `apiKeyHelper` in PROJECT settings + host key | **yes** | no | HOST key |
| `Y3` | `apiKeyHelper` in LOCAL settings + host key | **yes** | no | HOST key |
| `X3` | `apiKeyHelper` in USER settings, NO host key | **yes** | no | none -- request carried no credential |

**Finding 5. `apiKeyHelper` executes from ALL THREE scopes and supplies the
credential.** Sentinel written, and the helper's fake key -- not the host's --
appears on the wire. It is simultaneously arbitrary command execution and an
account redirect.

**Finding 6. `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST=1` suppresses it in all three
scopes.** The helper does not execute and the host's credential is used instead.
`X3` shows it fails CLOSED: with the flag set and no host credential, the helper
is still not run and the request goes out with no credential rather than falling
back to the poisoned source.

**Finding 7 -- this changes the design.** `apiKeyHelper` is NOT project-scope
filtered, even though `env` is (findings 1-2). So repository-owned settings ARE
dangerous after all, by a different key. Because those files must never be mutated,
the host flag is not defence-in-depth for project and local scope -- it is the only
control, and it is load-bearing.

### Still unproven -- do NOT design around these

| ID | Fixture | Result | Why it proves nothing |
| --- | --- | --- | --- |
| `A1`-`A3`, `H1`-`H3`, `M6` | `apiKeyHelper` observed through `doctor` | sentinel never fired | Superseded by round 3. Doctor excludes apiKeyHelper from its own path, so these rows carry no information and are retained only to record the dead end. |
| `P1` | `CLAUDE_CODE_MANAGED_SETTINGS_PATH` -> realm-local file with an `env` block | not applied | Cannot distinguish "not honoured" from "wrong path/shape" from "managed env filtered". Contract unestablished -- and not pursued further, because the primary host mechanism is sufficient. |
| `P2` | `MANAGED_SETTINGS_PATH` + PROJECT settings | not applied | Same. |
| `M1`-`M3` | host flag vs PROJECT settings `env` | no signal | PROJECT `env` is blocked with or without the flag, so these compare two blocked states. |

### Not tested

- Remote / organizationally managed settings. Doctor reports
  `Managed settings (remote): ...`, so the CLI fetches settings from the server for a
  signed-in account. Not locally observable without a signed-in org account.
- Settings changed while a session is running.
- Two managed realms with conflicting credentials.

## What this licenses

**Proven, and sufficient to build on.** `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST=1`
is the enforcement mechanism. Under it, on this pinned version:

- user-scope settings cannot inject `ANTHROPIC_BASE_URL` or `ANTHROPIC_API_KEY`
  (`M4`, `M7` against `M5`, `E1`);
- `apiKeyHelper` cannot execute or supply a credential from user, project or
  local scope (`X2`, `Y1`, `Y3` against `X1`, `X4`, `Y2`);
- it fails closed rather than falling back to a poisoned source (`X3`).

**Pinned-version behaviour, not a permanent property.** Findings 1-2 (project and
local `env` blocks never reach the CLI) narrow the implementation and its tests,
but they are behaviour of `2.1.278` and must be re-derived when the pinned version
moves. Finding 7 is the cautionary case: the same two scopes that are safe for
`env` are NOT safe for `apiKeyHelper`, so "this scope is filtered" must never be
generalised from one key to another.

**Not claimed.** Complete settings-source isolation is NOT claimed and must not be
claimed until the manual gates below pass:

- remote / organizationally managed settings (the CLI fetches settings from the
  server for a signed-in account -- `Managed settings (remote): ...`);
- settings changed while a session is running;
- two managed realms with conflicting credentials.

These are explicit manual acceptance items. They do not block adapter construction,
but any testable authentication override must pass before the candidate merges.

The preflight diagnostic is defense-in-depth and reports only what is locally
observable. It is NOT the security boundary: dynamic and remote settings sources are
not locally observable, so a clean preflight cannot mean "isolated".

---

# Part 2 -- what was BUILT on this evidence (2026-09-21, same day)

Part 1 above established the mechanism. This part records the derivations the
implementation needed, the deltas from the literal instruction, and the manual
gates that are still owed. Nothing here re-opens Part 1; the probe matrix stands.

## Owner constraints this implements

Recorded from the 2026-09-21 planner update, because several of them narrow
choices that would otherwise look arbitrary in the code:

1. `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST=1` is a load-bearing security control
   for every app-managed Claude session, including setup/auth/status/logout
   paths where applicable.
2. Sanitisation preserves unrelated user configuration: remove `apiKeyHelper`
   entirely from the app-owned profile copy; remove only the derived provider,
   authentication, routing and authority entries from its `env` block; retain
   harmless `env` entries and all unrelated settings; never modify shared source
   settings or repository-owned settings.
3. Preflight fails visibly when the host control is unsupported or was not
   applied. It must NOT reject a launch merely because project/local settings
   contain values the proven host mechanism safely suppresses.
4. Establish a minimum compatible Claude CLI version; until an earlier version
   is independently proven, 2.1.278 is the floor for managed multi-account
   launches. Older versions get an actionable upgrade requirement, never a
   silent fallback.
5. Automated regression tests for: the flag applied last and unoverwritable;
   every managed launch path receiving it; unmanaged/external shells not;
   `apiKeyHelper` and poisoned provider settings unable to influence the final
   launch; sanitisation preserving unrelated settings.
6. Before merge, the manual acceptance matrix must prove the host flag still
   permits the intended OAuth credential from each isolated profile home, and
   that two profile realms remain distinct. Remote/org settings and mid-session
   mutation stay in that same manual matrix.

## Derivation: the authority variable list

Method: the candidate names from Part 1's reading of the binary and
`code.claude.com/docs/en/env-vars`, then a PRESENCE scan of the pinned binary to
confirm each one exists in it. Presence is used only to classify `source` and to
justify REMOVING a variable from an environment this app composes. No behaviour
is claimed from presence -- that would break Part 1's own rule.

Command, against `C:\Users\nicho\.local\bin\claude.exe` (237,232,800 bytes,
`claude --version` reports `2.1.278 (Claude Code)`):

```
node -e "<chunked latin1 scan counting occurrences of each candidate name>"
```

Result: **all 32 candidate names present, none absent.** Occurrence counts ran
from 8 (`CLAUDE_CODE_MANAGED_SETTINGS_PATH`) to 140 (`CLAUDE_CODE_OAUTH_TOKEN`).

The list ships as `CLAUDE_AUTHORITY_VARIABLES` in
`src/main/providers/claude/managed-launch.ts`, one row per variable with:

| field | meaning |
| --- | --- |
| `kind` | config-root / credential / federation / routing / provider-switch / host-hook |
| `source` | official-doc / pinned-binary / both -- the owner's 2026-09-20 classification ruling |

Two entries the owner named explicitly are in, and both are `pinned-binary`
only -- i.e. a docs-derived list misses both: `CLAUDE_CODE_USE_ANTHROPIC_AWS`
and `ANTHROPIC_CONFIG_DIR`. A regression test asserts both are present, so a
future re-derivation from the docs alone fails rather than silently narrowing.

`CLAUDE_CODE_MANAGED_SETTINGS_PATH`, `CLAUDE_CODE_HOST_AUTH_ENV_VAR` and
`CLAUDE_CODE_HOST_CREDS_FILE` are classified `host-hook` and are REMOVAL-ONLY.
The owner ruled them untrusted/undocumented and ruled out further investigation
of MANAGED_SETTINGS_PATH; removal needs no contract, because an inherited value
would be an authority override this app did not choose.

### Slice-1 open question, now closed

Slice 1 left this beside its four-name list: do authority/cloud switches
(`ANTHROPIC_BASE_URL`, `CLAUDE_CODE_USE_BEDROCK`, ...) belong in the ambient
list, given they redirect where a credential GOES rather than which realm is
read? The owner's ruling closes it as **yes**. A session pointed at an
attacker's endpoint is not isolated merely because it read the right stored
login. The same ruling applies to the Codex endpoint variables.

## Derivation: Codex

Widened from slice 1's two names on two grounds:

- the CLI's own diagnostic enumerates three credential variables, not one:
  `auth env vars present: OPENAI_API_KEY, CODEX_API_KEY, CODEX_ACCESS_TOKEN`;
- the endpoint variables follow the same ruling as Claude's.

`OPENAI_WORKLOAD_IDENTITY_CONTEXT` is deliberately EXCLUDED (owner ruling:
attribution-only). Unrelated AWS/Azure/GCP developer-tool variables are equally
deliberately excluded (owner ruling).

**Still owed:** derived against codex-cli `0.153.4`; D7 pins `0.155.1`. The list
must be re-derived against 0.155.1 before the candidate. It is widened rather
than narrowed, so an entry that turns out not to exist in 0.155.1 costs a
removed variable nobody set, not a hole.

## DELTA from the literal instruction -- owner decision wanted

Constraint 2 names `apiKeyHelper`. The implementation removes **four** settings
keys wholesale, as `CLAUDE_COMMAND_HELPER_SETTINGS_KEYS`:

| key | occurrences in 2.1.278 | basis |
| --- | --- | --- |
| `apiKeyHelper` | 103 | PROVEN in Part 1 (X1/X4/Y2): executes from user, project and local scope, and its key goes on the wire |
| `awsAuthRefresh` | 25 | present in the pinned binary; a settings-file-supplied command line, same defect class |
| `awsCredentialExport` | 25 | present in the pinned binary; same class |
| `otelHeadersHelper` | 39 | present in the pinned binary; same class, and an exfiltration channel as well as an auth one |

Reasoning: the last three are NOT proven to execute, and nothing here claims
they do. Removal acts only on THIS APP'S OWN COPY of a settings file. Being
over-inclusive costs a setting that had no business in a managed realm; being
under-inclusive costs a credential redirect. `forceLoginMethod` (27
occurrences) is deliberately NOT removed -- it is a preference, not a command or
credential source, and removing it would be the over-removal constraint 2
forbids.

**If the owner wants the literal scope, narrowing to `apiKeyHelper` alone is a
one-line change to `CLAUDE_COMMAND_HELPER_SETTINGS_KEYS`.**

## The version floor

`CLAUDE_MIN_MANAGED_CLI_VERSION = '2.1.278'`. A floor of EVIDENCE, not of
capability: the control may well work in earlier releases, but nothing here has
tested one. Lowering it means re-running Part 1's matrix against that version
and recording the rows beside the 2.1.278 ones.

Comparison uses `src/shared/version-order.ts` `compareVersions`, which honours
prerelease precedence -- NOT `sentinel-version.ts` `compareSemver`, which
deliberately ignores it. The difference is load-bearing: an ignore-the-suffix
comparator calls `2.1.278-beta.1` equal to `2.1.278`, turning a floor of
evidence into a floor of wishful thinking. A regression test pins it.

States: `supported` / `too-old` / `unknown`. An UNPARSEABLE version is `too-old`
(we have an answer and cannot vouch for it); `unknown` means exactly one thing,
that no probe has returned yet. Both surface a blocking-severity preflight
finding with an action.

### Open interpretation, flagged for the owner

Constraint 4 says an older version "must receive an actionable upgrade
requirement, never a silent fallback". As built, that requirement is a
BLOCKING-severity preflight finding: logged loudly at every managed launch and
available to the diagnostics surface. **The spawn itself is not refused.**
Refusing it would brick multi-account work on an older CLI, and the version
probe is asynchronous, so a spawn can legitimately run before any probe has
answered. Escalating to a hard refusal is a one-line change at the call site in
`src/main/pty-manager.ts`. It is the owner's call, and it is recorded here
rather than decided quietly.

## Scope boundary: what is NOT a managed launch

The host control is applied exactly where a launch is bound to an app-managed
profile realm (`withProfileHome` with a non-null home). Three cases sit outside
it, deliberately:

- **The Default account / bare-global home.** The user's own machine, settings
  and credentials. Asserting host management there would silently disable their
  own `apiKeyHelper` in a realm this app does not manage.
- **A plain shell not pinned to a profile.** Same reason.
- **SSH / remote sessions.** The remote `claude` runs under the remote user's
  own home; there is no app-managed profile realm on that host, the probe
  evidence is local-only, and setting the flag there could break a remote user
  whose credential legitimately comes from their own helper. Hardening remote
  launches needs its own probe round against a remote host, not an
  extrapolation from these rows.

## Regression coverage, and proof it can fail

`tests/wp1/managed-launch.test.ts` -- 67 tests. Each guard was proven RED under
a mutant of the production code; the runner restores from an in-memory backup
(never `git checkout --`).

| mutant | tests failed |
| --- | --- |
| M1 host control never applied | 9 |
| M2 provider may overwrite the host control | 4 |
| M3 sanitiser leaves `apiKeyHelper` alone | 6 |
| M4 sanitiser leaves authority `env` entries alone | 4 |
| M5 sanitiser copies a file it could not parse (fail open) | 3 |
| M6 registry sanitiser falls open with no package registered | 1 |
| M7 `withProfileHome` skips the hardening entirely | 4 |
| M8 version floor ignores prerelease suffixes | 3 |
| M9 preflight never blocks | 3 |
| M10 unprobed version treated as supported | 2 |
| M11 settings copy written THROUGH a hardlink | 1 |
| M12 ambient strip narrowed to credentials only | 3 |

Twelve mutants, twelve detected, none green.

Gates at this slice: `npm run typecheck` clean; `npx vitest run` 905 files
passed / 2 skipped, 11302 tests passed / 0 failures (slice-1 baseline: 904 files,
11234 tests).

## MANUAL ACCEPTANCE MATRIX -- owed before merge, none of it run yet

Constraint 6 plus Part 1's unproven rows. **No claim of complete settings-source
isolation may be made until every row below passes.** The first row is the one
that could invalidate the design, and it is not optional:

| # | Gate | Why it cannot be automated | Status |
| --- | --- | --- | --- |
| A1 | With the host flag set, a real signed-in profile home still authenticates from its STORED OAuth credential | Part 1's `X3` proved fail-closed with NO host key present. It never tested a stored OAuth login under the flag. If the flag suppresses stored credentials too, managed sessions cannot sign in at all and the design needs rework | **RUN 2026-09-22 -- FAILED.** The flag alone makes the CLI report not signed in and refuse a request. See Part 7 |
| A2 | Two managed realms with different accounts stay distinct under the flag | needs two real signed-in accounts | NOT RUN |
| A3 | Remote / organizationally managed settings | the CLI fetches these from the server for a signed-in account; not locally observable | NOT RUN |
| A4 | Settings changed mid-session | needs a live session and a real edit | NOT RUN |
| A5 | `apiKeyHelper` suppression re-confirmed with a disposable real identity | Part 1 used synthetic keys against a loopback capture server | NOT RUN |

A1 is the risk this slice carries. The implementation is complete and the
regression suite proves the mechanism works as specified; whether the mechanism
is COMPATIBLE with the app's own credential model is an open empirical question
with a one-command answer, and it is the first thing to run on a machine with a
signed-in profile.

---

# Part 3 -- the independent review round (2026-09-21)

Two independent reviewers, neither the author, on the staged change: one for
SPEC COMPLIANCE against the six constraints in Part 2, one for CODE QUALITY and
correctness. Both read the diff and ran the suites. Their verdicts agreed on the
mechanism and on the gap.

**Mechanism:** no correctness defect found in `applyRealmEnvPatch`, no key
mismatch in the sanitise map, no `inFlight` race in the version probe, no
null-prototype breakage at any of the five spawn call sites. Constraints 1, 2, 5
and 6 assessed MET. The full enumeration of managed launch paths came back with
**no missed path**: interactive PTY, account-pinned shell-only sessions, headless
runner, insights runner (including the cross-account synthesis), cloud agents and
`claude auth status` all carry the control; SSH, the CLI setup PTY, the version
probe itself and Codex are excluded with a stated reason each.

**The gap both found:** constraints 3 and 4 were compliant in LOGIC and not in
EFFECT. Layer 4 wrote only to `app.log` -- `listManagedLaunchReports()` had no
production caller, no IPC channel and no renderer surface -- so "fail visibly"
and "never a silent fallback" described a surface that did not exist. One
reviewer put it exactly right: the defensible part was the decision not to refuse
the spawn; the indefensible part was that the requirement had no channel to
reach the user through.

## What changed in response

| # | Finding | Change |
| --- | --- | --- |
| 1 | Layer 4 was write-only; its `action` strings named UI that did not exist | New IPC channel `accountProfiles:managedLaunchReports` + `AccountIsolationNotice` in the Accounts panel, rendering `blocked` findings only (deduplicated by finding id, so six sessions with one out-of-date CLI is one row). Actions reworded to steps that exist |
| 2 | The source guard's exemption was `!text.includes('withProfileHome')` -- a WHOLE-FILE escape hatch satisfied by a comment, which permanently exempted `claude-cli-auth.ts`, the very file it was written to catch | Rewritten as a pure function with an explicit path allowlist and a PER-LINE exemption; now matches `HOME` as well as `USERPROFILE`, and property assignment as well as object literals. Given a self-test that feeds it six synthetic violations and four legitimate forms |
| 3 | The ambient strip grew 4 -> 33 names and was completely silent | New `strippedAmbient` preflight input, populated by difference in `withProfileHome`, surfaced as an `info` finding naming what was removed |
| 4 | `{ ...withProfileHome(...), HOME }` re-attached `Object.prototype` to an env deliberately built without one | `Object.assign` onto the returned object instead |
| 5 | `applyHostManagedEnv` and `preflightPassed` had no production caller; a second, weaker way to apply the control is the hazard the design forbids | Both deleted. A test now asserts the applier does NOT exist |
| 6 | Two soft claims ahead of gate A1 ("supports host-managed isolation") | Reworded to "is at or above the version the control was verified on" |
| 7 | An empty `hostManagedEnv` declaration was invisible to BOTH guards: the preflight destructured `[0]` and threw into a swallowing catch, and the `withProfileHome` assertion loop passed vacuously | Preflight iterates every declared entry and reports an empty declaration as `host-control-undeclared`; `withProfileHome` refuses an empty declaration explicitly. Mutants M13/M14 |
| 8 | `claude-cli-version` exec'd the bare name, which `claude-cli-probe.ts` documents as wrong: a GUI-launched Electron's PATH carries no Homebrew/nvm/asdf, so a healthy macOS install would read `unknown` forever and put a blocking finding on every launch | Resolves through `probeClaudeCli()` and execs the resolved path; added `ensureClaudeCliVersion()`, called from the launch path, so an install or update mid-session is picked up instead of being stuck on one failed boot probe |
| 9 | `rmSync` + `writeFileSync` left a window on EVERY spawn in which the settings copy did not exist | `atomicWriteFileSync` (staged `wx` + rename). Rename-over replaces the directory entry, so it still breaks a hardlink -- the property the unlink was there for -- with no window |
| 10 | A routine sanitise logged at WARN, per spawn, with an absolute profile path | `logInfo`, and the profile id rather than the path |
| 11 | No test covered `claude-cli-version.ts` | `tests/unit/main/claude-cli-version.test.ts`, 13 tests |
| 12 | The CLI setup PTY was not named in the scope boundary | Named below |

## Scope boundary, completed

Added to the three cases in Part 2: **the first-run CLI setup PTY**
(`src/main/ipc/setup-handlers.ts`) spawns `claude` with the raw parent
environment against the user's REAL home. It is correctly excluded -- there is no
managed realm, and asserting the control there would disable the user's own
`apiKeyHelper` on their own machine -- but it is worth naming because the source
guard can never catch it: it composes no profile env at all, so there is nothing
for the guard to see.

## OPEN QUESTION for the owner -- the strip now reaches plain shells

The quality reviewer raised one thing that is a policy call, not a defect, so it
is recorded rather than decided.

Every session pinned to an account runs under a profile home, INCLUDING
shell-only ones (`pty-manager.ts`: "EVERY session of an account -- shell-only
(plain shells + the add-account login flow) AND interactive Claude"). So the
33-name ambient strip now applies to a plain terminal tab pinned to an account,
and to every command the user runs in it.

- **For keeping it:** the add-account login flow IS a shell-only session, and it
  runs `claude /login`. An ambient `ANTHROPIC_API_KEY` reaching that shell is
  exactly the poisoning this layer exists to stop.
- **Against:** `AWS_BEARER_TOKEN_BEDROCK` is an AWS SDK variable as well as a
  Claude Code credential. Removing it from a pinned shell changes the behaviour
  of the user's `aws` CLI in that tab -- which is close to the thing the owner
  ruled out for Codex ("do NOT broadly remove unrelated AWS/Azure/GCP
  developer-tool variables").

As built: the strip stays, and it is no longer silent -- the preflight now names
everything it removed. If the owner wants it narrowed, the natural split is
"always strip" (config-root + credential) versus "strip only for a launch that
actually runs the Claude CLI" (routing + provider-switch), which `spawnPty`
already has the information to decide (`shellOnly`).

## Coverage after the review round

`tests/wp1/managed-launch.test.ts` 72 tests + `tests/unit/main/claude-cli-version.test.ts`
13 tests. **16 mutants, 16 detected** -- the original 12 plus four for the
review-driven fixes:

| mutant | tests failed |
| --- | --- |
| M11 settings copy written THROUGH a hardlink (plain write) | 1 |
| M13 package declares NO host control (vacuous assertion) | 17 |
| M14 preflight checks only the FIRST declared control | 4 |
| M15 source guard back to the whole-file exemption | 1 |
| M16 version probe execs the bare name, not the resolved path | 1 |

Gates: `npm run typecheck` clean; `npx vitest run` 906 files passed / 2 skipped,
11320 tests passed / 0 failures.

**The manual acceptance matrix in Part 2 is unchanged and still entirely NOT
RUN.** Both reviewers independently ranked gate A1 -- does a real signed-in
profile home still authenticate from its stored OAuth credential with the host
flag set -- as the thing that should be run first, because it is the only one
that can invalidate the design rather than refine it.

---

# Part 4 -- review round 2 (2026-09-21)

Both reviewers re-ran against the round-1 fixes. Both confirmed every fix landed
and nothing regressed. Both then found new defects, and they converged
independently on the most serious one -- which is the strongest signal in this
record, because neither could see the other's report.

## The defect round 1 CREATED

**A malformed settings file put its own contents on screen.**

`sanitizeClaudeManagedSettings` interpolated the raw `JSON.parse` error into
`refused`. V8 does not just name the position; it quotes a WINDOW OF THE SOURCE.
Confirmed on Node 24.18.0 on this host:

```
JSON.parse('{ "env": { "ANTHROPIC_API_KEY": sk-ant-api03-REALSECRET-abcdef } }')
-> Unexpected token 's', ..."API_KEY": sk-ant-api"... is not valid JSON
```

That string became a `blocked` finding, travelled over the new IPC channel and
rendered in the Accounts panel. It had been log-only until round 1 promoted it
to a screen, and a half-edited credential line is one of the likelier ways to
malform a settings file in the first place. It also contradicted the
"names keys, never values" guarantee asserted in four separate doc comments.

Fixed: `jsonErrorPosition()` keeps the position and discards the message text.
V8 has two shapes -- the positional one ("... at position 2 (line 1 column 3)")
carries no content and its position is kept; the "Unexpected token 's', ..." one
carries ONLY content and is dropped whole. The `fs` read-failure path got the
same treatment: the errno only, never the message, because a Node fs error
embeds the absolute path and therefore the OS username. Mutant M17, plus a
regression test that feeds a malformed file containing a syntactically-shaped
key and asserts none of it survives into `refused`.

## The interaction the two round-1 fixes created between themselves

**Blocked findings never cleared.** The notice scanned all fifty retained
reports and kept the first occurrence of each finding id -- which answers "has
anything ever gone wrong" rather than "is my isolation OK now". So the version
probe's new recovery path (install the CLI, `ensureClaudeCliVersion()` picks it
up) was invisible through the new panel: the user would keep being told to run
`claude --version` until fifty more sessions pushed the stale report out. Same
for `settings-copy-refused` after the user fixed their JSON.

Fixed: only the NEWEST report per profile home is consulted. Mutant M18, and a
renderer test whose name is the property ("CLEARS once the newest launch for
that home is clean").

## The rest of round 2

| Finding | Change |
| --- | --- |
| The ambient strip was reported as `info`, and the panel rendered `blocked` only -- so the "it is no longer silent" half of the Part 3 disposition was true in the log and not in the product | `info` findings now render behind a "Show what account isolation changed for your sessions" toggle. Quiet, not absent. Mutant M21 |
| That finding's detail said "set these per account in AI Code Conductor instead" -- there is no per-account env feature. A dead-end instruction, the same class as the dead-end `action` strings fixed in round 1 | Sentence dropped |
| `ensureClaudeCliVersion()` re-probed on every managed spawn while the answer was unknown, and `probeClaudeCli()` caches nothing between calls -- so a machine with no resolvable CLI started a fresh LOGIN SHELL resolution (8s timeout, three candidates) per session | 60s floor after a failed probe. A DELIBERATE `probeClaudeCliVersion()` still ignores it. Mutant M19, two tests |
| `strippedAmbient` was computed by plain set difference, so it also reported keys `applyRealmEnvPatch` drops for being unrepresentable (an `=`, NUL, CR or LF in the name) under the label "authority variables were removed" -- a claim the data did not support | Intersected with the provider's own declared list, read from the registry via a new `ambientAuthVariablesForProvider()` rather than restated in the launch path. Mutant M20 |
| The "non-secret by construction" claim on the channel was overstated in four places | Reworded to what actually holds now: names keys and variables, never a credential value, with the two text-carrying paths reduced in the main process before they leave it |

Two items were raised and deliberately NOT changed:

- **`host-control-altered` prints the observed value** (`is "0", expected "1"`).
  It is a value, but it is the host flag's own value and can never be a
  credential; the path is near-unreachable because `withProfileHome` throws
  first. The doc comments now say "never a credential value" rather than "never
  their values", which is the accurate claim.
- **The source guard is sensitive to prose** -- `HOME\s*:` in a doc comment or
  an interface field in a non-allowlisted file would fail a security test for a
  non-security reason. Verified clean across all of `src/` today, and the
  failure message prints the offending line, so the cost of a false positive is
  one read. Recorded rather than loosened, because loosening it is how the
  round-1 version of this guard became useless.

## Coverage after round 2

| suite | tests |
| --- | --- |
| `tests/wp1/managed-launch.test.ts` | 74 |
| `tests/unit/main/claude-cli-version.test.ts` | 15 |
| `tests/unit/renderer/account-isolation-notice.test.tsx` | 8 |

**21 mutants, 21 detected** -- the 16 from Part 3 plus M17 (JSON error echoed
verbatim), M18 (notice scans all reports), M19 (no probe backoff), M20 (stripped
list not intersected), M21 (notice drops info findings).

Gates: `npm run typecheck` clean; `npx vitest run` 907 files passed / 2 skipped,
11332 tests passed / 0 failures.

## Standing, after two rounds

Both reviewers' verdict is the same: proceed to the manual gates. The
**manual acceptance matrix in Part 2 remains entirely NOT RUN**, and gate A1 --
does a real signed-in profile home still authenticate from its stored OAuth
credential with the host flag set -- is still the row that can invalidate the
design rather than refine it. Nothing in two rounds of review changed that, and
nothing in the code can.

Three decisions are recorded for the owner rather than taken quietly:

1. the four-key sanitiser scope where the instruction named one key (Part 2);
2. a CLI below the floor produces a blocking, visible requirement but does not
   refuse the spawn (Part 2);
3. the 33-name ambient strip now reaches plain account-pinned shells (Part 3).

---

# Part 5 -- ADR-009 remediation round (2026-09-21)

An adversarial pass over the slice-2 tree returned one blocker and nine findings.
Findings 4-7 were closed in the preceding session and are recorded in the commit;
this part records what closed the rest, and the probe that turned four VOID rows
from Part 2 into decided ones.

## The provider-conditioned helpers -- now decided, not assumed

Part 2 could say only that `apiKeyHelper` is suppressed by the host control. The
other four credential helpers produced VOID rows: they never fired **even in the
control**, because that run gave the CLI no reason to reach for them -- no
Bedrock, no Vertex, no configured proxy. A row whose control does not fire says
nothing about the test.

This run supplies the preconditions, with synthetic values only: loopback capture
servers in place of the Bedrock, Vertex, proxy and Anthropic endpoints, **no real
cloud credential anywhere** (the point is that the CLI has none and must run the
helper to get one), and sentinels that record that they ran and echo a
syntactically shaped fake answer. Each helper is probed twice, control then
hosted.

| row | preconditions | helper(s) | control fired | with host flag | verdict |
| --- | --- | --- | --- | --- | --- |
| B1/B2 | `CLAUDE_CODE_USE_BEDROCK=1`, region, loopback Bedrock endpoint, no AWS credentials | `awsAuthRefresh`, `awsCredentialExport` | **both** | **neither** | SUPPRESSED |
| V1/V2 | `CLAUDE_CODE_USE_VERTEX=1`, project, region, loopback Vertex endpoint, no GCP credentials | `gcpAuthRefresh` | **yes** | **no** | SUPPRESSED |
| X1/X2 | `HTTPS_PROXY` at a loopback capture, `CLAUDE_CODE_ENABLE_PROXY_AUTH_HELPER=1` | `proxyAuthHelper` | **yes** | **yes** | **NOT suppressed** |

Two details that make B2 and V2 more than an absence:

- B2 did not merely fail to run the helper, it refused the credential class
  outright and sent nothing: *"Bedrock credentials are managed by the desktop
  app, but none are available."* The capture server recorded a request in B1 and
  none in B2, so the host flag fails CLOSED on that path rather than falling back.
- V2 ended on the ordinary "could not load Google Cloud credentials" error, i.e.
  the CLI looked for credentials the normal way and never consulted the helper.

**X1/X2 is the finding, and it corrects a claim.** `proxyAuthHelper` fires under
the host flag exactly as it does without it. Both rows exited at `Not logged in`,
so what this shows precisely is that the helper is invoked while the connection
is being configured, before authentication, and that the flag makes no difference
at that point. So:

- the helpers that can supply a **model credential** -- `apiKeyHelper`,
  `awsAuthRefresh`, `awsCredentialExport`, `gcpAuthRefresh` -- are suppressed by
  the host control in every settings scope. All four are now behaviourally
  proven, where Part 2 could prove only the first;
- `proxyAuthHelper` is **not** suppressed by the host control, in any scope. It
  is removed from the app-owned settings copy and nowhere else. That is
  acceptable and is recorded rather than fixed: it mints a `Proxy-Authorization`
  header for whichever proxy the environment already selects, and the proxy
  selector (`HTTPS_PROXY` and friends) is deliberately PRESERVED under D18 item
  1, so the helper selects no account, credential source or model endpoint. The
  claim that had to change is the wording, not the disposition.

The authentication PINS (`forceLoginOrgUUID`, `forceLoginGatewayUrl`,
`gatewayInternalNetworks`) remain what Part 2 said they were: binary-path
evidence plus app-owned-copy sanitisation, with no local observable. They stay on
the remote/organisational manual gate. `forceLoginMethod` keeps its verbatim
binary-path evidence at @199007641.

Probe: `probe/d13b.mjs` in the session scratchpad, with per-row transcripts and
`results-d13b.json`. It is a maintainer tool against a pinned CLI, not a test.

## The credential-store selector the CLI enumerations do not list

The generated manifest is derived from two enumerations the CLI maintains. Those
are what the CLI singles out, which is not the same set as everything that
decides which stored identity a launch resolves: a credential-STORE selector is
read before either filter is consulted, so neither enumeration contains it and
the extraction alone missed it.

`CLAUDE_CODE_FORCE_WINDOWS_CREDMAN` is now classified in this repo as a
`claude-realm-root` and removed on both axes -- out of the inherited environment
of every managed launch, and out of the `env` block of the settings copy the app
writes. It is recorded in the manifest under a fifth source, `repo-added`, and
the generator asserts that each `repo-added` name still OCCURS in the pinned
binary, so the list cannot drift back into a hand-maintained denylist carried
forward on faith. AT THE TIME THIS PARAGRAPH WAS WRITTEN the manifest was 169
entries (was 168), 89 stripped from the settings copy and 85 from the ambient
environment, with a digest beginning `2c69fac6`. **Those figures are history,
not the shipped artefact**: the census added in later rounds took the manifest to
1,167 entries. The current counts, digest and scope are in Part 6, which is the
only place they are stated. Unchanged throughout: schemaVersion 2, cli 2.1.278,
win32-x64, binary sha256 `006ea5c8638f67f10a5ae66bb232fd267c9f6af294e3f03f4cfcf1fd3f2cced8`.

## D17 -- what the guarantee covers, stated the same way everywhere

The owner's ruling is that host management suppresses **provider and
authentication authority** and nothing else: ordinary settings, hooks included,
continue to operate, and this app does not sandbox code the same OS user can
already run. The probe supports both halves -- the flag refuses
`ANTHROPIC_API_KEY`/`ANTHROPIC_BASE_URL` from a settings `env` block and
suppresses the credential helpers, while a `SessionStart` hook still executes.

That wording now appears in three user-facing places rather than only in code
comments: the Feature Guide / Ask Conductor knowledge (`settings-scope`, plus a
"what account isolation does NOT cover" entry under known issues), and the user
guide's *Multiple accounts* section. A regression test asserts the code half of
the pair as one fact: the same settings file loses `apiKeyHelper`,
`forceLoginMethod` and its `env` authority entry while its `hooks`, `statusLine`,
`outputStyle` and `permissions` survive byte-identical.

## The Accounts panel was importing a component it never rendered

Worth recording because no test caught it and the whole of layer 4 was invisible
in the UI: when the notice became per-account it was removed from the panel body
and never added to the account row, so `AccountIsolationNotice` was imported and
unused. It now renders inside each account's row, and a panel test asserts that
one request is made per account id and that a finding appears under the account
it belongs to and nowhere else.

# Part 6 -- ADR-009 rounds 2 to 9, the D3 re-ruling, and the full mutation scope (2026-09-22)

**Scope of every claim in this part.** Claude Code **2.1.278**, **win32-x64**,
binary sha256 `006ea5c8638f67f10a5ae66bb232fd267c9f6af294e3f03f4cfcf1fd3f2cced8`.
Nothing here is a claim about another CLI version or another platform. Where a
statement about Linux or macOS appears it says whether it was MEASURED or
REASONED, and almost all of them are reasoned: the only host these rounds ran on
is Windows.

**The manifest is a census, not a policy.** It now has **1,167 entries**. That
number is what five read forms found in one binary: every name in one of the
CLI's own namespaces (875, after round 8) and every authority-shaped name
outside them. It is not the isolation policy and it is not a completeness
claim: **145** of those entries are stripped from the settings copy and **141**
from the ambient environment, and the other thousand-odd are inventoried and
deliberately KEPT, each with a ruling of its own. Which entries are removed is
decided separately, by D3, and that decision is what most of this part is
about. Manifest digest
`f1f309fa9cfcd523dcc0def0f0af8dd3a1740ee873b5fb05ecf973ad7efff31c`;
`gen-claude-authority-manifest.mjs --check` reproduces it byte for byte from the
pinned binary.

**Correction to Part 5.** Part 5 quotes "169 entries ... 89 stripped ... 85 from
the ambient environment" and a digest beginning `2c69fac6`. Those figures were
true of the manifest when that paragraph was written and are not true of the
manifest this change ships. Part 5 has been amended to say so; the figures above
are the current ones.

## Rounds 2 and 3 -- owed from the previous part

**The threadpool finding.** The project-settings scan ran `statSync` and
`readFileSync` on the synchronous spawn path, and a working directory on an
unreachable share froze the Electron main thread for 42 seconds, measured twice.
Moving it off that path and racing it against a two-second deadline was not
enough: `fs.promises.open` takes no AbortSignal, so the deadline abandons the
await and leaves the syscall running on the libuv pool. Four launches consumed
the whole default four-thread pool and stalled every `fs.promises` call and DNS
lookup in the process for 21 seconds. The fix was a UNC refusal before any
syscall plus SINGLE-FLIGHT, with the flag released when the SCAN settles rather
than when the deadline does. Round 5 found that this was still not a bound --
see below.

**The census.** Rounds 2 and 3 each found another hand-anchored enumeration the
extractor had missed (the identity names, then the background-auth snapshot path
and the messaging token, then a name outside every listed namespace). Adding a
fourth and fifth anchor was the defect, not the cure, so the generator stopped
anchoring and began CENSUSING the binary, with a hard failure for any
authority-SHAPED name that has no ruling. Non-Claude names are settled by three
documented family rules; a Claude- or Anthropic-namespaced name settled by a
family rule is refused by the validator.

**The probe/launch split and `'not-evaluated'`.** The `claude auth status` probe
behind the Accounts panel is a real managed launch and recorded a report of its
own, newer than the session it described, so opening the panel replaced what the
panel was about to show. Reports now carry a `kind`, live in two rings, and the
notice answers with the newest non-probe. Separately, a launch that never built
the profile home reported the settings copy as CLEAN; there is now a third state,
`'not-evaluated'`, and "there was no shared settings file to copy" records
`{removed: []}` so a healthy install does not carry a permanent notice.

## Round 4 -- the census could not see four read forms

Three patterns is what round 3 shipped. The pinned binary uses at least four
more, and a bearer token was hiding behind each:

| read form | why round 3 missed it | what it hid |
|---|---|---|
| a list containing a SPREAD | the pattern matched a whole `[...]` literal, so one `...x` inside made it match nothing | the CLI's own token list |
| an alias longer than two characters | `\w{1,2}` | `this.deps.env.NAME` |
| a typed env-schema object KEY | the name exists only as a key; every consumer is rewritten to a local binding | the CLI's authentication module (six such maps ship) |
| a lone quoted argument | no list to belong to, no key to be | the environments worker's key, sent as `authToken` |

The census now uses five forms: spread-tolerant list RUNS, `process.env.NAME`,
alias reads of any depth, object keys, and standalone quoted literals. A run is
an environment list when at least ONE member is namespaced -- a presence test,
deliberately not the majority vote round 3 removed, because the secret-redaction
list is four Claude names out of nine. **Stated limit:** a name ASSEMBLED AT
RUNTIME from fragments is invisible to any literal scan, and the binary contains
some. That residual is recorded in the classification header and in the
manifest's own provenance text rather than closed.

**A family rule had swallowed a Claude credential.** `ENVIRONMENT_SERVICE_KEY`
carries no Claude prefix, so the rule "a Claude name needs a ruling of its own"
did not apply, and the third-party family ruled it KEEP on both axes with a
reason that was false of it. The generator now extracts the lists the CLI ITSELF
designates as secret names, and membership forces an exact ruling whatever the
prefix. Round 5 found two more members of the same list with the same false
reason, which is why that rule is structural rather than a one-name patch.

**The Anthropic profile store.** The SDK resolves its config root as
`ANTHROPIC_CONFIG_DIR`, then `%APPDATA%\Anthropic`, then
`%USERPROFILE%\AppData\Roaming\Anthropic` (elsewhere `$XDG_CONFIG_HOME/anthropic`,
then `$HOME/.config/anthropic`). Redirecting the home alone therefore moved
nothing, and `APPDATA` and `XDG_CONFIG_HOME` had been ruled `replace` -- "the
fake-home mechanism sets this" -- while nothing set either. How that was fixed
is the subject of owner requirement 4, below.

## The D3 re-ruling of the 49 hand rulings (owner requirements 1 to 3)

Round 4's first pass over the widened census stripped on resemblance: "this app
never sets it, so stripping is harmless". That is not the rule. **D3** removes a
variable only when it can override the selected **account, credential, provider
or provider endpoint**; an interactive session otherwise INHERITS the developer's
environment, and a strip that redirects nothing is a cost with no benefit. All
49 were re-ruled against that test, and an independent attacker then re-checked
every one against the binary: **44 agreed, 5 had a correct disposition resting on
a wrong or unproven reason, none was an over-strip and none an under-strip.**

| disposition | names | what decided it |
|---|---|---|
| REMOVED -- credential | `ANTHROPIC_ENVIRONMENT_KEY`, `CLAUDE_CODE_HFI_BEARER_TOKEN`, `ENVIRONMENT_SERVICE_KEY` | each is sent as a bearer credential on an Anthropic-side request |
| REMOVED -- child helper | `CLAUDE_CODE_PROXY_URL`, `_HOST`, `_AUTHENTICATE` | assigned CONDITIONALLY into a credential-minting helper's environment, so an inherited value survives where the CLI has none of its own |
| kept -- inbound secret | `ANTHROPIC_WEBHOOK_SIGNING_KEY` | verifies inbound payloads; never sent; selects nothing |
| kept -- identifier | `ANTHROPIC_SESSION_ID` | see below |
| kept -- log sink | `CLAUDE_CODE_DEBUG_LOGS_DIR` | see below |
| kept -- exec path | `CLAUDE_CODE_POLICY_HELPER_PS1_PATH` | command execution, the accepted D17 class beside `PATH` and `CLAUDE_CODE_GIT_BASH_PATH` |
| kept -- CLI-set | eleven `CLAUDE_RUNNER_*`, the marketplace/plugin/MCP helper URLs, `CLAUDE_TEST_PROJECT_DIR` | assigned UNCONDITIONALLY from the CLI's own state, so an inherited value is overwritten before anything reads it |
| kept -- non-model endpoint | `CLAUDE_CODE_GB_BASE_URL`, `CLAUDE_CODE_DEV_RAW_CHANGELOG_URL` | feature flags and a changelog; no account credential, not a provider endpoint |
| kept -- not a variable | `CLAUDE_AI_AUTHORIZE_URL` | a key in the CLI's OAuth constants object |
| kept -- subcommand credential | `SELF_HOSTED_RUNNER_POOL_SECRET`, `SELF_HOSTED_RUNNER_ENVIRONMENT_SECRET` | Anthropic-side, but read only by a subcommand a managed launch never runs |
| kept -- third-party credential | nineteen registry, cloud and MCP-server secrets | D18 item 2; each now ruled BY NAME because the CLI lists it as a secret |

**`CLAUDE_CODE_DEBUG_LOGS_DIR` is preserved (requirement 2).** Every read of it is
the log-path chain, and the writer only creates directories, appends, rotates
and marks a latest-symlink. Nothing is ever read back from that directory, and no
credential, configuration or provider decision consults it. An independent
attempt to find static or behavioural evidence of an account or provider effect
found none. The residual is recorded rather than used to justify a strip: an
inherited value decides WHERE a transcript is written, which is a confidentiality
question and the accepted D17 class, not an isolation one.

**`ANTHROPIC_SESSION_ID` is preserved (requirement 3).** It reaches exactly one
place: the `data: {type: "session", id}` field of a work-order payload. The only
authorisation on that call is the separate environment key, which IS removed, and
the read is an exact, unnormalised environment lookup, so there is no alias path
around that removal. It therefore cannot override managed identity. On
cross-account attribution: work is scoped by the environment id plus that key, so
with the key gone the id selects nothing, and a party who already holds the key
does not need the id.

**One recorded reason was false and is corrected in place.** The marketplace,
plugin-archive and MCP headers helpers were first ruled kept because their
environments were "built FRESH, with no `...process.env` spread". They are not:
all three route through the CLI's subprocess-environment helper, which returns
the ambient environment. The disposition holds on the SAME test as the runner
group -- each name is assigned unconditionally and applied last.
Conditional-versus-unconditional is the rule. Fresh-versus-spread never was.

## Round 5

**The realm store's Linux half was a no-op.** The store was first placed at
`<home>/.config/anthropic` off Windows. `mirrorRealHome` links every dot-entry of
the real home into the profile home and excludes only `.claude` and
`.claude.json`, so `<profileHome>/.config` IS the developer's real `~/.config`
and every profile resolved one shared store -- the round-4 defect surviving inside
its own fix. This was proven by execution against the pinned binary with the
mirror semantics reproduced literally, not reasoned. Both stores now live under
`.claude`, the one directory the mirror excludes, on every platform.

**A second credential backend.** Claude Code's own OAuth store can be backed by
the Windows Credential Manager under a service name that gains a directory hash
ONLY when `CLAUDE_SECURESTORAGE_CONFIG_DIR` or `CLAUDE_CONFIG_DIR` is set. A
managed launch set neither, so the name was a per-OS-user CONSTANT, and that
backend is selected by a server-side feature flag rather than by this app or the
user. It is off in the pinned build, which makes the collapse latent rather than
absent. The realm patch now owns and sets `CLAUDE_SECURESTORAGE_CONFIG_DIR`, which
keys both backends on the profile. Nothing outside Claude Code reads that
variable, so fidelity is untouched. **Not demonstrated:** no entry was written to
the Credential Manager to show the cross-account read; the mechanism is read from
the binary.

**An incomplete SHAPE test, not an incomplete census.** Three names were already
among the census's names and never became entries, because the authority-shape
pattern did not match them and so the hard-failure gate never fired:
`CLAUDE_CODE_RATE_LIMIT_TIER` and `CLAUDE_BG_DISPATCHER_RATE_LIMIT_TIER` -- the
tier twins of two names already stripped as account pins, which the CLI writes
together out of authenticated account state and scrubs together from its own
children -- and `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`, which turns off the CLI's own
credential redaction for every subprocess. The pattern now covers both shapes,
the gate fired on exactly those three, and each is ruled. A sixth namespace,
`ANT_`, was added to the census for the same typed-map read form.

**The watchdog was not a bound.** Round 4 added a 60-second watchdog so one
wedged mount could not disable the project scan for the life of the process, and
described the cost as "at most one more occupied thread". It was one more PER
WINDOW: re-opening the flag does not return the thread, so repeated launches into
one dead mapped drive stranded the whole pool for good. The flag is no longer the
bound. A count of scans STARTED AND NOT SETTLED is, with a ceiling of two -- half
the default pool. At the ceiling the diagnostic turns itself off and says so
once. **Stated residual:** a mapped drive or a junction onto a dead host is still
not detectable from the path string, and two of them cost this feature.

**The rest.** The size caps are now fixed-buffer reads of cap-plus-one bytes, so a
byte past the cap IS the refusal whatever a stat said; the terminal failure line
strips C1 controls as well as C0, because `U+009B`, `U+009D` and `U+009C` are CSI,
OSC and ST as single code points and NTFS permits them in a file name; the sanitise
record is cleared at the top of the home build and written after the atomic write;
a deleted shared settings file now removes the account's copy; and the probe rule
is "every call site states `probe`" rather than a list of five files.

## Owner requirement 4 -- isolation and developer-tool fidelity, both

The first fix redirected `APPDATA` and `XDG_CONFIG_HOME` into the profile home.
That isolates the store and breaks everything else that reads those variables:
`gh` keeps its OAuth tokens under `%APPDATA%\GitHub CLI`, npm its cache and global
prefix, git its XDG-style configuration. It was replaced before it was attacked.

`ANTHROPIC_CONFIG_DIR` is consulted FIRST and returns immediately, so owning it
isolates the store while `APPDATA` and `XDG_CONFIG_HOME` stay at the developer's
own values. They are ruled `superseded-config-root`: stripped from a settings
`env` block, KEPT from the ambient environment. `ANTHROPIC_CONFIG_DIR` and
`CLAUDE_SECURESTORAGE_CONFIG_DIR` are ruled `strip` AND are owned by the realm
patch -- not `replace` -- so a poisoned value is removed on every platform and the
app's own is set only where it has one. `replace` would have been a hole on macOS,
where neither is set.

| | win32 | linux | darwin |
|---|---|---|---|
| (A) isolation of the identity stores | HOLDS -- measured: with a profile under `%APPDATA%\Anthropic` and the first key pointed elsewhere, the CLI reported not signed in | REASONED to hold after the move under `.claude`; the pre-move failure was measured on win32 with the Linux mirror semantics reproduced, not on a Linux host | not attempted: the home is not redirected, multi-account is disabled, and the store is stripped and not re-set |
| (B) `gh` | HOLDS -- measured live inside a managed launch | reasoned | reasoned |
| (B) `git` | HOLDS -- measured; the global config resolves from the real file | reasoned; a global config kept ONLY at the XDG path is lost, which predates this change | as linux |
| (B) `npm` | HOLDS -- measured: userconfig, prefix and cache all real | reasoned | reasoned |
| (B) ordinary child processes | HOLDS -- inherited unmodified apart from one appended PATH entry | reasoned | reasoned |

**The one place the two properties genuinely collide** is the Anthropic SDK's own
store: Anthropic's command line tool, or an SDK script, run from inside a managed
session now sees that account's private store rather than the developer's. That
store IS the identity store isolation is about, so isolating it is the correct
resolution; it is user-visible with a workaround and has a known-issues entry.

**No design blocker was found.** Both properties hold at once on the platform
where both could be measured.

## Owner requirement 5 -- oversized or malformed settings

Verified end to end by reading and then by test: an oversized file, invalid JSON,
JSON that is not an object, and JSON `null` are each RECORDED with a reason the
user can act on, surface as a `blocked` finding rather than `info` (the Accounts
panel renders `blocked` as a warning and collapses `info` under routine
activity), remove any stale copy so old settings do not keep applying in silence,
and leave the source file byte-for-byte unchanged. No path through the copy opens
the source for writing.

## Owner requirement 6 -- the FULL mutation scope across Slice 2

An earlier handoff quoted "33 mutants across five rounds, 32 detected". **That
figure could not be reproduced and is withdrawn.** The five runners from those
rounds define **49** mutants, and their result files held only 14 because each
partial re-run overwrote the file. All 49 were therefore re-run in full against
the FINAL tree, which is the only tree the number should describe.

| set | defined | detected as written | corrected, then detected | not detected |
|---|---|---|---|---|
| rounds 1 to 5 of the earlier sessions (M, N, R, C, F) | 49 | 43 | 4 (M1, M5, F2, R2: anchor drift) | 2 (N6, N7) |
| round 4 of this session | 8 | 6 | 0 | 2 superseded (see below) |
| round 5 of this session | 12 | 10 | 2 (R5-7, R5-12: invalid as first written) | 0 |
| the combined mutant that settles N6 | 1 | 1 | 0 | 0 |
| round 6 of this session (the re-attack fixes) | 3 | 3 | 0 | 0 |
| round 7 of this session (the second re-attack) | 7 | 6 | 1 (R7-5: the test never reached the floor) | 0 |
| round 8 of this session (the round-7 confirm, and its confirm) | 10 | 10 | 0 | 0 |
| round 9 of this session (the independent code-quality review) | 9 | 9 | 0 | 0 |
| **all** | **99** | **88** | **7** | **4** |

ONE bucketing rule, applied to every row: a mutant counts as "detected as
written" only if its FIRST definition applied and was caught. A first draft of
this table put round 5 at 12 of 12 while its own raw results recorded R5-7 as
"test did not run" and R5-12 as "survived" before both were corrected -- the same
thing the row above calls a correction. The prose said so; the table did not, and
a table is what gets skimmed.

The four that are not detected, each accounted for rather than rounded away:

- **N7** -- the `isFile()` half of the project-scan guard. Its only discriminating
  test needs a POSIX FIFO and is skipped on win32 at an `it.skipIf` that says so.
  A PLATFORM survivor: untested HERE, not untested.
- **N6** -- the project stat-size check removed on its own. It is now an
  EQUIVALENT mutant: the fixed-buffer bound added in round 5 refuses the same
  file. Proven rather than asserted -- removing the stat check alone survives,
  and removing BOTH bounds is detected.
- **round 4's "size cap removed" and "APPDATA no longer set"** -- the code each
  mutated no longer exists. Their successors are round 5's buffer-bound and
  realm-store mutants, all detected.

Two things the re-run found that a quoted number would have hidden. **R2** --
"the flag is released on the DEADLINE, not the scan", the mutant for the original
starvation bug -- had silently stopped being that mutant: its main edit no longer
matched, a secondary edit still changed the file, so it reported "applied" while
mutating something harmless. Re-anchored to its real intent it SURVIVED, because
every test finished inside the two-second deadline. An assertion now advances
past the deadline and requires the flag to still be held, and the mutant is
detected. And **two of round 5's own mutants were invalid as first written**: one
had no test that isolated it, and one mutated a spread that the literal after it
overrode, so it changed nothing. Both were corrected and re-run; the first needed
a new test.

**Guards with no mutation evidence, stated plainly:** the census SHAPE pattern and
the generator's read forms themselves, which can only be exercised against the
proprietary binary -- the suite asserts that the names they found are in the
shipped manifest, not that a narrowed pattern would still find them; the
two-second deadline as
a TIMING value (its ordering against the flag is covered, its magnitude is not);
the project scan's cap-plus-one skip when a file grows between stat and read,
which needs a concurrent writer to reach; and the manifest-derived strip lists
under a corrupt manifest, which are covered only transitively, by the test that
the module refuses to load at all.

## Round 6 -- the re-attack

One verification round, the same four attackers. **No blocker.** Both round-5
blockers were re-proven fixed by execution: with the mirror reproduced and a
shared store under the real home, the old realm path reported signed in and the
new one did not; and an existing signed-in profile stayed signed in with the
secure-storage root set, while an unrelated directory signed it out, so the
variable selects the store and the chosen value is continuity-safe. Writing to
the Credential Manager to demonstrate the hashed service name was, again, not
done.

What the re-attack still found, all fixed:

- **The `ANT_` fix reopened the hole it sat beside.** Adding the namespace to the
  census made the family visible and nothing more: the exact-ruling rule still
  tested CLAUDE and ANTHROPIC only, so every `ANT_` name fell to the catch-all
  family rule -- whose reason, "not an environment variable the CLI reads", was
  false of both that landed -- and a future `ANT_` bearer would have been kept
  with no hard failure. The rule and the validator guard now both cover `ANT_`,
  and the two entries carry their own ruling (telemetry endpoints, kept).
- **`_OVERRIDES` was not an authority shape.** With it added, the gate asked about
  `CLAUDE_INTERNAL_FC_OVERRIDES` -- the feature-flag override channel, which the
  CLI lists in its own provider-env allowlist -- and
  `CLAUDE_CODE_EVAL_ALLOW_FLAG_OVERRIDES`. Both are INERT in the pinned build: the
  consumer is a stub. They are ruled by the owner's existing precedent for
  exactly that, D16 item 8 -- stripped, because inactivity is pinned-version
  evidence and not a contract -- and the precedent has some force here, since what
  the channel would override is feature flags and the credential-store backend is
  selected by one. **This is the one ruling in this part made by precedent rather
  than by a D3 effect in the pinned binary, and it is flagged for the owner as
  such.**
- **`HOME` was ruled `replace` and set on one platform of three.** That is the
  shape of the `APPDATA` defect, kept true-by-exception. Its behaviour is
  unchanged -- stripping it breaks Git Bash, setting it on macOS breaks the
  keychain -- but it now has a kind of its own, `posix-home-selector`, that says
  what happens to it, and `replace` means `USERPROFILE` alone, which IS set
  everywhere the realm is redirected.
- The terminal failure line now also strips bidi overrides and isolates and the
  Unicode line and paragraph separators, which are not controls but spoof as well;
  a stale comment about why the realm store is created eagerly was corrected, and
  the store is now created after `.claude` is hardened rather than before; and the
  generator's census paragraph no longer says "every".

**Considered and deliberately left unruled**, with the attacker's agreement on each:
`CLAUDE_PLUGIN_ROOT` and `CLAUDE_CODE_MARKETPLACE_NAME` are assigned conditionally
and do reach a helper, but a plugin path and a marketplace name select no realm;
`CLAUDE_CODE_POLICY_HELPER_PSMODULEPATH` and `CLAUDE_ENV_FILE` are command
execution under the same OS user, the accepted D17 class, and the second runs
after credentials are resolved and reaches only the Bash tool's children; and five
OAuth and host CONSTANTS remain stripped as endpoints although they are not
variables, which costs nothing and is untidy rather than wrong.

**Open and out of scope, stated rather than buried:** the profile-home build is
still fully synchronous -- some sixty blocking calls per spawn with no deadline --
so a resources directory on an unreachable share freezes the main process. It
predates this change, this change made it slightly smaller rather than larger
(one bounded read in place of a stat and an unbounded one), and rewriting it
touches all five launch paths and the boot-time repair.

## Round 7 -- the second re-attack

Two of the four attackers had open findings after round 6 and were asked to
verify the fixes. The evidence auditor returned PASS. The policy attacker passed
the ANT_ instance and found the CLASS was still open: the exact-ruling rule and
the validator guard were a three-item prefix list while the census treated
CCR_, AGENT_PROXY, SESSION_INGRESS and the two OAuth switches as the CLI's own
-- so AGENT_PROXY_AUTH_TOKEN is stripped as a credential while a hypothetical
AGENT_PROXY_AUTH_TOKEN_V2 would have been family-ruled keep with no hard
failure. The third occurrence of the ENVIRONMENT_SERVICE_KEY defect.

**Fix: one list.** CLI_OWNED_NAMESPACES is declared once in the classification
module; the generator builds the census namespaces from it and writes it into
the manifest as provenance.cliOwnedNamespaces; the runtime validator reads THAT
copy, refuses a manifest without it or one that drops the CLAUDE/ANTHROPIC
floor, and the list is in the digest; the WP1 suite checks the manifest's copy
against the module's. **The moment the list existed the gate found two more**:
CCR_OAUTH_TOKEN_FILE, a credential SOURCE the CLI reports as its login method
(now claude-credential, stripped), and CCR_SESSION_ACCOUNT_EMAIL, a session
identity written into the git hook the CLI installs (now account-pin,
stripped). Both had been family-ruled keep while their sibling
CCR_SESSION_PROFILE was stripped.

The same attacker also showed the round-6 ruling of
CLAUDE_CODE_EVAL_ALLOW_FLAG_OVERRIDES was WRONG: it is not stubbed, it is live
in the pinned build, and the CLI's own error text says its value "must come
from the operator's shell". An operator opt-in that selects nothing is what D3
preserves, so it is now kept (non-redirecting-operator-switch) with that
evidence; CLAUDE_INTERNAL_FC_OVERRIDES stays stripped under D16 item 8.

Manifest after round 7: 564 entries, 144 stripped from the settings copy, 140
from the ambient environment, digest beginning `89bb1dc3`. Superseded by round
8, below; the figures at the top of this part are the current ones.

## Round 8 -- the round-7 confirm, and the gate that was written but not built

The policy attacker was asked once more to confirm the round-7 fixes and
nothing else: the one shared namespace list, the two CCR rulings, the
eval-switch keep. It confirmed all three -- the three regexes are built from
one list with identical construction, the list is in both digests, the floor
cannot be bypassed through the validator's charset, the eval switch selects
nothing and runs in a realm the eval harness builds itself, and
`CCR_SESSION_ACCOUNT_EMAIL` is set beside the account UUID and written into the
git hook the CLI installs. Then it reproduced the census offline, got the same
1,294 names and the same digest as the manifest's provenance, and diffed that
against the entries.

**The exact-ruling gate never ran on most of the names it was written for.**
The generator filtered the census to AUTHORITY-SHAPED names BEFORE asking
`classify`, so the rule "a CLI-owned name is never settled by a pattern" was
applied only to the names a shape pattern happened to describe -- and the
generator's own comment claimed the wider gate. **611** names in the CLI's own
namespaces were counted, digested and never ruled. One of them is
`CLAUDE_BRIDGE_REATTACH_OWNER_ACCT`: read off the environment in the same
statement as `CLAUDE_BRIDGE_REATTACH_OWNER_ORG`, written from the owning
account UUID, compared against the resolved owner on reattach. The `_ORG` half
was in the strip as an account pin because `_ORG` is a shape the pattern knew;
the `_ACCT` half was inherited because `ACCT` is not. The round-5 "tier twins"
defect, verbatim, and the fourth shape in a row the pattern lacked.

**The fix is not a fifth word in the pattern.** A shape pattern is a denylist of
shapes, and this repo has been here before. Every CLI-owned census name is now
an entry with a ruling of its own; the shape test still qualifies third-party
names on its own. Eight names that END in `_` are prefix fragments of names
the CLI assembles at run time (`CLAUDE_CODE_SESSION_`, `CLAUDE_CODE_SDK_`,
`CLAUDE_CODE_RELAUNCH_`, `CLAUDE_CODE_HOST_`, `CLAUDE_BG_`, `CLAUDE_CODE_`,
`CLAUDE_`, `ANTHROPIC_`); they are not variables, they are not ruled, and they
are recorded in `provenance.census.fragments` so the residual "assembled at run
time" now names the prefixes it hides behind. The generator refuses a binary
whose fragments differ from the declared list.

**How 603 names were ruled.** Two independent reviews of the pinned binary, each
name with its occurrences read (up to six, 240 bytes of context either side)
and the surrounding code where that was not enough, then this pass re-checked
the strips and the flagged keeps. The rulings live in
`scripts/claude-authority-census-rulings.mjs` as `[kind, what]` rows, composed
into exact rulings by the classification module with the same dispositions the
kind carries everywhere else; the binary excerpts are NOT committed. The
outcome, against the D3 test: **one strip** (the `_ACCT` twin, account-pin) and
602 keeps -- 525 operational, 27 CLI-set child variables, 15 identifiers a
separate credential authorises, 13 model selectors, 8 exec paths, 4 sinks, 3
operator switches, 2 transport, 2 runtime, 2 non-model endpoints, 1 inbound
secret. 128 of the keeps were FLAGGED by a reviewer as sent in a request, used
to open a file, choosing a backend, or relaxing a permission, and each was kept
on a stated reason; the ones worth naming:

- `CLAUDE_CODE_EXTRA_METADATA` -- JSON merged into request metadata beside
  `account_uuid`. The merge order IS visible: the CLI's own fields are spread
  LAST, so an inherited value cannot override the account field. Kept.
- `CLAUDE_BG_RENDEZVOUS_SOCK` -- the path the CLI LISTENS on for its background
  control server, under the same OS user; its auth token is already stripped.
  Not the `CLAUDE_CODE_MESSAGING_SOCKET` case, which is a socket the CLI
  connects OUT to and relays messages from. Kept.
- `CLAUDE_PLUGIN_ROOT` and `CLAUDE_CODE_MARKETPLACE_NAME` -- one reviewer ruled
  both child-helper channels on the round-5 test (conditional assignment into a
  headers helper). Round 6 had considered exactly this and kept them, and that
  holds: the helper mints a THIRD-PARTY server's headers (D18 item 2), and a
  plugin path or marketplace name selects no Claude account, credential,
  provider or endpoint. Where a helper command resolves through the path, that
  is same-OS-user command execution, the accepted D17 class. Kept, with the
  disagreement recorded in the row.
- `ANTHROPIC_ENVIRONMENT_ID`, `ANTHROPIC_WORK_ID` -- work-order fields
  authorised by `ANTHROPIC_ENVIRONMENT_KEY`, which is stripped; the
  `ANTHROPIC_SESSION_ID` argument of requirement 3 applies to both. Kept.
- `CLAUDE_CODE_HTTPS_PROXY` / `_HTTP_PROXY` -- Claude-specific egress proxy,
  kept as transport for consistency with `HTTPS_PROXY` (D18 item 1); the
  closest call in the set.
- `CLAUDE_CODE_USE_COWORK_PLUGINS` -- selects a settings file and plugin
  directory INSIDE the already-selected config root; it cannot move the root or
  the credential store. Kept; the one the reviewer would re-argue first.
- 32 names occur in this build only as a key in the CLI's typed env-schema
  map, a label or a constant, with NO consuming read; each says so and is
  ruled anyway, because a later build may add the read.

**Also fixed this round, from the same confirm:**

- The runtime validator enforced only the first trigger of the exact-ruling
  rule. A manifest edited so that a CLI-designated SECRET outside the CLI
  namespaces carried a family id as its reason validated clean, although the
  generator would refuse to build it. It now refuses to load one.
- The validator checks that exactly `census.cliOwned` CLI-owned entries cite
  the census, after the digest. An entry ending in `_` is refused as not a
  variable. **The confirm of this round found the count was not in the
  digest**: neither canonical digest covered `provenance.census`, so an entry
  deleted, the count decremented and the digest re-signed validated clean, and
  the new test passed only because it left the count alone. The census figures
  are now in both digests. Stated plainly: this is DRIFT DETECTION, not proof.
  An edit that deletes an entry, decrements the count and re-signs is
  consistent by construction, and so is swapping one CLI-owned entry for
  another; only `--check` against the binary catches those, and the test says
  so in its last assertion rather than implying otherwise.
- `CCR_OAUTH_TOKEN_FILE` is a credential-source LABEL in the pinned build, not
  a variable it reads: every occurrence is the resolver's `source` string, a
  `case` arm or a display-map key, and the token it names is found by a
  well-known path. Round 7's reason said an inherited value authenticates as
  another account, which is false of it. It stays stripped -- a build that read
  the name it labels would read a credential file, and the strip costs nothing
  -- with the reason corrected.
- The generator's census comment claimed the wider gate; it now says what was
  true, what is true, and why.
- **From the independent specification review of this round:** 65 CLI-owned
  hand rulings from rounds 3 to 7 (the carrier set's "everything else" and the
  census "PRESERVED" group) shipped one shared reason, "telemetry or timeout
  behaviour", which is false of several of them -- a bash executable path, a
  key in the OAuth constants object, two plugin directories code is loaded
  from, a git-config rewrite. The disposition of every one was right; the
  reason of record was not, which is the defect round 4 counted five of and
  round 7 corrected for `CCR_OAUTH_TOKEN_FILE`. All 65, plus the six
  third-party names in the same groups, now carry an individual finding read
  from the binary to the round-8 standard (the same reviewer, the same method),
  composed with the kind's D3 clause; twenty-two changed KIND while staying keep
  (`CLAUDE_CODE_GIT_BASH_PATH`, `CLAUDE_CODE_PLUGIN_CACHE_DIR` and
  `_SEED_DIR` to exec-path; `CLAUDE_CODE_AGENT_PROXY_GIT_CONFIG` and
  `_GH_SHIM` and `API_FORCE_IDLE_TIMEOUT` to transport; eleven identifiers,
  two sinks, two endpoints and one CLI-set variable to their own kinds). No
  entry in the manifest now carries that shared reason. Worth naming from
  that pass: `CLAUDE_CODE_REMOTE_MEMORY_DIR` REPLACES the directory auto-memory
  is read from and written to -- a read-and-write root, not a sink -- and is
  kept on the same reasoning as `CLAUDE_CODE_DEBUG_LOGS_DIR` (requirement 2):
  the credential store does not resolve from it, so it selects no account,
  and where a session's memory lands is the accepted D17 class, recorded as a
  residual rather than used to justify a strip.

**Ten mutants, ten detected, all as first written**: the gate narrowed back to
shaped names (`--check` fails), each validator guard removed, the entry-name
regex loosened, `classify` no longer consulting the table, the collision check
removed, the `_ACCT` entry flipped to keep in the shipped manifest with its
digest re-signed, the count invariant miscounted, and the census dropped from
both digests with the manifest re-signed to match (exactly one test red, the
one that asserts the binding). Runners and results are in the session
scratchpad (`mutate-r8.mjs`, `mutate-r8b.mjs`, `mutate-r8.json`); the row is
in the table above.

**The confirm's verdict.** The same attacker re-ran its census reproduction
against the new manifest: 875 CLI-owned non-fragment names, all 875 entries,
all citing the census, none missing on either the CLI-owned or the shaped
path, no entry ending in `_`, the eight fragments exactly its own eight. It
checked every CLI-set child-variable row in the manifest (42, counting the
rounds before this one) for a conditional assignment mis-ruled as
unconditional and found none; verified fourteen flagged keeps against the
binary; and accepted the `CLAUDE_PLUGIN_ROOT` / `CLAUDE_CODE_MARKETPLACE_NAME`
keeps on the same reasoning as round 6, having constructed no path from either
name to the model endpoint's headers.

Manifest after round 8: the figures at the top of this part.

## Round 9 -- the independent code-quality review

Run after the specification review passed, on the whole uncommitted tree, by a
reviewer who had seen none of it. **No blocker. One MAJOR, six MINORs, all
fixed**, each with a test that goes red under its mutant (nine of nine).

**The MAJOR was the settings-copy defect again, one function over.** The
project-settings scan refuses itself on a network path, while another scan is
outstanding, at the thread ceiling, and at its two-second deadline -- and every
refusal was a LOG LINE. The stored report was left as it stood, and the panel
reads the newest non-probe report, so a refused scan was indistinguishable from
"this project carries nothing". For a project on a UNC share that is permanent:
a `.claude/settings.json` there carrying `apiKeyHelper` was suppressed by the
host control with the panel silent about it on every launch. For two sessions
restored in one tick, the second's report -- the newest, the one shown -- said
nothing until the user happened to start a solo session. This is exactly the
shape `'not-evaluated'` was added for in the previous part, and the code's own
justification ("the next launch re-runs it") did not hold for the report the
panel actually reads. Every refusal now AMENDS the report with an `info`
finding, `project-settings-not-scanned`, carrying the reason that applied and
the statement that the control still applies; the deadline case does too.

**The MINORs, each fixed:** the registry's required-operation loop did not
include the third managed-launch operation the project scan added, so a
package without it registered cleanly and threw inside the scan's per-file
catch, silently returning nothing; the ceiling warning said scans were
"DISABLED for this run" when the ceiling is transient, and its de-duplication
flag was never cleared, so a second episode an hour later logged nothing (it
clears when a scan settles under the ceiling, and a test seam exposes the
counters rather than spying on the logger); the bounded-list helper existed
twice with two private `20`s (one `boundNames` / `summariseNames` in the shared
providers module now); the source-absent branch that deletes the stale settings
copy ran with none of the guards the write path has, so a `.claude` junction
into another profile made it delete THAT account's copy (it now carries the
containment and leaf-link guards, records the refusal, and the rest of the home
build continues); the validator's namespace-prefix charset admitted `?`, which
interpolated into a RegExp would WIDEN the family-rule guard (literal prefixes
only); and the amendment tests polled 400 ms against a 2000 ms deadline, going
red on a loaded machine for correct code (they poll to the deadline plus a
margin for the finding they expect). The reviewer also noted, without making
findings of them, four exports with no production consumer and one assertion
that cannot fail (`AUTHORITY_MANIFEST_ERROR` is unobservable because the
module-scope accessor throws first); both are recorded here rather than
addressed in this slice.

## What this part does not claim

It does not claim the census is complete. Three rounds in a row each found a read
form or a name it had missed, a fourth found that most of what it HAD found was
never ruled, and a name assembled at runtime cannot be found by scanning -- the
fragments list says where such names are known to start, not what they are. It
does not claim the 602 keep rulings of round 8 were each measured: they were
read from the binary by two reviewers and re-checked, which is the same
standard as the 49 of round 4 and not a stronger one. It does not claim anything about a CLI other than the one pinned: the
manifest's digest covers the manifest's own entries, never the installed binary,
and the only runtime gate is a version FLOOR, so a newer auto-updated CLI reports
"supported" with none of this re-verified. And it does not claim that the Linux
and macOS rows of the fidelity table were measured, because they were not.

---

# Part 7 -- Gate A1, run (2026-09-22)

**Scope.** Claude Code **2.1.278**, **win32-x64**, binary sha256
`006ea5c8638f67f10a5ae66bb232fd267c9f6af294e3f03f4cfcf1fd3f2cced8`, one real
managed profile home with a stored claude.ai login
(`<home>/.claude/.credentials.json`, 524 bytes, subscription max), the
launch environment composed by `withProfileHome` exactly as every app launch
path composes it, `claude auth status --json` and one `claude -p` request
with `--tools ""` `--model haiku` `--max-turns 1` from an empty temporary
working directory. Nothing else was run. No token or email is reproduced here.

## Result: FAILED

Under the full realm patch the CLI reports `loggedIn: false, authMethod:
"none"` with `configDirectory` resolving correctly to the profile's
`.claude`, and the request prints `Not logged in - Please run /login` and
exits 1. The same profile, same binary, same working directory, with only
`USERPROFILE` redirected, reports `loggedIn: true, authMethod: "claude.ai"`
and the stored subscription.

**Bisected, one variable at a time, every row measured:**

| environment on top of `USERPROFILE=<home>` | `auth status` |
|---|---|
| nothing else | signed in, claude.ai |
| `CLAUDE_SECURESTORAGE_CONFIG_DIR=<home>/.claude` | signed in, claude.ai |
| `ANTHROPIC_CONFIG_DIR=<home>/.claude/anthropic` | signed in, claude.ai |
| `HOME=<home>` | signed in, claude.ai |
| all three of the above | signed in, claude.ai |
| **`CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST=1` alone** | **not signed in, none; exit 1** |
| the full patch (all four) | not signed in, none |

The realm roots added in rounds 4 and 5 are continuity-safe, which the round-6
attacker had measured on a scratch profile and this run confirms on a real one.
**The host control is not.** The one control Part 1 proved to stop
settings-sourced redirection is also the one that stops the profile's own
stored login.

## Why, from the pinned binary

The CLI's OAuth-credential resolver, read from the binary: with the flag set it
returns a token handed to it by the HOST (`CLAUDE_CODE_OAUTH_TOKEN`, or the
token file descriptor / well-known path the CCR host uses) and otherwise
returns `null` **before** the branch that reads the stored `claudeAiOauth`
credential -- `if (managedByHost) return null` sits ahead of the store read
in both the synchronous and the asynchronous resolver, and the same flag turns
off the subscription and `/login`-managed-key paths. The error text the CLI
prepares for this state says what the flag means to it: *"credentials are
managed by the desktop app, but none are available ... restart the desktop
app"*. `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST` is Claude Desktop's mode, in
which the host application supplies and rotates the token
(`CLAUDE_CODE_HOST_AUTH_ENV_VAR`, `CLAUDE_CODE_HOST_CREDS_FILE`,
`CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH`). It is not a "suppress the settings
files" switch that leaves credential resolution alone, which is what Part 1's
probes -- all run against synthetic keys, never a stored login -- took it for.
Part 2's constraint 6 and this matrix's first row were written precisely
because that gap was visible then; it is now measured.

## What this does and does not invalidate

- INVALIDATED as shipped: a managed launch under this control cannot use the
  account it was launched for. Every other layer of slice 2 stands on its own
  and was reviewed on its own -- the sanitised settings copy, the ambient
  strip, the realm roots, the manifest, the diagnostics -- but the control they
  were built around fails the one row that could invalidate it.
- NOT invalidated: the evidence of Parts 1 to 6 about what the flag suppresses.
  It suppresses settings-sourced redirection; it also suppresses the stored
  login. Both were true all along; only the second was unmeasured.
- Rows A2 to A5 were NOT run. They presuppose a session that signs in.

## Options seen in the binary, for the owner -- none chosen, none probed

1. **Become the host the flag expects.** Read the profile's stored OAuth
   token and hand it to the CLI the way Claude Desktop does (a token variable
   or descriptor, plus the host-refresh contract). Keeps the proven control;
   makes this app the token's custodian, including refresh -- a new credential
   surface with its own review.
2. **A second mode the binary distinguishes.** The settings-env filter has a
   separate branch for a "desktop host" (`CLAUDE_CODE_ENTRYPOINT` in a small
   set of Claude Desktop entrypoints) that ignores provider and auth variables
   from project, local and policy settings and excludes the `apiKeyHelper`
   path, WITHOUT the managed-by-host credential rule -- the stored login is
   read. Unprobed; and it means presenting the session as a Claude Desktop
   entrypoint to the CLI and its telemetry, which is not this app's identity to
   claim without a decision.
3. **Drop the flag; detect rather than prevent.** Keep every other layer and
   turn the project-settings scan, which already names the redirecting keys,
   from an informational finding into a refusal or a prominent warning. Weaker:
   it stops nothing the user does not read.

The temporary probe that produced the measurements was a one-file vitest
test under `tests/unit/`, gated on an environment variable and deleted after
the run; the recipe above is enough to reproduce it.

---

# Part 8 -- Option 2 probe: `CLAUDE_CODE_ENTRYPOINT=claude-desktop` (2026-09-22)

**Authorised as evidence gathering only, not as approval to ship.** Scope: Claude
Code **2.1.278**, **win32-x64**, binary sha256 `006ea5c8...cced8`, one host.
Every dynamic row ran against **loopback only**: two capture servers stood in
for the API base (answering 400, so no OAuth refresh path is entered) and a
loopback egress proxy RECORDED and REFUSED every other outbound attempt, so
nothing left the machine and every attempt is on record. Every credential was
synthetic except the two `auth status` rows, which read real stores and print
nothing but signed-in / method / "distinct". The harness is
`scratchpad/probe2/probe2.mjs` (not committed); one recipe reproduces it:
`claude -p "say ok" --tools "" --max-turns 1` from a scratch project, scratch
`USERPROFILE`/`HOME` with a seeded `.claude.json`, a fake
`.claude/.credentials.json` (`claudeAiOauth`), the realm roots set as the app
sets them, `ANTHROPIC_BASE_URL` at the capture server, `HTTPS_PROXY` at the
refusing proxy with `NO_PROXY=127.0.0.1`, and `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`.
A first harness used a synchronous spawn, which blocked the process hosting the
capture servers; every row below is from the asynchronous one.

## Verdict: NOT complete and unambiguous. Stopped before gate A1 and before any ADR-009 pass, as instructed.

Two of the six requirements hold, one holds only partially, and three are
answered by facts the owner has to judge rather than by a pass. Nothing was
changed in the committed slice.

## The matrix

Observables: **wire** = the credential the CLI put on the captured request
(which store, which key); **sentinel** = the `apiKeyHelper` command wrote its
marker, i.e. it EXECUTED; **server** = which capture server received the
request (primary = the launch environment's base URL; secondary = the URL a
settings file tried to inject); **egress** = hosts the CLI tried to reach
outside loopback (all refused). "entry" = `CLAUDE_CODE_ENTRYPOINT=claude-desktop`.

| row | fixture | without entry (positive control) | with entry |
|---|---|---|---|
| R0 | stored fake login only | Bearer STORE-A | Bearer STORE-A |
| R1-user | `apiKeyHelper` in USER settings + store | sentinel FIRED, wire = HELPER key | sentinel **FIRED**, wire = STORE-A |
| R1-project | same, PROJECT settings | sentinel FIRED, wire = HELPER key | sentinel **FIRED**, wire = STORE-A |
| R1-local | same, LOCAL settings | sentinel FIRED, wire = HELPER key | sentinel **FIRED**, wire = STORE-A |
| R4 | USER settings `env.ANTHROPIC_API_KEY` + store | wire = x-api-key ENVKEY | wire = Bearer STORE-A |
| R5x-user | USER settings `env.ANTHROPIC_BASE_URL` -> secondary, name ABSENT from the launch env | secondary (APPLIED) | secondary (**APPLIED**) |
| R5x-project | same, PROJECT settings | secondary (APPLIED) | primary absent -> default host, refused (BLOCKED) |
| R5x-local | same, LOCAL settings | secondary (APPLIED) | BLOCKED |
| R5 / R6 | the same three rows with `ANTHROPIC_BASE_URL` PRESENT in the launch env | user/project/local all APPLIED | all BLOCKED -- by the host-env VETO (see below), not by the filter |
| R7-user | USER settings `env.CLAUDE_CODE_USE_BEDROCK=1` + store | provider switched (AWS credential error, no request) | provider **switched** |
| R7-project | same, PROJECT settings | provider switched | Bearer STORE-A on primary (BLOCKED) |
| R9 | AMBIENT `ANTHROPIC_API_KEY` + store | wire = x-api-key AMBIENT | wire = Bearer STORE-A |
| R11 | two homes, two stores, one project, both with entry | -- | A -> STORE-A only; B -> STORE-B only |
| R12 | fake tokens anywhere on disk or in `--debug` logs outside their store | -- | none |
| real | `auth status --json` on two real managed profiles | signed in, claude.ai, distinct, config dir = own home | signed in, claude.ai, distinct, config dir = own home |

Egress in every OAuth row, with or without the entrypoint: one refused
`CONNECT api.anthropic.com:443` -- the CLI's own OAuth profile fetch, made with
the fake bearer. No other host was attempted (non-essential traffic was
disabled; telemetry destinations were therefore not observed dynamically and
are covered by the census below).

**Corrections to Part 1 this matrix forces.** Part 1's Finding 2 ("project and
local `env` blocks do not reach the CLI") was measured through `doctor`'s
remote-settings line, and it is false of the request path: without the host
flag, PROJECT and LOCAL `env.ANTHROPIC_BASE_URL` redirected the request
(R5x-project/local, R6) and PROJECT `env.CLAUDE_CODE_USE_BEDROCK` switched the
provider (R7-project). Repository-owned settings inject provider and endpoint
overrides in 2.1.278; the flag, and only the flag, was stopping all of it.

## Requirement by requirement

1. **Preserves the correct profile's stored login -- HOLDS.** R0, R4, R9, R11,
   and both real profiles under `auth status`. The desktop branch changes
   precedence, not the store: the stored claude.ai login is read and WINS over
   an ambient or user-settings API key (R4e, R9e), where without the entrypoint
   the key wins.
2. **Blocks credential/provider overrides and `apiKeyHelper` from user, project
   and local settings -- PARTIAL.** Credential SELECTION is blocked in all three
   scopes (R1e, R4e, R9e). Endpoint and provider overrides are blocked from
   PROJECT and LOCAL scope (R5x-project/local, R7-project) and **NOT from USER
   scope** (R5x-user APPLIED, R7-user switched): the CLI's desktop filter covers
   `policySettings`/`projectSettings`/`localSettings` and not
   `userSettings`, so for the user scope the app's sanitised copy is the only
   control. And `apiKeyHelper` **still executes** in all three scopes (R1e
   sentinel fired every time). Read from the binary: it is spawned by an
   unconditional warm-up at startup gated only on "is a helper declared";
   `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST` empties that getter and the desktop
   entrypoint does not. Its output is cached in-process and remains reachable
   through an ungated getter that feeds key-fingerprint telemetry and, if the
   OAuth bearer were ever absent, the `x-api-key` header. A repository's
   settings file therefore still runs a command of its choosing on every
   session start; only its key is not selected.
3. **Isolation between two managed profiles -- HOLDS** on synthetic stores
   (R11) and real ones (`auth status`).
4. **No credential exposure in logs, reports, child environments, diagnostics
   -- HOLDS for what was observable.** R12 found neither fake token anywhere on
   disk outside its store, `--debug` logs included. Child environments were not
   exercised (no tool ran); the census found the entrypoint variable itself is
   deleted from children and the credential scrub is unchanged. The app's own
   reports were not part of this probe.
5. **No material change to permissions, product behaviour, session ownership,
   account attribution -- FAILS on the census, one item measured.** From the
   86-site census (`scratchpad/entrypoint-census.md`):
   - permission grants made in a session are persisted to USER settings instead
     of the session (`tln()`), i.e. into the file this app writes and re-writes;
   - the session's tool-permission callback is parked process-globally for
     out-of-turn artifact-comment replies;
   - host-supplied SDK MCP servers become declarable to the model;
   - **the launch environment becomes a veto list over every settings scope**:
     a settings `env` entry whose NAME exists in the process environment is
     silently ignored, user scope included. Measured: R5/R6 were "blocked" only
     because the harness carried `ANTHROPIC_BASE_URL`; R5x, without it, shows
     the user-scope override going through;
   - auth failures become a host-refresh RETRY instead of a clean stop, with no
     host to refresh;
   - desktop transcripts are exempted from local retention deletion.
6. **Telemetry / identity differences -- RECORDED, and they are attribution
   changes.** Measured on the wire: User-Agent `claude-cli/2.1.278 (external,
   claude-desktop)` and the billing block `cc_entrypoint=claude-desktop`
   carried as a system-prompt text on every request (R0e vs R0n; headers
   otherwise identical, `anthropic-client-platform` unset because no desktop
   app version was presented). From the census: MCP OAuth start URLs on the
   claude.ai origin carry `product_surface=claude-desktop`; error telemetry is
   tagged `entrypoint:claude-desktop`; a flag-gated PR footer would read "via
   Claude Desktop". Every one of these tells Anthropic the session is Claude
   Desktop.

## Why this stops here

The instruction was to proceed to gate A1 and a fresh ADR-009 pass only if the
result was complete and unambiguous, and to stop on any open security,
identity, telemetry or compatibility question. Three are open and none is
this app's to settle: a repository's `apiKeyHelper` still executes (security);
every request is attributed to Claude Desktop (identity, telemetry); and
session permission grants are written into the app-managed settings copy while
the launch environment silently vetoes settings entries (compatibility). The
user-scope gap is a fourth, milder one: it moves the whole of user-scope
isolation onto the app's sanitiser with no CLI backstop.

Options 1 and 3 were not pursued, as instructed. Nothing in the committed
slice was modified by this part.

---

# Part 9 -- the scope correction: the supported launch model, a refusing gate, stated boundaries (2026-09-22)

**Owner decision.** Option 2 rejected; no further identity-mode search. Slice 2
is corrected around the existing supported Claude launch model. Option 1
(this app as credential host) and option 3 (warn instead of prevent) are not
targets. The guarantee has changed, so a fresh ADR-009 pass follows this part.

**Scope of every claim.** Claude Code **2.1.278**, **win32-x64**, binary sha256
`006ea5c8...cced8`, one host. The manifest is now **1,167 entries, 146 stripped
from the settings copy, 142 from the ambient environment**, digest
`89098f7df000f12a53eff4bcaedce54c195e08565cede355a0e43eba96f67fe4`, byte-for-byte
from the pinned binary. The one ruling change from Part 6: `CLAUDE_CODE_ENTRYPOINT`
is now stripped on both axes (`host-hook`), because Part 8 measured that an
inherited Claude Desktop value changes which credential wins and attributes the
session to Claude Desktop; the CLI sets its own value for its own surfaces.

## What the corrected model is

Four layers, in the order a launch applies them. Nothing else.

1. **Ambient strip.** The 142 ambient-authority variables are removed from the
   environment the session starts with; the developer's shell is untouched.
   This is the ledger's WP1.38 ("ambient poisoning cannot override" the realm
   env), and it is met by construction: the app composes that environment.
2. **Realm.** `USERPROFILE` (and `HOME` on Linux) point at the profile home,
   plus the two realm roots the CLI reads outside the home
   (`ANTHROPIC_CONFIG_DIR`, `CLAUDE_SECURESTORAGE_CONFIG_DIR`). Unchanged from
   rounds 4 and 5; measured continuity-safe on real profiles in Part 7.
3. **The app-owned copy.** The per-account `settings.json` copy is sanitised
   of the 146 settings-strip keys and the five credential helpers; the shared
   source and every repository-owned file are never touched. The
   self-reference, containment and leaf-link guards on both the write and the
   delete path stay (the data-loss fix).
4. **The project gate.** Before a managed session starts in a directory, that
   directory's own `.claude/settings.json` and `.claude/settings.local.json`
   are read (bounded: cap+1 bytes, regular files only, no network path, a
   3-second deadline, at most two filesystem threads, one scan per directory
   shared by concurrent launches) and classified with the same manifest. A
   credential helper, an account pin, a provider switch or an endpoint redirect
   **refuses the launch**: `withProfileHome` records a report whose finding is
   `repository-settings-refused` (blocked) and throws; the PTY path prints the
   refusal in the terminal, file and key named, never a value, then the exit;
   the Accounts panel shows it. A directory the gate cannot read safely or in
   time launches with `project-settings-not-scanned` as a **warning** -- the
   session started, the files were not checked, and the panel says so.

**Removed.** `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST` is no longer set (Part 7:
it stops the stored login). `CLAUDE_CODE_ENTRYPOINT` is never set (Part 8) and
an inherited one is stripped. The whole "host-managed control" concept is gone
from the realm patch, the registry and the preflight: there is no slot for one,
no "applied last" step, no "at least one control" rule, no `host-control-*`
finding. The app owns no OAuth token and refreshes none; Claude Code signs in
from the account's stored login exactly as in a plain terminal.

**The launch paths.** All five run the gate. The PTY spawn stays a synchronous
function: a managed spawn is deferred once through the same mechanism the
profile-refresh wait already used, and re-enters with the verdict; the two
waits chain (the profile is held across both -- the test rework found and this
part fixed a teardown that did not survive the chain). Cloud agents and the
insights runner await the gate; the auth-status probe and the headless runner
read a recent verdict synchronously and await only on a miss, so overlapping
probes still share one subprocess and cannot race a single-use refresh token.

## Gate A1, reframed (owner's five rows)

| # | row | status |
|---|---|---|
| 1 | Existing Claude authentication and profile switching still work | **PASS, measured 2026-09-22.** Real profile, the corrected environment exactly as `withProfileHome` composes it (gate run, no flag, no entrypoint -- both asserted absent): `auth status --json` signed in via claude.ai with the config directory under the profile home; one tool-less haiku `-p` request answered, exit 0, no token string in either stream. Switching is by home: two real profiles each report their own account (Part 8's `auth status` rows, valid without the entrypoint). Part 7's bisect showed the realm roots continuity-safe |
| 2 | Two managed profiles remain isolated under the existing supported mechanism | **PASS, measured.** Two real profiles: signed in, distinct accounts, config dir = own home (Part 8, `auth status` rows, still valid without the entrypoint); two synthetic stores each put only their own token on the wire (Part 8 R11, the mechanism is the realm, not the flag) |
| 3 | App-owned settings cannot silently redirect authentication | **PASS, by construction and by test.** The copy is sanitised at both writers; refusals are recorded and shown; the source guard proves every launch path composes through the choke point; mutation-tested in Parts 6 and 9 |
| 4 | Detectable repository overrides fail visibly before launch | **PASS, by test through the real code path.** Eight fixtures (four kinds, two files) refuse from the gate; `withProfileHome` records the blocked finding then throws; the real `spawnPty` path (node-pty mocked) does not spawn, writes the refusal to the terminal naming file and key and no value, then the exit. The in-app run on a real project is the VM check in the manual matrix, not done here |
| 5 | No new Claude Desktop attribution or credential custody is introduced | **PASS, by inspection.** Nothing in `src/` sets `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST`, `CLAUDE_CODE_HOST_*`, `CLAUDE_CODE_OAUTH_TOKEN*` or `CLAUDE_CODE_SDK_HAS_*`; the manifest strips all of them; no code reads or writes `.credentials.json` on a launch path |

## Boundaries, recorded rather than claimed

- **Settings edited after a session started** are read by the CLI without any
  further check. The gate runs once, before launch.
- **Remote / organisation-managed settings** are fetched by the CLI for a
  signed-in account and are not locally observable.
- **Another process of the same OS user** can change the profile home, the
  settings copy or the project files at any time; this app does not police
  what the user can already run (D17).
- **A project on a network path** is never read on the launch path (a dead
  share froze the app for 42 s); it launches with a warning. A wedged mapped
  drive reaches the same warning through the deadline or the thread ceiling.
- **A user-scope override lives only in the app-owned copy**, which the app
  sanitises; the CLI itself applies user-scope settings in full.
- **A helper the gate refuses is one that was DECLARED.** A settings file the
  gate cannot parse, or one over the size cap, is skipped (clean) exactly as
  the CLI skips it.

Guaranteeing against the first three needs a credential host -- this app
supplying and rotating the token so the CLI reads no settings-sourced
credential at all -- which is option 1, a separate design, not authorised.
Nothing in this part implies the gate provides that guarantee.

## Part 1, corrected

Part 1's Finding 2 ("project and local `env` blocks do not reach the CLI")
was wrong on the request path (Part 8, rows R5x and R7). Without any flag, a
PROJECT or LOCAL `env.ANTHROPIC_BASE_URL` redirects the request and
`env.CLAUDE_CODE_USE_BEDROCK` switches the provider. That is precisely why the
gate refuses rather than warns, and why the ruling of 2026-09-21 that "a launch
must not be refused for settings the proven mechanism suppresses" no longer
applies: there is no suppressing mechanism.


# Part 10 -- the fresh ADR-009 pass on the correction, and what it changed (2026-09-22)

**Bound, stated before the first attacker ran:** one round of four lenses,
then one re-attack. Lenses: bypass (Opus), injection (Sonnet), blast-radius
(Sonnet), design and coverage (Sonnet). The re-attack was a fresh Opus bypass
lens over the fixes. Both bounds were spent; what the re-attack found was
fixed, tested and put through the two independent reviews (specification on
Opus, code quality on Sonnet, both PASS), and the round-2 fixes have had **no
attacker pass of their own**. That is the standing at the end of this part, and
it is recorded rather than rounded up.

**Scope of every claim.** Claude Code **2.1.278**, **win32-x64**, binary sha256
`006ea5c8...cced8`. Every "the CLI does X" below was read from the pinned
binary's own code (offsets in the 197,000,000 region are the settings loader;
`Bt`/`Wr`/`Kt` at ~197,229,000 are the git-root resolver; `Kpr`/`A9t`/`NTt` at
~196,643,000 are the file reader; `St`/`se`/`Ko` at ~196,538,000 are the
settings parser), and the ones marked *measured* were then confirmed by
running the binary against a fixture on this host. Tests ran on Windows 11 and
on Ubuntu 24.04 (WSL 2, a copy of the worktree with a Linux `npm ci`).
**Nothing ran on macOS.**

## What the round found, and what was done about it

Twenty-eight findings in all: sixteen from the first round (two BLOCKER, four
MAJOR, four MINOR, five coverage gaps, one note), one found on Linux while
proving the first fixes there, ten from the re-attack (one BLOCKER, three
MAJOR, six MINOR), and one more from the reviews. Every one is fixed except the
note, which is recorded below as left by design. Every fix has a regression
test that was run RED under a mutant that removes the guard -- fourteen
mutants on Windows, seven on Linux, one (the FIFO) on Linux only -- and green
with the guard back.

| # | severity | finding | fix | test (goes red under the mutant) |
|---|---|---|---|---|
| 1 | BLOCKER | `pty:spawn` forwarded the raw options; a renderer could send `projectGate: {status:'clean'}` and skip the gate | `MAIN_INTERNAL_SPAWN_FIELDS` deleted by name in `pty-handlers.ts` (now `refreshAwaited`, `projectGate`, `projectGateDirs`) | `pty-handlers-command-secrets` "STRIPS projectGate" + the list pin |
| 2 | BLOCKER | the gate ran on the configured directory, but an exact resume relaunches the CLI in the resume target's own directory -- for a session in its designated worktree, every resume | `managedLaunchGateDirs` gates the configured directory AND the resume target's (peeked, expanded exactly as `resolveResumeLaunch` expands it); `gateManagedLaunchDirs` merges: any refusal refuses, keys prefixed by their directory; else the first not-scanned warns; else clean | `pr600-r3-fresh-wait` "gates the RESUME target's directory"; `managed-launch` "gates EVERY directory a launch may run in" |
| 3 | MAJOR | `isUncPath` matched `\\?\C:\proj` (an extended-length LOCAL path) as network | device-prefix parsing: a drive letter or `Volume{}` is local, `UNC\` is a share, anything else is treated as network | "tells an extended-length LOCAL path from a network path"; win32 end-to-end |
| 4 | MAJOR | the gate's size cap was 128 KiB; the CLI reads settings through `maxBytes` 2,097,152 (`A9t` throws only ABOVE it, *measured*: exactly 2,097,152 bytes is applied by the CLI and flagged by the gate; 2,097,153 is refused by both) -- a file between the two was too big for the gate and small enough for the CLI | cap = 2 MiB, the CLI's own | "REFUSES a project settings file between the OLD 128 KiB cap and the CLI's 2 MiB cap" |
| 5 | MAJOR | scan and cache keys were lower-cased everywhere; on Linux/macOS `/Proj` and `/proj` shared a verdict | no case folding on any platform (the re-attack showed an NTFS directory with per-directory case sensitivity, no admin needed, where two spellings are two directories on Windows too) | "never folds the verdict cache key by case" |
| 6 | MAJOR (POSIX) | with uid semantics the CLI resolves `localSettings` to the canonical git root (`STt`/`cV`/`nPn`/`iao`/`Lf`: root differs from cwd and from the real home; root, `.git` entry and `.claude` entry owned by the current uid) and reads the ROOT's `settings.local.json` as well as the cwd's | `posixCanonicalLocalSettingsRoot` mirrors those rules; the root's file is read and reported as `settings.local.json (repository root): <key>`; `settings.json` stays at the cwd; win32 unchanged | "reads the repository ROOT's settings.local.json where the CLI does" (Linux) |
| 7 | MAJOR | `withProfileHome` threw inside `spawnNow`'s promise executor, so a refused headless launch REJECTED where every other failure resolves `{code:1}`; neither insights caller catches a rejection | the environment is composed before the executor; a refusal resolves `{code:1, stderr}` | `claude-headless-profile-consumer` "RESOLVES { code: 1 } with the refusal on stderr" |
| 8 | MAJOR (was filed MINOR) | the CLI's reader sniffs `FF FE` as UTF-16LE and its parser drops a leading U+FEFF before a strict `JSON.parse` (`NTt`, `Ko`, `se`; *measured*); the gate decoded UTF-8 and parsed as-is, so a BOM-prefixed or UTF-16 settings file parsed as nothing and was reported CLEAN while the CLI applied it | `decodeSettingsText` + `stripLeadingBom`, in the gate, the classifier, the sanitiser and the app-owned copy reader | "REFUSES a settings file the CLI parses through a BOM or as UTF-16" |
| 9 | MINOR | raw working directories in log lines (the log sink escapes only CR/LF) | `stripSpoofableText` (`src/shared/safe-text.ts`) applied to every path-bearing log line in the gate and in pty-manager | "never writes a control or spoofing character from a directory name into the log" |
| 10 | MINOR | `deferSpawnUntil` had no rejection path: a wait that rejected leaked the profile hold and left a blank terminal | a rejection handler with the same exit as a failed re-entry | `pr600-r3-fresh-wait` "a wait that REJECTS releases the hold" |
| 11 | note | the auth-status probe gates `process.cwd()`, so a not-scanned warning can show on a profile with no launches | **left as is**: the report is true of the probe, and the panel prefers a launch over a probe whenever one exists | -- |
| T5 | coverage | the commit's own headline ruling (`CLAUDE_CODE_ENTRYPOINT` strip) had no name-anchored test; a self-consistent re-ruling to `keep` with the digest regenerated left every test green | name-anchored assertion on the manifest entry and a real strip | "strips an inherited CLAUDE_CODE_ENTRYPOINT on BOTH axes, by name" |
| T8 | coverage | "a not-scanned verdict is never cached" was asserted for `network-path` only | `peekGateVerdict` asserted undefined after the deadline and the ceiling | the two existing cases, extended |
| T6 | coverage | "a network path is never read" was asserted by verdict only | `fs.promises.open` spied, never called | the UNC case, extended |
| T13 | coverage | the insights path had no refusal test | real gate, real choke point, poisoned install directory | `insights-project-gate-refusal` |
| T14 | coverage | the auth-status probe had no refusal test | the gate answers refused through a test seam; the probe does not spawn, warns, falls back to the file | `claude-cli-auth-read` "a REFUSED project gate never launches the CLI" |
| 17 | MAJOR (Linux) | opening a FIFO at `.claude/settings.json` for reading BLOCKED -- before the `isFile()` refusal could run; the FIFO test was red on Linux at `6290f8e4`, which had only ever been run on Windows | `O_RDONLY \| O_NONBLOCK` on the open (the constant is absent on win32, hence `?? 0`; a numeric open of a regular file behaves as `'r'`, *measured*) | the FIFO case, now green on Linux |
| B1 | BLOCKER (re-attack, POSIX) | the CLI's `canonicalGitRoot` follows a linked worktree's `.git` FILE to the MAIN checkout (`Bt`: `gitdir:` -> `commondir` -> `dirname(<common>)`, validated by the `worktrees` parent and the `gitdir` back-pointer); the walk stopped at the worktree, so a helper in the main checkout's local settings applied to every session in every linked worktree -- this repo's own session model | `canonicalGitRootOf` mirrors `Bt`, every validation miss leaving the root as it was, exactly as the CLI does; a symlinked `.git` is not a root | the worktree block of the repository-root case (Linux) |
| M2 | MAJOR (re-attack) | `\\localhost\C$\proj` and `\\127.0.0.1\C$\proj` were declined as network paths -- the not-scanned, launch-anyway bucket -- while the CLI reads them (*measured*) | a loopback host by name, by `127.0.0.0/8`, `::1`, or this machine's own name (full, short, `.local`) is local and scanned | the loopback rows of the path-rule case; win32 end-to-end against the admin share (skipped where the share is absent) |
| M3 | MAJOR (re-attack) | the verdict was carried across the deferral but `resolvedCwd` was re-derived from disk on the re-entry; a directory that vanished collapsed to the home directory and ran there under the project's verdict | `projectGateDirs` carried with the verdict; `assertGatedDirectory` refuses at the working-directory point and again at the resume-directory point, recording a `launch-directory-unverified` blocked finding so the panel shows it | `pty-managed-deferral-carries-launch` "REFUSES when the configured directory vanished", "REFUSES when the resume decision lands the CLI in a directory the gate did not scan" |
| M4 | MAJOR (re-attack) | the self-captured resume target is stored after each entry's `killPty`; the deferred re-entry's own `killPty` wiped it and its own capture found nothing -- every deferred Restart and account switch silently lost its exact resume | `deferSpawnUntil` carries the target captured (and gated) by the first pass and re-enters it as the persisted target | "relaunches the exact conversation in ITS directory after the gate deferral" (binder answers once, as the real one does) |
| m5-m10 | MINOR (re-attack) | win32 case fold on case-sensitive NTFS; bidi marks / invisibles / tag block / mid-surrogate cut survived the strip; four more raw-path log lines; the merged refusal prefix carried a raw path to the panel; a two-directory gate took both scan slots; the walk was bounded at 64 where the CLI's is not | see 5 and 9; the strip class extended and the cut made code-point-safe; sequential gating (one slot per launch); the walk unbounded to the filesystem root; the prefix stripped, bounded and home-relative (`~`) | each has its own assertion and mutant |
| r1-r3 | MINOR (reviews) | the directory-changed refusal was printed but not recorded for the panel; `app-knowledge` under-described the gate; a case-differing home prefix defeated the `~` shortening on Windows; a shared in-flight scan wrote its cache and log line once per waiter; the admin-share case passed vacuously where the share is absent | recorded as a finding; the Feature Guide text updated; case-insensitive on win32; side effects moved to the scan's completion; `ctx.skip()` | each has its own assertion |

## Part 9, corrected

Three sentences in Part 9's "Boundaries" were wrong when written and are true
now, and the difference is worth stating as a hole that was open, not only as
one that is closed:

- "A settings file over the size cap is skipped (clean) exactly as the CLI
  skips it" was **false between 128 KiB and 2 MiB**. The cap is the CLI's own
  now.
- "A settings file the gate cannot parse is skipped (clean) exactly as the CLI
  skips it" was **false for a BOM-prefixed or UTF-16LE file**: the CLI parsed
  it and this gate did not. The decode mirrors the CLI's reader now; a file
  with a comment or a trailing comma is not applied by the CLI (*measured*:
  its settings fell back to defaults) and is honestly clean here.
- "A project on a network path is never read on the launch path" is narrower
  now: a UNC path whose host is loopback or this machine IS read and gated,
  because the CLI reads it; `\\?\C:\`, `\\.\C:\` and `\\?\Volume{}\` are local
  and gated; `\\?\GLOBALROOT\`, `\\?\pipe\` and any other device prefix stay in
  the warning bucket. A host reached by a name this machine does not answer to
  (an FQDN reached by a different alias) stays in the warning bucket too.

And four things layer 4 does now that Part 9 did not say:

- **Every directory a launch may land in is gated**, and the verdict is bound
  to that set: the configured directory, plus the resume target's for an
  interactive Claude session, plus -- since the final pass below -- every
  worktree the resume PICKER can offer (`git worktree list` from the configured
  directory, read by the main process; the picker is handed the gated set in
  `CCC_GATED_DIRS` and exits rather than retarget outside it). A directory the
  launch does not use in the end (a resume target whose transcript is gone) is
  gated all the same, so a poisoned resume folder refuses a launch that would
  have run cleanly elsewhere. That is the fail-closed side, and it is deliberate.
- **A directory that appeared, vanished or was re-pointed during the deferral
  refuses** (`launch-directory-unverified`, shown on the panel). The CONTENT of
  a gated file is not re-read between the gate and the spawn; only the
  directory's identity is held to.
- **On POSIX only, the repository root's `settings.local.json` is read** when
  the CLI would canonicalise to it, and a linked worktree canonicalises to the
  main checkout.
- **One spelling, one verdict:** the scan and cache key is the resolved path,
  case-folded on no platform.

## Residuals and the scope matrix

- **The round-2 fixes have now had their own attacker pass and two
  confirmation passes** (rounds 5 to 7 below, ordered by the owner as ONE
  final bounded pass with same-role confirmation). Verdict at the end of round
  7: HOLDS A-E.
- **Platforms.** All assertions ran on Windows 11 except the FIFO case and the
  POSIX branch of the repository-root case (git root, worktree pointer,
  symlinked `.git`, uid veto, unbounded walk), which ran on Ubuntu 24.04 under
  WSL 2 only. The two Windows end-to-end path cases (extended-length,
  loopback admin share) never run on POSIX, and the loopback one is skipped
  where the admin share is absent. **Nothing ran on macOS**, where the POSIX
  git-root code executes in production.
- **T14 is proven through a seam** (the gate answers refused by a test flag):
  it proves the probe's plumbing on a refusal, not the gate, which the gate's
  own cases prove.
- **The win32 `isFile()` half of the non-regular-file check is still
  unverified** (Part 6): no Windows-reproducible non-regular-file hang at a
  plain file path is known.
- **A two-directory gate can add up to 6 s** (two 3 s deadlines, sequential)
  before the PTY appears, only when a directory is wedged.
- **The auth-status probe still gates `process.cwd()`** (finding 11, left by
  design); the warning it can show is true of the probe.
- The in-app refusal on a real project, and the resume-in-worktree case on a
  real transcript, remain the VM checks in the manual matrix. Not done here.

## Rounds 5 to 7 -- the final bounded pass over the round-2 fixes, and its confirmations (2026-09-22)

**Bound, stated before the first attacker ran (owner's instruction):** one
attacker pass, Opus bypass lens, scoped to the round-2 fixes only -- A = the
linked-worktree canonical root (B1), B = loopback/UNC path classification
(M2), C = directory binding across the spawn deferral (M3), D = exact-resume
preservation across the deferral (M4), E = the related minors (m5-m10, r1-r3).
Concrete repro required for any finding; in-scope defects fixed and proven with
a red mutant; then targeted confirmation from the SAME role (a fresh Opus
attacker with the same brief) asked to confirm the fixes and hunt new gaps in
them only. The confirmation broke two scopes, so a fix round and a second,
targeted confirmation followed. Three attacker rounds in all; the last returned
HOLDS A-E with no new finding. Nothing here ran on macOS.

**The pinned binary moved under the session.** The live `~/.local/bin/claude.exe`
auto-updated from 2.1.278 to 2.1.280 at 17:49 on 2026-09-22, between two runs
of the same suite. Every "the CLI does X" in this section was re-read from the
installer's version-store copy of **2.1.278** (`~/.local/share/claude/versions/2.1.278`,
237,232,800 bytes, sha256 `006ea5c8...cced8` -- the doc's pin, verified by the
confirming attacker independently). `tests/wp1/authority-manifest.test.ts` now
selects its regeneration fixture by that digest (falling back to the
version-store path) instead of by the live path, so an auto-update cannot fail
the suite or, worse, silently regenerate against another build.

### Round 5 -- the final bounded pass (Opus, over `6290f8e4..b8e0217f`)

| # | severity | finding | fix | test (red under the mutant) |
|---|---|---|---|---|
| R5-1 | MAJOR (C/D) | the resume PICKER (`scripts/resume-picker.js`) retargets `claude` into a sibling worktree (`spawnOpts.cwd = sourceCwd`, from its own `git worktree list`) that the gate never scanned -- the deferral carried the verdict for the configured and the resume directories, and the picker's choice was a third | `pickerCandidateDirs` (main process: `execFile git worktree list --porcelain`, 5 s timeout, fail-safe `[]`; `parseWorktreePaths`) merges the worktrees into the gated set; the deferral resolves `{ verdict, dirs }`; `CCC_GATED_DIRS` (JSON) is handed to the picker; `gatedDirsFromEnv` / `isGatedDir` / `resolveRetargetCwd` decide, and the spawn site EXITS 1 on `refused` -- never the configured directory instead | `pty-managed-deferral-carries-launch` (poisoned sibling refuses; clean -> `CCC_GATED_DIRS` on the PTY env; git failure degrades to the configured dir); `resume-picker-gated-dirs` (the pure decision, a source pin that the exit precedes `spawnSync`); mutants: candidates not gated, set not handed, picker ignores set |
| R5-2 | MAJOR (B) | the IPv6 loopback UNC forms Windows resolves (`\\0--1.ipv6-literal.net\C$`, the eight-hextet form; *measured*, Test-Path true, the CLI reads them) were classified network -> not-scanned, launch anyway | `isLoopbackHost`: the `*.ipv6-literal.net` spelling (`-` -> `:`, `s` -> `%`), zone strip, `normaliseIpv6` (`::` expansion, dotted-v4 tail), `::ffff:127.x` | the loopback rows + the `_isLoopbackHostForTest` matrix; mutants: ipv6-literal, no-normalise |
| R5-3 | MINOR (A) | a symlinked `.git` diverged from the CLI's `Ce`: the walk skipped every link | followed with `stat` -- **superseded in round 6** (R6-3), which showed a bare follow is the opposite error | the symlinked-`.git` case (later rewritten) |

Everything else in A-E held. Out of scope, noted and not pursued: the
shell-only first-run command and Codex `spawnArgs` are logged un-stripped;
Codex sessions are never gated (pre-existing); `recentVerdicts` is unbounded
per spelling; a symlinked `.claude/settings*.json` is over-read (safe direction).

### Round 6 -- the same-role confirmation (fresh Opus, same brief)

C, D and E held (the picker enforcement could not be made to land the CLI in
an unscanned directory across 12 `CCC_GATED_DIRS` shapes x 10 path spellings;
a planted `git.exe` in the cwd was not picked up; a 100,000-character env value
survived `CreateProcess` untruncated; `exit(1)` precedes the only `spawnSync`).
A and B did not:

| # | severity | finding | fix | test (red under the mutant) |
|---|---|---|---|---|
| R6-1 | MAJOR (B) | a trailing FQDN dot defeats the suffix rule outright: `0--1.ipv6-literal.net.` resolves like the undotted name (*measured*: the CLI reads the poisoned file through it) and classified network | trailing dots stripped before every rule | the root-dotted rows (`localhost.`, `127.0.0.1.`, three literal.net forms, the hostname); `localhost.evil` stays network; mutant |
| R6-2 | MAJOR (B) | the machine's OWN non-loopback addresses are UNC hosts for itself -- every IPv4 (LAN, Tailscale, both Hyper-V/WSL vEthernet) and every IPv6 (ULA, link-local in the `...s<zone>.ipv6-literal.net` form) resolved `\\<addr>\C$` and classified network; end-to-end the CLI read the poisoned file and the gate said not-scanned | `ownAddresses()` from `os.networkInterfaces()` on each call (zone stripped, try/catch -> []); an own IPv4 matches by string, an own IPv6 by `normaliseIpv6` equality, and the IPv4-MAPPED spelling of an own IPv4 too | synthetic-interface rows in every spelling incl. zero-expanded; neighbours stay network; a throwing `networkInterfaces` degrades to the name rules; three mutants. The confirming attacker then wrote a marker into the scratchpad and read it back through EACH live own address's admin share: every reachable one returned this machine's own bytes, so none points at another machine's disk |
| R6-3 | MAJOR (A) | round 5's bare `stat` accepted a `.git` link the CLI's `Ce` REFUSES (a link whose text carries a byte that is not UTF-8 -- legal on Linux and macOS), so the gate stopped BELOW the root the CLI used and never read that root's `settings.local.json`; repro: `clean` from the gate, `apiKeyHelper` applied by the CLI | `isGitRootEntry`: a transcription of 2.1.278's `Ce` (offset 197,227,427) and its helpers `lCt` / `Li` / `_Se` / `e$` / `Ya` / `nN` / `$5` / `FV` / `QS` / `Q` / `re` / `en` (197,243,151 and 195,98x,xxx): lstat; a symlink only when its text is NUL-free valid UTF-8, names nothing on another host or a network mount, every component of the target -- and of every link met on the way, forty deep -- is a plain entry, and the target is a directory or a file. The darwin-only volume rule (`jt`) and the stubbed `so` / `XJ` are not ported (macOS residual) | the repro verbatim (root refused via `settings.local.json (repository root)`), a relative `..` target accepted, a 40-link chain refused / 1-link accepted, `\??\foo` text refused, a nested hop with non-UTF-8 text refused; mutants: bare-stat walk, lstat-only walk, UTF-8 check dropped, host rule dropped, target walk dropped. The confirming attacker ran the port against a verbatim JS transcription of the CLI's functions over 29 on-disk layouts: **0 divergences in either direction** |
| R6-4 | MINOR (C) | the picker created the companion directory under `~/.claude/projects/<unscanned worktree>/` BEFORE it refused the retarget -- a durable side effect keyed on a directory the gate never checked | the retarget decision and its exit precede the companion block | source-order test; mutant |
| R6-5 | MINOR (C) | the refusal message wrote the raw directory to the terminal (every other path sink strips) | `displayPath` in the picker -- the same class as `src/shared/safe-text.ts`, 500 code points, surrogate-safe | 12 vectors (ESC/CSI, C1 CSI, OSC+ST, bidi, LS/PS, TAG, ZW*, NUL, DEL) and the cut; two mutants |
| R6-6 | suspected, not reproduced | `stat` follows a `.git` link into a hung mount where `lstat` did not, holding a threadpool slot | left: bounded by the two-slot ceiling and the 3 s deadline (which bounds the promise, not the thread) | -- |

### Round 7 -- targeted re-confirmation of round 6 (same attacker)

R6-1 to R6-5 all CONFIRMED-FIXED (R6-2 with the live admin-share read-back
above). One new finding, in the same function as R6-3:

| # | severity | finding | fix | test (red under the mutant) |
|---|---|---|---|---|
| R7-1 | MAJOR (A) | the BARE-REPOSITORY branch of `canonicalGitRootOf` still asked "does the shared directory hold a `.git` of its own" with a bare `stat`, where `Bt` asks with `Ce`; a `.git` link the CLI refuses under the bare directory kept the gate at the worktree while the CLI canonicalised to the bare directory and applied ITS local settings | `isGitRootEntry(join(common, '.git'), common)` -- `Bt`'s tail verbatim | the bare-repository case, three states of `<common>/.git`: absent (root resolves to the bare directory, and then the CLI's ownership probe `Lf` lstat()s `<root>/.git`, throws, and `iao` keeps the store at the cwd -- the gate agrees: clean), a real directory (worktree), a refused link (bare directory, refused); mutant. The attacker's 13-state end-to-end chain (`Kt` -> `Ce` -> `Bt` -> `cV` / `nPn` / `iao` / `Lf`): 0 divergences |
| R7-2 | MINOR (B) | classifying a UNC host now costs about 5 ms of synchronous main-process work (`os.networkInterfaces()`, 14 addresses) | left: an ordinary local directory pays nothing (`isUncPath` returns first), loopback short-circuits earlier, and the cost lands only where a UNC path is about to be declined -- beside the SMB attempt it replaces | measured, not tested |

**Verdict after round 7: HOLDS A-E.**

### Mutants recorded as EQUIVALENT (expected green, kept for fidelity)

- `readGitPointer(entry, true)` -> `readGitPointer(entry)`: a symlinked
  `.git` FILE can never satisfy the back-pointer rule (`realpath(gitdir/gitdir)`
  is the link's target, `realpath(root)/.git` is the link itself), so both
  variants return `root`; confirmed over six layouts, and `Bt` shares the
  comparison.
- the `isDirectory() || isFile()` kind check after the target walk: the walk
  (`re`) already rejects a special-file component, and a dangling target
  throws in the `stat`.
- the 40-deep bound on Linux: the kernel's MAXSYMLINKS is forty, so `stat`
  ELOOPs at exactly the depth the bound refuses. Observable only on a kernel
  with a higher limit.

### Corrections to the text above

- Row B1: "a symlinked `.git` is not a root" was the first version's rule and
  was wrong in that direction; round 5 reversed it and was wrong in the other;
  the rule is now the CLI's own (R6-3, R7-1).
- "A project on a network path is never read on the launch path" is narrower
  again: a UNC host that is this machine BY ADDRESS (any interface, any
  spelling Windows resolves) is local and scanned, as a loopback or own-name
  host already was.
- The Codex disposition ledger had no row for `pty-managed-deferral-carries-launch.test.ts`
  (added at `b8e0217f`; it matches P13 through a mocked `registerCodexReviewSession`
  key), so `legacy-codex-gate` was RED at `b8e0217f` and the round-2 close
  shipped with a red gate that its verification did not run. Reconciled
  (`added`, WP1.38) and the manifest digest regenerated; recorded here as a
  miss in that round's "full suite" claim.
- The fake-timer ceiling test stubs `stat` as well as `lstat` now that the
  walk follows links; the attacker confirmed the stub masks nothing (the
  assertion is on `open` counts).

### Residuals added by these rounds

- **macOS:** `Ce`'s darwin-only volume rule (`jt`, `/Volumes`) and `Kt`'s
  `/Network/Servers` form are not ported; a cross-volume `.git` link on macOS
  is a root for the gate and not for the CLI (same class as R6-3, macOS only).
  Nothing ran on macOS.
- The gate's `.claude` ownership lstat swallows every error where `Lf`
  rethrows anything but ENOENT: an EACCES on `<root>/.claude` lets the gate
  canonicalise where the CLI declines -- the cwd's own file is still read, so
  this is over-refusal, and it needs a second uid to reproduce.
- One worktree on a network path degrades the whole managed launch's verdict
  from clean to not-scanned (refusals still win); not-scanned is never cached,
  so every such launch repays it.
- The gated set is a whitelist of directories, not of contents: a settings
  file written into a gated worktree between the scan and the spawn is the
  pre-existing scan-to-spawn window, unchanged.
- Added launch-path latency, measured: 79 ms (32 ms git, 47 ms for eight
  directories); designed worst case 5 s (git timeout) + N x 3 s.

## Round 8 -- the exact-head Codex review of `a0eace5d`, and the double review of its fixes (2026-09-22)

**Scope.** Codex's exact-head review of PR #619 at `a0eace5d` (review
5283868877): three blockers, three CI/test corrections, and the administrative
gates (update onto `beta@2566c429`, a lowercase conventional PR title, the
desktop gate stays red). The branch was updated by merge (`d3d585df`, no
conflicts); the fixes are `4f8afcc8`. An independent spec-compliance review
(Opus) and code-quality review (Sonnet) of `d3d585df..4f8afcc8` then found
one gap in CI4 and five smaller defects, fixed in `152ed38e` and re-reviewed
by the same two reviewers: both PASS, no new blocker. No ADR-009 attacker
pass ran in this round; the Codex review is the adversarial input.

### The Codex items

| # | finding | fix | test | mutants |
|---|---|---|---|---|
| B1 | the manifest was derived at MODULE LOAD (`CLAUDE_AUTHORITY_VARIABLES = authorityManifest().entries`), and `index.ts` imports that chain statically, so a malformed manifest killed the main process before `composeProviders()`' try, its error dialog and its exit | nothing is derived at load: a memoised `derived()` that re-throws on every call for a bad manifest; the constants are functions (`authorityEntries()`, `claudeSettingsEnvStrip()`, `claudeAmbientStrip()`, `claudeAuthorityVariables()`, `claudeAuthorityEnvVariables()`, `claudeAmbientAuthVariables()`); the validator is wrapped; `createClaudePackage()` reads the derived data first, inside `composeProviders()`' try | `startup-manifest-boundary.test.ts`: computes `index.ts`'s real static import graph (the only route to the manifest: index -> compose -> claude/index -> managed-launch -> authority-manifest), imports every module on it with the manifest corrupted (each must load), proves `composeProviders()` throws, and pins the try / `showErrorBox` / `exit(1)` shape; the manifest test now reads "loads, and every derived answer throws" | B1-a..e |
| B2 | one `FileHandle.read()` was taken as the whole file; a legal short read classified a prefix while the unread bytes carried the authority key | `readFully`: reads to end of file or cap + 1 into the same fixed buffer; the deadline and the two-slot thread ceiling are untouched; a byte count different from the `fstat` size is `unreadable` (the pointer reader too since R9-3) | 512 B and 1 B per read (key past 4 KiB); a size that changed mid-read; the linked-worktree pointers at 3 B per read (POSIX) | B2-a, B2-b, B2-c |
| B3 | read and classification failures collapsed to `[]` and were CACHED CLEAN | `absent` / `keys` / `uncertain(reason)`; only ENOENT and ENOTDIR are absent; `verdictOfScan`: refused > not-scanned > clean; not-scanned is never cached (and evicts an older clean, R9-2); the scan's catch is `scan-failed`; new reasons `unreadable`, `over-cap`, `classifier-unavailable`, `scan-failed`, each with its warning text | over-cap; EACCES / EPERM / EBUSY / EIO / ELOOP on open; a stat or read failing after open; a directory and a FIFO (POSIX); no classifier, a throwing classifier; a failed scan; a refusal over an uncertain sibling | B3-a..i |
| CI4 | the ledger gate lists the bound commit's tree, absent from CI's depth-1 checkout (`not a tree object` on both platforms) | the gate reads that tree lazily and fails one case with the fix; `scripts/wp1/fetch-ledger-commit.mjs` (git without a shell, the SHA format-checked, `fetch --depth=1`, then `cat-file -e`) runs before the suite in `ci.yml` and, since R9-1, in both `release.yml` test jobs; the manifest and ledger are re-bound (`manifestHead` `4f8afcc8`) | the CI run on the pushed head | -- |
| CI5 | the `killAllAgents` test stopped awaiting `dispatchAgent()` once production gained an await, so on macOS it killed before either child registered | both dispatches awaited; spawn count, distinct pids, and a second sweep that kills nothing | `cloud-agent-manager.test.ts` | CI5 |
| CI6 | the "foreign" `fe80::1` rows depended on the runner's own interfaces (macOS owns that address) | the foreign rows run under `os.networkInterfaces()` stubbed to loopback only; the own-address rows keep their own stub | the loopback / UNC rows | -- (a determinism fix) |

`tests/unit/claude-headless-profile-consumer.test.ts` now composes the providers:
it had passed only through the B3 fail-open (no classifier meant clean).

### The double review of the fixes (`152ed38e`)

| # | from | severity | finding | fix | mutant |
|---|---|---|---|---|---|
| R9-1 | spec | MAJOR | `release.yml`'s Windows and Linux test jobs run the suite from depth-1 checkouts too, so the first release run after merge would fail the gate | the fetch is one script called by all three steps; `ci.yml` no longer names the ledger, so its ledger row is dropped | -- |
| R9-2 | spec | MINOR | an uncertain scan left the previous clean verdict in the reuse cache, and `peekGateVerdict` handed it out for up to 5 s | an uncertain verdict evicts it | R9-e |
| R9-3 | quality (MAJOR), spec (MINOR) | MAJOR | the pointer reader had the loop but not the size check: a `commondir` rewritten mid-read came back spliced or as a miss, and a miss keeps the root at the worktree while the CLI reads the main checkout | `GitPointerChangedError` out of the reader; the scan catches only that and reports `unreadable`; a key in the working directory still refuses | R9-a, R9-b, R9-c, R9-d |
| R9-4 | spec | MINOR | stale text: the cap comment (over-cap "clean"); the manifest error comment ("ordinary shells are unaffected" -- a bad manifest now stops startup at the dialog); the warning's "this session IS using it" for an over-cap file the pinned CLI skips | rewritten; the warning says "may be using it", and `unreadable` names the git pointer | -- |
| R9-5 | quality | MINOR | `readFully` can take cap + 1 reads on a one-byte-per-read filesystem, holding a ceiling slot | bounded and inside the deadline; recorded in the comment | -- |
| R9-6 | spec | MINOR | the mutant runner counted a suite that failed to COMPILE as red (B3-h's first run) | the runner reports it as an error; B3-h re-run for real | -- |

### Mutant results (restored from an in-memory copy after each; never `git checkout`)

| mutant | guard removed | Windows | Linux (WSL Ubuntu 24.04) |
|---|---|---|---|
| B1-a / B1-b | an eager manifest read at module load (manifest module / managed-launch) | RED | -- |
| B1-c | the factory never reads the manifest | RED | -- |
| B1-d | derived data degrades to empty | RED | -- |
| B1-e | a throwing validator escapes at load | RED | -- |
| B2-a | one read taken as the file | RED | -- |
| B2-b | the settings read's size check | RED | -- |
| B2-c | the pointer reader reads once (and loses its size check) | RED | RED (3 tests) |
| B3-a..g, B3-i | each uncertainty folded into absent or clean | RED | -- |
| B3-h | an uncertain verdict cached | RED (7 tests) | RED (8 tests) |
| R9-a | a torn pointer is a miss (the old check) | RED | RED |
| R9-b | the reader swallows the torn pointer | RED | RED |
| R9-c | the scan swallows the torn pointer | skipped (POSIX test) | RED |
| R9-d | the torn pointer fails the whole scan | skipped (POSIX test) | RED |
| R9-e | an uncertain scan keeps the older clean | RED | RED |
| CI5 | the dispatches not awaited (test mutated back) | RED | -- |

B2-c removes the pointer reader's loop and its size check together, so it is
not a single-guard proof of that loop; B2-a is the single-guard proof on the
settings read. Targeted suites at `152ed38e`: Windows 12 files, 363 passed /
4 skipped; Linux (the touched suites the copy can run -- it has no `.git`, so
not the ledger gate) 225 passed / 3 skipped. The full-suite result for the
exact pushed head is in the PR body: a document cannot carry the hash of the
commit that contains it.

### Boundaries stated for the reviewer, not changed

- **A complete file that does not parse stays CLEAN.** The CLI applies
  nothing from a settings file it cannot parse (measured, Part 9), so "clean"
  is what the session gets. A SHORT or TORN read is not this case: a byte
  count different from the `fstat` size is `unreadable`. Read literally,
  Codex's "absent/valid-clean" would make an unparseable file `not-scanned`;
  that is a ruling for Codex, and this round did not take it.
- **Over the cap is `not-scanned`**, although the pinned CLI skips such a file
  as well: that is one CLI version's behaviour, and the gate did not read it.
- **Root resolution.** Only a torn pointer is uncertainty. An absent or
  invalid pointer, and the home and ownership checks, still mean "no root", as
  they do in the CLI; Round 7's ownership residual stands.
- **The startup-boundary test walks static relative `import` / `export`
  only.** A top-level `require()` of the manifest would not be followed; none
  exists.
- **The ledger's bound commit (`4f8afcc8`) is a branch commit.** After a
  squash merge it is reachable only through GitHub's `refs/pull/619/*`, which
  `git fetch origin <sha>` serves. If that ever stops, re-bind the ledger to a
  commit on `beta`.
- **The Windows CI `SyntaxError: Invalid or unexpected token`** on the ledger
  gate was NOT the missing object. It came back at `4abe355c` with the bound
  commit fetched on both legs (macOS green). Root cause: the Windows runner
  checks out with `core.autocrlf`, and the #207 rule that keeps a hashbang
  `.mjs` LF (`scripts/*.mjs text eol=lf`) does not cross a slash, so
  `scripts/wp1/`'s manifest script arrived CRLF. Vite finds a hashbang with
  `/^#!.*\n/`, which does not match a CRLF first line, so it inserts its own
  code ahead of the `#!` and the module does not parse. Reproduced locally
  under Node 20 and 24 (CRLF fails, LF passes, only the hashbang line
  matters); `git check-attr` showed `scripts/release-gate.mjs` pinned and the
  WP1 script unspecified, which is why the older hashbang script passes on the
  same runner; an autocrlf `checkout-index` of the WP1 script gave 323 CRs
  under the old glob and none under the new. Fixed in `e8985073`: the glob is
  `scripts/**/*.mjs`, and `tests/unit/scripts/mjs-eol.test.ts` asserts the
  attribute for every tracked hashbang `.mjs` under `scripts/` on every
  platform (red under the old glob). Not covered by that test: a hashbang
  file outside `scripts/`, or a `.js` one, that a test ESM-imports; today the
  `.js` ones are loaded with `require()`, which Node strips cleanly.

### Corrections to the text above

- Part 9's "a settings file the gate cannot parse, or one over the size cap,
  is skipped (clean)" and Part 10's restatement: an over-cap file is now
  `not-scanned` (`over-cap`), never clean; an unparseable one stays clean
  (above).
- `CLAUDE_AUTHORITY_VARIABLES` (the ambient list section) and the other
  derived constants are functions now: `claudeAuthorityVariables()`,
  `claudeAuthorityEnvVariables()`, `claudeSettingsEnvStrip()`,
  `claudeAmbientStrip()`, `claudeAmbientAuthVariables()`,
  `authorityEntries()`.

## Round 8b -- the ADR-009 attacker pass over the round-8 changes, and gate 7 (2026-09-23)

**Bound, stated before the first attacker ran:** one attacker round, scoped to
the round-8 changes (`d3d585df..b88d8a2d`), three lenses, all Opus 5.5
(owner instruction: Opus for implementation, attack and review): L1 bypass /
fail-open on the project gate, L2 blast radius of the startup boundary, L3
design, coverage and the CI supply chain. A second round only if round 1
found a BLOCKER or MAJOR in scope; the final confirmation pass is the owner's
"final ADR review". In parallel, gate 7: an independent spec-compliance and a
code-quality review (both Opus) of `5ba627b4` + `a0eace5d` at the exact head.
Owner instruction for anything non-blocking: a follow-up ticket on the
private planning repo, not a change here.

### Attacker findings

| # | lens | severity | finding | disposition |
|---|---|---|---|---|
| A8-1 | L1 | MAJOR (in this PR, pre-dating round 8) | a working directory spelled with a trailing dot or space is ENOENT to Node's fs (it prefixes `\\?\`), so both settings files read as absent and the verdict is CLEAN, while CreateProcess strips the dot or space and the CLI runs in the real folder and applies its settings. Reachable through a cloud agent's raw `projectPath` from a user config (not repository-chosen); the PTY, headless, probe and Insights paths resolve the directory first | FIXED: `hasWin32RewrittenComponent` -- on win32 a path with a component ending in a dot or a space is `not-scanned` / `path-spelling`, never clean. Measured on Windows 11 first: CreateProcess drops trailing dots from every component and a trailing space from the last (a middle component ending in a space fails to spawn), so the rule is a superset. A blanket "the directory must exist" rule was rejected: `git worktree list` keeps stale worktrees, and it would have put a warning on every picker launch in such a repo |
| A8-2 | L3 | MAJOR (pre-dating round 8; the round-8 re-bind kept it) | the gate's new-file check listed the tree of the ledger's `manifestHead`, which moves with every re-skeleton; once that commit contained the files WP1 created, flipping every real `added` row to `retain` left the check green. Its verify-the-verifier row used an invented path in no tree, so it passed for the wrong reason | FIXED: the check lists the fixed pre-WP1 baseline (`inventory.head`, `6bafcc33`, on beta); the test now flips every live `added` row to `retain` and requires each to be caught; `fetch-ledger-commit.mjs` fetches the baseline, so nothing depends on GitHub serving a branch commit after the squash merge |
| A8-3 | L3 | MINOR (round 8) | the fetch script, run in a full clone missing the object, would have made the repository shallow (`--depth=1`) | FIXED with A8-2: an object already present is not fetched; `--depth=1` only in an already-shallow checkout |
| A8-4 | L1 | MINOR | an over-size git pointer is a miss, not uncertainty | follow-up aicc_planning#95 |
| A8-5 | L1 | MINOR (latent, round 8) | a non-pointer error from the root lookup would be rethrown and discard keys already found (no call throws today) | follow-up aicc_planning#95 |
| A8-6 | L1 | MINOR | `scanKeyFor` does not fold case, so an uncertain scan under one spelling does not evict a clean one cached under another within 5 s | follow-up aicc_planning#95 |
| A8-7 | L2 | MINOR (widened by round 8) | the loaded manifest and the derived entries are not frozen, and the registry accepts an empty ambient strip list: code already in the main process could empty it before `composeProviders()` | follow-up aicc_planning#96 |
| A8-8 | L3 | MINOR | the EOL rule and its test cover `.mjs` under `scripts/` only; a CRLF hashbang `.js` imported through ESM fails the same way, and a pre-rule Windows clone is not renormalised | follow-up aicc_planning#97 |

Held, with the probes run: T1 (a corrupt manifest makes `composeProviders()`
throw and leaves nothing registered; everything downstream fails closed), T2
(a walker over static, re-export, dynamic `import()` and `require` edges from
all four main entries and preload found one route to the manifest, the one the
boundary test pins; a sensitivity probe that derives at load in a sibling
module turns that test red), T3 (every accessor throws twice for a bad
manifest; nothing is cached after a throw), T4 to T7 and T9 on reading, and
T10: the fetch script, run against hostile ledgers (`--upload-pack=...`, a
trailing newline, `__proto__`, upper-case hex, a BOM, an unreachable SHA),
failed closed every time and wrote nothing. No finding needed private routing.
L1 was interrupted by a classifier before its POSIX and junction probes; those
surfaces were covered by rounds 5 to 7.

### Gate 7 -- independent reviews of `5ba627b4` + `a0eace5d` at the head

Spec compliance: 13 rows PASS and R6-5 PARTIAL -- no BLOCKER or MAJOR. Code
quality: no BLOCKER; one MAJOR on the sibling-worktree policy -- one poisoned
sibling refuses every managed picker launch in the repository (over-refusal,
by the round-5 design and asserted by its test), and a `not-scanned` sibling
still joins `CCC_GATED_DIRS`. Neither half yields a clean verdict (a
not-scanned sibling makes the whole launch not-scanned, with the warning), so
it is consistent with the owner's gate policy and is recorded as a design
follow-up needing an owner decision, aicc_planning#98, with the other picker
items (case folding, `CCC_GATED_DIRS` not cleared for unmanaged launches, a
malformed value read as unmanaged, de-duplication by spelling, no abort on
cancel, snapshot age). Test gaps and nits: aicc_planning#99.

### Mutants for this pass (restored from memory after each)

| mutant | guard removed | Windows |
|---|---|---|
| R10-a | the `path-spelling` check | RED |
| R10-b | only the last path component checked (a dot on a middle component) | RED |
| R10-c | the new-file check bound back to `manifestHead` | RED |

The `path-spelling` test is Windows-only by construction (the rewrite is a
Win32 rule); it runs on the windows-2025 CI leg and pins the measured
normalisation before it asserts the verdict.

### Corrections to the text above

- **R6-5** claimed 12 vectors. The test covers ESC/CSI, OSC with ST (0x9d /
  0x9c), U+202E, U+2028, a TAG character, the 500-code-point cut and a
  passthrough. C1 CSI (0x9b), U+2029, U+200B-200D, NUL and DEL are handled by
  the same regex as `src/shared/safe-text.ts` but no test would fail if they
  were dropped (aicc_planning#99).
- **macOS.** "Nothing ran on macOS" (Rounds 5 to 7) is out of date: since
  `a0eace5d` the POSIX gate cases run on the macos-latest CI leg (181 tests,
  the 2 skipped are the Windows-only pair). One exception: APFS refuses the
  non-UTF-8 link name, so on macOS the refused-link fixtures take the `$5`
  branch and the CLI's UTF-8 rule (`lCt`) has no CI coverage on any leg; only
  local Linux runs exercise it (aicc_planning#99).
- **Where the R6-3 and R7-1 mutants were red:** on Linux (WSL Ubuntu 24.04).
  Those cases sit in one test that returns early on win32, so Windows counts
  them as passed rather than skipped (aicc_planning#99).
- **Round 8, CI4:** the fetch now targets the pre-WP1 baseline, not
  `manifestHead` (A8-2); "The ledger's bound commit (`4f8afcc8`) is a branch
  commit" no longer matters to any workflow, because only the ledger's own
  binding test reads `manifestHead`.

### The final ADR-009 review (Fable, owner instruction)

A fresh attacker, never the author, confirming the round-8b fixes and
hunting for gaps they introduced. Bound: two rounds at most.

- **Round 1 (head `ccee5f18`).** A8-1 and A8-2 CONFIRMED-FIXED: 45 working
  directory spellings compared across Node's fs, a spawned `node`, a
  `cmd /c` child (the cloud agent spawns with `shell: true`) and the real
  gate; the fetch script's failure paths run in scratch clones (not a repo,
  git off PATH, no origin, an origin without the object, shallow and full
  clones); every workflow step that runs the suite is preceded by the fetch.
  One new MAJOR, introduced by the A8-1 fix: the rule was asked of the RAW
  path, so `C:\ghost.\..\proj` -- whose `..` Node and CreateProcess both
  resolve away, so the gate reads the folder the CLI runs in and used to
  REFUSE -- became `not-scanned`. Fixed in `3ac11f3d` (asked of
  `path.resolve(cwd)`); the Windows test adds both ghost spellings with an
  expected refusal; mutant R10-d (raw cwd) is RED. One latent MINOR (a WP1
  file deleted and re-created at a baseline path would escape the new-file
  check; no live instance) -> aicc_planning#99.
- **Round 2 (head `3ac11f3d`).** CONFIRMED-FIXED over 49 spellings through
  the real gate, with two invariants asserted: everything Node can open is
  still REFUSED, and no spelling is CLEAN while the CLI reads the file (CLEAN
  only where the spawn itself fails). `path.resolve` introduced no gap:
  relative, root-relative and drive-relative spellings resolve to the same
  folder CreateProcess uses. One MINOR residual with no exposure: a
  `\\.\`-prefixed spelling ending in a dot is now `not-scanned` where it was
  refused, and cmd.exe cannot start in such a folder -> aicc_planning#95.
  **VERDICT: HOLDS.**

### SSH live-matrix gate: not triggered

`src/main/pty-manager.ts` is in the SSH blast-radius list, so this was
checked rather than assumed: the SSH branch of `spawnPtyResolved` is the
`if (options?.ssh)` block, and none of this PR's hunks fall inside it. The
only SSH-related lines are the `!options.ssh` exclusions in the new gate and
picker helpers (SSH sessions are not managed launches, see "SSH / remote
sessions" above) and a log line before the branch; the gate's deferral lives
in the local branch. No sentinel parser, statusline routing or SSH-shim code
changed.

## VM gates on WINDOWS_1, and the defect they found (2026-09-23)

The two packaged-app gates (PR gates 1 and 2), run on the Hyper-V guest
WINDOWS_1 (Windows 11 22621, hostname WinDev2407Eval) against the INSTALLED
app, never in the owner's session.

**Setup.** Installer built at `c9c908a5` (`AI-Code-Conductor-2.1.1-beta.1.exe`,
sha256 `1c54ee4e…ea52`, the same hash on the VM), installed silently (product
2.1.1.0). Claude Code **2.1.280**, npm-installed, so the CLI on the PATH is the
shim `%APPDATA%\npm\claude.cmd` (above the 2.1.278 floor). One managed account
(`profile-mtoyn2mk-6990df`). Fixtures under `C:\Users\User\wp1-vm`: `gate1-proj`
(its own `.claude/settings.json` carries `apiKeyHelper` with a marker value),
`repo` (a git repository) and two linked worktrees of it, `wtA` and `wtB`.

**Driver.** A script attaches to the installed app over CDP
(`--remote-debugging-port`) and drives the renderer's own `electronAPI` -- the
same IPC the UI uses (`pty.spawn/kill/write/onData`,
`accountProfiles.managedLaunchReports`) -- so every check runs through the real
main process. Restart is driven exactly as the Restart control does it
(`useRestartSession`: kill, then an IMMEDIATE same-id spawn with the resume
picker requested). Outputs (terminal text, raw PTY streams, reports, app-log
lines, screenshots) were kept in the session scratchpad.

| Gate | Result | What was observed |
| --- | --- | --- |
| 1 -- refusal on a real project | **PASS** (01:06Z) | Terminal: `[profiles] refusing a managed Claude launch: the project's own settings could redirect this account -- settings.json: apiKeyHelper ...`; PTY exit -1; Claude never started; the marker value in no terminal output, report or panel text. Report finding `repository-settings-refused` (blocked). Settings > Accounts shows `isolation-finding-repository-settings-refused` (screenshot). app.log `[managed-launch] project settings in ...gate1-proj refuse a managed launch: settings.json: apiKeyHelper`. |
| 2a -- Restart resumes the exact conversation in ITS worktree | **PASS** (01:35Z, run `313007`) | A conversation started in `wtA` (transcript `8c0bb599-…` under `C--Users-User-wp1-vm-wtA`). Restart from the configured main checkout (`repo`): app.log `T8b captured resume target … cwd=…\wtA`, then `T8b exact resume for wp1-g2a-…: uuid=8c0bb599-… cwd=C:\Users\User\wp1-vm\wtA (was C:\Users\User\wp1-vm\repo)`; the launch line is `Set-Location '…\wtA'; & '…\npm\claude.cmd' --resume 8c0bb599-…`; the resumed view shows the first prompt; the second prompt lands in the SAME transcript with `cwd=…\wtA`. The gate reported "checking the project settings in …\repo and …\wtA and every worktree the resume picker may open" before the launch. |
| 2b -- a poisoned sibling worktree, via the picker | **PASS** (01:10Z) | `wtB/.claude/settings.local.json` carrying `apiKeyHelper`: the picker launch from `repo` is refused BEFORE the picker runs -- `… ~\wp1-vm\wtB: settings.local.json: apiKeyHelper …`, exit -1, no Claude, no value leak, finding `repository-settings-refused`. (The picker's own per-selection `exit 1` branch is reachable only for a worktree added in the milliseconds between main's and the picker's `git worktree list`; it stays covered by the unit tests.) This is the conservative #98 policy, kept as is; the alternative stays aicc_planning#98. |
| 2c -- the picker from the main checkout offers and resumes the worktree conversation | **PASS** (01:36Z, run `313007`) | With the siblings clean, the picker launched from `repo` listed the conversation tagged `⑂ wtA` (chosen by this run's own marker, not by position); choosing it resumed `8c0bb599-…` in `wtA` (binder `exact bind committed sid=wp1-g2c-… path=…wtA\8c0bb599-….jsonl`); the third prompt is in the same transcript, `cwd=…\wtA`. |

**Scope, stated rather than implied.**

- **Model replies were not exercised.** The VM's only managed account is signed
  out: its stored OAuth record has empty access and refresh tokens and a
  refresh expiry of 2026-09-16 (read as shape and dates only, never a value).
  Every assistant line in the transcript is the CLI's own `Login expired ·
  Please run /login` API-error record. The transcripts themselves are real and
  CLI-written, and the resume mechanism -- which conversation, which
  directory -- does not depend on a reply. A signed-in re-run would add model
  round-trips, not resume coverage.
- **Account switch was not exercised**: one account on the VM. A switch is the
  same Restart path (`useSwitchAccount` → `restart`).
- The first 2a/2c attempts failed on the DRIVER, not the app, and each cause was
  fixed in the driver before the counted run: CLI 2.1.280's new trust dialog
  preselects "No, exit" (answered with Down then Enter, and only once per
  appearance); the CLI paints spaces as cursor-forward escapes; its idle footer
  no longer says "for shortcuts"; the profile's `projects` folder is a junction
  the walker did not follow; and the Restart simulation must not pause between
  kill and spawn.

### The defect the VM found: a Windows npm install never had its CLI version verified

Every managed launch on the VM carried `cli-version-unverified`, and app.log
showed why: `[claude-version] probe threw: spawn EINVAL` on every probe (12 in
35 minutes). `src/main/claude-cli-version.ts` (new in this PR) ran
`execFile(<resolved>, ['--version'])`; for an npm install the resolved CLI is
the batch shim `claude.cmd`, and since the CVE-2024-27980 fix Node refuses to
spawn a batch file without a shell. So the version stayed unknown for good, and
every managed launch for an npm-installed Windows user carried a
blocked-severity "Claude Code version not yet verified" finding (preflight
`ok: false`, shown in Settings > Accounts) for a current CLI, with a doomed
re-probe every 60 s. Launches were not blocked. The gate-1 note written
earlier ("the probe had not answered yet") was wrong.

**Fix (`f2332e39`).**

- A `.cmd`/`.bat` shim is run through cmd.exe the way Node runs `shell: true`:
  `cmd /d /v:off /s /c ""<path>" --version"`, verbatim arguments.
- A shim path carrying `" % & ^` or a control character is refused, and the
  version stays unknown. npm's shim re-reads its own folder unquoted
  (`SET dp0=%~dp0`).
- The shim runs in its own folder with `NoDefaultCurrentDirectoryInExePath=1`.
- cmd.exe is `ComSpec` only when that is an absolute `…\cmd.exe`, otherwise
  `%SystemRoot%\System32\cmd.exe`.
- Every other path runs directly, as before.
- On Windows the CLI is found by an **in-process, async PATH walk**
  (`findClaudeOnWindowsPath`), in the order the launch asks `where` for it, and
  no longer through `where`, which answers in the OEM code page and mangled
  every non-ASCII profile path. The walk skips relative, drive-relative,
  unexpanded and device-namespace entries, and never asks an unreachable folder
  twice.
- A probe that does not answer is **settled at its deadline**, whatever still
  holds its streams. Its tree is killed with the absolute `taskkill /T /F`
  BEFORE cmd.exe, and nothing is killed once the child has exited.
- The unknown-version finding no longer says "not probed yet". It says the
  check may not have been able to run the CLI and points to the
  `[claude-version]` log lines.
- **Legacy pins.** The same round found that a managed launch pinned to a
  legacy CLI had its floor checked against the INSTALLED CLI's version: a 2.0.x
  pin read as "2.1.280 is at or above 2.1.278". The launch now tells the
  preflight about the pin (`pinnedCli: { version, installed }`), and the Claude
  provider decides which version to check (`claudeManagedCliVersionToCheck`):
  - An installed pin is what runs, so it is what gets checked.
  - A pin the cloud agent installs AFTER the record counts only when it is below
    the floor, so a failed install can only make the record louder, never a
    false "supported". This corner was first listed as a follow-up; the fix
    that made the code comment true closes it.
  - A below-floor pin is remedied by the pin, not by "update Claude Code".
  - The interactive launch passes the pin only when it is installed and the pane
    is not shell-only.

### ADR-009 pass over the fix

**Bound, stated before dispatch:** one attacker round, scoped to the probe's
process command-line construction through cmd.exe, two lenses, both Opus 5.5:
L1 injection/evasion, L2 blast radius + platform parity + design/coverage.
Round 1 found no way to make cmd.exe run a second command or redirect.
Characters tested in folder names: `& ^ ( ) ! ; , = ' `` ` `` @ ~ $ #`, fullwidth
and RTL forms, U+2028, NEL, BOM and NBSP. Registry cases: HKCU
`DelayedExpansion=1` and `AutoRun` (`/v:off` and `/d` both hold). Round 1
widened the fix with its MAJORs (non-ASCII `where`, the legacy pin) and MINORs.

Round 2, the re-attack of those fixes, found two MAJOR regressions the fixes
had introduced. First, a timed-out probe never settled when a descendant held
stdout: taskkill ran after cmd.exe was already dead. Second, the synchronous
PATH walk froze the main thread for 21 s on a dead network entry. Both were
fixed. Round 3 and a final confirmation of the post-review delta: **PASS on
both lenses, nothing open at BLOCKER or MAJOR.** Every guard is pinned by a
test that goes red under its mutant (below). A final Fable ADR review:
**HOLDS**. Seven theses were each tied to a named test that asserts it (no second command from a folder name; no planted node or cmd.exe from the working directory; a hung probe always settles and kills nothing after exit; the walk never blocks and never searches the current directory; no false "supported" across the pin, install and version matrix; the launch path still cannot throw; the startup import boundary is unchanged). The MQ-q equivalence (below) was confirmed. Two nits, neither required: a synchronous taskkill throw would skip the stream destroys, and a ComSpec path with spaces goes on the command line unquoted, as in Node's own shell:true.

**Double review (Opus, independent).** The spec review confirmed that every
fix item is implemented and nothing out of scope was added (the one scope
change is noted under Legacy pins). The quality review found no blocker. Their
MINORs were fixed and re-reviewed:
- flaky real-process cleanup;
- the `%` entry test and the pin-predicate tests;
- the finding-text assertions;
- the absolute taskkill;
- a POSIX timeout case;
- an exact-floor pin case;
- a `SystemRoot`-less timeout case;
- one `isWindowsAbsolute` helper;
- the doc-comment placement.

**Mutants** (each restored after its run; baseline checked green first):
**39 of 40 red**. The survivor, MQ-q, narrows the device-prefix test's leading `[\\/]{2}` to backslashes only. It is EQUIVALENT: it differs only for `//`-prefixed input, which the drive/UNC clause already rejects (confirmed by the Fable review). The mixed-slash case itself is pinned by MQ-n and MQ-v. One incident is recorded: a mutant run killed by a tool time limit
left one inserted line in the source, and a second run then measured against
it. That was caught (a baseline test went red), removed, and a checked-green
baseline plus an on-disk journal were added to the runner before the counted
run.

**Routed, not fixed here** (private planning repo, premise-reviewed):
- **aicc_planning#101.** The launch's own `resolveClaudeBinary` still uses
  `where` (non-ASCII paths). The resume picker ignores a legacy pin (it runs the
  installed CLI, while the report names the pin). The probe and the headless and
  cloud spawns can pick different installs.
- **aicc_planning#102.** An overall deadline around the PATH walk, a PATH set
  only by a PowerShell profile, a taskkill image filter, and output already
  printed before the deadline.

**Verification.** At `f2332e39`:
- typecheck clean;
- full `npx vitest run` under Git Bash: 915 files passed / 2 skipped, 11,588 tests passed / 24 skipped / 2 todo;
- the seven affected files: 271 passed / 4 skipped.

An earlier full run timed out unrelated suites: another session on this host was deliberately saturating the CPU (24 busy loops). The counted run was made after that load stopped.

**VM re-check of the fix.** The installer was rebuilt at `f2332e39` (sha256 `54060fce…84bf`, the same on the VM; the asar carries the new strings) and installed over the gate build. On a clean managed launch in `wtA`:
- At boot, app.log shows `[claude-version] installed Claude Code 2.1.280 (C:\Users\User\AppData\Roaming\npm\claude.cmd)`. Every earlier probe on this VM had logged `spawn EINVAL`.
- The launch report's compatibility is `supported`, found `2.1.280`, with no findings and `ok: true`.
- Settings > Accounts no longer shows "Claude Code version not yet verified" (screenshot kept out of the repo because it shows the account email).

Gates 1 and 2b were not re-run (owner instruction). The fix does not touch the project gate, and this check exercised the managed launch itself on the new build.
