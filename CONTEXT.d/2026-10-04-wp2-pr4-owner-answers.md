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
  probe and a sign-out beside it in the profile's own home; the sign-out is
  unsupported on macOS only, where one keychain sign-in is shared by every
  Claude Code on the Mac (14ac75e8). No renderer surface calls them for a
  Claude account.
- **Smaller answers (lanes B and C).** Codex on Windows is the first
  `codex.exe` or `codex.cmd` in PATH order (1745a9cc); one-assistant tips
  carry that assistant's mark, with no filter; the Feature Guide has a Cloud
  Agents card; Sonnet 5's fallback price is Anthropic's reference; the Opus
  hint drops its context size; a Close sessions clear held by a scanner is
  retried at each later save, exit flush and load; the credential delete
  skips quietly an id that cannot hold a stored credential.
- **Sentinel (lane E).** The VM chase showed the release notes were read and
  the wait was the analysis agent, unable to reach its model and tried twice
  under a 180 s cap. An analysis that cannot reach its assistant now says so
  within a minute, for Claude Code and Codex (9dfc220c, and the Codex half in
  8a87026a).
- **Dependencies (lane D).** The sass override is scoped under excalidraw and
  pinned to 1.79.4, clearing the braces advisory from the runtime set
  (ec89e5a6); the remaining http-cache-semantics advisory is recorded as an
  explicit 2.1.1 exception on the build path only, with its exposure
  assessment and a follow-up for 2.2.

**Evidence recorded.** Rows 59 and 67 are VERIFIED (CI runs 37134624406 and
37156412028; the VM e2e runs at 69c98042 and f73f1785), row 60 is PARTIAL
until its release-candidate leg, and the prove-red dispatch (CI run
37155296304) is in `docs/wp1/evidence/ci-matrix.md`. Row 38's midnight UTC
check passed on the VM.

**Still owed.** The reviews and the ADR-009 delta pass of this round; the
SSH live matrix at the final head (the pty manager, the statusline watcher
and the per-session settings writer changed at import lines and call sites
only); the VM checks of question 5's copy and its HOST QUARANTINE link
tests, the Windows PATH order and the packaged canvas run; the Cloud Agents
card's image.
