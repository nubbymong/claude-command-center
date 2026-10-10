## 2026-10-10 -- Fixes from the owner's fresh-laptop run of the first-run build

The owner installed the first-run build (7ed87dad) on a fresh Windows laptop
(an LG gram) and went through setup: Claude Code and Codex installed from
setup, the new claude.exe added to PATH, then a chatgpt.com sign-in. That run
found the problems below, diagnosed from the app's log and the owner's
screenshots. It is the only real-machine run so far, and it came BEFORE these
fixes: they are checked by unit tests, typecheck and code review only, not on
a desktop and not with two accounts.

A chatgpt.com sign-in was lost when its window was closed right after signing
in (56087a05). The run ended on the close without reading the cookies again,
so a session that had landed since the last poll was never seen, and the run
then wiped the storage that held it. A diagnostic read awaited inside the poll
could hold the cookie reads for up to 10 s and widened that gap. Now the first
close request (never during quit) hides the window and the same checks run
again at once, for at most 12 s. A second close, a close during quit and a
close nobody asked for end the run at once, and Cancel, sign-out and archive
still win. The diagnostic read no longer holds the poll, and a run that does
not complete logs how it ended, with cookie names only, never a value.

Settings, Accounts rows (2ba6ee91, review fixes 587fa275). Every row kept an
empty Plan column, so a long name such as "This computer's Codex" was cut off
beside empty space, and each cell was centred on its own height, so a
one-line name sat below the badges beside it. Cells now line up on their
first line of text, a row with no plan gives its name the Plan track, and the
badge track keeps a 128px minimum, so "Confirm each launch" no longer runs
into the state column. After review, a long name wraps to at most two lines
and keeps its full text as its title, so it stays whole once a plan is
recorded, and a long email in the state cell breaks inside its own cell
instead of running under the "..." button. Still open: on cards narrower than
about 750px the badge floor takes width from the other text tracks (a few px
at the 728px card measured on the test laptop); below about 665px of card
width a blocked row's "This is still my account" button runs into the gap
beside it (10.8px into the 12px gap at 637px), and at 80% UI text about 11px
into the menu column.

Reviews wording (50b7c4ff). The Codex card said only "Reviews can't run on it
right now." when code reviews would use this computer's own Codex sign-in,
which is confirmed at each launch and so can never run a review. The card now
gives the reason and the next step with its own controls: Add Codex account,
then Make reviewer on that account, or Make reviewer on another account that
can review. One store helper (reviewerBlockKind) decides for the card and for
Code review tools, the Confirm each launch badge has a tooltip with the
reason, and the Feature Guide known issue names the Accounts card.

Window freezes on the first start of a new program (ADR-025; bfa3ab47, review
fixes 6aa9bada). Right after Add it to PATH for me the whole window froze for
about two seconds. On Windows the first start of a newly written program
holds the start call while the OS checks the file, and the app made that call
on the main thread. Before a main-thread start of a Claude Code or Codex .exe
that this run has not started yet, the caller now awaits a warm-up that
starts the same file once with --version in a worker thread. It is keyed by
file identity, bounded at 13 s, never a gate, never for an SSH session, and
ended at quit. The callers are discovery's --version run, the boot version
probe, the setup and /insights terminals, the local launches the accounts
service prepares and, after review, headless Claude Code runs, cloud agents
and the Accounts panel's claude auth status. Five synchronous main-thread
starts are now timed: the CLI runner's spawn, which starts discovery's
--version runs, both tools' reviews, and Codex's Insights runs and cloud
agents, among others; the boot version probe; the two setup terminal starts;
and the /insights terminal. Session starts, Claude Code's headless runs and
cloud agents, and the Accounts panel's claude auth status are not. A timed
start over 500 ms is logged by the program's base name only, and a [jank]
line names the timed start in flight or says that no tracked operation was.
The review fixes also stop a kill of the setup terminal from being lost when
it arrives while the terminal's start is being prepared (the terminal no
longer starts hidden afterwards).

The integration review then found a test that raced the warm-up, fixed in the
commit that adds this note (a test change, no app code). Since 6aa9bada a
Windows dispatch awaits the warm-up before its account refresh wait, but
cloud-agent-provider-off.test.ts checked, one timer tick after a dispatch
began, that it had reached that wait. The real warm-up's file check on the
thread pool made the check fail under load (4 of 10 runs of 6aa9bada in a
copy here), and CI runs vitest on Windows, so it would have flaked there. The
test now fakes the warm-up, so the real one, which starts programs through
its own child_process, never runs in it; the fake takes 20 ms, as a real one
takes time; and the test waits until the dispatch reaches the refresh wait.
Each half is held by a mutant: a single tick again fails 3 of 3 runs, and
removing the fake fails 3 of 3.

Not addressed: the other four stalls in the laptop log came during the
Microsoft sign-in inside the chatgpt.com window. Windows' own records of the
programs run on the laptop place the Windows Hello (passkey) step around the
first of them; for the other three they show nothing either way. They are not
app JavaScript work; their cause is unconfirmed, most likely native OS or
Chromium work, and they stay open. The new [jank] attribution should show
whether a tracked start was in flight the next time one happens.
