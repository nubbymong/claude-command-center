## 2026-10-04 -- WP2 PR 4: the owner's answers of 2026-10-04 built and recorded

**What.** The owner answered every open PR 4 item on 2026-10-04. Five lanes
built the answers on f073124e and one integration commit (8a87026a) applied
their shared-file changes; `docs/wp2/completion-plan.md` records each answer
in section 10 and this round's records in 9.7, and the parity checklist
moves its rows.

- **Section 10 questions.** Questions 2, 3, 4, 6 and 7 A and question 8 B,
  each kept as built. Question 5 C, superseding the default A: for this
  computer's own Codex sign-in the app copies its three canvas skills into
  the Codex skills folder (`~/.codex/skills`, or the one under `CODEX_HOME`),
  after noting that folder in a record in its data folder, writes or removes
  only the skill folders carrying its mark, never touches a same-named skill
  of the user's own (the canvas page names it), and removes its copies when
  Codex or the built-in tools are turned off (c0d79113). Option A's
  developer instructions, settings scan and picker record are gone, with the
  picker flag, the discovered version and the launch route port that only A
  used (8a87026a).
- **Provider boundaries and the Claude adapter (lane A).** The nine imports
  that reached past a provider package's `index.ts` are routed through the
  provider interfaces, reached from the registry (d9560e39); rule R3 leaves
  no other route, so lane A also edited the provider types, the composition
  root and two boundary allowlists (removals only), approved after the fact.
  The deep-import, cross-package reach and package-orphan allowlists are
  empty, and an esbuild metafile of `src/main/index.ts` shows no new import
  cycle. The Claude adapter's `cli.discovery`, `auth.status` and
  `auth.logout` are complete, reusing the existing `claude auth status`
  probe and a sign-out beside it in the profile's own home (14ac75e8). The
  review fix pass runs both from the executable discovery proved, with no
  shell, and a sign-out of this computer's own sign-in (the primary profile;
  every profile on macOS, where each runs on the Mac's one keychain sign-in)
  only with the user's acknowledgement; no platform carve-out is left. No
  renderer surface calls them for a Claude account.
- **Smaller answers (lanes B and C).** Codex on Windows is the first
  `codex.exe` or `codex.cmd` in PATH order (1745a9cc); one-assistant tips
  carry that assistant's mark, with no filter; the Feature Guide has a Cloud
  Agents card; Sonnet 5's fallback price is Anthropic's reference; the Opus
  hint drops its context size; a Close sessions clear held by a scanner is
  retried at each later save, exit flush and load; the credential delete
  skips quietly an id that cannot hold a stored credential.
- **Sentinel (lane E).** The VM chase showed the release notes were read and
  the wait was the analysis agent, unable to reach its model and tried twice
  under a 180 s cap. An analysis whose connection to its assistant is refused
  now says so within a minute: measured in the app for Codex; for Claude Code
  from the pinned CLI's stream format as read from its binary and the unit
  replay, its early stop not yet run against a real CLI (VM owed) (9dfc220c,
  and the Codex half in 8a87026a). The review fixes (fd02adfd, fe51f31d,
  47751ec3): Claude Code stops early on retries that got no answer, with a
  retry backstop of 8 for a Claude Code that prints no retry line, so an
  answered overload is ridden out for up to 8 retries; the title-bar chip
  says "did not complete" only after an analysis that failed. A network that
  silently drops traffic is not stopped early (a known issue).
- **Dependencies (lane D).** The sass override is scoped under excalidraw and
  pinned to 1.79.4, clearing the braces advisory from the runtime set
  (ec89e5a6); the remaining http-cache-semantics advisory is recorded as an
  explicit 2.1.1 exception on the build path only, with its exposure
  assessment and a follow-up for 2.2 (aicc_planning#127). http-cache-semantics
  4.3.0, published after the records commit, is not taken: it is unverified
  as a fix. The sass pin is dropped once excalidraw declares sass >= 1.79.
-  **Review fix pass.** The round's spec and quality reviews and its ADR-009
  delta pass ran at 8bf078f2: three reviews failed on major findings and the
  delta pass returned FINDINGS (its one major, L1-1, fixed in 89f0da82 and
  confirmed at 46832d72), the rest passed with findings. Four fixers fixed
  them on disjoint files (fd02adfd, fe51f31d, 4913297e, 89f0da82, 26fb4fcd,
  c748fa7e), and an integration commit applied their shared-file changes:
  the Codex skill copies stay the app's in every state and a removal never
  leaves an unmarked copy; Codex on Windows is looked for in fully qualified
  PATH folders, a share included, as a terminal does; a Close sessions clear
  stays owed across a restart; a Claude sign-out of this computer's own
  sign-in asks first and runs the proved executable; Sentinel's Claude Code
  analysis stops early only on unanswered retries. Row 22 goes back to
  PARTIAL (its real-account resume is still owed, as row 35's): 61 DONE, 12
  PARTIAL, 2 OPEN. A bounded second round (28960fbe, bea30e0f, 47751ec3,
  c60c864d, a3580bb6) fixed the re-review's findings, integrated after them.

**Evidence recorded.** Rows 59 and 67 are VERIFIED (CI runs 37134624406 and
37156412028; the VM e2e runs at 69c98042 and f73f1785, recorded in
`docs/wp1/evidence/mode-matrix.md`), row 60 is PARTIAL
until its release-candidate leg, and the prove-red dispatch (CI run
37155296304) is in `docs/wp1/evidence/ci-matrix.md`. Row 38's midnight UTC
check passed on the VM.

**Still owed.** The ADR-009 delta pass's round-2 re-attack; the SSH live
matrix at the final head (the pty manager, the statusline watcher and the
per-session settings writer changed at import lines, call sites and one
registry-lookup helper, with a throw on a null Claude resolve and a heal
wrapper; the local Codex branch drops the developer-instructions spawn
option, which changes its argv), with End remote with and without a saved
sudo password, the tmux kill and a non-persistent teardown; the HOST
QUARANTINE files on CI and the VM; the VM checks of question 5's copy and
removal (a held-open copy among them), the Windows PATH order, Sentinel
behind the dead proxy for both assistants (a merge gate, Claude Code on
2.1.278 and on the current version), the primary Claude profile staying
signed out after a sign-out and a restart, the Tokenomics chart and the
packaged canvas run; the Sonnet 5 price's native test in CI; the Cloud
Agents card's image; on a Mac, the Claude sign-out with the acknowledgement
and every Accounts row reading the Mac's one sign-in (owner); one real-model
Claude Code analysis on the stream format (owner). Closed since: the GitHub
sidebar's session reads leave the read-failure latch alone (f2ed852e), and
the Claude auth runs build their environment in the managed-launch shape the
WP1 check reads (9f3adef4).