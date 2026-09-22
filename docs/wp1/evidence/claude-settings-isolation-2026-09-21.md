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

