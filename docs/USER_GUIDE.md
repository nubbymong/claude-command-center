# AI Code Conductor — User Guide

A task-oriented manual: *how do I…* for everyday use. For the feature tour and
install instructions see [`README.md`](../README.md); for running a dev build
next to your install see [`dev-alongside-prod.md`](./dev-alongside-prod.md).

---

## Getting started

1. Install (see README → Getting started) and launch. On first run, CCC picks a data
   directory and checks that the `claude` CLI is on your PATH. If it is not
   there, install it and press Retry, or choose **Use Codex only** if you only
   use Codex.
2. A fresh install asks **Which assistants will you use?**: Claude Code, Codex,
   or both. Choosing Codex adds a **Set up Codex** page (see
   [Installing or updating Codex](#installing-or-updating-codex) and
   [Codex accounts](#codex-accounts)).
3. Create a **saved config** — a reusable launch template (working directory,
   account, model, provider, options). Configs live in the sidebar.
4. Click a config to start a **session**. Each session is a live terminal running
   Claude Code (or a plain shell / SSH / Codex, depending on the config).

**Mental model:** a *config* is a reusable template; a *session* is one running
instance of it. You can run many sessions from the same config.

## Working with sessions

- **Switch** sessions from the tab bar, the sidebar's Active Sessions list, or
  `Ctrl+Tab` / `Ctrl+1`–`Ctrl+9`.
- **Close** a session from its tab's ✕, the sidebar right-click menu, or
  `Ctrl+W`.
- **The header bar** (below the tabs) shows the active session's name, working
  directory, and — if the repo is wired to GitHub — the repo + connection state.

### Naming the work in each window (rename)

Give a session a **work name** so you can tell your windows apart at a glance —
e.g. `IM-8315 keychain fix`. The name:

- persists across app restarts, and comes back when a saved session reopens;
- is cleared when you **close** the session in CCC;
- is **independent of the config** — renaming a session never renames its saved
  config;
- shows up in the **logs/history** tab too, so past sessions stay identifiable.

**How to rename** (any of these):

- **`F2`** with the session active → edits it in the **Active Sessions** list.
- **Double-click** the tab, or **right-click** the tab → *Rename…*.
- Click the **name in the header bar**.

Clear the name (blank + Enter) to revert to the config's label.

## Multiple accounts

CCC isolates accounts per session so you can run different Claude logins side by
side. Switch a session's account from its sidebar right-click menu → *Switch
Account*, or from the account pill at the far left of its status line. A Codex
session moves between your Codex accounts the same way and keeps its
conversation (see [Codex accounts](#codex-accounts)). (On macOS only one Claude
account can be used, because Claude Code keeps its sign-in in the login
Keychain. Codex accounts are not limited this way.)

**What that isolation is, exactly.** It keeps the *logins* apart. Each account
has its own home folder, and a session launched as that account runs in it: its
own stored login, its own settings copy, its own Anthropic profile store. Three
things make sure that is the account the session actually signs in as:

- the settings copy CCC writes into each account leaves out anything that
  decides *which* account signs in — a key or token, a command that fetches
  one, a login pin, a provider switch, an endpoint that sends the credential
  somewhere else. Your own shared `settings.json` keeps all of it; only the
  per-account copy is trimmed;
- those same variables are dropped from the environment CCC starts the session
  with, so a stale `ANTHROPIC_API_KEY` in your shell does not win over the
  account's login. Your own shell is untouched;
- a project's own settings files (`.claude/settings.json` and
  `settings.local.json` in the folder the session starts in) are checked
  before the session starts, and **if they carry one of those settings the
  session is refused** — in the terminal, naming the file and the key (never a
  value). When a session resumes a conversation that ran in another folder,
  that folder is checked too, and so is every worktree the resume picker can
  offer; the refusal says which one. On Linux and
  macOS, Claude Code also reads `settings.local.json` from the root of the git
  checkout you are in (the main checkout, for a linked worktree), so that file
  is checked as well. CCC never edits a project's files, and it has no way to
  make a session safe to start under such a file, so it does not start one.
  Remove the key, or move it to your own shared settings, and start the session
  again. A session that is not tied to a managed account is not gated.

**What it does not cover**, so you are not relying on something it never
promised: settings edited after a session has started; settings your
organisation manages, which Claude Code fetches for a signed-in account; and a
program running as you on this machine, which can change what a session sees.
A project on a network path is not checked at all — reading it could freeze CCC
— so such a session starts with a warning instead of a check. Settings →
*Accounts* shows what was left out for each account, says when a session was
refused and why, and says when a session started with something unchecked,
rather than pretending otherwise.

**What it is not.** It is not a sandbox. Hooks, status line commands and
everything else in your settings still run, and a session can read and write
whatever you can. A hook you configure runs under whichever account the session
uses, so treat it as shared across accounts. Isolation also stops at this
machine: an SSH session uses the remote's own login. And CCC never holds or
refreshes a login token itself: Claude Code signs in from the account's own
stored login exactly as it does in a normal terminal.

## Choosing your assistants (Claude Code and Codex)

CCC can run two assistants, called *providers*: **Claude Code** and OpenAI's
**Codex** (Beta). **Settings → Accounts** starts with a **Providers** card, one
row per provider:

- a switch that turns the provider on or off;
- whether its CLI was found on this computer and which version, with **Check
  now** or **Check again** when it has not been looked for yet, was not found,
  or cannot be used as found;
- when Codex is missing or too old, the commands to install or update it (see
  [Installing or updating Codex](#installing-or-updating-codex));
- once you have said you use Codex (see below) and a Codex account you added
  in CCC is signed in, **Show the Codex
  introduction**, which replays the five-page Hello Codex introduction (also
  on the Codex card in the Feature Guide, under Integrations). The Codex
  sign-in already on this computer does not count: with only that one, Hello
  Codex and its replay stay hidden.

A fresh install asks **Which assistants will you use?** during setup. You can
change the answer at any time on the Providers card.

Coming from an earlier version? After updating, and after the release notes,
CCC asks you once **Do you use Codex?**: **Yes, set up Codex** or **No, I
don't use Codex**. Codex now has accounts of its own, so nothing carries over
from your earlier Codex setting: everyone who updates answers again, and until
you answer, Codex is *not set up* and nothing of it starts (the Providers card
says so, and a Codex config says *Codex is not set up yet*). **Yes** turns Codex
on and opens the **Set up Codex** page, where you add a Codex account, or choose
**Use this sign-in** for the Codex sign-in already on this computer; that
sign-in is used only after you choose it. **No** turns Codex off; you can set it
up later in Settings → Accounts. With Claude Code off, **No** cannot be chosen,
because one assistant always stays on. Your Claude Code setting is not
changed. The old Settings Codex tab is gone: its switch and install commands
are on this Providers card, your Codex accounts are in the Codex section below
it, and *Test connection* is now **Check sign-in** in each account's menu. The
ChatGPT plan label is no longer shown.

Codex runs on this computer only in this release: Codex sessions and Codex
reviews never run over SSH, and the session dialog turns its SSH options off
for Codex and says why.

### Turning a provider off

- At least one provider always stays on.
- A provider cannot be turned off while anything of it is running: its
  sessions, a code review, a sign-in in progress, a Sentinel check or
  analysis, and for Claude Code also cloud agents and Insights. The row says so (for example
  *"Codex is in use (2)."*); close those and switch it off again.
- Once a provider is off, nothing of it starts anywhere. Its saved configs say
  why instead of launching (*"Codex is off. Turn it on in Settings, Accounts to
  launch this config."*), and a tab that is restored or restarted for it shows
  *"Not started. Codex is off. Turn it on in Settings, Accounts, then Restart
  this tab."* The tab and its conversation are kept: turn the provider back
  on, then Restart the tab.
- With Claude Code off, Ask Conductor, Cloud Agents and Insights are
  unavailable and say so. **Terminal only** configs still run.

## Codex accounts

### Account and identity

- An **account** is one sign-in with one provider: one of your Claude
  accounts, or one Codex account.
- An **identity** is who that account belongs to, as CCC shows it: a name and a
  colour. When you add a Codex account you either give it **A new name** and a
  colour, or choose **The same person as an existing account**, so that, for
  example, your Work Claude account and your Work Codex account share one name
  and colour.
- The Codex sign-in already on this computer always keeps an identity of its
  own, because CCC cannot tell whose it is.
- To change an identity later, click the round chip at the left of any account
  row in Settings, Accounts, Claude or Codex. Its editor holds the **Name**,
  the **Colour** and the **Group**, and **Link another account** ties the
  account to your account of the other assistant (**Unlink** undoes it). The
  name, colour and group show on every linked account, and the colour on the
  account's chips everywhere. (This computer's own sign-in has no name field
  and cannot be linked.)
- A row with sessions running on it says how many (*2 running*). When an
  account cannot be made inactive, archived or removed because sessions use
  it, the row names each one with **Go to**.
- If an account's name or colour is changed both in CCC and in Claude's own
  account list, Settings → Accounts shows both and lets you pick one (**Keep
  this app's** or **Use Claude Code's**).

### Managed Codex accounts and this computer's own sign-in

**Managed accounts** are the ones you add with **Add Codex account** (in the
Codex section of Settings → Accounts, or on the Set up Codex page):

- CCC creates a sign-in folder for each one inside its resources folder
  (`codex-realms/`), and Codex signs in there, so sessions never mix
  identities. CCC never reads the sign-in Codex keeps in that folder: it asks
  Codex whether the account is signed in.
- Sign in with ChatGPT (opens your browser) or with an API key. The key goes
  to Codex, and CCC never stores it. Then name the account.
- The menu on each account row has **Make default** (new Codex sessions use it
  unless a config picks another account), **Make reviewer** (code reviews use
  it; with none set, reviews use the default), **Sign in again**, **Check
  sign-in**, **Sign out**, **Make inactive** or **Make active**, and
  **Archive**. Inactive and archived accounts are not offered at launch.
  Archived accounts are listed under **Archived**, each with **Restore**.
- A setup you started and did not finish is listed under *Unfinished setups*,
  with **Resume** and **Discard**.

**This computer's own sign-in** is the one the Codex CLI uses outside CCC:
`~/.codex`, or the folder `CODEX_HOME` pointed at when CCC started.

- CCC never takes this sign-in in on its own. The Set up Codex page asks Codex
  whether it is signed in, without taking it in, so the page says it is only
  when it is. CCC uses it only when you choose to: **Use this sign-in** on the
  Set up Codex page, or **Use this computer's Codex sign-in** in the Codex
  section of Settings → Accounts
  (offered once Codex is on; while you have not said whether you use Codex,
  that section shows **Yes, I use Codex**, which only records your answer).
  (It does read the conversation files Codex writes there for Tokenomics; see
  [PRIVACY.md](../PRIVACY.md).) Choosing it asks Codex whether that folder is
  signed in, and only if it is, lists it as *This computer's Codex*, with
  the folder it checked, such as *(~/.codex)*. If Codex could not answer, the button becomes **Check again**;
  if the folder is signed out, sign in there first (see below) and choose it
  again.
- Because CCC did not create it, the row reads **Confirm each launch** and
  **Cannot run reviews**. Every launch on it asks you to confirm, either with
  the tick in the session dialog or just before the session starts. A code
  review, which nobody is there to confirm, never runs on it.
- CCC never signs in to it on its own. If it is signed out, run `codex login`
  in a terminal, then **Check sign-in** on its row, or choose **Sign in again**
  in its menu: CCC warns first that this signs out every app that uses that
  sign-in, and that it stays signed out if the new sign-in does not finish.
- Signing out of it or archiving it asks first: signing out also signs Codex out
  for everything else on this computer that uses it, while archiving only
  forgets it in CCC.

To start a Codex session, open **New saved config** (the sidebar's + New, then
Config), choose the **Codex** card and an account. The default account is
listed first, an account you confirm at each launch says so, and an account
that needs attention cannot be picked.

- **Model and effort.** The model list is the one the supported Codex versions
  offer in their own picker; each model offers only the effort levels it runs,
  and a saved effort its model cannot run is dropped.
- **Permissions.** *Read-only*, *Standard*, *Plan mode*, *Auto* and
  *Unrestricted*. *Plan mode* starts the session read-only and turns on
  Codex's own Plan mode once Codex is ready; if it cannot, a note says so
  (type `/plan`, or `/permissions` to change what Codex may do). The
  permission pill reads *plan* only while Codex shows its Plan mode.
- **Restart.** A Codex session's header has a **Restart** menu: **Restart**
  carries on with the same conversation (a new one if the session had none
  yet), and **Restart and pick a conversation** lists its recent conversations
  in the terminal (type a number to pick one, or `n` for a new one). The list
  includes the project's other git worktrees, tagged with the worktree's name,
  and leads with a session's name where you gave it one. A Codex session that
  was open when CCC closed reopens in the same conversation, under the same
  account.
- **Compact and the model pill.** On a running Codex session, **Compact** on
  the status line types Codex's own `/compact`, and the model pill opens
  Codex's own model and effort picker. Each types only while Codex waits at an
  empty prompt, and says why when it cannot. On a session that is not
  running, the model pill is a list, applied when the session restarts.
- **Switch Account.** With two or more Codex accounts, the account pill at the
  far left of a Codex session's status line, or **Switch Account** in its
  right-click menu, moves the running session to another Codex account: it
  restarts there and carries on in the same conversation, which CCC copies
  into that account's folder. When the conversation cannot come along whole, a
  note above the terminal says why.
- **Status line.** A Codex session's status line shows its account, model and
  effort, tokens, lines changed (counted from Codex's edits), duration (the
  conversation's running time, carried on across restarts) and its 5-hour and
  weekly windows; the Status Line settings apply to it.
- **Multi Spawn and Quick Start** work for Codex configs as for Claude ones.

### Sign-in recovery

- **Check sign-in** asks Codex right now whether the account is signed in, and
  shows the answer on the row (for example *Checked just now: signed in.*).
- **Sign in again** asks you to tick *Sign in to the same account as before*,
  then signs in with the same kind of sign-in the account had before: ChatGPT
  again, or an API key again. Close the account's sessions first: an account
  in use cannot be signed in again.
  - A signed-out or expired account signs in again inside its own folder.
  - An account that is still signed in signs in again inside a new folder, and
    moves there only once the new sign-in is verified, with its earlier
    conversations carried over (*Carrying your earlier conversations over...*;
    with a long history this can take a few minutes). A sign-in that fails or
    is cancelled leaves the account with the sign-in it had. The row then reads
    *Needs attention: the old sign-in is kept*: the account works on its new
    sign-in, and the old one stays until CCC can remove it without signing out
    the new one; archiving the account removes it.
  - Earlier conversation files that are also linked from somewhere else on
    this computer are not carried over; the dialog says how many, and they
    stay in the account's old folder. An account with more earlier conversation
    files than CCC carries over is refused with nothing changed: to keep them,
    sign out first, then sign in again, which signs in within the account's own
    folder.
- **Needs attention: signed in a different way than before.** A check notices
  when an account is now signed in a different way than the one on record, for
  example with an API key where it had a ChatGPT sign-in. Nothing launches or
  reviews on the account until you press **This is still my account**, which
  checks it again and records the new sign-in; that is the only way to clear
  it.
- A signed-out *This computer's Codex*: run `codex login` in a terminal, then
  **Check sign-in**.

### Installing or updating Codex

CCC needs Codex 0.153.4 or newer. A version newer than CCC was tested with
(0.156.1) still runs, with a note saying so. When the Providers card finds
Codex missing or too old, its row shows the commands from OpenAI's own README,
to copy:

| | Install | Update |
|---|---|---|
| npm (every platform) | `npm install -g @openai/codex` | `npm install -g @openai/codex@latest` |
| Homebrew (macOS) | `brew install --cask codex` | `brew upgrade --cask codex` |

OpenAI's script installers (`curl -fsSL https://chatgpt.com/codex/install.sh | sh`
on macOS and Linux, and a PowerShell one on Windows) are shown for you to read
and run yourself; CCC never runs them. When CCC can tell how the Codex it found
(the one your sessions run) was installed, it shows the update for that way: an
npm install gets the npm update, a Homebrew cask the Homebrew upgrade, and one
that OpenAI's script installer put there gets that installer again. When it
cannot tell (another package manager, or a Homebrew formula rather than the
cask), it shows every update, each saying which install it updates. After installing or updating, press **Check again**.

During setup, the **Set up Codex** page can also run the npm or Homebrew
command for you: **Run in a terminal** asks *Run this command?* and then types
it into a visible terminal tab, one install at a time, in a tab that is never
saved or restored. On Windows it runs `npm.cmd`. A system-wide npm on macOS or
Linux may ask for administrator rights; CCC never elevates on its own.

## Code review between Claude and Codex

- From a Claude session, ask for a *Codex review*; from a Codex session, ask
  for a *Claude review*. Each session is offered only the other provider's
  reviewer, and only while a review could actually run.
- Each review is a separate, one-off reviewer: read-only, in the asking
  session's project, and nothing is saved as a conversation. It never uses one
  of your open sessions, and it cannot ask for another review.
- Reviews run on the reviewing provider's **reviewer** account, or on its
  **default** account when no reviewer is set. Set it with **Make reviewer**
  (in a Codex account's menu, or the button on a Claude account's row). A
  sign-in you confirm at each launch cannot review, so this computer's own
  Codex sign-in never does. On macOS, Claude reviews use your normal Claude
  sign-in.
- Each direction has its own switch in **Settings → General → Built-in Tools →
  Code review**: *Codex review* (Claude sessions can ask Codex) and *Claude
  review* (Codex sessions can ask Claude). Each row names the account reviews
  will use and, when a review cannot run, says why. Changes there or in
  Settings → Accounts apply to sessions started after them.
- Code review runs in local sessions only, and is skipped for a session whose
  working directory is missing or resolves to your home folder.

## Known issues with Codex

- **No Codex review while your only Codex sign-in is `~/.codex`.** That sign-in
  is confirmed at each launch, so it never reviews, and Claude sessions are not
  offered Codex review. Add a Codex account in Settings → Accounts, and choose
  **Make reviewer** on it if `~/.codex` is still your default; Claude sessions
  started after that are offered Codex review.
- **An `OPENAI_API_KEY` in your environment is not used by Codex sessions.**
  CCC leaves API keys in its environment out of every Codex session, so a
  session signs in only as the account you picked. Add a Codex account with
  **Use an API key** instead; the key goes to Codex, and CCC never stores it.
- **No Codex over SSH in this release.** Use a Claude Code config for a remote
  machine, or run Codex from a local config.
- **Codex asks once per account to review the app's hooks.** The first Codex
  session on an account opens on Codex's own *Hooks need review* screen;
  choose *Trust all and continue*. Without them the session works, but the
  attention dot does not light up for Codex's approvals or finished turns (see
  the Feature Guide's known issues for what the hooks send and how to trust
  them later).
- **One tab at a time per Codex conversation.** *Restart and pick a
  conversation* marks a conversation another tab has open (*open in another
  tab*). With Codex 0.155.1, picking it shows Codex's own lock screen, which
  stays: close that tab and carry on in the one that has the conversation, or
  close that one first and pick again. Codex 0.153.4 starts a new conversation
  instead and says why.
- **On Windows, Codex edits on its own only after its sandbox is set up.**
  When Codex asks, choose *1. Set up default sandbox* (Codex says it needs
  administrator permission). With *2. Use non-admin sandbox*, or none, Codex
  asks before every edit on *Standard* and fails on *Auto*. Do not run CCC as
  administrator.
- **On Windows, a Codex session's tab can stay open after Codex quits** while a
  command Codex started in the background still runs. Close the tab: that ends
  the command too.

## Logs & transcript viewer

Every local Claude and Codex session's conversation is indexed locally (never
leaves your machine); a Codex session's is read from its own Codex account's
folder. The **Logs** tab is a
chat-style transcript viewer with search and a timeline. Slots are labeled by
the session's work name (or config label), so a renamed session is easy to
find later.

**Index conversation logs** (Settings, General, or one saved config's own
setting) turns indexing off at once, for sessions already running too; turning
it on applies to sessions started after. What a session writes while indexing
is off is never indexed, and a conversation a session resumes carries on in
the index where it left off, for Claude and Codex alike.

On Windows, give a Claude config its working folder as Windows spells it
(choose it with the folder picker, or type it as File Explorer shows it, with
the drive letter in upper case). For a folder typed in another mix of upper
and lower case than it has on disk, with a lower-case drive letter, or by its
short 8.3 name, CCC can look for the session's conversation in another folder
than Claude Code writes it to, so a restored tab may not reopen its own
conversation, and with the app's hooks and status line off the Logs page may
not show it. The conversation itself stays in Claude Code's files.

### Codex usage

The **Usage page** (the person icon on the left rail, once you have two or
more accounts) has a Codex section beside the Claude Code one. Each Codex
account shows its 5-hour and weekly allowance and its plan:

- from an open session on the account, when there is one (**Updated**);
- otherwise, for an account signed in with ChatGPT, from a short check CCC
  asks Codex to run in that account's own folder when you open the page,
  press **Refresh** or use the card's **Retry** (about a second, one account
  at a time). It never runs for an API-key account, for *This computer's
  Codex*, or for an account a session or review is using;
- otherwise from the account's latest session, marked **As of** with its age.

An account with no session yet says its allowance shows after the first one;
an API-key account is billed per token, so it has no plan allowance. An
account on paid credits shows its credits under its bars, in Codex credits (a
count, not money): *N credits*, or *Unlimited*. The
usage strip at the foot of the window shows one pill per person, grouped by
provider. Token use and cost are in Tokenomics (below).

### Tokenomics by provider and account

Tokenomics shows Claude Code and Codex apart once both have usage:

- The **Provider** filter appears when both assistants have usage. The
  **Account** filter lists each account under its provider, with *This
  computer's sign-in* for `~/.codex` and *Not recorded* for usage with no
  account, and the sessions table has an Account column.
- The KPI row (Life-to-date, Last 7 days and Cache efficiency) splits each
  figure between the two when both have usage and no filter narrows the
  view. The cost chart draws a line for each when both have spend in the
  range.
- Codex usage belongs to the account whose folder it was written in, and
  Claude usage to the account profile a local session runs under, from this
  version on. Older usage, SSH sessions, sessions run outside the app and
  sessions with no account profile read *Not recorded*; usage cannot be
  assigned by hand.
- A model with no price yet reads **no price** instead of costing $0, and a
  notice names it and its tokens; its cost is not in the totals.
- The first start after updating sorts your earlier Codex history by account
  once. A notice shows its progress while it runs; the totals are complete
  throughout, and only the split by account fills in.

## Tokenomics, Memory, and the rest

The README covers these in depth: **Tokenomics** (cost/usage analytics),
**Memory** dashboard, **Sentinel**, **Conductor MCP** (incl. vision capture),
**Cloud Agents**, **Codex** provider, **GitHub** PR context, **Combined Mode /
Draw**, **Snap / Vision**, and **Dynamic workflows**. See the README, in
particular *And the rest of the surface*; Codex accounts and code review are
covered above.

## Best practices

- **Name every long-lived session** (`F2`). It pays off in the tab strip, the
  window picker, and the logs tab weeks later.
- **One config per project/role**, then spin up sessions as needed — don't create
  a new config for every run.
- **Keep configs as stable templates.** Rename the *session* for per-window work;
  rename the *config* only when the template itself changes.
- **Use per-session accounts** rather than switching your global login, so
  parallel work doesn't contend on one token.
- **Mind the context meter** in the sidebar row; start a fresh session when a
  conversation gets long rather than fighting a bloated context.
- **Testing changes to CCC itself?** Run the dev build with `ccc` so it can't
  touch your real config/sessions — see the dev-alongside-prod guide.

## Keyboard shortcuts (defaults, rebindable in Settings)

| Action | Shortcut |
|---|---|
| New config | `Ctrl+T` |
| Close session | `Ctrl+W` |
| Next / previous session | `Ctrl+Tab` / `Ctrl+Shift+Tab` |
| Jump to session 1–9 | `Ctrl+1`…`Ctrl+9` |
| Rename active session | `F2` |
| Toggle sidebar | `Ctrl+B` |
| Paste clipboard image | `Alt+V` |

## Troubleshooting

- **CLI not found:** ensure `claude` is on your PATH (Onboarding → *Find Claude*),
  or choose **Use Codex only** if you do not use Claude Code. For Codex, see
  [Installing or updating Codex](#installing-or-updating-codex).
- **A tab reads "Not started" and names a provider:** that provider is off. Turn
  it on in Settings → Accounts, then Restart the tab.
- **No terminal cursor:** the caret is a thin bar; it shows a hollow outline when
  the terminal isn't focused. (Claude/TUI sessions deliberately hide it — they
  draw their own.)
- **Slow first paint in dev:** use a current build — the boot-time backfill and
  dev source-watcher now run deferred/async.
- **Where's my data?** Prod uses the data dir chosen at setup. A **new** install
  defaults to `%LOCALAPPDATA%\AI Code Conductor`; an install **upgraded** from a
  release before the rename keeps whatever it already had (usually
  `%LOCALAPPDATA%\Claude Command Center`) — the installer reads the existing
  path from the registry and never moves your data. A dev build uses a `dev`
  sub-folder under whichever data root applies.
