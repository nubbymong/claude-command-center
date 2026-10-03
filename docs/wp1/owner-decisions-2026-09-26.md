# Owner decisions, 2026-09-26: Codex on upgrade, and the parity rule

This record supplements `owner-decisions-2026-09-20.md`. It records decisions
the owner made on 2026-09-26 while PR #625 (WP2) was being finished, and what
each one changes in the WP1 design and its acceptance items. It does not
rewrite the design; where the two disagree, this record wins.

## U1. Every upgrader confirms Codex again

Owner, verbatim: "No matter who upgrades we need to either not set up codex or
set it up - they reconfirm either way", and "we should formally confirm the
codex sign in anyway."

| What | Decision |
| --- | --- |
| The question | Once, after the release notes, every user who updates answers "Do you use Codex?" (Yes, set up Codex / No, I don't use Codex). A fresh install answers on its assistants page instead. |
| The earlier setting | Nothing carries over. A saved `codexEnabled` counts only with `codexAnswered` saved `true`; main ignores it otherwise, and the renderer drops it once at load. Until the user answers, Codex is **not set up**: nothing of it starts (no launch, no review, no CLI look-up). |
| This computer's sign-in | `~/.codex` (or the folder `CODEX_HOME` named) is never taken in automatically. Only "Use this sign-in" on the Set up Codex page, or "Use this computer's Codex sign-in" in Settings, Accounts, adopts it. |
| Adding an account | Adding a Codex account counts as yes. It never adopts `~/.codex`. |
| Closing the app before answering | Showing the page records nothing, so the next start asks again. |
| With Claude Code off | No cannot be chosen: one provider always stays on. |

**Superseded in the design:** section 8.2 (upgrade adoption of the default
Codex home), and the acceptance items that described it:

- **WP1.5** ("Existing light-Codex upgrade preserves enablement and imports or
  reports default Codex state"): the upgrade no longer preserves the Codex
  on/off and no longer imports the default home. What it must now show: the
  earlier setting is ignored until answered, the answer is asked once, and
  nothing is adopted at start.
- **WP1.43** ("Current-Codex migration covers signed-in/signed-out default
  home, ambient key, durable/absent preference, interruption and rerun"): the
  one-time start-up migration is retired, with its IPC channel, service method
  and test. What it must now show: nothing adopts the home at start, and the
  explicit adoption (and its read-only check, U2) run only with Codex answered
  on, keep nothing when the home is signed out, and never read its files.

Replacement coverage (all automated, fake CLI or mocked IPC):
`tests/unit/main/codex-unanswered-service.test.ts`,
`tests/unit/main/provider-startup-no-adoption.test.ts`,
`tests/unit/renderer/codex-reconfirm-gate.test.ts`,
`tests/unit/renderer/codex-reconfirm-page.test.tsx`,
`tests/wp1/account-lifecycle.test.ts` (the external home and its check),
`tests/unit/renderer/onboarding-codex-setup.test.tsx` (the Set up Codex page's
check: asked only when answered on, and only "Use this sign-in" adopts). The
real-app upgrade walk is `tests/e2e/codex-reconfirm-upgrade.spec.ts`, which runs
on the test VM only.

## U2. The Set up Codex page checks this computer's sign-in, read-only

The approved setup mockup showed "Codex is already signed in on this computer
(~/.codex, <email>)". Resolved by parity (Claude's setup states only what it
has checked):

- The page asks Codex whether that sign-in is signed in (`codex login status`
  in that folder), **without taking it in**: the reservation the check runs
  under is always dropped, and no account, identity or marker is written.
- It says "already signed in" only when Codex says so, offers the sign-in for
  a new account when it is signed out, offers nothing when there is no Codex
  sign-in folder, and offers "Use this sign-in" without the claim when the
  check got no answer.
- The email is not shown. `codex login status` does not report one, and this
  app never reads Codex's sign-in files. A lead for later work, not built
  here: the Codex app-server documents `account/read` (email and plan) and
  `account/rateLimits/read`; they must be verified on the supported CLI
  versions before anything relies on them.
- **Note, 2026-09-26 (ADR-009 review; the decision is unchanged).** "Read-only"
  is about this app: the check writes nothing in that folder and keeps
  nothing in the app. The Codex CLI itself writes its own scratch files in
  that folder whenever it runs, `codex login status` included (0.153.4 writes
  under `tmp/arg0/`), exactly as it does when the user runs it.

## U3. Smaller rules that follow from U1

- **The last provider on.** A provider the user has not answered for launches
  nothing, so it never counts as the provider left on: Claude Code cannot be
  switched off while Codex is unanswered.
- **Every surface reads "not set up".** The Providers card, the review
  switches, the Conductor MCP review cards, onboarding's tools and recap
  pages, and the session strip never present an unanswered Codex as on.
- **Tokenomics** reads the history in `~/.codex` whatever the Codex answer,
  exactly as it reads `~/.claude/projects` whatever Claude Code's (D10, and
  the parity rule below). It reads history only, never a sign-in.
- **Device-code sign-in** stays off: it is experimental upstream, and WP1.41
  keeps experimental methods off unless the owner enables them. The app no
  longer advertises it in the changelog, the tour, the introduction or the
  guides.

## P1. The parity rule for 2.1.1

Owner, verbatim: "This is called feature parity - so whatever happens with
claude should happen with codex."

- 2.1.1 is the Codex feature-parity release. Its gate is zero unsupported
  shared Conductor features for Codex (design section 19).
- **SSH Codex sessions are the only agreed exclusion.**
- Each Codex gap defaults to doing what Claude does, the same way. A question
  goes to the owner only where Claude's behaviour cannot carry over (an
  upstream limit, with evidence), where there is no Claude behaviour to copy,
  or where carrying it over conflicts with an earlier explicit owner call.
- A PR being ready never means parity is complete. The release-wide list is
  `docs/wp2/parity-checklist.md`.
