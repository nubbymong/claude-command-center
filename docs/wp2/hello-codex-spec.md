# Hello Codex: the Codex introduction (WP2, commit 6 renderer)

Status: MOCKUP APPROVED by the owner on the Agent Canvas (v1, 2026-09-24),
as drawn: page 4 shows only the Claude-to-Codex review until claude_review
ships. Open questions 1 and 3 below were not on the mockup and stay open. Owner scope: plan.md "Scope
additions" (Hello Codex). The renderer slice builds nothing here until the
mockup has been reviewed on the Agent Canvas
(`.ccc-canvas/hello-codex.html`). Acceptance tests are pending cases in
`tests/unit/renderer/hello-codex.acceptance.test.ts`; commit 6 turns each one
into a real test.

## What it is

A short full-screen introduction, shown once, the first time Codex is both
turned on and set up. It explains:

- Codex accounts;
- launching and resuming Codex sessions;
- code review between the two providers;
- how working with Codex differs from Claude.

It is part of the full-screen post-install experience, not a modal and not a
Settings page.

## When it shows

"Set up" means all of these, read from the accounts snapshot
(`providerAccounts:snapshot`, pushed by `providerAccounts:changed`):

1. The Codex installation is enabled.
2. Its executable is discovered and its version is not refused.
3. At least one Codex account is active and last known to be signed in.

It shows in two places, with the same component:

- **Inside the onboarding run.** The harness gets a `helloCodex` page after
  `codexSignIn`. Its `when()` is the definition above. A user who turns Codex
  on and signs in during onboarding therefore meets it straight away.
- **Later, as a one-time takeover.** Codex can also be turned on and set up
  from Settings or Accounts. The first snapshot that meets the definition
  then shows the page as a full-screen takeover. It uses the pattern of
  `MultiSpawnStartupPage`: an opaque `DialogOverlay` over `--surface-base`
  (not `scrim()`), a real `<h1>`, and Skip / Continue. It waits for any open
  dialog and for the boot gates, so it never covers a running setup.

Seen state is one stamp in appMeta, `helloCodexSeenVersion`, written by
Done, Skip or Escape. Once written, neither place shows the page again.

It can be replayed from two places:

- Feature Guide, Integrations, Codex: "Show the Codex introduction".
- Settings, Codex: the same link.

A replay never changes the stamp.

It does not show:

- while Codex is off or undecided;
- when the only Codex sign-in is an adopted external home that is still
  unverified (setup is not complete; the Accounts page says what to do);
- to a user who has already seen it, after an upgrade.

## Pages

It uses the agreed showcase anatomy (What's New showcase, approved
2026-08-24):

- **Left column:** an eyebrow ("Codex - N of 5"), a big heading, a one-line
  tagline, then 3-4 one-line points. Each point has a peach dot and a bold
  lead-in. A muted "Where:" locator with a left rule closes the column.
- **Right column:** a drawn vignette in pure CSS and JSX: no screenshots, no
  emoji, no `\u{}` escapes.
- **Footer:** page dots with 24px hit targets (the active one is a pill), a
  "Skip" ghost button, and Next. The last page has "Start a Codex session"
  (primary) and "Done".

Copy is plain English with no em dashes, the same rule as app-knowledge.

**1. Hello, Codex**

- Tagline: "Codex now runs beside Claude, in the same window."
- Points:
  - **Your Codex account is ready.** It is signed in and it is yours. Codex
    keeps its sign-in in that account's own folder, and this app never
    reads it.
  - **Sessions side by side.** Codex sessions open as tabs next to Claude
    ones.
  - **On this computer.** In this release, Codex sessions and Codex reviews
    run on this computer only, not over SSH.
- Vignette: two session tabs, one Claude and one Codex, over a terminal.

**2. Accounts**

- Tagline: "Each Codex account keeps its own sign-in."
- Points:
  - **One folder per account.** Each account has its own sign-in folder,
    so sessions never mix identities.
  - **A default, and a reviewer default.** New sessions use the default
    account. Code reviews use the reviewer default, or the default if no
    reviewer default is set.
  - **An existing sign-in.** A sign-in this app did not create (for example
    `~/.codex`) must be confirmed at each launch, and cannot run reviews.
  - **Sign-in methods.** Sign in with ChatGPT, or with an API key. The key
    goes to Codex, and this app never stores it.
- Where: Accounts.
- Vignette: an account list showing two accounts, Default and Reviewer
  badges, and one "Confirm each launch" row.

**3. Launch and resume**

- Tagline: "Start Codex from the same New session dialog."
- Points:
  - **Pick Codex.** In New session, choose the Codex card and an account.
    The project folder is Codex's workspace.
  - **Resume where you left off.** A restarted Codex session offers its
    recent conversations in the terminal: arrows to pick one, N for a new
    one.
  - **Local only for now.** The SSH options are off for Codex, and the
    dialog says why.
- Where: New session.
- Vignette: the session dialog with the Codex card selected, then a small
  terminal list of three conversations.

**4. Code review**

- Tagline: "Ask the other provider for a second opinion."
- Points:
  - **From a Claude session.** Ask for a "Codex review". Codex reviews the
    change, or the files you name, on the reviewer account. It runs
    read-only and returns its findings with the tokens used.
  - **From a Codex session.** Ask for a "Claude review". This point ships
    only if `claude_review` (commit 5b) is in the release; otherwise the
    line is omitted.
  - **One at a time, never nested.** A session runs one review at a time,
    and a reviewer cannot ask for another review.
  - **You stay in control.** Code review can be turned off in Settings,
    Conductor tools.
- Where: any session; Settings, Conductor tools.
- Vignette: a Claude terminal with a review request, then a findings list
  and a "review 1" pill.

**5. How Codex differs from Claude**

- Tagline: "The same place to work, with a few differences."
- Points:
  - **Instructions.** Codex reads `AGENTS.md`; Claude reads `CLAUDE.md`.
  - **Permissions.** Codex has its own approval and sandbox modes. Choose a
    preset in the session dialog (Read-only, Standard, Auto or
    Unrestricted); Claude's permission settings do not apply to it.
  - **Conductor tools.** Codex sessions get the Conductor tools that suit
    them. Vision, the in-app browser and the Agent Canvas stay with Claude
    sessions for now.
  - **Usage.** Codex reports tokens per session and review. Claude's
    rate-limit figures do not apply to Codex.
- Where: Feature Guide, Codex.
- Vignette: a two-column comparison card.

The last page's "Start a Codex session" button opens New session with the
Codex card selected, and writes the stamp.

## Behaviour details

- **Keyboard.** Left and Right arrows move between pages. Enter activates
  the focused button. Escape is the same as Skip (the takeover uses
  `useDialogEscape`). On entry, focus goes to the primary button.
- **Reduced motion.** Page changes cut instead of slide when the system asks
  for reduced motion.
- **Theme.** Semantic tokens only: `--surface-base`, `--surface-raised`,
  `--text-primary`, `--text-muted`, `--brand`, and the onboarding azure
  family. No hard-coded colours. It works in both the dark and light themes.
- **Narrow windows.** Below 900px the vignette moves under the points, and
  the footer stays pinned to the bottom.
- **Truthfulness.** Every claim on the pages must hold in the build that
  ships it. The review page's Claude line, and any other point that depends
  on unfinished work, is data-driven and hidden until that work ships.

## Open decisions for the owner

1. **The later-enable path.** Should it be a one-time takeover (recommended,
   so the page is seen when it is relevant), or only a Feature Guide link
   and a tip?
2. **The review page before 5b ships.** Settled by the approved mockup:
   one direction only.
3. **Replay.** Is the Feature Guide plus Settings, Codex enough, or should
   the tour list it too?

## Acceptance criteria (tests/unit/renderer/hello-codex.acceptance.test.ts)

- AC1: With Codex enabled, discovered and compatible, and one active
  signed-in account, the gate is due; with any one of those missing, it is
  not due.
- AC2: An adopted external sign-in that is still unverified, as the only
  account, does not make the page due.
- AC3: Inside onboarding, the `helloCodex` page follows `codexSignIn` and is
  skipped when its `when()` is false.
- AC4: Outside onboarding, the first snapshot that makes the gate due shows
  the takeover once, after the boot gates and any open dialog.
- AC5: Done, Skip, Escape and "Start a Codex session" each write
  `helloCodexSeenVersion`, and the page is not shown again, including after
  an upgrade.
- AC6: A replay from the Feature Guide or Settings shows the page and leaves
  the stamp unchanged.
- AC7: The pages appear in the order Hello, Accounts, Launch and resume,
  Code review, Differences, with the counter "N of 5". Arrow keys and the
  dots move between pages.
- AC8: The first page and the launch page both say that Codex sessions and
  reviews run on this computer only in this release.
- AC9: The review page's Claude line is shown only when `claude_review`
  ships in the build.
- AC10: "Start a Codex session" opens New session with the Codex card
  selected.
- AC11: The page uses semantic tokens only (no hard-coded colours) and
  renders in the dark and light themes.
- AC12: The copy has no em dashes and no emoji. The JSX has no `\u{}`
  escapes.
- AC13: Focus lands on the primary button on entry. With reduced motion,
  pages cut instead of slide.
- AC14: The Feature Guide and app-knowledge entries (commit 7) say the same
  things as the pages: local only; the reviewer default; confirming an
  existing sign-in at each launch.
