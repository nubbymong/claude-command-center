# Hello Codex: the Codex introduction (WP2, commit 6 renderer)

Status: BUILT in WP2 commit 6f, with the review round 1 fixes. The owner
approved the mockup on the Agent Canvas (`.ccc-canvas/hello-codex.html`, v1,
2026-09-24) as drawn, then approved two changes on the commit 6 canvas
(`.ccc-canvas/commit6-surfaces.html`), which win over v1 where they differ:
page 4 is v2, both review directions (canvas F3), and page 3 describes the
Codex restart menu (canvas F7). Open questions 1 and 3 were settled on that
canvas (R1); see "Decisions". Where the approved copy was not true of this
build, the fewest words were changed; each change is listed under "Copy
changed for truth", and the strings added for a Codex-only install under
"New strings for the owner". Owner scope: plan.md "Scope additions" (Hello
Codex). Acceptance tests: `tests/unit/renderer/hello-codex.acceptance.test.ts`
(AC1-AC13 real; AC14 is commit 7's and stays pending).

Code: `src/renderer/onboarding/hello-codex.ts` (the gate, the seen stamp, the
open state, the copy as data) and `src/renderer/onboarding/HelloCodex.tsx`
(the component, the onboarding page, the takeover and its host, and the held
"Start a Codex session"); the boot-chain decision is `bootChain` in
`src/renderer/utils/bootGates.ts`.

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

1. The Codex installation is enabled, and the user has said yes to it (its
   preference is on: not off, not undecided).
2. Its executable is discovered and its version is not refused (refused:
   too old, or a version this app does not support; a newer one still runs).
3. At least one Codex account is active, last known to be signed in, not
   blocked, vouched for (not unverified), and not an external sign-in.
   External sign-ins (this computer's own `~/.codex`) are excluded outright.

It shows in two places, with the same component:

- **Inside the onboarding run.** The harness has a `helloCodex` page straight
  after `codexSetup`, wherever that page is shown: a fresh install that chose
  Codex, and the upgrader handed the Codex setup page by this run's "Use Codex
  only" (commit 6e), alone or inside a release-notes run. Its `when()` is "the
  Codex setup page is shown here" and the definition above, read when the
  user leaves Codex setup, so signing in on that page makes it the next page.
  Back on its page 1 returns to Codex setup without writing the stamp. In the
  registry (`steps.ts`) it is `freshInstallOnly` and `requiresSetup: false`,
  so it never re-runs onboarding for an upgrader and never reaches them
  through `stepsNewSince`.
- **Later, as a one-time takeover.** Everyone else (an upgrader, or Codex
  turned on and set up later from Settings, Accounts) meets it here. The first
  snapshot that meets the definition opens it once every boot gate has had its
  turn (`bootChain` asks whether the takeover would be next: it is the last
  gate, after the `*Due` waits) and no dialog or other window-level overlay is
  open (`paneOcclusionStore`). It then holds its own turn in the boot chain
  (`helloCodex`) until it is left. It uses the pattern and layering of
  `MultiSpawnStartupPage`: an opaque `DialogOverlay` over `--surface-base`
  (not `scrim()`) at the shared z-50, rendered before the close dialogs so
  they paint above it, with the onboarding frame and a real `<h1>`.

Seen state is one stamp in appMeta, `helloCodexSeenVersion`, written by Done,
Skip, Escape and "Start a Codex session", in both places. Once written,
neither place shows the page again, including after an upgrade (presence is
what counts).

It can be replayed from two places, each offered only once Codex is set up
(page 1 says the account is ready):

- Feature Guide, Integrations, the Codex Provider card: "Show the Codex
  introduction".
- Settings, Accounts, the Codex row of the Providers card: the same link.
  (Not the Settings Codex tab, which the next slice removes.)

A replay of an introduction already seen never changes the stamp. A replay
opened while the page is still due and unseen counts as the takeover: leaving
it writes the stamp, so the takeover does not show all five pages again right
after.

It does not show:

- while Codex is off or undecided;
- when the only Codex sign-in is an external one (setup is not complete; the
  Accounts page says what to do);
- to a user who has already seen it, after an upgrade.

## Pages

It uses the agreed showcase anatomy (What's New showcase, approved
2026-08-24):

- **Left column:** an eyebrow ("Codex - N of 5"), a big heading, a one-line
  tagline, then 2-4 one-line points. Each point has a peach dot and a bold
  lead-in. A muted "Where:" locator with a left rule closes the column.
- **Right column:** a drawn vignette in pure CSS and JSX: no screenshots, no
  emoji, no `\u{}` escapes. Provider marks are the app's own (`ProviderMark`).
- **Footer:** page dots with 24px hit targets (the active one is a pill), a
  "Skip" ghost button, Back, and Next. The last page has "Start a Codex
  session" (primary) and "Done".

Copy is plain English with no em dashes, the same rule as app-knowledge. Two
inputs decide some lines, both as data: whether `claude_review` ships
(`CLAUDE_REVIEW_SHIPS`, read from the build's own list of built-in tools; the
Claude review switch shipped with the tool in 5b) and whether Claude Code is
on (`claudeCodeOn`: the saved setting, and main's switch). With Claude Code
off (a Codex-only install) there are no Claude sessions and main offers no
Claude review, so the pages say nothing that needs Claude.

**1. Hello, Codex**

- Tagline: "Codex now runs beside Claude, in the same window." With Claude
  Code off: "Codex now runs in this window."
- Points:
  - **Your Codex account is ready.** It is signed in and it is yours. Codex
    keeps its sign-in in that account's own folder, and this app never
    reads it.
  - **Sessions side by side.** Codex sessions open as tabs next to Claude
    ones. With Claude Code off: **Sessions as tabs.** Codex sessions open as
    tabs, like any other session.
  - **On this computer.** In this release, Codex sessions and Codex reviews
    run on this computer only, not over SSH.
- Chip: "Local sessions only in this release".
- Vignette: session tabs over a terminal: two Claude and one Codex; with
  Claude Code off, two Codex tabs.

**2. Accounts**

- Tagline: "Each Codex account keeps its own sign-in."
- Points:
  - **One folder per account.** Each account has its own sign-in folder,
    so sessions never mix identities.
  - **A default, and a reviewer default.** New sessions use the default
    account. Code reviews use the reviewer default, or the default if none
    is set.
  - **An existing sign-in.** A sign-in this app did not create (for example
    `~/.codex`) must be confirmed at each launch, and cannot run reviews.
  - **Sign-in methods.** Sign in with ChatGPT, or with an API key. The key
    goes to Codex, and this app never stores it.
- Where: Settings, Accounts.
- Vignette: an account list showing a Default account, a Reviewer account,
  and this computer's `~/.codex` with "Confirm each launch".

**3. Launch and resume**

- Tagline: "Start Codex from the same New saved config dialog."
- Points:
  - **Pick Codex.** In New saved config, choose the Codex card and an
    account. The project folder is Codex's workspace.
  - **Resume where you left off.** In a Codex session's Restart menu,
    "Restart and pick a conversation" offers its recent conversations in the
    terminal: type a number to pick one, n for a new one.
  - **Local only for now.** The SSH options are off for Codex, and the
    dialog says why.
- Where: the sidebar's + New, Config.
- Vignette: the New saved config dialog with the Codex card selected and the
  SSH field "Not available for Codex in this release", then the resume picker
  as it really is: a numbered list of three conversations and "n New
  conversation".

**4. Code review** (canvas F3, v2)

- Tagline: "Ask the other provider for a second opinion."
- Points (Claude Code on):
  - **From a Claude session.** Ask for a "Codex review". Codex reviews the
    change, or the files you name, on your Codex reviewer account.
  - **From a Codex session.** Ask for a "Claude review". Claude does the same
    on your Claude reviewer account.
  - **A separate reviewer, not another session.** Each review starts its own
    one-off reviewer: read-only, in this project, and nothing is saved as a
    conversation. It never uses one of your open sessions, and it cannot ask
    for a review of its own.
  - **You stay in control.** Each direction has its own switch in Settings,
    General, Built-in tools, and the reviewer accounts are set in Settings,
    Accounts.
- Where: any session; Settings, General, Built-in tools; Settings, Accounts.
- Points (Claude Code off):
  - **It needs Claude Code too.** Code review asks the other provider for a
    second opinion, so it needs Claude Code on as well. Turn it on in
    Settings, Accounts.
  - **A separate reviewer, not another session.** (as above)
- Where (Claude Code off): Settings, Accounts.
- Vignette: two flows, one per direction: a session asks, a separate
  read-only reviewer runs, findings come back. It is an illustration of the
  feature as the build ships it, so it stays with Claude Code off.

The "From a Codex session" point needs BOTH `CLAUDE_REVIEW_SHIPS` and Claude
Code on. With `claude_review` not shipped (and Claude Code on), the page
drops that point and the Codex flow, and the control point reads "Codex
review has its own switch in Settings, General, Built-in tools, and the Codex
reviewer account is set in Settings, Accounts."

**5. How Codex differs**

- Tagline: "The same place to work, with a few differences."
- Points:
  - **Instructions.** Codex reads `AGENTS.md`; Claude reads `CLAUDE.md`.
  - **Permissions.** Codex has its own approval and sandbox modes. Choose a
    preset in the session dialog; Claude's permission settings do not apply
    to it.
  - **Conductor tools.** Codex sessions get the Conductor tools that suit
    them. Vision, the in-app browser and the Agent Canvas stay with Claude
    sessions for now.
  - **Usage.** Codex reports tokens per session and review. Claude's
    rate-limit figures do not apply to Codex.
- Where: Feature Guide, Integrations.
- Vignette: a comparison table (Claude, Codex): instructions file;
  permissions (Claude permission settings; Read-only, Standard, Auto,
  Unrestricted); runs over SSH (Yes; Not in this release); vision, browser,
  canvas (Yes; Not yet); code review (Asks Codex; Asks Claude, or "Not yet"
  without `claude_review`, or "Needs Claude Code on" with Claude Code off);
  usage shown (Rate limits; Tokens, and its limits when it sends them).

The last page's "Start a Codex session" button opens New saved config with
the Codex card selected (SessionDialog's `initialProvider`), and writes the
stamp. Inside onboarding the request is held until the run ends (the harness
covers the window until then) and handed to App with `onComplete`; after a
chosen tour, the dialog follows the tour. In every place it is also held
while the resume prompt waits for an answer (`useHeldCodexSessionStart`): the
dialog outranks that prompt in the boot chain, and a launch would autosave
over the restore set the user has not answered.

## Behaviour details

- **Keyboard.** Left and Right arrows move between pages. Enter activates
  the focused button. Escape is the same as Skip (`useDialogEscape`, with a
  guard). On entry, focus goes to the primary button, which stays the same
  element on every page. Auto-repeated keys are ignored. The takeover
  ignores every key for 500 ms after it opens (`HELLO_CODEX_ARM_MS`): it can
  open late, while the user is typing elsewhere. While another dialog is open
  above it (a close dialog), it acts on no key and leaves them to that
  dialog. While the takeover or a replay is open, the global shortcuts are
  suppressed, as they are while onboarding is due.
- **Focus trap.** Not used: the shared Dialog primitives offer none, and the
  separate `useFocusTrap` hook focuses the first control on entry, which
  would take focus off the primary button.
- **Reduced motion.** Page changes cut instead of slide when the system asks
  for reduced motion.
- **Theme.** Semantic tokens only: `--surface-*`, `--text-*`, `--border-*`,
  `--brand`, `--accent`, `--scrim` (the vignette shadows), the status tokens,
  and the onboarding azure family. No hard-coded colours. Every token used is
  defined for both the dark and the light theme.
- **Narrow windows.** Below 900px the vignette moves under the points, and
  the footer stays pinned to the bottom.
- **Truthfulness.** Every claim on the pages must hold in the build that
  ships it and in the setup that reads it. The review page's Claude line, and
  any other point that depends on unfinished work or on Claude Code being on,
  is data-driven.

## Decisions

1. **The later-enable path.** Settled (owner, canvas R1): a one-time
   takeover, so the page is seen when it is relevant.
2. **The review page before 5b ships.** Settled by the approved mockup, and
   superseded by 5b shipping: both directions, data-driven.
3. **Replay.** Settled (owner, canvas R1): the Feature Guide (Integrations,
   Codex) and Settings, Accounts. The tour does not list it.

## Copy changed for truth

Each is the fewest words that make the approved copy true of this build.

Page text:

- Page 2, Where: "Accounts" -> "Settings, Accounts" (Accounts is a Settings
  tab, not a page of its own).
- Page 3, tagline and "Pick Codex": "New session" -> "New saved config" (the
  dialog's title; there is no surface called New session).
- Page 3, "Resume where you left off": the resume picker is a numbered list,
  not an arrow-key list, and a Codex restart opens it only from "Restart and
  pick a conversation" (commit 6c): "A restarted Codex session offers its
  recent conversations in the terminal: arrows to pick one, N for a new one."
  -> "In a Codex session's Restart menu, "Restart and pick a conversation"
  offers its recent conversations in the terminal: type a number to pick
  one, n for a new one."
- Page 3, Where: "New session" -> "the sidebar's + New, Config".
- Page 4 (canvas F3), the switches: "Settings, Built-in tools" -> "Settings,
  General, Built-in tools", and "set in Accounts" -> "set in Settings,
  Accounts"; the Where line likewise.
- Page 5, Where: "Feature Guide, Codex" -> "Feature Guide, Integrations" (the
  Codex card sits in the Integrations section).
- Page 5, table, Codex usage: "Tokens" -> "Tokens, and its limits when it
  sends them" (a Codex session's strip shows Codex's own rate limits, when
  Codex reports them).
- Page 5, table, Codex code review: "Not yet" -> "Asks Claude" (5b shipped;
  data-driven, see above).

Vignettes (pictures, changed to match the app as built):

- All pages: the coloured squares in the session tabs and the table header
  are the app's own provider marks (`ProviderMark`); page 2's list header
  and page 3's provider cards carry them too.
- Page 1: the prompt glyph is ">" (plain ASCII) instead of a right angle
  quote; with Claude Code off the tabs are two Codex tabs ("api-server
  (Codex)", "docs (Codex)").
- Page 2: the external row is named as the Accounts page names it, "This
  computer's Codex (~/.codex)", instead of "~/.codex".
- Page 3: the dialog header "New session" -> "New saved config"; the Claude
  card "Claude" -> "Claude Code" (the dialog's card label). The resume list
  is the real picker: title "Resume Codex Conversation" (was "Resume a Codex
  conversation"); rows "1 retry for the upload client 2h ago", "2 pagination
  bug in /orders Yesterday", "3 update the README examples 3d ago" (was a
  pointer row "retry for the upload client 2 h ago" and a row "pagination
  bug in /orders yesterday"); "n New conversation" (was "N start a new
  conversation"); and a prompt line "> 1". The SSH field keeps the approved
  "Not available for Codex in this release".
- Page 4 (canvas F3): the prompt glyph is ">" as drawn; the Codex flow's
  findings box reads "2 findings" (canvas: "Findings").

## New strings for the owner (Claude Code off)

- Page 1 tagline: "Codex now runs in this window."
- Page 1 point: **Sessions as tabs.** Codex sessions open as tabs, like any
  other session.
- Page 4 point: **It needs Claude Code too.** Code review asks the other
  provider for a second opinion, so it needs Claude Code on as well. Turn it
  on in Settings, Accounts.
- Page 4 Where: "Settings, Accounts".
- Page 5 table, Codex code review: "Needs Claude Code on".
- Page 1 vignette tab: "docs (Codex)".

## Notes (recorded, not fixed)

- Surfaces that do not register as open dialogs (for example
  `ExcalidrawModal`) can be covered by the takeover, and a boot gate that
  arrives late can push the takeover aside; it then restarts at page 1.
- Inside onboarding, "Start a Codex session" opens the dialog only after the
  remaining setup pages (owner to glance at).

## Acceptance criteria (tests/unit/renderer/hello-codex.acceptance.test.ts)

- AC1: With Codex enabled, discovered and compatible, and one active
  signed-in account, the gate is due; with any one of those missing, it is
  not due.
- AC2: An adopted external sign-in that is still unverified, as the only
  account, does not make the page due.
- AC3: Inside onboarding, the `helloCodex` page follows `codexSetup` and is
  skipped when its `when()` is false.
- AC4: Outside onboarding, the first snapshot that makes the gate due shows
  the takeover once, after the boot gates and any open dialog.
- AC5: Done, Skip, Escape and "Start a Codex session" each write
  `helloCodexSeenVersion`, and the page is not shown again, including after
  an upgrade.
- AC6: A replay from the Feature Guide or Settings shows the page and leaves
  the stamp unchanged (a replay while still due and unseen counts as the
  showing and writes it; see "When it shows").
- AC7: The pages appear in the order Hello, Accounts, Launch and resume,
  Code review, Differences, with the counter "N of 5". Arrow keys and the
  dots move between pages.
- AC8 (amended in 6f, for the owner): The first page says that Codex
  sessions and reviews run on this computer only in this release; the launch
  page says the SSH options are off for Codex and the dialog says why. (The
  approved launch page does not mention reviews; the criterion now says what
  the approved pages say.)
- AC9: The review page's Claude line is shown only when `claude_review`
  ships in the build (and Claude Code is on).
- AC10: "Start a Codex session" opens New saved config with the Codex card
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
