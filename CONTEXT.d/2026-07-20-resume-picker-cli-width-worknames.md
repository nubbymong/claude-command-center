## 2026-07-20 -- CLI resume-picker: real terminal width + surface CCC work names (#130)

The bug driving #130 is the CLI resume/new-conversation picker (`scripts/resume-picker.js`)
that runs INSIDE the terminal before Claude opens -- not the React startup card
(`ResumeSessionsPrompt.tsx`) the issue body originally described. Both are addressed on
this branch; this fragment covers the CLI picker.

Three symptoms, three root causes:
- **Width:** picker hard-clamped to 78 cols (`Math.min(process.stdout.columns||80, 78)`),
  so title/meta/preview lines truncated on any wider terminal. Fix: `computeLayoutWidth`
  honors real width (floor 60, ceiling 120).
- **Renamed work name never shown:** the picker only reads Claude transcripts
  (`~/.claude/projects/*.jsonl`) and had no access to session-state.json (where
  `customName` lives). It was spawned with only cwd + forwarded flags. Fix: pty-manager
  sets `CCC_CONFIG_DIR` on the PTY env; `loadWorkNames(configDir)` reads session-state.json
  and maps `resumeUuid -> customName` (the transcript basename UUID equals resumeUuid).
  Conversations that were renamed sessions now lead with the work name (bold peach), with
  the first user message kept as a dim sub-line so context isn't lost.
- **Hard to pick:** addressed by the above -- recognizable name up front + wider rows.

- **Not renderer-only** (contra the issue body): touches `scripts/resume-picker.js` +
  `src/main/pty-manager.ts` (env injection, best-effort/fail-safe). No IPC/schema changes.
- **Tests:** `tests/unit/scripts/resume-picker.test.ts` gains `computeLayoutWidth` (wide/narrow/
  fallback) and `loadWorkNames` (map, skip-missing, fail-safe) coverage. 62/62 pass;
  node + web typecheck clean.
- Env var chosen over passing the name as a flag: it lets the picker label the WHOLE list
  from one read, and keeps the visible command line clean. The current-session-name-in-header
  variant was dropped -- customName isn't in the spawn options, and cwd->name is ambiguous
  when sessions share a cwd; `resumeUuid` gives a precise per-row match instead.
