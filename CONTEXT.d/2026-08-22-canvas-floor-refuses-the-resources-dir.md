# 2026-08-22 — the canvas served-root floor refuses the app's own resources directory

Fifth of the #371 follow-ups, from the note the #308 adversarial pass left behind.

## The gap

The floor refused the home directory and every ancestor of it, a volume root, and the
dot directories under home (`~/.ssh`, `~/.claude`, `~/.aws`, `~/.gnupg`) — the places a
USER's credentials live. It did not refuse the place THIS APP keeps credentials.

The resources directory holds `CONFIG/` — `ssh-credentials.json` (the DPAPI-encrypted SSH
passwords, sudo passwords and secret arguments) and `conductor-secret.json` (the Conductor
MCP HMAC key) — plus `account-profiles/` and `account-homes/` (Claude OAuth tokens), and
the canvas store itself. Registered as a canvas served root, all of it becomes readable
over the `ccc-ux://` surface.

Same-user hardening, not a privilege boundary: the agent already runs as the user. What it
removes is the canvas quietly turning "read a file" into "serve a credential store over
HTTP" because a working directory happened to point there.

## All three directions, and why

`isResourcesDirOrAround` refuses the directory itself, anything UNDER it, and anything
that CONTAINS it. The third is the one worth arguing for, and the precedent is already in
the file: `isHomeOrAncestor` refuses ancestors of home for exactly this reason — serving a
parent serves the child. It bites when someone points their resources directory inside a
project they actually work in, which is the only configuration where the exposure is
real *and* invisible.

Applied at all three sites the floor is applied, because two of them would otherwise be a
way round it:

- `registerCanvasUatRoot` — the live root, at spawn;
- `designateCanvasWorktreeRoot` — the lexical floor for a worktree that does not exist
  yet;
- `liveDesignatedRoot` — re-evaluated on EVERY resolution, so a directory that was fine
  yesterday and is inside the resources directory today stops serving today.

The store's own rule decides the direction when it is ambiguous: *"Over-denial is the
intended direction: a refused root costs a canvas render, an accepted one costs a
credential."*

## Five existing suites changed, and why they had to

Five canvas suites were laying their test content in places the new floor refuses, and it
is worth being explicit that this is a test-layout problem rather than the rule being too
strict:

- `ccc-ux-protocol` and `canvas-distroot-confinement` registered
  **`path.dirname(mkdtempSync(os.tmpdir()))`** — i.e. the whole system temp directory —
  as the base. That also contains each suite's mocked resources directory, so the
  contains-it rule refuses it. Each now gets its own dedicated parent, which is what
  "the base the dist sits under" was always meant to be.
- `canvas-content-egress`, `canvas-record-provenance` and `canvas-adoption` built their
  dist / project directories **inside** the mocked resources directory. Moved out to
  their own temp directories.

None of the assertions changed; only where the fixtures live.

## Verification

Each of the three sites was mutated independently and watched go red — 6, 1 and 1 tests
respectively — then restored byte-for-byte. The suite also covers a case-variant spelling
(the Windows case that a string compare misses), a path reaching the directory through
`..`, a sibling directory that must still be accepted, an ordinary project directory that
must still be accepted, and an unresolvable resources directory abstaining rather than
refusing everything.

Full suite on the branch: 7086 passed, 15 skipped, 2 todo (662 files, 2 skipped);
typecheck clean.

## Review follow-up (same day)

**A refusal now says which floor it hit.** `canvasRootRefusalReason` /
`describeCanvasRootRefusal` name the floor, the log line carries it, and
`canvasRootRefusalFor` hands it to the Conductor MCP tool so an agent whose render was
refused is told *why* instead of being told to write the file where it already wrote it.
The generic message was unreachable-by-design for this case: the branch that names the
folders which WOULD have worked only runs when there is a root, and the refusal is what
emptied the list.

**The worktree designation is no longer collateral.** It sat in the same `else if` chain
as the project root, so any refused project directory also cost the session its worktree
root — even though `<parent>/ccc-wt/<sid>` neither contains nor sits under the resources
directory and would have been accepted. One refusal, not two.

**Fixture hygiene.** Four relocated fixtures had FIXED names in shared temp
(`ccc-adopt-confine-proj`, `ccc-prov-planted-dist`, …). This repo mandates parallel
sessions, so two concurrent runs writing one path is an EPERM window on Windows — the
repo's known "flaky suite = load, not a test" failure mode. All are `mkdtemp` now, every
relocated directory is tracked and removed in `afterAll`, and the `PRIVATE KEY` fixture no
longer persists in shared temp.

One relocated assertion had gone **vacuous**: it kept a hardcoded `'confine-outside'`
basename after the directory moved, so it normalised to a path that does not exist and
passed on the missing-file branch — it would have passed with the containment logic
deleted. It uses the real directory now.

**Not symmetric, stated plainly.** The floor is re-applied per resolution for
*designated* worktree roots (`liveDesignatedRoot`), and the suite proves it. It is **not**
re-applied for live UAT roots: `resolvesUnderSessionRoot` compares against the registered
set and never re-runs the floor, so a project root keeps serving until the session
respawns. Defensible — live roots are registered once at spawn — but the earlier wording
implied all three sites give a live re-check, and they do not.
