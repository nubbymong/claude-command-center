# 2026-08-24 — Tips rotation survives acknowledge; GitHub pill sheds the octocat; canvas tips catch up

Owner goodnight-list items, one PR off beta.

**The "Got it" vanish bug (and its twin).** `markTipActed` nulled
`currentTipId` with no successor; the sidebar tip row only renders while the
current tip exists AND RESOLVES, and `pickNextTip` runs once per launch. So one
"Got it" — or Discuss, or the tip's action button, all three call
`markTipActed` — unmounted the whole row for the rest of the session. Review
found a second path with the same symptom: using the feature an
excludes-without-postUse tip points at makes `resolveContent` null (e.g.
`tip.memory-visualiser` + opening Memory). Both fixed IN THE STORE: acknowledge
and usage-unresolve now ADVANCE the rotation (`selectNextTip`, acted tip
excluded and 7-day-shown-skipped, silence respected); the row goes empty only
when the rotation genuinely runs dry. The TipCard consequently advances in
place instead of closing when its tip unresolves (its own "Next advances in
place" model); its close-on-null effect still guards the rotation-dry case.

**NOTE for future readers:** `src/renderer/changelog.ts` (2.0.x history)
records the OLD intent — "'Got it' … clears the tip pill (markTipActed clears
currentTipId)". That line is history, not current design; do not restore the
nulling behavior from it.

**GitHub pill.** `SessionGitHubPill` (SessionHeader) is dot + "GitHub" only —
octocat SVG removed at the owner's request (2026-08-24 screenshot), pinned by a
no-svg test.

**Canvas tips housekeeping** for merged #435/#436: right-click dismiss-all
(confirm + Reopen), Ctrl+V paste-to-attach, chat picks on A/B/C chips,
two-level History (artifact picker + per-artifact stepper, Archived group,
archive/permanent delete), mode-as-title, Inspect/Sketch/Region chips with
X-ray riding Inspect. Copy fact-checked against the components; two stale
location/label claims fixed along the way (Canvas sits beside Snap, not
Browser — a test pinned the wrong wording and now pins the right one; the
scratchpad tip's close instruction names the Terminal-labelled toggle).

**Double Review:** spec + code-quality reviewers (independent) found the second
vanish path, two non-discriminating tests (both rebuilt to fail on mutants),
the missing component-level regression tests (added: dock survives acknowledge
+ excludes-fire; card primary click leaves a successor armed), and the copy
staleness above. Changelog entries for these fixes land with the rc.1 cut prep.

**Deferred/known:** `AgentCanvasPane.tsx` renders a literal 🔒 emoji in JSX
(landed with #436; against the no-emoji-in-JSX convention) — FYI-triage item.
