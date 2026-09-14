## 2026-07-19 -- Resume Sessions prompt: refresh + width/layout polish (#130)

The startup "Resume previous sessions?" card (`ResumeSessionsPrompt.tsx`) rendered a
list captured ONCE at boot — `App.tsx` calls `session.load()` a single time into
`pendingRestore` (App.tsx:393). A session restarted after launch was therefore
missing from the list until the app was relaunched.

- **Refresh:** added an optional `onRefresh` prop + a refresh icon button in the card
  header (spins while loading). `App.tsx` wires it to re-call `session.load()` and
  update `pendingRestore` via a functional update that KEEPS the current list on a
  transient empty read (never dismisses the prompt out from under a manual refresh).
  No main/IPC changes — `session.load()` already existed.
- **Width/layout:** widened `w-80 -> w-96` (capped `max-w-[calc(100vw-2rem)]`), and gave
  each row a two-line layout — work name primary, label/path as a muted sub-line — both
  truncating, so long names are no longer chopped. Count moved to a header badge; the
  body copy trimmed. Kept it a compact bottom-right card (mouse-only, `tabIndex=-1`, no
  autofocus — unchanged contract).
- **Tests:** `tests/unit/renderer/resume-sessions-prompt.test.tsx` updated for the
  two-line rows and given refresh coverage (button present only when `onRefresh` is
  passed; click fires it). 7/7 pass; typecheck clean.
