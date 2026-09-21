## 2026-09-21 -- WP1 slice 2: managed-launch hardening for Claude accounts

Slice 2 of WP1. Slice 1 (`6eceb5ac`) built the provider core, the registry and
the composition roots; it deliberately wired no launch handoff. This slice wires
one, and makes it the place four security controls live.

### The problem slice 1 left open

Slice 1's realm-env contract removed ambient authentication variables from a
managed launch. The owner's ruling of 2026-09-20 said that is not sufficient for
Claude: the CLI also reads SETTINGS files, and this app copies the shared
`settings.json` into every managed profile home
(`src/main/account-profiles.ts`). Stripping the environment and then handing the
CLI a settings file that can re-add the same values is not isolation.

Three probe rounds against the pinned CLI settled what actually stops it. The
executable record is `docs/wp1/evidence/claude-settings-isolation-2026-09-21.md`
(Part 1 = the probe matrix, Part 2 = what was built on it).

### Four layers, and where each one lives

1. **Strip** -- the Claude package's `ambientAuthVariables` grows from four
   names to the full derived, classified authority list
   (`src/main/providers/claude/managed-launch.ts`). Every entry records its
   authority `kind` and whether it is documented, observed in the pinned binary,
   or both. Codex's list widens the same way, from its own CLI's diagnostic.
2. **Sanitise** -- the app-owned settings copy is read, cleaned and written
   rather than `copyFileSync`'d. Command/credential helper keys go entirely;
   inside `env`, only authority-bearing entries go; everything else is
   preserved. The destination is unlinked before the write, so a hardlink can
   never make the sanitiser edit the user's own settings through it. The shared
   source and any repository-owned settings are never touched.
3. **Apply the host control** -- a new `hostManagedEnv` on the provider package,
   applied LAST by `applyRealmEnvPatch`. A realm patch that tries to set or
   unset one is refused, in any case-variant, and registration refuses a package
   that declares the same key as both a host control and an owned variable.
   "The host wins" is a property of the mechanism, not of call order.
4. **Preflight** -- `src/main/managed-launch-diagnostics.ts`, run on every
   managed spawn, surfaced through `accountProfiles:managedLaunchReports` and
   rendered by `AccountIsolationNotice` in the Accounts panel (blocked findings
   only; nothing to say means nothing rendered). It is a DIAGNOSTIC and says so
   in its own header: remote and mid-session settings sources are not locally
   observable, so a clean preflight is not a claim of isolation. Its job is to
   make a missing control loud.

### One choke point, because six call sites is five too many

`withProfileHome` is now the single place a managed Claude environment is
composed, and it takes the policy from the REGISTERED package rather than
restating it -- so a launch path cannot opt out of half of it. `claude auth
status` was the one path that had hand-built `{ ...process.env, USERPROFILE }`
and therefore had no hardening at all; it now goes through the same function. A
test walks `src/` and fails on any new site that redirects USERPROFILE without
it.

Fail-closed, deliberately: `withProfileHome` and the settings sanitiser both
refuse when no provider package is registered, rather than composing an
unpoliced environment or copying an uninspected file. That is why several
existing suites now compose the registry the way boot does.

### Minimum verified CLI version

`2.1.278` -- a floor of EVIDENCE, not of capability. The control may work in
older releases; nothing here has tested one. Comparison deliberately uses the
prerelease-aware comparator, because the other one in this repo would call
`2.1.278-beta.1` equal to `2.1.278`.

### Two decisions recorded rather than taken quietly

- The sanitiser removes four command/credential helper settings keys, where the
  instruction named one. The other three are the same defect class and are
  present in the pinned binary; removal acts only on the app's own copy, so
  over-inclusion is cheap and under-inclusion is not. Narrowing to the literal
  scope is a one-line change.
- A CLI below the floor produces a blocking-severity preflight finding, logged
  at every managed launch -- it does not refuse the spawn. Refusing would brick
  multi-account work on an older CLI, and the version probe is asynchronous.
  Escalation is a one-line change at the call site.

Both are written up in Part 2 of the evidence doc with the reasoning.

### Not claimed

Complete settings-source isolation. Five manual acceptance gates are owed and
none has been run; they are tabulated at the end of the evidence doc. The one
that could invalidate the design is A1: whether a real signed-in profile home
still authenticates from its stored OAuth credential with the host flag set.
The probe that proved fail-closed behaviour tested a profile with no stored
login, so that question is genuinely open.

### Independent review, two rounds

Two reviewers, neither the author: one on spec compliance, one on code quality.

**Round 1.** Both agreed the mechanism is sound and both found the same gap --
layer 4 was write-only, so "fail visibly" described a surface that did not
exist. Twelve findings fixed, two of them structural: the source guard's
whole-file exemption had permanently excused the exact file it was written to
catch, and an EMPTY host-control declaration was invisible to both the preflight
and the launch-path assertion. The version probe now resolves the binary the way
`claude-cli-probe.ts` documents instead of execing a bare name Electron's PATH
may not resolve -- without which the new panel would mostly have shown a false
alarm on macOS.

**Round 2 found a defect round 1 had created, and both reviewers found it
independently.** The settings sanitiser interpolated the raw `JSON.parse` error
into its refusal message, and V8 quotes a window of the source in that message.
That had been log-only; promoting the preflight to a screen turned it into "a
malformed settings file puts its own contents in the Accounts panel", with a
half-edited credential line being one of the likelier ways to malform one. Now
reduced to a position, with the `fs` read path reduced to an errno for the same
reason. The other round-2 finding was an interaction between the two round-1
fixes: the panel scanned every retained report, so the version probe's new
recovery path was invisible through it -- a user who installed the CLI kept
being told to check their version. Now only the newest report per profile home
is consulted.

One policy question is left open for the owner rather than decided: the ambient
strip now reaches plain account-pinned shells, which is right for the
add-account login flow and arguably wrong for a developer's `aws` CLI in the
same tab. It is at least no longer silent -- `info` findings render behind a
toggle in the same panel.

### Coverage

`tests/wp1/managed-launch.test.ts` (74), `tests/unit/main/claude-cli-version.test.ts`
(15), `tests/unit/renderer/account-isolation-notice.test.tsx` (8). Each guard
proven red under a mutant of the production code: **21 mutants, 21 detected**.
Full suite 907 files / 11332 tests, typecheck clean.
