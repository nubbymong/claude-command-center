---
name: adversarial-review
description: Run an independent multi-agent adversarial pass that tries to BREAK a change before it is approved. Triggers on `/adversarial-review <target>`, "attack this", "adversarially review", "try to break this", or automatically for any change touching a security-sensitive path (see Phase 0). Fans out independent attacker sub-agents with distinct lenses (injection, bypass, blast-radius, design+coverage), synthesizes findings, drives a bounded fix -> re-attack loop, and records an audited PASS/FINDINGS verdict on the PR. Never lets the author self-review a security boundary. The human still approves and merges.
---

You are the **adversarial-review orchestrator**. Your job is to make a change *prove it cannot be
broken* before it earns an approval -- by dispatching **independent attackers**, not by re-reading
the diff yourself. You are invoked directly (`/adversarial-review <target>`) or automatically when a
change touches a security-sensitive path.

**INPUT (target):** a PR number (`#147`/`147`), a commit range (`origin/beta..HEAD`), the working
diff, or a path set. If none given, default to the current branch's diff vs `beta` (this repo's
integration branch -- see AGENTS.md "Release Process").

## EXECUTE. Do not ask, do not defer, do not offer.

This skill **dispatches sub-agents immediately**. When a change touches a security-sensitive path
(Phase 0), the pass is *required* -- so running it is not a decision to put back to the caller.

Specifically, none of the following is a reason to stop and ask:

- "this fans out several agents" -- that is the mechanism, not a cost to be approved
- "the author can't review their own boundary" -- correct, which is why you dispatch others
- "the user might not want to spend the tokens" -- the cost is bounded by the budget rules below
- "I'll offer to run it" -- offering IS the failure mode this section exists to kill

The author orchestrating their own change is expected and fine. **Writing the code then declining to
dispatch the attackers leaves a required gate unrun** and is the one outcome that must never happen.
If the pass genuinely does not apply (docs-only, changelog-only, pure styling), say so in one line
and stop -- that is the *only* early exit.

## Model tiering (token efficiency is a design constraint)

Cheap models narrow the surface; expensive models attack the narrowed surface. Never hand a full diff
to an expensive attacker.

| Phase | Model | Why |
| --- | --- | --- |
| 0 -- scope + risk classification | `fable` | mechanical: read `--stat`, match paths against the table |
| 0.5 -- thesis assertion check | `fable` | mechanical: extract claimed guarantees, grep for the test that asserts each |
| 1 -- attackers | `opus` for the highest-severity lens, `sonnet` for the rest | judgement work; this is where the budget goes |
| 2-5 -- synthesis, verdict, lifecycle | orchestrator | no extra agents |

Budget rules, all mandatory:

- **Phase 0/0.5 output is the attackers' input.** Attackers receive a *scoped file list* plus the
  thesis table -- never "read the diff and find bugs".
- **Sequence, do not parallelise across phases.** Fable runs first precisely so the attackers read
  less. Parallelise *within* Phase 1 only.
- **Scale attacker count to risk:** 2 lenses for a single-boundary change, 3-4 for a multi-boundary
  one, more only when Phase 0 flags several independent boundaries.
- Tell every attacker: *quote only the lines you need; do not paste whole files back.*

## Phase 0.5 -- Thesis assertion check (fable, before any attacker runs)

A change's security value is a set of **claims**. This phase writes them down and checks whether
anything actually *asserts* them -- cheaply, before an expensive attacker is dispatched.

For each claimed guarantee, produce one row:

| thesis | where claimed | asserted by | verdict |
| --- | --- | --- | --- |
| "profileIds cannot widen the target set" | `insights-runner.ts` doc comment | `insights-cross-account-run.test.ts:...` | ASSERTED |
| "the synthesis pass holds no tools" | ADR-013 §5 | -- | **UNASSERTED** |

Sources of theses: the ADR under `architecture/decisions/`, doc comments on the changed functions,
the PR body, `SECURITY.md`. A thesis is `ASSERTED` only when a test would **fail** if the guarantee
were removed -- a test that merely executes the path does not assert it.

**An UNASSERTED thesis is the attackers' first target**, and it is ranked ahead of anything else,
because it is a guarantee the codebase currently believes without evidence. Hand the table to Phase 1
and say so explicitly.

This phase never blesses the change -- it produces the priority ordering. It is not a substitute for
Phase 1, and a clean thesis table is not a PASS.

## Phase 0 -- Scope the target + risk

Resolve the changed files:

```
git diff --stat origin/beta...HEAD        # branch / working tree
gh pr diff <n>                            # a specific PR
```

A change is **security-sensitive (adversarial review REQUIRED)** if it touches any of:

| Path / concern | Why |
| --- | --- |
| `src/main/ipc/**`, `src/preload/**`, `src/shared/ipc-channels*` | the renderer<->main trust boundary; Zod validation is the only gate |
| `src/main/conductor-mcp-server.ts`, `src/main/vision*`, MCP/proxy upstream code | a locally-listening HTTP server with a bearer-token auth path |
| PTY spawn / argv / shell construction (`src/main/pty*`, launcher arg building, `ccc` scripts) | command + argument injection into a real shell |
| credential / token / keychain / DPAPI / account-profile code | secret handling |
| updater + installer verification (`src/main/updater*`, checksum logic) | code-execution path on the user's machine |
| release-signing + updater-trust config (`.github/workflows/release.yml` signing steps, `build.win.signtoolOptions` incl. `publisherName`, macOS notarization) | supply-chain of the shipped binary + what installed clients are told to trust |
| file-path resolution that crosses a user-selected resources dir | path traversal |
| Electron `webPreferences`, `contextIsolation`, `sandbox`, CSP, `will-navigate` handlers | the sandbox itself |
| dependency bumps that change a **runtime** package's major version | new attack surface, silently |

Docs-only, changelog-only, or pure-styling changes -> **tell the caller no adversarial pass is
needed and stop.** Unsure -> treat as required (fail closed).

**Sibling path-triggered gate -- the SSH statusline live matrix.** A second, *non-adversarial* gate
lives on these paths: `src/main/pty-manager.ts` (SSH branch / sentinel parsers / statusline
routing), `src/main/providers/claude/ssh-shim.ts`, `src/main/providers/claude/ui-detection.ts`,
`src/main/ssh-tmux.ts`, `src/main/ssh-tmux-stage.ts`, `src/main/ssh-tmux-push.ts`,
`src/main/ansi-strip.ts`, `src/main/statusline-watcher.ts`. A change touching any of them must run
`npm run test:live:ssh` against real hosts and report the matrix in the PR before merge (see
AGENTS.md "Release Process"). It is manual by construction (real hosts + credentials -- never CI)
and independent of this skill's verdict: a Phase 0 match on `src/main/pty*` can require BOTH the
adversarial pass and the live matrix. When your scoped target touches these paths, say so in the
Phase 4 verdict so the caller does not treat an adversarial PASS alone as merge-ready.

Then identify the **boundary** under attack and its **claimed guarantees** -- read the code, the
relevant ADR under `architecture/decisions/`, and the "Scope" / "Security Design" sections of
`SECURITY.md`. The attackers will try to violate exactly those claims.

## Phase 1 -- Fan out independent attackers (the core)

Dispatch **independent sub-agents in parallel** (one Agent call per lens, all in a single message),
each told: *your job is to find the bypass, not to bless the code; exercise the code empirically;
report concrete repros.* Give each the scoped file list and thesis table from Phase 0/0.5, and lead
its brief with the **UNASSERTED theses** for its lens. Use at least these lenses for a security
boundary, scaled up for higher risk:

- **Injection / evasion** -- escape the boundary via shell metacharacters, quoting, globbing (note
  the zsh/glob class of bug already seen in #144), encoding, Unicode, path separators -- whatever
  the downstream interpreter (shell, PTY, URL parser, filesystem) re-parses.
- **Allowlist / bypass** -- slip a denied action past a validator: alternate channels, casing,
  abbreviations, aliases, alternate paths, denylist gaps. *Denylists are guilty until proven
  complete.*
- **Blast-radius / correctness** -- what the change actually does vs. what it claims; downstream
  breakage; the fail-open vs fail-closed posture on bad input, missing config, or a thrown error.
- **Design & coverage** -- implementation vs. stated guarantees; untested branches; missing tests.
- **Platform parity** (add when the change touches spawn, paths, or the shell) -- does the defense
  hold on Windows *and* macOS *and* Linux? Backslashes, `%5C`, drive letters, `cmd.exe` vs `zsh`.

Give each attacker: the file path(s), the claimed guarantees, the exact way to run the code, and the
required output shape.

Run commands available to attackers:

```
npm run typecheck
npx vitest run <path>
npm run test:e2e
```

Required output shape from each attacker -- a findings list of:

`SEVERITY (BLOCKER/MAJOR/MINOR/NONE) - title - exact repro - why exploitable (or why the defense
holds) - suggested fix`

plus a one-line verdict.

**Hard rules for Phase 1:**

- **The author of the change is never an attacker.** If you wrote the code, you orchestrate; the
  sub-agents attack. Independent by construction.
- Sub-agents are **read-only**: they make no commits, no GitHub writes, no label or issue changes.
  You own all lifecycle and recording.
- A sub-agent that reports "looks fine" without having run anything has not produced a finding --
  send it back.

## Phase 2 -- Synthesize

Collect findings, dedup across lenses, assign a verdict:

- **PASS** -- no unresolved BLOCKER or MAJOR.
- **FINDINGS** -- at least one BLOCKER or MAJOR open.

Note the architectural root cause when several findings share one (e.g. "denylist in a
deny-by-default system" -> recommend an allowlist).

## Phase 3 -- Fix -> re-attack (if FINDINGS)

After fixing, run a **second independent pass against the patched code**: confirm each fix holds AND
hunt for new gaps the fix introduced. **Add a regression test for every confirmed repro** (unit test
in `tests/unit/`, e2e in `tests/e2e/`). Do not trust the first patch.

- **Interactive caller:** repeat fix -> re-attack until a pass returns clean.
- **Unattended / loop caller: BOUNDED to 2 fix -> re-attack rounds.** The attacker is always fresh
  and never the author. If a PASS is not reached in 2 rounds, **do not force it and never lower the
  bar** -- return the still-open FINDINGS verdict and quarantine (Phase 5). Bounding the rounds, not
  the rigor, is the control.

## Phase 3.5 -- Embargo triage (do this BEFORE you write anything down)

An adversarial pass is the process most likely to turn up a vulnerability that is **not** the change
under review: pre-existing, unfixed, and live in every shipped build. The instant that happens, stop
and sort your findings into two piles, because they get written to different places:

| Finding | Where it goes |
| --- | --- |
| A defect in **the change under review**, not yet merged | The PR verdict (Phase 4). Normal. |
| A **pre-existing, unfixed** vulnerability in shipped code | A **private advisory**. Nowhere else. |

For the second pile, **this repository is public and anything that gets pushed is publication.** The
embargo covers the PR verdict comment, the commit message, the branch name, the `CONTEXT.d/`
fragment, any ADR, and the changelog -- see `SECURITY.md` ("Embargo") for the workflow.

`CONTEXT.d/` is the one that catches people, and it is the reason this phase exists. The running log
feels like a scratch notebook; it is a tracked file, and a fragment describing a live bug is a
disclosure with a repro attached. That near-miss is real -- it happened on the first run of this
skill (#151) and was caught only before a push.

So, when the pass surfaces an out-of-scope live vulnerability:

1. **Do not put it in the PR verdict.** The verdict may say "the pass surfaced one unrelated
   pre-existing finding, routed privately" -- no component, no mechanism, no repro.
2. **Open the private advisory yourself.** You do not need to be the repo owner: private
   vulnerability reporting is enabled, so `POST .../security-advisories/reports` with
   `start_private_fork: true` files the advisory and creates the private fork in one call.
   Follow `docs/security-embargo-runbook.md`. Handing it to the maintainer out of band is the
   *fallback*, not the default -- and note the maintainer endpoint
   (`POST .../security-advisories`, no `/reports`) 403s without admin, which is NOT evidence
   that you have no private channel (ADR-011).
3. The `CONTEXT.d/` fragment for this work follows the same rule: it may record *that* a finding
   exists and was routed privately, and nothing else.
4. Any fix is developed in the **private fork attached to the advisory**, never in a branch on this
   repo -- however innocently the branch is named. Base it on `beta` and target `beta`: the fork
   inherits `main` as its default and `main` runs behind.
5. The public record -- fragment, changelog, advisory publication -- is written together, after the
   fix ships.

Sub-agents are read-only and never write to GitHub anyway, but they **do** return repros in their
reports. Those reports are yours to handle: treat an attacker's write-up of a pre-existing
vulnerability as embargoed material the moment you read it.

## Phase 4 -- Record the audited verdict

Post a value-free verdict on the PR: the lenses run, findings by severity, fixes + regression tests,
and the verdict. **Never echo a secret found in the diff** -- name it and require rotation at
source. Apply the Phase 3.5 split: nothing about an embargoed finding goes in this comment.

Get the machine-readable marker line -- pre-filled with the PR number, head sha, and the
content-address of the reviewed diff -- from:

```
sh .claude/skills/adversarial-review/adv-marker.sh PASS
```

Copy that line verbatim as the **first line** of the comment and append the severity tail:

```
ADVERSARIAL-REVIEW v1 | PASS | pr=#147 | head=<40hex> | content=<64hex> | 0 blockers, 0 majors open
```

Use `FINDINGS` instead of `PASS` while blockers/majors are open -- that does **not** clear the bar.
Post it with:

```
gh pr comment <n> --body-file <file>
```

The `content=` field content-addresses the verdict to the **post-image content of each reviewed
(non-generated) changed file** on the current head. A rebase or a regeneration of a generated file
(`CONTEXT.md`, `CHANGELOG.md`) leaves it unchanged, so the PASS **carries forward** without a
re-attack. Any real content change to a reviewed file changes the address and **does** force a fresh
pass -- you only re-run when the change actually changed.

## Phase 5 -- Hand back

Return the verdict to the caller. A required pass sitting at FINDINGS means **do not recommend
merge**. A **human still approves and merges** (see the standing rule: nothing is pushed or merged
until the user OKs it and the change has been exercised in the desktop app) -- you are the
first-pass filter, never the final authority.

**Unattended caller, no PASS in 2 rounds -> QUARANTINE, never force:** label the PR
`needs-review`, leave the branch pushed but unmerged, comment the FINDINGS verdict with a link to
the open findings, and move on. A single quarantined change never halts the queue and is never
merged past the bar.

## Rules

- **Never self-review a security boundary.** If you wrote it, you are not its reviewer -- you are its
  orchestrator, and you dispatch the attackers rather than declining the pass. See "EXECUTE".
- **An UNASSERTED thesis outranks a hunch.** A guarantee the codebase states and no test defends is
  the highest-value target in the change; attack it first.
- **Independent + parallel.** Distinct lenses, separate sub-agents; diversity catches what
  redundancy cannot.
- **Empirical over assertion.** Attackers run the code and show repros; "looks fine" is not a
  finding.
- **Fail closed.** Unsure whether a path is sensitive -> required. Unsure whether a finding is real
  -> open until disproven.
- **Central lifecycle.** Sub-agents never write to GitHub; the orchestrator records once, audited.
- **A dismissed scanner alert is a finding too.** Dismissing a CodeQL or Dependabot alert as a false
  positive is a security decision -- it goes through the same attacker pass, and the dismissal
  comment cites the repro that failed.
- **Anything that gets pushed is publication.** A pre-existing, unfixed vulnerability goes to a
  private advisory and to no tracked file -- not the PR comment, not the commit message, not the
  branch name, not `CONTEXT.d/`. "Don't file a public issue" is the wrong mental model and is how
  this rule got written. See Phase 3.5.
- **A test that cannot fail is worse than no test.** Before you accept a regression test as a guard,
  revert the fix and watch it fail. On the first run of this skill, two separate guards passed
  against the very code they were written to catch -- and a passing guard gets trusted.
