## 2026-10-03 -- WP2 PR 4: Codex tools, surfaces and qualification (P4.1 to P4.11)

**What.** PR 4 is the last implementation PR of the 2.1.1 Codex parity
release. It carries the 15 rows left after PR 3 (15, 16, 51 to 60, 66, 67
and 68): the Agent Canvas, browser and vision tools for Codex sessions; Ask
Conductor on Codex, with the "Ask Conductor runs on" Settings row when both
assistants are on; Codex memories and log folders; Cloud Agents and Insights
run with `codex exec`; the Codex web session and the artifacts record; Linux
and real-CLI CI; the end-to-end mode matrix; the qualification and owner-run
gates; and the final user-facing sweep that takes the Codex "Beta" labels off.

**Where the plan is.** `docs/wp2/completion-plan.md`, section 9 (the phase
plan, its probes, lanes, phase entries, owner-gated items and package gates),
with sections 2, 4 and 10 and `docs/wp2/parity-checklist.md` brought current
in the same commit.

**Stacking.** PR 4 is stacked on PR 3 (#626), itself on #625, and targets
beta; #625 and #626 merge first, and PR 4's own commits are those after PR
3's final head.

**Open with the owner.** Section 10's questions 5 (row 51, how the canvas and
vision instructions reach this computer's own Codex sign-in), 6 (row 53,
characters outside the BMP on the npm `.cmd` route and a live Ask tab) and 7
(row 57, what a Codex agent's skip-permissions choice runs as). Each is built
as its default A meanwhile; PR 4 waits on the answers before its merge is
recommended, as PR 3 does for questions 2, 3 and 4. Question 8 (rows 51 and
52, raised by the VM checkpoint): what Codex's Auto preset, which cannot ask,
should do about the app's own tools; built as default B, no keys, so they are
refused on Auto. Also to confirm: OR1 runs
rows 4 and 6 on every OS before merge (the owner's request said "on each
system"; plan 9.5 names per OS only for rows 4 and 15).

**First code.** A shared scaffold (S0) lands before any lane starts: the IPC
channel names, preload bridges and their types, a provider on the Cloud Agent
and Insights records, the background lease kind, the `askConductorProvider`
setting field and the Codex web-session id class. Handlers come with the
phases that use them. S0 and the plan were reviewed PASS.

**Built so far** (each phase's record is in the plan's 9.4 entry; rows in the
checklist):

- P4.1 (row 51, PARTIAL: question 5): the Agent Canvas on a Codex session's
  `/mcp` connection, its roots from the configured folder, the three canvas
  skills staged in a managed account's folder on the Built-in Tools master
  switch as Claude's `--plugin-dir` carries them, question 5's default A on
  this computer's sign-in, the per-preset approvals, and markers typed
  through one submit primitive at Codex's ready composer, a marker not sent
  kept on the canvas page until dismissed.
- P4.2 (row 52, PARTIAL: question 8): the vision tools and the push to the
  in-app browser for Codex sessions under Claude's switches.
- P4.3 (row 53, PARTIAL: question 6): Ask Conductor on Codex, the "Ask
  Conductor runs on" row with both on, the help folder with `AGENTS.md`
  rebuilt before every Ask start of either assistant and every Ask launch
  run in it, the question on the launch line on the direct route's fresh
  launch and typed through the primitive elsewhere, emoji removed and
  counted, a question not sent kept with Send again; a Codex Ask on Read
  Only. After the resources folder moves, the next Ask start begins a new
  conversation in the new help folder.
- P4.4 (row 55, PARTIAL: the delete check; row 56, VERIFIED, VM pending):
  each account's Codex memories on the Memory page, read only for now
  (delete built, hidden and refused in main until the VM check; frontmatter
  edit does not carry over), and each account's log folders in Settings.
- P4.5 (row 57, PARTIAL: question 7): Cloud Agents on Codex through `codex
  exec` under a background lease, Auto for the skip-permissions tick; at
  quit a running agent's whole tree is ended as a Claude agent's is.
- P4.6, first half (row 58, OWNER): a Codex account's own web partition,
  the orphan warning over both prefixes, Claude's claude.ai items off a Codex
  tab's menu and pane. The sign-in window waits for OR2a, the artifacts
  half for OR3.
- P4.8 and P4.9 (rows 59, 60, 67): Linux in the CI test matrix, the real-CLI
  conformance job per OS with the runner's own Codex home proven untouched,
  and the mode-matrix specs with a pure reader for Codex's first screens.
  They move when their CI and VM runs are recorded.
- P4.10, first part: the traceability binding made decidable on a shallow
  CI checkout and unable to certify itself, and the map of what the 20 DONE
  rows owe (`docs/wp1/evidence/release-qualification.md`).
- P4.11 (row 54): the Codex Beta labels off, the Feature Guide showing the
  cards for the assistants in use, and the PR 4 user-facing sweep with the
  2.1.1 changelog lines, built on the defaults of questions 5 to 8; seven
  listed items are owner calls (the plan's P4.11 record).
- P4.7 (row 68, DONE, mocked; d99a553b to 699c0214 with fix passes 1 to
  8, fix pass 5 below): Insights for a Codex account as the OR3 mockup
  drew it, approved on the canvas 2026-10-05 (C1 = A): the app reads and
  counts that account's own sessions, and one read-only `codex exec` with
  no tools, under the account's lease, writes the cards, which the page draws in its layout,
  figures and history as text; Run all rolls up the accounts of both
  assistants, its written analysis holding no tools and reading the
  comparison as data; `insights:run` answers the app window only and checks
  the provider and id class. Fix pass 1 (23505eaa to 63878767) cleared the
  three WP1 gate failures found at integration; fix pass 2 (b896c5d9,
  a566fff8) answers ADR-009 round 1 and the spec and quality reviews; fix
  pass 3 (228af0d5 to b0165c10) answers the VM dry run with the real CLI:
  the sandbox refusals counted in the words real sessions record, an
  account whose sign-in check failed named in Run all with its reason, and
  the provider row's in-use line following the count; fix pass 4
  (df25c65b, c293f847) answers ADR-009 round 2 (PASS: 0 blocker, 0 major)
  and the fix pass 3 reviews, their minors fixed (26 mutants, 26 killed);
  fix pass 6 (46510944 to d01c91e5) answers ADR-009 round 3 (four lenses,
  PASS: 0 blocker, 0 major) and the fix pass 4 reviews (8 mutants, 8
  killed); fix pass 7 (23176b9c; 4 mutants, 4 killed) answers the one
  minor of ADR-009 round 4 over fix pass 6 (two lenses, PASS: 0 blocker, 0
  major); fix pass 8 (699c0214) puts the Codex run confirmation in its own
  file on the dialog palette, for the #360 guard CI failed on at d1a126a3.
  The spec and quality reviews of fix passes 4 and 6 PASS; ADR-009 round 5
  over fix pass 7 (one lens) PASS at d1a126a3. At d1a126a3 the VM run
  passed every piece (3 refusals and 3 failed commands per account on
  0.153.4 and 0.155.1, the links file 6 of 6, the packaged walk), and the
  pre-push batch to it was green (327 host-safe unit files, 6,037 tests,
  at f9630c5d; fix pass 7 again at d1a126a3). Row 58's artifacts record
  is signed (67f44333).

**Owed for PR 4 now.** The spec and quality reviews of fix pass 8; the
spec reviews of 1daf5faa, c0a0b7f6, 07b400b8 and f6b9a086; the checks of
the dev dependency bumps; the Electron 44 migration, its ADR-009 pass and
its VM packaging run; the final VM e2e and packaged pass at the final
head; CI at the final head; the owner's checks (OR1, OR2, OR4, OR5a and
the screenshot review).

**Why this way.** The parity rule (OD26 P1): Claude's behaviour in the code
is the spec. Where it carries over it decides, as when the re-review sent
the per-tool-group skill staging back to Claude's master-switch rule; where
it cannot, the built default stands and the owner is asked (section 10,
questions 5 to 8).

**Shipping with workarounds (app knowledge, Known issues).** A Codex session
on this computer's own sign-in may get the canvas and vision tools without
their guidance (question 5's default); a canvas verdict line a Codex session
does not take is said on the canvas page; Ask Conductor on Codex cannot pass
on emoji typed into Codex's prompt; Ask Conductor starts nothing when its
help folder cannot be rebuilt.

**Reviews.** Every phase had its spec and code-quality review, a batched
fix pass per lane, and a re-review of those fixes; the re-review's own fix
pass (41638f93, b4413a24) is verified, spec and quality PASS, and the WP1
ledger is current at b4413a24 (0a643a5e). Recorded residuals and follow-ups
are in each phase's record: among them the Past discussions picker when the
resources folder sits inside a git repository (a follow-up proposal) and the
POSIX quit check of a Codex agent's commands (VM).

**Gate status.** ADR-009 pass: PASS at 1a51bb66 (four lenses, two fix rounds);
VM confirmations owed. The SSH live matrix at PR 4's final head (OR5:
`pty-manager.ts` changed outside the SSH branch). The VM walks each phase
lists, the e2e suite at the final head, CI with `ci-run` (the first Linux run
of the WP2 stack),
the owner's screenshot review, OR1 to OR4, the Desktop test gate, and
questions 5 to 8. Findings about pre-existing behaviour raised by the reviews
were routed privately.

**VM checkpoints and CI.** VM checkpoints 1 and 2 ran at 69c98042 and
passed, apart from four findings fixed in 2ef1c892, 00b8da6d, 3bb58680 and
e30aded1 (the plan's 9.7 record), with P4.5's non-admin edit case going to
OR6 and the memory delete check to OR4. PR 4's first CI run failed on POSIX
in tests only (b76e9f6c, 1eba3623); on ext4 a file deleted and made again at
once keeps its inode, recorded as a limit of the identity checks. Still owed
on the VM: a picker launch showing the inline guidance in a new
conversation, the compat test leaving `~/.codex` untouched, and an Ask
Restart resuming on both assistants.

**Final head.** The final-head VM run at f73f1785 passed (e2e 94 of 94, the
picker guidance, the compat test, an Ask Restart on both assistants, the Auto
refusal, the capture tool's host safety); what it found since is fixed
(eef195d8, 512e6bb4), and row 38 stays scheduled. The recaptured images wait
for the owner's review, with step-snap and the Mac images still to take.
512e6bb4 fixes a boot chain latent since 2.1.0 that no shipped path hit. The
dependency floors are raised (198b0412, ca965fd7); the electron-builder 26 and
excalidraw chains need major changes and are the owner's. P4.10's second part
is done; OR1, OR4, the VM rollback run and the release-level items stay
owner-gated.

**Usage attribution, fix pass 5.** #625's attribution delta pass (four
minors) and the two tests its spec review owed are answered on this branch:
a session's usage is attributed only to the profile it runs under now, with
ASCII-only case folding and an exact registry link first (a5b181ea);
attributions are kept, never queued, while the index is not listening
(6f9cbd4f); the first-index and re-read progress tests (932b7d00); the guide
and app knowledge say how a resumed session is attributed (the records
commit), and fix pass 6 brings the README's summary into line (cc6f2ac1).
Confirmed: #625's delta ADR-009 confirmation over fix pass 5 (two lenses)
PASS, and fix pass 5's spec and quality reviews PASS.
