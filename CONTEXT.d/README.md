# CONTEXT.d -- running decision log (CARP)

This directory is the **running decision log**: a dated record of decisions,
changes, blockers, and assumptions as work happens. It follows the CARP
convention (one entry per file) so parallel branches never collide on a shared
log file.

## How it works

- **One fragment per entry:** `CONTEXT.d/YYYY-MM-DD-<key>.md` (optional
  `-<slug>`), containing a single `## YYYY-MM-DD -- <title>` block. Plain
  Markdown, ASCII, no frontmatter.
- **Add a NEW fragment** for your ticket/session. Never edit another entry's
  fragment. Roll very old entries into `CONTEXT.d/0000-00-00-archive.md` (sorts
  last).
- **`CONTEXT.md` is generated, not tracked.** It is the aggregate of all
  fragments (header + fragments, newest first) and is gitignored (`/CONTEXT.md`).
  Regenerate on demand; never hand-edit or commit it. Because it is never
  tracked, it can never be a merge conflict.
- **Architecture/decisions** with lasting rationale go in
  `architecture/decisions/` as ADRs (`YYYY-MM-DD-adr-NNN-title.md`), not here.
  This log records *what happened and why, when*; ADRs record *the decision*.

## What belongs here

Decisions and their rationale, notable changes, blockers, assumptions,
follow-ups. Not: durable structural docs (README/AGENTS), secrets, or
third-party restricted content.
