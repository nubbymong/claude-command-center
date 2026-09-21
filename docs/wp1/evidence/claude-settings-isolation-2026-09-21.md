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
| A1 | With the host flag set, a real signed-in profile home still authenticates from its STORED OAuth credential | Part 1's `X3` proved fail-closed with NO host key present. It never tested a stored OAuth login under the flag. If the flag suppresses stored credentials too, managed sessions cannot sign in at all and the design needs rework | NOT RUN |
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
