## 2026-08-26 -- #536 carry the CCC session name onto the transcript (sidecar)

A session's display name (customName, set by the left-hand rename) lived only in CCC's stores --
never on the transcript. The resume picker mapped names via a uuid->customName map read back from
session-state.json (last-writer-wins, collides when sessions share a folder), and a diagnostic had
to cross-reference session-state by uuid to tell which transcript was which.

Chosen mechanism (user decision): a CCC-owned SIDECAR, not a line inside Claude's JSONL. Writing
into `<uuid>.jsonl` risks breaking Claude's own resume parse (#535 territory); a sibling
`<uuid>.ccc-name.json` couples to nothing Claude reads, survives worktree/cross-account moves, and
the picker prefers it over the fragile session-state map.

Implementation:
- `src/main/logging/session-name-sidecar.ts` (new): pure `sidecarPathFor` / `writeNameSidecar` /
  `readNameSidecar` (injectable I/O, best-effort, JSON.stringify-escaped name, blank name REMOVES
  the sidecar) + a pending-name registry (`rememberSessionName`/`getRememberedName`/`forget`) that
  bridges "renamed before the transcript is bound".
- Rename IPC (`logs2-handlers.ts` LOGS2_RENAME_SESSION): remember the name; write the sidecar now if
  the session is already bound (`getTranscriptBinder().getLatestTranscriptPath`).
- Binder exact bind: new `onExactBind(sessionId, canonicalPath)` dep (sibling of #480's `persist`);
  `logging-service.ts` wires it to write the remembered name once the path is known.
- Picker (`scripts/resume-picker.js`): new `readSidecarName(conv.filePath)`, preferred over
  `loadWorkNames` at the label site.

Best-effort throughout: a name is never worth throwing into a rename/spawn/bind path; every read is
fail-safe -> null. Un-renamed sessions write no sidecar (picker falls back to the session-state
label -- existing behaviour).

Known follow-up: #535's transcript relocation does not yet move the sidecar (a relocated transcript
falls back to the session-state name). Minor; note for a later pass.

Gate: 62 targeted tests (20 new sidecar unit tests + picker readSidecarName cases); binder+logging
suites 236 pass; typecheck clean (3 tsconfigs). Refs #480 #130 #535.
