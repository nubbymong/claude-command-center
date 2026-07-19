## 2026-07-18 -- AGENTS.md made canonical; CLAUDE.md imports it

Decision recorded in architecture/decisions/2026-07-18-adr-004-agents-md-canonical-agent-brief.md.

Ensured every agent that runs in the repo gets the same brief, from the file its
tool actually reads.

- Reversed the 2026-07-17 call that gitignored root AGENTS.md as "personal/local".
  Removed `AGENTS.md` from .gitignore (breadcrumb comment left; git check-ignore
  now returns not-ignored).
- AGENTS.md (root, tracked) is now the canonical cross-tool agent brief: migrated
  the old CLAUDE.md project content, corrected stack versions to Electron 42 /
  React 19, added a "Deeper references" section linking docs/agent-conventions.md,
  CONTRIBUTING.md, ADRs, and the operational guides.
- CLAUDE.md reduced to a short header + `@AGENTS.md` import (Claude-Code-specific;
  other tools read AGENTS.md directly as literal text, so AGENTS.md holds the real
  content).
- docs/agent-conventions.md intro updated to name AGENTS.md as the canonical brief
  it expands on.

Note: the outer non-git workspace (C:\Users\severson\Projects\Claude Command
Center) has its own AGENTS.md/PROJECT.md; unrelated to this repo.
