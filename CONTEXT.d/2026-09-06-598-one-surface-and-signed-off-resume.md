## 2026-09-06 -- One session surface at a time, and a signed-off canvas is done (owner-found rc.15 bugs, PR #598)

**Report (owner, driving rc.15 live, 2026-09-05).** Opening the Agent Canvas while the
browser pane was open did nothing -- the browser held the foreground and the canvas never
rendered. And the purple "resumable" dot on the Canvas button kept lighting for canvases the
owner had already approved: "if something was signed off then it should be done."

**Mechanism, panes.** The browser, canvas and logs panes were three independent `isOpen`
flags and App.tsx rendered the highest-priority open one (Logs > Browser > Canvas). Opening
the canvas set its flag but left the browser's set, so the browser kept winning -- and the
browser is a native WebContentsView, so nothing HTML can sit over it anyway; closing it is
what reveals the canvas. Fix: `src/renderer/stores/altPane.ts` is the coordinator
(`toggleAltPane` / `openAltPane` / `closeOtherAltPanes`) and the three buttons route through
it (64208981). Three paths opened a pane WITHOUT it and left two flags set: the canvas-queue
popover's resume/open and the CommandBar "page" command (both 336feedb), and -- found by the
post-fix review -- `openAccountPane` in the browser store, reached from the CommandBar
Artifacts button and from Settings' internal-browser sign-in. That one is closed AT THE
SOURCE: the browser store's own `navigate` and `openAccountPane` (the two writes that set
`isOpen: true`) call `closeOtherAltPanes` themselves, so no present or future caller has to
remember. The caller-side calls in WebviewButton and CommandBar went as redundant. This is
a deliberate import cycle (altPane reads the browser store; the browser store calls
altPane), only ever inside actions and never at module evaluation; the repo has no no-cycle
lint and other stores already cross-import.

**Mechanism, signed off.** `isResumeCandidate` / `resumeCanvasForSession` (canvas-store)
excluded only a `completed` (Marked complete) canvas, so a reviewed-and-approved one that
was never formally completed -- the common case -- stayed resumable. `isSignedOff` now
gates both: the newest version the user would act on carries 'approved' / 'dismissed'.
'rejected' asks for another round and stays resumable; an open (unverdicted) version stays.
The first cut (6f6a63af) scanned the FLAT version list, and the review found it strands a
new artifact run: approve run A, archive it, start run B as a draft -- the scan skips the
draft and lands on A's approval, so B is omitted from the list AND refused by the action.
Now judged on the NEWEST artifact run only (`artifactRuns(...).at(-1)`, the grouping the
Library and archive use), and a draft rendered after that run's last ready version reads as
the next round starting: unfinished, not signed off. Two meanings of "signed off" coexist on
purpose and are documented at the function: the Library chip means Marked complete (#476);
the resume gate means the newest run carries a user verdict.

**Tests.** `alt-pane-coordinator.test.ts` drives the real coordinator against the real
stores, now including the at-source cases for `openAccountPane` and `navigate`; each was
proven red by removing its eviction. `canvas-session-link.test.ts` gains the multi-run
block: archived approval then a fresh open run; a show-and-tell-only run; a trailing draft
(after an archive, and in the same run); the newest run approved = done; an archived
approval alone = done. Under the flat scan three of those fail.

**macOS CI lane.** `Test (macos-latest)` had been red on every push since 572411ed: the
`profileIdFromHome` test asserted that a BACKSLASH profile home maps to its id on every
platform. On POSIX a backslash is a filename character -- the basename is the whole string
and fails the id charset -- and the app never builds a HOME that way there; the inverse is
platform-native, like `getProfileConfigDir`. A test defect, not a behaviour change: the
assertion now expects the id on win32 and null elsewhere. The implementation (reviewed in
the adversarial pass) is untouched.

**Not in the ADR-009 path table.** Renderer stores/components and canvas resume logic that
only tightens (a signed-off canvas is refused where it was allowed); no IPC, preload, PTY
argv, credential or updater code. No adversarial pass for this round; the independent spec
and quality reviews ran.
