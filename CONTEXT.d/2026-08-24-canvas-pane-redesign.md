## 2026-08-24 -- Canvas pane redesign (item C), agreed v6, five phases

The canvas review pane redesign the owner accepted on the "Canvas pane redesign"
canvas (v6 mockup). Built as one branch off beta in five committed phases, each
tested, plus an ADR-009 pass on the destructive phase.

- **Phase 1 -- chrome.** The pane leads with the MODE as its title -- PLAN /
  MOCKUP / TESTING in its own colour with a keel line -- instead of a small
  badge. Browse/Draw/Region became app-family tool chips Inspect / Sketch /
  Region; the X-ray Off/Stealth/On setting rides the Inspect chip (it only
  governs Inspect), locked to Stealth on a plan. Pure presentation over the
  existing pointer-owner + #367 x-ray state.
- **Phase 2 -- framed content + provenance.** The reviewed page sits in a 2px
  framed card with a "PAGE UNDER REVIEW" tag; the "canvas was filed" banner
  became a one-line provenance sentence with "Reopen it".
- **Phase 3 -- panel.** App surfaces (no mantle slab) + slim scrollbar; rounds
  grouped under NEEDS YOU / WITH THE AGENT / CLOSED section headers; seen-aware
  collapse (a round waiting on the user folds only once its addressed notes have
  been SEEN, never before -- the canvas_verdict seen-barrier still gets its
  dwell); a hide control that collapses the panel to a ~30px rail.
- **Phase 4 -- two-level history.** The flat version select became a per-artifact
  version stepper + a History picker that chooses the artifact (a plan, a
  mockup, a legacy test build). A display projection over the version list
  (shared `artifactRuns`, so main and the picker agree) -- no ids or review
  anchors move. Legacy uat builds fall into a muted Archived group.
- **Phase 5 -- archive + permanent delete-artifact.** Two history-row actions.
  Archive is reversible (an `archived` flag on the versions, validated on load
  like `draft`). Delete is permanent: it removes an artifact's versions, their
  files, and their review notes. DURABLE via a new monotonic `nextVersion`
  high-water counter on the (MAC-signed) canvas record -- healed on load, never
  lowered on delete -- so a later render mints a fresh id and never resurrects a
  deleted one. New IPC `canvas:archiveArtifact` / `canvas:deleteArtifact`.

**ADR-009 (the destructive path).** An adversarial pass (two attacker lenses +
a round-2 re-attack) found one MAJOR and one LOW, both fixed:
- MAJOR -- `deleteArtifact` removed each version dir with `removeTreeNoFollow`
  starting BELOW the realpath-checked canvas dir, so a junction planted at
  `<canvasDir>/versions` redirected the per-version delete out of tree
  (`deleteCanvas` was immune -- it walks node-by-node from the checked root).
  Closed with a per-version realpath identity check plus a final-component lstat
  of `versions/`. Regression test plants a real junction and proves the victim
  survives; reverting either guard fails it.
- LOW -- the sketch-file unlink now re-checks `PNG_PATH_RE`, mirroring
  `unlinkPastedImage`. Record integrity (MAC / `archived` / `nextVersion`),
  counter durability, note over-deletion, cross-canvas isolation, refused-delete,
  and only-artifact refusal all held.

**Deferred (owner-approved, tracked for a follow-up).** Two agreed affordances
were not built and the owner chose to merge as-built and follow up: TESTING
MODE's LIVE pill + "End test" (net-new live-test chrome; uat currently reads as
an Archived artifact), and the consolidated one-primary-Approve + honest-words
"⋯" verdict menu (the functionality already works through the existing per-note
and per-round verdict controls -- this is UI consolidation, not a gap).
