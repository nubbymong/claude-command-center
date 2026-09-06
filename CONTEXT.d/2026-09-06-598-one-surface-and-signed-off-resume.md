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
post-fix review -- `openAccountPane` in the browser store, reached from the Artifacts
buttons (CommandBar and Sidebar, via `openArtifactsPerSetting`), from Settings'
internal-browser sign-in, and from the pane's own Back-to-account. That one is closed AT THE
SOURCE: the browser store's own `navigate` and `openAccountPane` (the two writes that set
`isOpen: true`) call `closeOtherAltPanes` themselves, before they snapshot state, so no
present or future caller has to remember. The caller-side calls in WebviewButton and
CommandBar went as redundant. This is a deliberate static import cycle (altPane reads the
browser store; the browser store calls altPane) -- the repo's only runtime store cycle, used
only inside actions and never at module evaluation; there is no lint rule against cycles
and the renderer bundle builds. One consequence to know: Settings' sign-in picks a host
session itself, so the eviction lands on a session that was not active at click time (the
handler then switches to it); the native view has to own the pane, so that is unavoidable.

**Mechanism, signed off.** `isResumeCandidate` / `resumeCanvasForSession` (canvas-store)
excluded only a `completed` (Marked complete) canvas, so a reviewed-and-approved one that
was never formally completed -- the common case -- stayed resumable. `isSignedOff` now
gates both. The first cut (6f6a63af) reverse-scanned the FLAT version list; two reviews
found what that gets wrong on a canvas with a HISTORY of runs: an earlier run's approval
answered for later work (approve run A, archive it, render a show-and-tell run B: B read as
done), and -- the sharper one -- an approved NEWEST run masked an OPEN version of another
kind (plan v1 awaiting the user, design v2 approved), which Mark complete refuses but the
resume gate called done, stranding the plan review with no way back in. Now read the way
the completion guard reads it: `openVersionIdsOf` (moved to `src/shared/canvas.ts`, ONE
definition for both gates) must be empty -- nothing owed in any live run -- and the newest
run's anchor (`artifactRuns(...).at(-1)`, skipping show-and-tell and withdrawn) must carry
'approved' / 'dismissed'. 'rejected' stays resumable; drafts only = nothing decided, stays.
Drafts otherwise neither block nor count: they are the agent's own loop (#366), shown to
nobody, absent from the Library and history, and ignored by Mark complete -- so a draft the
agent rendered after an approval does NOT reopen the subject (a cause no screen could show
and no gesture could clear). Relative to beta the gate only tightens (beta had no
sign-off test at all: every uncompleted canvas with a dead owner was adoptable); relative
to 6f6a63af it relaxes two classes beta allowed -- a newest run with no version the user
would act on (show-and-tell or withdrawn only), and an open version in an earlier live run.
The invariant is one-directional: the gate never says done over a canvas Mark complete
would refuse on its versions. Known gap (pre-existing since 6f6a63af, not closed here):
Mark complete also refuses over review notes still with the agent, which this store cannot
read, so a canvas with notes still owed under an approved newest run reads as done to the
resume gate. Two meanings of "signed off" coexist on purpose, documented at the function:
the Library chip = Marked complete (#476); this gate = decided.

**Tests.** `alt-pane-coordinator.test.ts` drives the real coordinator against the real
stores, now including the at-source cases for `openAccountPane` and `navigate`; each was
proven red by removing its eviction. `canvas-session-link.test.ts` gains the multi-run
block: archived approval then a fresh open run; an open earlier run of another kind under
an approved newest run; a show-and-tell-only run; an archived run's open version; the
newest run approved = done; an archived approval alone = done; drafts after an approval
(archived and same-run) = done; drafts only = not signed off (nothing listed, since the row
builder needs a shown version, but the action does not refuse it).

**macOS CI lane.** `Test (macos-latest)` had been red on every push since 572411ed: the
`profileIdFromHome` test asserted that a BACKSLASH profile home maps to its id on every
platform. On POSIX a backslash is a filename character -- the basename is the whole string
and fails the id charset -- and the app never builds a HOME that way there; the inverse is
platform-native, like `getProfileConfigDir`. A test defect, not a behaviour change: the
assertion now expects the id on win32 and null elsewhere. The implementation (reviewed in
the adversarial pass) is untouched.

**Not in the ADR-009 path table.** Renderer stores/components and main canvas resume logic;
no IPC, preload, PTY argv, credential or updater code, and the gate is strictly tighter
than beta. No adversarial pass for this round; the independent spec and quality reviews
ran (two rounds: the quality review's major above, then re-verification).
