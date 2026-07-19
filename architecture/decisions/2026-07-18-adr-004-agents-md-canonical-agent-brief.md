# ADR-004: AGENTS.md is the canonical, tracked, cross-tool agent brief

- **Status:** Accepted (2026-07-18)
- **Deciders:** @nubbymong (owner)
- **Related:** CONTEXT.d/2026-07-18-agents-md-canonical.md, CONTEXT.d/2026-07-17-ccc-launcher-and-docs-protocol.md (the decision this reverses), CLAUDE.md, AGENTS.md, docs/agent-conventions.md

## Context

Instructions for agents were fragmented and, worse, not reliably delivered to
every agent that runs in the repo:

- `CLAUDE.md` (read only by Claude Code) held a full project brief.
- `docs/agent-conventions.md` (tracked) held the detailed conventions.
- Root `AGENTS.md` — the emerging **cross-tool** standard read by Codex, Cursor,
  Copilot and others — was **gitignored** (2026-07-17 docs-protocol adoption
  treated it as "Personal/local config"). So the one file most non-Claude agents
  look for was never committed: a fresh clone or CI checkout had no `AGENTS.md`.

Goal: any agent executing in the repo picks up the same instructions, from the
file its tool actually reads.

Two constraints shaped the design:

1. **`@import` is Claude-Code-specific.** Other agents read `AGENTS.md` as literal
   text and do not expand `@path` imports — so `AGENTS.md` must contain real
   content, not merely reference other files.
2. **Avoid a third divergent copy.** `docs/agent-conventions.md` already exists as
   the deep-dive; `AGENTS.md` should be the canonical entry point that points to
   it, not duplicate every detail.

## Decision

**Make `AGENTS.md` the canonical, tracked, cross-tool agent brief; reduce
`CLAUDE.md` to a one-line import of it.**

1. **Un-ignore `AGENTS.md`.** Remove it from `.gitignore` (breadcrumb comment left
   in place). This reverses the 2026-07-17 "AGENTS.md is personal/local" call —
   that rationale is obsolete now that the file is the shared source.
2. **`AGENTS.md` (root, tracked) = canonical brief.** Migrated from the old
   `CLAUDE.md` content (build/run, architecture, coding conventions, testing,
   release/changelog/commit standards, CARP protocol), corrected to the actual
   stack versions (Electron 42 / React 19), plus a "Deeper references" section
   linking `docs/agent-conventions.md`, `CONTRIBUTING.md`, the ADRs, and the
   operational guides.
3. **`CLAUDE.md` = `@AGENTS.md`.** A short header plus the import, so Claude Code
   gets the identical brief with no second copy to maintain.
4. **`docs/agent-conventions.md` stays the deep-dive.** Its intro now names
   `AGENTS.md` as the canonical brief it expands on.

## Consequences

- Every agent tool reads the same instructions from the file it natively loads:
  Claude Code via `CLAUDE.md → @AGENTS.md`, others via `AGENTS.md` directly. CI
  and fresh clones now ship the brief.
- Single edit site: change `AGENTS.md`; `CLAUDE.md` follows automatically.
- **Reverses ADR-adjacent prior decision.** The 2026-07-17 fragment's "root
  AGENTS.md is gitignored" note is now superseded; see the breadcrumb in
  `.gitignore` and the new CONTEXT.d fragment.
- **Some overlap remains** between `AGENTS.md` and `docs/agent-conventions.md`
  (architecture, hard constraints). Deliberate: `AGENTS.md` must be self-contained
  for non-Claude agents; `agent-conventions.md` carries the exhaustive detail.
  Keep them in sync on *structural* changes only (per the CARP doc rule).
- **Anyone who kept a personal, uncommitted `AGENTS.md`** at the repo root would
  find it now tracked — it must be moved out (e.g. to `.agents/`, still ignored)
  before committing.
- Watch for stale stack-version strings elsewhere (e.g. `docs/agent-conventions.md`
  still says "React 18"); correct opportunistically.
