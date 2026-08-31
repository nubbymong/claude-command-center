# Changelog

All notable changes to AI Code Conductor (formerly Claude Command Center) are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **Generated file — do not edit by hand.** The source of truth is
> `src/renderer/changelog.ts`. After editing that file, run `npm run changelog`
> (CI enforces that this file is in sync via `npm run changelog:check`).

## [2.1.0-rc.12] - 2026-08-31

> A remote session stops being a second-class one. Local and remote sessions now report their status the same way, over the same channel, so an SSH session shows its account and its full usage — including the per-model bars — exactly like a session on your own machine. That also fixes the one host the status line never worked on: a Windows remote. The config dialog answers "where does this run?" properly for the first time: Connection is a choice of three (Local, SSH, SSH Persistent), and a new Runtime section runs the session inside a Docker or Podman container without you maintaining a shell one-liner. And a plan on the canvas is reviewed as a plan: Approve or Submit Revisions, with approval held back while a question is still open.

### Added
- A remote session shows its account and its usage, like a local one. An SSH session now reports over its own connection back to the app rather than by painting escape codes through the terminal, and it gathers the same figures a local session does: the signed-in account on the remote, the 5-hour and weekly limits, and the per-model bars (Fable included). So the account line on the session card, the account pill in the session header and the multi-account strip along the bottom all fill in for remote sessions. The strip no longer has to borrow a local session's numbers, and signing in with /login on the remote moves the session to the right account on the next tick. Nothing to install or re-run: it applies to sessions you launch from now on.
- Connection is three plain choices: Local, SSH, or SSH Persistent. Persistence used to be a "Detachable" checkbox tucked below the SSH fields, which read like an option rather than what it is — a different kind of connection, one that keeps running when the link drops. It is now the third card beside Local and SSH, described where you choose it. Your saved configs are untouched and need no editing: one that had Detachable set simply opens as SSH Persistent.
- Run the session inside a container, without writing the command yourself. A new Runtime section on an SSH config asks where the session lands once it has connected: on the host, or in a Docker container. Pick the engine (docker or podman), name the container, choose whether to step into a running one or start a stopped one, optionally give a directory inside it, and say if the engine needs sudo — the app composes and runs the command. Claude runs inside the container with the full status line, account and usage, the same as anywhere else. If you already do this with a hand-written "after connecting" line, the dialog spots it and offers a one-click Convert; it never rewrites your command behind your back, and arbitrary prep still has its home under Advanced.

### Changed
- The remote host is named once instead of three times. The floating host pill docked at the bottom-left of the terminal is gone, and so is the small "remote" tag on the command-bar clusters — both added last release, and both saying again what the header's "SSH: user@host" line already says. The "this PC" mark stays on the partner shell, where it is genuinely surprising that the pane runs somewhere else.
- A container session says so. A small teal container mark sits on the session card and in the session header, with the container name on hover. It reads alongside the SSH marks rather than replacing them, so a persistent remote session in a container wears all three.
- A plan on the canvas is reviewed as a plan. The two buttons are Approve and Submit Revisions — there is no Reject on a plan, because a plan is meant to go round again. Approve is held back while the plan still has an open question, or while you have a note you have not sent, and the panel says which: "Approve is unavailable: 2 open questions — answer them in a note and submit revisions". So an approval never arrives carrying work the agent has not seen. History reads REVISIONS rather than REJECTED for a round you sent back.
- Less apparatus around a review. A plan drops the X-Ray switch, Region and Sketch entirely — it is reviewed by reading it and pointing at a step, and a padlocked control whose whole content was an apology for being disabled is worse than no control. The hover readout beside the page is one quiet row instead of a three-line box, and on a plan it is headed "Pointing at" rather than "X-Ray".

### Fixed
- The status line works on a Windows remote host. Connecting to a Windows machine over SSH used to show no status line at all, and the last release reported that as an upstream limitation to wait out. It was ours. A Windows remote stacks up to three terminal layers between Claude and your pane, and at least one of them rewrites or swallows the codes the status line was travelling in — bytes that never arrive cannot be read. The status now travels as data over the session's own connection instead, which no terminal layer touches, so Windows, Linux and macOS remotes all behave identically. It needs the built-in tools switched on (they are, by default); without them a remote session falls back to the old path.
- Ending a container session ends the right Claude. The end that runs when you close a remote session now reaches inside the container and stops that session's Claude, matched on the session's own marker — so a second session sharing the same container carries on untouched, and a container no longer accumulates abandoned processes.

## [2.1.0-rc.11] - 2026-08-30

> A UX sweep from living on rc.10: the command bar stops hoarding space and the SSH host reads as a quiet pill above the status line instead of a floating IP overhanging the buttons. Two real bugs die with it: End remote now genuinely ends password-auth remote sessions (orphaned Claudes no longer pile up on the host), and approving a canvas round with final notes no longer loses those notes to the agent. The blank browser page gets its brand masthead.

### Changed
- Command-bar buttons stop reserving space for their widest label. The Canvas button held permanent dead space sized for the word "Terminal"; toggle buttons now animate to the width of the label they actually show, and their neighbours slide over smoothly — including when the canvas review dot arrives beside the label.
- The blank browser page wears the brand. The near-invisible "Browser" title is replaced with the http:// artwork beside a gradient wordmark, baseline-aligned with the art.

### Fixed
- End remote works on password hosts. The quiet kill that runs when you end an SSH session could only authenticate with a key, so on a saved-password host every End silently left Claude and tmux running on the remote — each one holding a few hundred MB until the host ran dry. The kill now signs in the same way the session did: it answers exactly one password prompt, over its own hidden connection, and the password never appears in a command line or a log. Verified live against a real password host.
- The SSH host badge no longer overhangs the command bar. A remote session used to print its raw IP as a tiny floating pill across whatever buttons sat nearby. The cluster marks now just say which side each pane runs on — THIS PC / REMOTE — and the host itself shows as a quiet rounded pill docked bottom-left of the terminal, riding just above the status line. SSH sessions only, terminal view only, and it never intercepts a click.
- SSH sessions show up in the account strip. A remote session knows which account it is signed in as, but the multi-account strip ignored it — the session appeared under no account at all. It now joins its account’s row (a local session’s identity still wins when both exist), sharing the row’s usage buckets fed by local sessions.
- Approving a canvas round with final notes no longer strands those notes. An approval with nothing else owed signs the canvas off and returns the pane to its front page — correct — but it also cut the agent off from reading the very notes sent with that approval. The agent can now still fetch a review from a signed-off canvas (read-only; nothing else about completion changes).

## [2.1.0-rc.10] - 2026-08-29

> The Agent Canvas is rebuilt around one idea: a review is a decision, and a decision settles. Approving a version owes the agent nothing — notes you send with an approval are kept as observations, not work — and an approved artefact signs itself off. A new Testing mode lets you click through the build your agent is serving and save evidence notes that lock the screen, the page state and how you got there together, into a pass-or-fail test pack. Unfinished canvas work now outlives the session that made it: any session on the project can pick it up. And a new Canvas Explained page draws the whole model.

### Added
- A canvas review is one decision, and it settles. You approve or reject the version in front of you, and the panel says exactly what Submit will do — "Submit — Approve v3, 2 notes". Approving owes the agent nothing further: notes you send with it are recorded as observations rather than work, and when nothing else on the canvas is open the artefact signs itself off and returns you to the front page. Only one round is ever live at a time, and a settled round stays settled — nothing the agent does can re-open it. Reopening a note, or a whole round, is yours alone.
- Mark complete is never a dead button. It is hidden only while the version on screen is still yours to decide (there the decision IS the gesture, and an approval completes it anyway); otherwise it is live, and when something is still outstanding it says exactly what it will close — "deletes 2 unsent notes; closes 1 note still with the agent, as not done" — before you confirm. A completed canvas keeps a Reopen.
- Testing mode: review a running build by using it. The agent serves the app itself and you click through it live. The moment you start writing a note the screen pauses and locks the evidence together — a screenshot with your drawings over it, the page state (the route, an open dialog, which fields are filled, changed or invalid, and where the focus is, never a character of what you typed), and a timed trail of what you actually did to get there. Notes collect into a test pack you can name or leave to name itself, and one build takes one pass-or-fail verdict.
- A finished test pack is a record you can look back through. Once the verdict is in, the pane stops serving the live site and shows the saved evidence instead: each note with the screen exactly as it was, the time it was taken, and its state and trail beside it. Your agent reads the same pack structure first and asks for the pictures only when it needs to see pixels, so a long run does not cost a wall of screenshots.
- Unfinished canvas work is no longer lost with its session. While a session is live, the canvas it is working on is private to it. When that session goes away the work does not: any session on the same project can Resume it from the canvas front page, taking it over with its versions and notes — the first to press it wins, and anyone who was a moment late is told so rather than left guessing. Dismiss discards it, saying how many notes and how much evidence go with it. Work that was signed off stays visible to every session as read-only project history.
- A new canvas front page. It opens with the artwork and the Agent Canvas wordmark, then an "In flight work" band — what is waiting on you, a jump to an approved plan, and any canvases that can be resumed — then "Recent in this project" in three columns: Mockups, Plans and Test packs, each row carrying its verdict and how long ago it was.
- The canvas Library is a real library. Search across titles and notes, filter by kind (Mockups, Plans, Test packs) and by state (Needs you, Open, Signed off, Archived), and read a plain audit line on every row: what it is, which version, which config and account, which session, and when it last moved. A test pack expands in place to page through its saved evidence, and a bulk bar archives or deletes several at once. Another session’s signed-off work is listed and viewable; nothing else is.
- Canvas Explained: one page that draws how the whole thing works — what an artefact and its versions are, what a note stores, and the three shapes the loop takes for a mockup, a plan and a test run. Open it from the card on the canvas front page, or read it inside the Feature Guide.

### Changed
- The review panel is easier to read. History is folded away at the top instead of filling the panel, the live round wears a plain OPEN pill rather than a count that argued with the queue, and the decision bar sits at the bottom as one row: the two verdicts, the reason a reject needs a note, and a single submit that names the decision. After you submit, the panel says what it is now waiting on — "Review #7 filed · waiting on the agent to render v8" — with a link back to the terminal, instead of leaving you looking at an empty note box.
- A half-written note survives. Your draft — the decision, the words, the element you targeted, pasted images and your drawing — is kept with the canvas and comes back when you return to it. A draft written against a different artefact is dropped rather than reattached to the wrong thing, and a box you measured on one version never silently moves to the next.
- Paste as many screenshots as a note needs. Ctrl+V adds another image and drops a marker where your cursor is — Image 1, Image 2 — so your words can point at a specific picture; removing one renumbers the rest, and the agent is told which name belongs to which image.
- Drawings ride your note automatically. There is no attach step any more: whatever you have drawn over the page goes with the next note you save, and the composer shows the count before you save it. Sketch is a proper toggle — press it again to give the page back the pointer — with a Tools control to hide the drawing tools without leaving sketch mode. Also: a tall page scrolls properly inside the frame again, switching panes cross-fades instead of flashing, and the two rival Dismiss buttons are one.
- A quiet dot on the Canvas button means there is unfinished canvas work on this project that anyone here can pick up. It is deliberately understated and never competes with the amber "Review needed" state — that one is what YOU owe an answer on; the dot is work nobody currently holds.

## [2.1.0-rc.9] - 2026-08-27

> The SSH statusline is solid across Linux and macOS remotes — key or password login, with or without tmux, fresh connect and reattach, all live-tested end to end. Two bugs that could quietly kill it on tmux-wrapped sessions are fixed.

### Changed
- A live SSH connectivity test pack now drives the real connection flow against real hosts — key and password login, tmux wrapped and bare, reattach after disconnect, on Linux and macOS remotes — so these paths stay verified for future releases. Windows-remote delivery is exercised too; its statusline is pending an upstream Claude Code fix on Windows hosts and is not yet claimed working.

### Fixed
- The statusline no longer sticks at "pending" on hosts that start their own tmux (a shell profile with "exec tmux" or similar). Nesting detection used to discard the tmux binary path along with the wrap decision, and without that path the statusline updates could not reach your terminal through tmux. The two are now independent, and the statusline shim also finds a usable tmux by itself — the configured one, the staged one, then PATH — so it recovers even when an earlier setup step left the path unset.
- A successful tmux auto-install is no longer occasionally reported as failed. On Windows, the terminal can glue title and cursor codes onto the same line as the install confirmation (the same class of bug as rc.8’s password prompt), which made the app mis-read a clean result, fall back to launching without tmux, and lose session persistence. All remote-setup confirmations now strip those codes before parsing.

## [2.1.0-rc.8] - 2026-08-27

> The session sleep and working indicators settle down. Clicking a sleeping session no longer wakes its moon (only real output does, consistently), sessions running monitors are no longer tagged asleep between triggers, and the moon and working pill now fade in and out instead of popping.

### Changed
- The sleep moon and the working pill now ease in and out with a soft fade instead of popping, and neighbouring badges slide rather than jump. Reduced-motion setups keep the instant behaviour.

### Fixed
- Clicking or switching to a sleeping session no longer clears its moon. Opening a session repaints its terminal, and that repaint used to count as the session waking — sometimes, depending on window geometry, which is why the behaviour felt inconsistent. Repaint output around a click, focus change or resize is now recognised for what it is: the moon clears only when the session genuinely produces output again, and a click can no longer quietly push an impending moon back either. The working pill gets the same treatment, so it no longer flashes green on a session switch.
- SSH sessions with a saved password sign in again. On Windows, the terminal glues a window-title code onto the same line as the password prompt, which broke the prompt detection — the saved password was never typed and the connect flow asked about launching Claude while the prompt sat waiting. Detection now strips those codes (verified against a real host), and the connect flow holds while a password prompt is visibly waiting instead of advancing over it.
- Text selection works in SSH Claude sessions. The remote launch now disables Claude’s mouse tracking the same way local sessions do (following the classic copy/paste setting), so dragging selects and highlights text again.
- Sessions running monitors are no longer marked asleep between triggers. A Claude session with active monitors is quiet by design while it waits; the Watchdog now reads the "N monitors" mode footer and skips the moon for those sessions.

## [2.1.0-rc.7] - 2026-08-27

> The active-session indicator is easier to catch: a Claude session that is producing output now shows a green "working" pill beside its type badge — a gently pulsing play glyph — as well as the context-bar sweep, so a live session reads at a glance.

### Changed
- A working Claude session now shows a small green play pill next to its type badge, in the same slot as the sleep moon and gently pulsing, alongside the context-bar sweep from the previous build. It marks a Claude session that is actively producing output, honours reduced motion, and never appears while a session needs your attention or is asleep.

## [2.1.0-rc.6] - 2026-08-27

> Session cards now show life at a glance: a Claude session that is actively producing output gets a subtle green sweep across its context bar, and one that has gone quiet gets a moon with how long it has been asleep — two live opposites that update as work flows and stops. Plus: beta testers now see the full What's New story on every prerelease build.

### Added
- Session cards show a moon while a Claude session is asleep — the Session Watchdog (which must be enabled) has seen no output for its silence window (2 minutes by default, configurable). The card dims slightly, the moon shows how long, and it clears only when the Watchdog sees the session produce output again; opening the session does not wake it. A session waiting on your input shows the attention state instead, never the moon, and after you dismiss attention the moon waits a minute before appearing.
- Session cards show a subtle green sweep across the context bar while a Claude session is actively producing output — the live counterpart to the sleep moon. It reads the session's own output directly, so it works for every Claude session with no setup, and the context-usage colour stays visible underneath. It never shows while a session needs your attention or is asleep, is Claude-only, and honours reduced-motion (a steady tint instead of a sweep).

### Changed
- On the beta update channel, every prerelease build (beta and RC) opens What's New with the complete content for upgraders, including the rename/roadmap page that is normally shown once. Stable builds and the stable channel are unchanged: the page still appears once for anyone arriving from before the rename, and for fresh installs.
- The Agent Canvas gets a show-and-tell lane. When you ask the agent to simply show you something, it can render the page as a look rather than a review: nothing enters your review queue, and the canvas can be closed in one step — a Dismiss button in the pane for you, or telling the agent to dismiss it in chat. Real hand-overs are untouched: they still enter the queue, and every review guard behaves exactly as before. Annotating a show-and-tell page puts it under the normal review rules.

### Fixed
- Clicking a custom command button no longer leaves the keyboard on the button. Focus now moves into the terminal that received the command, so pressing Enter submits it — previously Enter re-pressed the still-focused button and injected the command a second time.

## [2.1.0-rc.5] - 2026-08-26

> Session resume gets more reliable. A conversation that was running in a git worktree now comes back correctly even after that worktree is cleaned up, instead of opening a fresh empty session — the conversation was always safe on disk, and it is now recovered and resumed in place. And the name you give a session now travels with the conversation itself, so the resume list labels each one with your own name for it rather than a guess.

### Changed
- Renaming a session carries the name onto the conversation on disk. The name now survives outside the app and identifies the conversation when you resume — the resume list shows the name you gave a session rather than inferring one, and clearing a name clears it there too.

### Fixed
- A session that ran in a git worktree resumes correctly after the worktree is removed. Previously, when the folder a conversation ran in had been cleaned up, resuming opened a fresh, empty session — the real conversation was still on disk but unreachable, sometimes showing a generated name like "session-…". The conversation is now found and resumed in place.

## [2.1.0-rc.4] - 2026-08-26

> A first What's New page for upgraders explains the rename to AI Code Conductor and previews the 2.2 roadmap — support for more coding agents beside Claude Code and Codex. The Agent Canvas review flow is rebuilt: a version is approved or rejected as one decision, only one version is ever open for review at a time, and the counts, header and history are all clearer for it. Plus a global setting for where claude.ai artifacts and sign-in open — a separate window, or in the app.

### Added
- What's New opens with the rename story. Upgraders see "Claude Command Center is now AI Code Conductor", with a roadmap band previewing 2.2 — Copilot CLI, Google Antigravity, Qwen Code and OpenCode joining Claude Code and Codex, plus local models through Ollama. Nothing about your install changes; the roadmap is tentative. Fresh installs meet the same page as an introduction.
- Choose where claude.ai opens. A global setting routes the Artifacts button and the claude.ai sign-in to either a separate window (the default) or the in-app browser pane; the Artifacts button also offers the choice on right-click. Your existing sign-in preference is kept.

### Changed
- Reviewing on the Agent Canvas is a decision now. You approve or reject a version — a reject asks for a note — and Submit stays inactive until you have decided, so a review can never be left half-finished. Rendering a new version supersedes the old one, so only one version of a thing is ever open for review at a time, and the old "5 reviews open" pile-ups are gone.
- The canvas header is two clean rows: what you are looking at (a Library way-back, the mode, the subject, and one version control), then the tools (X-Ray Off/Stealth/On, Sketch, Region, Sign off). History now lists each version with its outcome — approved, rejected, superseded — so the trail is readable at a glance.

### Fixed
- Canvas annotations stay on the version you drew them on. A region or sketch made on one version no longer paints over a later one.

## [2.1.0-rc.3] - 2026-08-25

> claude.ai comes into the app. The browser pane gains a pinned "claude.ai — your artifacts" entry that opens signed in as the session's own account, and Settings → Accounts can route the whole claude.ai sign-in into that in-app pane instead of a separate window — signed in once, it stays signed in for every surface that account owns. Ask Conductor becomes a slim help session that drops the project chrome it never needed, the browser pane gets a Clear back to its start page, and the Agent Canvas gains a real sign-off state. Plus a crop of fixes from the rc pass: multiple sessions of one config are told apart in the Running list, a resume-account setting, and a batch of contrast and canvas-confirm hardening.

### Added
- claude.ai in the browser pane, as your account. The pane's start page carries a pinned "claude.ai — your artifacts" entry that opens a claude.ai view bound to the session's own account — sign in once and it stays signed in, no re-entering credentials, no copying anything between browsers. Settings → Accounts adds "Open claude.ai sign-in in": keep the default sign-in window, or route it into that in-app pane. The default flow is unchanged.
- Ask Conductor is a slim help session now. It keeps Snap, Canvas and the statusline, and drops the surfaces a help session never needed — the command buttons, Browser, Partner, GitHub and the claude.ai auth pills. Its chatter stays out of the Logs index and its spend is filed under its own "Ask Conductor" row instead of your projects.
- The Agent Canvas has a completion state. A reviewed subject can be signed off — the canvas marks it complete and returns to the front page, with a Completed badge in the Library — instead of leaving a finished review sitting in the queue.
- A resume-account setting: choose whether resuming a session asks which account to use each time, or auto-resumes the one it was last on.

### Changed
- Contrast and polish: muted text and the light-theme status pills now meet AA, and command-bar tool buttons no longer change size when you click them.

### Fixed
- The browser pane has a way back. A Clear control returns the pane to its start page without closing it — the only way off a page used to be Close, which hid the whole pane.
- Multiple sessions of one saved config are told apart. Same-config live sessions in the Running list now carry a muted #2 / #3 instance number; a config with a single session shows none.
- The Agent Canvas review flow is steadier: a "Review needed" count no longer climbs per re-render of the same canvas (stale rounds are superseded), and submitting a review no longer races your own "back to terminal" click into a double toggle. The x-ray Off/Stealth/On control reads more clearly beside Inspect, and all three canvas delete confirms are proof against a double-click.
- A terminal that ssh painted over directly (an ssh host-key prompt spliced into the pane) can be repaired with Ctrl+Alt+R or right-click → Repaint terminal — and a long-standing bug where newly-added keyboard shortcuts were dead for existing users is fixed.

## [2.1.0-rc.2] - 2026-08-25

> Fixes from the rc.1 install pass. A saved config that is running shows a session-count pill and can be relaunched — with a clear warning before editing anything a restart would change; the canvas front page can delete an old canvas right from its "Pick up where you left off" rows; and the browser pane finally wears the app’s modern design language instead of the old black one.

### Added
- A saved config that is running is no longer locked. Its card shows a count pill for the sessions it has up, Launch starts another one (a config is a template, not a single session), and Quick Start keeps offering your pinned configs while they run. Editing a running config is allowed — the dialog warns, in amber, that open sessions keep the old values until relaunched and names exactly what a restart would change. Deleting is still refused while sessions are up.

### Changed
- The browser pane matches the rest of the app. Its start page, address row and favourites bar had kept the old near-black look; they now wear the modern design language, in both themes — and a guard test keeps the old palette from creeping back.
- The app’s old working name is gone from every user-facing string, including the release notes you are reading.

### Fixed
- The canvas front page can delete. The "Pick up where you left off" rows each carry a Delete beside Reopen — the same two-step confirm as the library, naming how many versions go, permanent once confirmed. And deleting a canvas in the library no longer leaves its stale row behind on the front page.

## [2.1.0-rc.1] - 2026-08-24

> The first release candidate for 2.1. The left panel has two modes — Saved configs and Running sessions — with a Quick Start; the Agent Canvas pane is redesigned around its mode (PLAN / MOCKUP / TESTING as the title), with tool chips, a framed page, a sectioned notes panel and a two-level History that can archive or permanently delete an artifact; the canvas review flow gains one-sweep dismiss, Ctrl+V paste-into-a-note and chat picks; and the release notes you are reading arrive as a multi-page showcase with drawn feature pages. Plus a crop of fixes: the tips row no longer vanishes after "Got it", creating an Agent Hub pipeline no longer crashes the app, and the glyph-corruption shortcut finally fires where you actually press it.

### Added
- The left panel has two modes: Saved ⇄ Running tabs with a Quick Start row, so launching and tending sessions stop sharing one crowded list. Session cards are unchanged.
- Canvas pane redesign. The MODE is the title — PLAN, MOCKUP or TESTING in its own colour — with Inspect / Sketch / Region tool chips (the X-ray Off/Stealth/On setting rides Inspect, locked to Stealth on plans). The reviewed page sits in a framed card with a provenance line; the notes panel is grouped under NEEDS YOU / WITH THE AGENT / CLOSED with seen-aware collapse and a hide rail.
- Canvas history is two-level: History picks the artifact (a plan, a mockup, an older test build under Archived) and a per-artifact stepper walks its versions. A History row can archive an artifact (reversible) or delete it permanently — a deleted artifact can never be resurrected by a later render.
- Canvas review workflow: right-click the Canvas button to clear the whole review queue in one sweep (a confirm card first; nothing is deleted and every cleared note keeps a one-click Reopen). Ctrl+V in the note composer attaches a pasted screenshot to your note. Naming your A/B/C pick in chat now records it — shown as "picked in chat", apart from your own clicks.
- The release notes are a multi-page showcase now: the one-line summary is page one, and the headline features each get a full page with a drawn illustration — flip with the dots, jump with "See it", or skip the lot.

### Changed
- Command bar breathing room: a Balanced row height and empty band labels are hidden.
- The session header’s GitHub pill is a dot and the word GitHub — the logo is gone.
- Release governance: issues fixed on beta now advance to an in-release state automatically when a release candidate is cut, and close automatically when it promotes to stable.

### Fixed
- The tips row survives "Got it". Acknowledging a tip — or using the very feature a tip points at — now advances to the next tip instead of hiding the whole row for the rest of the session.
- Agent Hub: clicking "New pipeline" crashed the whole app. The pipeline builder opens normally again, and a regression test now exercises the real store it mounts against.
- Ctrl+Alt+G (the glyph-corruption diagnostic) now fires while a terminal has focus — which is exactly where you are when characters go missing. It used to be swallowed by the terminal in that one spot and worked everywhere else, which made it look broken at random.
- Sentinel names the account and the real reason — a rate limit is reported as a rate limit — when an analysis fails, instead of a generic error.

## [2.1.0-beta.17] - 2026-08-23

> The command bar is one row. The tool row and the two command rows beneath every session are now a single row: the fixed tools (Snap, Canvas, Logs, Browser, Partner, Notes), then your Global buttons, then this config's Session buttons. The bar knows what kind of session it is in — a Codex session says Codex, an SSH session says which computer each button runs on — and so does the dialog that makes a button. Nothing you had is changed without asking: existing buttons that clash with the new model carry a small amber mark until you look at them. The Agent Canvas grows a real review flow — a "Review needed" state with one queue number, agent drafts you never see until they are ready, per-note A/B/C alternatives your approve picks between, close-out on your word, three x-ray modes and Ctrl+wheel zoom. A new Session Watchdog waits out a rate limit and types the retry itself — off by default, and careful never to type over you — and GPU terminal rendering is on by default with the corruption actually fixed.

### Added
- One row instead of three. The "⌄ Commands N" strip and the CLAUDE / SHELL / Partner rows are gone; your buttons sit in two fixed bands, Global and Session, after the tools. A band is the scope of what is in it — it cannot be renamed, moved or deleted — and the small mark before each cluster of buttons says where they run (the agent, the partner shell, the browser). Sections are drawn inline inside their band, with a coloured label; a section can still be collapsed to a single chip from its right-click menu. Two terminal lines come back to every session.
- Add is the first thing on the row, and it is a labelled button. Click it to make a new command button; the small arrow beside it offers Add section, Add note, Review N commands (while any need a look) and Manage commands.
- Buttons that do not fit fold into a per-band "N more" pill instead of wrapping under the terminal. Global gives way first, Session last, and a pinned button (right-click → Pin to bar) never folds. The pill opens a list you can type to filter; a button that cannot run in this kind of session sits in it greyed, with the reason, rather than vanishing. If you would rather see more, Settings → Custom Commands has "Two rows, then fold".
- Drag to reorder. Drag a button along its band, drop it on a section label to file it there, or drop it on the other band to change its scope — that last one asks first, and says how many configs a Global button would leave when it becomes Session-only. Keyboard: ←/→ between buttons, Alt+←/→ to move one, Alt+Shift+←/→ to move it across bands (same question), Alt+Enter to run with arguments, Shift+F10 for the menu.
- Every button, tool, section, band and the bar itself has a right-click menu that says what it is and where it runs — the same words as its tooltip. A button's menu offers Run, Run with arguments, Edit, Duplicate, Icon and colour, Pin, Show in (Global / Session), Move to section, Move, Delete. A tool's menu offers its own actions first (Open partner shell; Screenshot settings; Add note / Open notes) and Hide this tool — in this session, or everywhere.
- Buttons look like the tools: an icon and a label. Pick one of forty small glyphs in the dialog or the right-click menu, or keep the default — the first letter of the label on a tint of the button's colour. The colour lives in the icon, never on the button itself, so a full row stays calm. Your existing colours are kept.
- The bar knows its session. A Codex session says "Codex" wherever it used to say "Claude"; on an SSH session the Partner tool and the shell buttons wear a small "this PC" badge, because the partner shell runs on your computer and not on the host — the old bar never said so, and a deploy command meant for the host would have run on your PC. Snap is not drawn on a terminal-only session (it types an English prompt into a shell), and Logs is dimmed, with the reason, where there is no transcript to index.
- The command dialog asks "Where it runs" on every kind of button and answers with the computer and the pane: "On this PC — partner shell", "On build-box — Claude terminal", "From this PC — the browser pane". Where only one answer exists the other chip is shown disabled with the reason. The secret-argument toggle is offered only where the value can actually arrive (a shell on this PC); before, a secret aimed at a remote shell typed a PowerShell reference into bash with nothing behind it. New fields: Icon, Colour, Where it shows (Global — every config / Session — this config only, the bar's own words), and Section with "New section…" created in that band. The preview draws the real button, with its icon, its mark and the exact line it will type. An "Ask Conductor" chip beside the first question opens the help session with it.
- Encrypted notes move from the session header into the bar as one lock with a quiet count — the notes visible to this session (Global plus this config's). Click it for the list: label, colour, scope, when it was added, Edit and Delete, Add note, with notes from other configs folded under one line. The note dialog is in the new look and gains "Where it shows" (Global / Session); content is decrypted only while the dialog is open, exactly as before. The coloured note chips and the lock-plus in the header are gone.
- Settings → Custom Commands, kept small on purpose: how the row behaves (one row, or two rows then fold; show the bar), where hidden tools come back, Snap's colour and auto-delete (moved here from Snap's right-click, which now brings you here), and a plain searchable list of every button with Edit and Delete.
- The Canvas button now says when it is your turn. When the agent marks a render ready, or a round of your notes is waiting on your verdicts, the button turns amber and reads "Review needed", with one number counting every round owed across the session's canvases — click it for the list, newest first. The session tab carries a dot for the same thing. The old pulse is retired: a state that had to be caught mid-animation is now a label you can read any time.
- Agents draft in private. While an agent is still checking its own work it renders invisible drafts that supersede each other in place — nothing pulses, nothing counts, your pane keeps showing the last ready version. Only a version the agent deliberately marks ready surfaces and enters the review queue, so a hand-back is always finished work.
- A canvas note can offer alternatives. When a fix genuinely has more than one defensible answer, the agent renders every option in the new version and the note grows lettered chips — "A · thin rule", "B · no rule". Clicking a chip approves the note AND names the winner; the agent is told, reads your pick, and builds only that one. A plain Approve still works and leaves the choice to the agent. The letters are assigned by the app, never by the agent, and only your own click can record a choice.
- Close a review round on your word. When work has shipped and the notes no longer matter, close the round from the panel — "Accept as built" closes everything without calling any of it approved, and each note can be reopened. The agent can close notes too, but only on your explicit instruction, and it can never mark anything approved: approval stays yours alone. Closed notes keep saying who closed them and from what state.
- X-ray hover on the canvas has three modes, switched in one click in the pane header. On outlines and labels the element under the pointer (the default). Stealth still identifies it — the identity and box are read out in the panel — but draws nothing, so a hover-sensitive design stays undisturbed. Off makes the page behave like a normal browser tab. Plan pages always use Stealth: the flow is the picture, and boxes over it were noise.
- Ctrl+wheel zooms the canvas pane like a browser — over the chrome, the render or the notes panel. The level shows in the header while you are zoomed, and holds for as long as the pane is open.
- A full-screen welcome page walks existing users through the command-bar upgrade the first time they launch this release.

### Changed
- Your existing buttons are reviewed once, never changed. On the first launch after this update each command is checked against the new model, and one that clashes carries a small amber mark: an argument that looks like a token or password (the dialog offers "Make this argument a secret" — one click moves the value to the keychain and puts {secret} in the line); a Global "send a prompt" button when you have terminal-only configs it cannot run in ("Make it Session-only"); a button that sat in a section named "Global" (that section is merged into the Global band); a shell button on an SSH config (its partner shell is on this PC). "Review N commands" in the Add menu walks them; Settings → Custom Commands has a "Needs review" filter. Keep as is dismisses it.
- A never-used bridge that could hand a saved credential's plain-text value to the window has been removed. A credential's value only ever reaches the shell's environment when the shell starts; nothing in the window needed to read it, so nothing in the window can.
- The Saved Configs panel gained two new views beside the existing list (which stays the default, chosen in Settings): Cards, and Find — a search box with auto-complete and category chips, running sessions excluded from its launch list, and a launch-all for a category.
- Loose running sessions in the sidebar now sit under their own "Ungrouped" header instead of floating unlabelled below the groups.
- Every dialog is on the same design language now — the remaining stragglers from the old palette were inventoried and rebuilt, and the tip of the day is a card anchored to its dock row rather than a modal that took the whole screen to say one thing.
- The splash screen states its version, channel and build in clear text, and the "not affiliated" line is retired from the app and the docs.
- Ask Conductor has its own Feature Guide entry now, so the help session is explained in the same place as everything else.
- Session state got tougher again: the file keeps a previous-good mirror beside it, it is written on every exit path rather than only a clean one, and a corrupt saved field can no longer stop a session spawning — the spawn falls back to safe values instead of failing.
- The Session Watchdog arrives in this release: opt-in, off by default, it reads a rate-limit banner, waits out the reset, and types the retry itself — for local Claude sessions only. It watches a RENDERED pane — the same thing you see — not an append-only log, so an in-place redraw cannot pin it on stale text. Before typing it checks the pane: nothing is sent while a permission prompt or picker is open or your own unsubmitted draft is in the input box, and the dim placeholder hints Claude shows in an empty input do not count as a draft, so the retry actually fires when the box is empty. Settings has the switch, the retry message, the attempt cap and the silence alert; the finer tuning lives in your settings file, where an out-of-range value falls back to the default — and the patterns that decide when it may type stay compiled into the app.
- GPU terminal rendering is ON by default now that the shared-cache corruption is actually fixed. If you ever see characters go missing while backgrounds stay, Ctrl+Alt+G saves a diagnostic (event log plus screenshot) worth attaching to a report, and Settings > General > Terminal > GPU rendering falls back to the plain renderer.
- The release process refuses to cut a beta while its milestone still has open issues — the gate that keeps a "done" release from shipping with known work outstanding.
- The browser pane forgets its sign-ins when the session closes. The pane keeps cookies and site data while a session runs; closing the session now wipes that profile, so a site you signed into inside a session does not stay signed in on disk afterwards.
- Five more stores refuse to save over a file they could not read — cloud agents, teams and runs, usage snapshots, vision configuration and window geometry now take the same do-not-overwrite path your configs already had. A failed read pauses saving — and where you did the action, it says so — instead of a later save quietly replacing the file.
- A {secret} in a command line is now checked against where it can actually be delivered safely, and a placement that cannot work refuses to SAVE with the reason — wider than the earlier Windows-only refusal, and it can stop a save you could previously complete. One catch: a secret on a line that also contains a backslash or a backtick is now left as written rather than filled in — a Windows path on the same line is the common case. Rewrite the path with forward slashes.
- The canvas refuses to serve the app's own resources directory as a site root — a designation that would have put your configuration files behind a web origin.
- The tips library was re-read against everything above: tips that described the old bar, the old tip dialog or the canvas pulse are rewritten, and new tips cover the one-row bar, canvas x-ray and zoom, the Session Watchdog and GPU rendering.

### Fixed
- The dashed "global" mark on a button is gone — the band it sits in already says so, and its tooltip, menu and the "more" list repeat it in words. A user section literally named "Global" whose buttons were all Global is dissolved into the Global band on first launch; one with mixed buttons is renamed "Global (yours)" and left alone.
- The full-screen What's New page appears reliably after an update installed while the app was closed — the offline-installer path skipped it in beta.16.
- The "your configuration could not be read" notice is visible even with the sidebar collapsed — it used to live only in the space the collapse removed.
- Windows: tools built for the GUI subsystem (the Slic3r family, Inkscape, some Qt and Git components) could attach to the app's console and bleed their log text over your terminal. When a command button runs one, the app now spots it and offers to run it captured — the output goes to a log pane instead of over your terminal (you can also choose to keep the old behaviour, per button).
- The account strip no longer wraps to two rows when one row would hold every account.
- The model picker offers specific versions again — Opus 4.6 and friends, not only the family aliases.
- Tokenomics: the fallback prices for Opus 4.6 and Haiku 4.5 were wrong and are corrected to the published rates. Where the fallback had applied, historical costs re-price — numbers you saw before this release can change, and the corrected ones are right.
- Security: saved credentials are now bound to the session configuration that spawns them, closing a path where one configuration could receive another's credential. Details in advisory GHSA-49cm-xgg6-7vmw, published alongside this release.

## [2.1.0-beta.16] - 2026-08-21

> The terminal corruption is understood and the setting that causes it is off by default. GPU rendering shares one cache of character images across every open session, so one session rebuilding that cache wipes the text out of all the others, which is why it looked random, why it got worse the more sessions you had, and why resizing the window brought it back. Leave GPU rendering off and you will not see it.

### Added
- The browser is a pane of its own. Every session now has a Browser button beside Snap, Canvas and Logs — it no longer appears only once some command happens to carry a URL, which made the feature invisible until you had already found it. The pane has an address bar (type localhost:5173 or example.com and press Enter), working back and forward, a hard refresh, a home page per saved config, saved favourites behind a star, and a button to open the page in your real browser. Pages load in a sandbox with every permission switched off. A command can still point the browser somewhere — the "watch for a page" toggle and the new "Open a page" kind of button — but that is now a convenience rather than the only door in.
- A third kind of command button: "Open a page". It types nothing into any terminal; clicking it sends the session's browser to the address you gave it. Saved with the same scope, section and colour choices as the other two kinds, and drawn with a small globe so it cannot be mistaken for something that runs.
- A new Session Watchdog can automatically retry a Claude session that hit a usage limit, an overload (the server was busy), or a safeguard stop. It is off by default; turn it on in Settings, where you also set the message it sends and how many times it may try. While it waits it shows an hourglass with a countdown next to the session, and it turns red if it gives up. It only watches local Claude sessions, and a retry is submitted the same way you would type it — it cannot do anything you could not do yourself.
- The Session Watchdog appears in the Conductor services panel alongside the hooks, logging and terminal-integrity monitors. It shows how many sessions it is watching, how many are waiting on a retry, and how many have gone silent — a session whose provider stopped sending output. To stay cheap, it watches the app's own responsiveness and eases off its own checks when the main process is under load, so watching several busy sessions does not itself make the app stutter.
- The Agent Canvas lets you move between your canvases, and remove the ones you are done with. The subject in the pane header is now a picker: it lists every canvas this session has drawn, what each is of, how many versions it holds and what is still outstanding on it, and switching to one is a click. Deleting is there too, next to the thing you are deleting rather than only in the library, and the confirm says what goes — including any notes you wrote and never sent, which are the one thing you cannot get back. Your own canvases sort above everything else in the project, so the list stays readable once you have a few dozen.
- When the agent starts a different subject, the app says so. A canvas holds one thing, so drawing something new files the one you were reviewing and opens a fresh canvas — which is right, because notes anchored to a login screen have no business showing over a checkout flow, but it used to happen in complete silence and take your open notes out of view with it. A line now names what was filed, how many notes went with it, and offers to bring it straight back.
- Ask Conductor has a place of its own. It shipped in 2.0 as a way to launch a Claude session that had read the app documentation, and it worked — but the only way in was a box on one page, and using it left a saved config called "Ask Conductor" sitting in your sidebar next to your real projects, because launching a session was the only mechanism the app had. It now opens as a real session with its own tab and a header saying what it knows, and its pill lives at the BOTTOM of the sidebar, below a divider, apart from your project sessions. No config is created. It is a full interactive session, not a one-shot question, so you can keep talking to it, leave it open, come back to it, and use Past discussions in its header to reopen an earlier conversation.
- The Agent Canvas has a plan mode. Before starting anything large your agent can put the PLAN on the canvas rather than in the chat, and you review it the way you review a mockup — point at a step, write a note on that step, send the lot as one review. Nobody reads a markdown plan; they skim it, say "sounds good", and find out in the diff what step three actually meant. A plan on the canvas has somewhere to point. Every plan has the same six parts so two plans can be compared: the goal, the flow as a diagram rather than a list, a scope fence saying what is deliberately NOT being done, the blast radius of what it reaches and what it leaves alone, any open questions hoisted to the top with a count, and how both of you will know it worked — decided before the work rather than afterwards by whoever is tired. Open questions do not block: the agent starts on the steps that are not waiting and marks the rest. The plan stays up while the work happens, as the thing to check against.
- The multi-account strip along the bottom has a minimal mode. Instead of two or three labelled bars per account it shows the account name and two traffic-light dots — one for usage, one for Fable — with the exact figures on hover. The usage dot follows whichever of your time windows is in the worst shape, because the question the strip answers at a glance is whether anything is about to run out, and an average of a fresh 5h window and an exhausted weekly one answers it wrongly. Green is under 70%, amber to 89%, red at 90% and above: the same points the bars already change colour at, so a dot can never disagree with the bar the same number draws in the other mode. The dots differ in shape as well as colour — a ring, a half-filled disc, a filled disc with a halo — because the pill itself is already tinted with the account colour, and a state told in colour alone would be a second colour language in the same nine pixels. It is off unless you turn it on, in Settings beside the bar toggles, and it obeys the same list: switch Fable off there and its dot goes too. The account name is used only where you have set one; otherwise you get the full email, exactly as before.
- Tips and Ask Conductor can each be switched off by right-clicking them at the bottom of the sidebar. Both are on when you install. Hiding one turns the feature off rather than just tidying the row away — with tips off none is chosen or shown anywhere, and with Ask Conductor off there is no way to start one, though an Ask session you already have open stays open and keeps working. Because the row you dismissed it from is then gone, you are asked to confirm first, and told that Settings → General is the way back.
- Making a command button now starts with one question: what should it do -- run a command in a shell, or send a prompt to Claude? The old dialog had a single "Prompt" box that was a shell line for the partner terminal and an English sentence for Claude, with a placeholder that only fitted one of them. Answering first changes what the fields ask for, the wording around them, and which row the button will live in. On a terminal-only session the Claude option is not offered, because there is no Claude to send to, and you are asked which shell instead.
- A command button can now carry a secret argument -- a token, a key, a password -- without it ever touching your shell history. A button types its text into a running shell, and the shell records every submitted line to disk, so a secret typed as an argument was there in plaintext for good. Mark one argument as secret and the value goes to the OS keychain, exactly as a terminal config's secret argument already does; it is handed to the shell as an environment variable when the shell starts, and the button types a reference to it instead of the value. Write {secret} where the value belongs, e.g. -Token {secret}. One honest limit: a shell that was already open when you saved the secret does not have it yet -- restart that shell.
- The command dialog shows you the button and the exact text it will type, as you fill it in. The preview is produced by the same rule the bar itself uses to put the command and its arguments together, so what you see is what gets typed, down to the Enter at the end -- and if the button also watches for a page, it says which one.

### Changed
- The Canvas button now counts reviews across every canvas the session owns, not just the one on screen. A session can author many canvases and show one; the pane's own count was honest about that one and blind to the rest, and from the terminal the rest is exactly what you cannot see. The pill on the button is now the session-wide total, it appears from one when any of it is on a canvas you are not looking at, and its tooltip splits the number — so many here, so many elsewhere — and says when a canvas could not be read rather than calling it clear. Inside the pane a muted "+N elsewhere" sits beside this canvas's count and points at the subject picker, where each canvas is listed with its own.
- The saved-configs list looks like something laid on top of the sidebar rather than wedged into it. It was a lighter grey rectangle spanning the full width with square corners, which read as a slab dropped over the black — the one thing a floating menu should not look like. It is now inset from both edges so the sidebar shows down each side, fully rounded, lifted on a real shadow with a faint blue rim, and a small notch points back at the header it came from. Nothing about how it works has changed.
- The services panel is easier to manage: each service now has its own Restart button, so the watchdog (or any service) can be restarted on its own rather than through a single hooks-only control. And how long a watched session may go without output before it is flagged as silent is now a setting, in seconds, with 0 to turn silence detection off.
- Updating on the beta channel no longer walks you through the whole twelve-page setup flow again. Every beta build re-ran the lot so testers would see the current pages, which is a lot of clicking to deliver what is usually a single page of notes. A beta update now takes the same route as any other: what is new, then only the pages a release genuinely added, marked as new so it is clear why you are being shown them. The full flow is still there on demand from the Feature Guide, and still runs by itself when a release adds pages that everyone needs to see.
- The usage meters tell you when they are still waiting. The status line is produced by a separate background process, so on a freshly opened session it can trail the terminal by several seconds — and until now the meters simply were not there, which looks identical to them being broken. They now appear straight away as empty bars with a slow shimmer, and fill in when the first reading arrives. Nothing is invented in the meantime: there is no colour and no percentage until there is a real number. If you have the status line switched off, nothing changes.
- GPU rendering for terminals is OFF by default and marked experimental in Settings, and it is opt-in rather than opt-out, so if you have never touched the setting you get the plain renderer, which keeps no shared cache and cannot show this fault. Text is drawn by the normal font engine instead, so it may look very slightly different. A first attempt at repairing the GPU path was made and did not hold: telling the other sessions to redraw is not enough on its own, because a terminal skips any character cell whose contents have not changed and so redraws against the emptied cache anyway. That work continues. Turning it on is one checkbox, and Settings explains what you are trading for the speed.
- It is now obvious how to get back to your terminal. Opening the Agent Canvas replaces the terminal, but its button still said "Canvas" once it was open, so the only hint it was a toggle at all was a faint tint on one button among five identical ones — the words that explained it lived in a tooltip you had to already suspect in order to hover. Canvas now says "Terminal" with a back arrow while it is open, and is tinted in its own colour so leaving the terminal is visible at a glance. The webview button behaves the same way.
- The partner terminal now says that is what it is. It is the one pane that looks exactly like the thing it replaced — another terminal — so you could switch to it, see a shell prompt, and carry on believing you were still talking to Claude. It now opens under a slim strip naming it as a plain shell, with a "Back to Claude" button in the strip itself, so the way out is where you are already looking rather than only up in the command bar. Its toggle is highlighted while you are in it, which it never was before.
- On the last onboarding step, "Skip to the app" now sits under "Take the tour" on the right, instead of being stranded at the far left of the footer where it read as an unrelated control rather than the alternative to taking the tour.
- The canvas library now shows the canvases for the project you are in, rather than every canvas on the machine. Which project a canvas belongs to is resolved by the app itself rather than taken from the page asking, and anything with no project recorded still appears, so nothing becomes unreachable.
- That same strip is much quieter. Every account repeated "5h:", "Weekly:" and "Fable:" with a percentage after each, so with several accounts the words and numbers crowded out the coloured bars you actually read at a glance. The labels are now short codes, the percentages have moved into the tooltip on each bar, and the bars themselves are unchanged. Opening the "+N" list still shows full labels and exact figures, so the strip is for glancing and the list is for reading.
- Reviews come back as the rounds you sent. The notes panel used to flatten every open note from every review into one list, so a review you sent as a unit returned as loose items, a round the agent had finished looked no different from one nobody had touched, and this morning's note sat between two from ten minutes ago. Notes are now grouped under their review, newest first, each saying whether it is waiting on you, waiting on the agent, or closed — and when the agent has finished a whole round you can approve it in one action instead of note by note.
- Your agent now knows when you are mid-review. It could not tell before, so it would render again over notes you were halfway through writing, and the thing you were marking up was stale before you finished. The canvas tools now report how many unsubmitted notes you have and which reviews are still open, at the moment the agent acts, so it hands back instead of carrying on. Nothing is typed into your session to do it.
- The Agent Canvas says which canvas you are looking at. A canvas holds one subject, and a session builds up as many as you ask for, so the pane needed to name the one it is showing — it said "Agent Canvas" and left you to work the rest out from the version number. It now leads with the subject the agent gave it: "Checkout flow", "Title bar logo placement". The name was stored, and handed to the window, and then dropped one line before anything could draw it.
- You can see what is still owed on a canvas without opening it. A review stays open from the moment you send it until every note in it has your verdict, and until now the only way to find out was to open the pane and read the list. The canvas pane header now says how many are open, and the Canvas button in the command bar carries the number once there are two or more, so you can see it from the terminal. It sits beside the label rather than in the corner, because the corner already means "the agent just drew something new" — a badge that means two things is worse than no badge.
- The saved config the old version left in your sidebar is cleared away on the first launch after updating. Asking for help used to create one called "Ask Conductor" pointing at the app's own documentation folder, filed next to your real projects, because launching a session was the only thing the app could do. It is removed once, and only if it still matches exactly what the app itself wrote: if you renamed it, it is yours now and it stays.
- Your question now arrives already asked. Typing one into the Feature Guide used to copy it to the clipboard and leave you to paste it once the session had started, which is a strange thing to ask of a help feature. The session now opens with the question submitted. The text travels in the environment the session is launched with rather than on the command line, so nothing in it is ever parsed as a command, whatever you type.
- There are three ways into it and they all land in the same place: the docked pill at the foot of the sidebar, the Feature Guide, and Discuss on any tip — which hands the tip straight over, so a card written months ago becomes an answer about the version you are actually running. If it is already open, every one of them takes you to it rather than starting a second one. A fourth was tried, a button in the footer beside the version, and removed before release: two controls for the same thing in the same corner of the window read as two different things, and only the pill can tell you whether a session is already open.
- It is an expert on Claude Code as well as on the Conductor. It used to be told to refuse anything the app documentation did not cover, which meant an ordinary question about hooks, slash commands, MCP or permissions got a "the docs do not cover it". It now answers Claude Code questions properly, checks the official documentation when it is unsure, and is explicit about which of the two you are asking about — usually the thing you actually needed to know. It still cannot see your code, and now says so instead of guessing.
- Ask the Conductor now knows about problems as well as features. Its documentation had no notion of a known issue, so the one question people are actually asking — why a terminal keeps going blank — got a "the docs do not cover it". It now carries a known-issues section describing the symptom, what causes it and the exact setting to change, and every future release is required to add one for anything shipping with a live workaround.
- A canvas now says whether you are looking at a mockup, a plan or the live site, in its own colour, so you can tell from across the pane which kind of thing you are annotating — the notes you write on a picture of a screen and on a commitment about work are different in kind. The word "mode" was already taken in that pane by the drawing modes, so the thing you actually think of as the mode was previously only a small grey word beside the version number.
- The tip of the day has moved to the bottom of the sidebar, under Ask Conductor, and now shows you the tip instead of offering one. It used to be a small pill in the header of whichever session was in front, which meant it moved about as you switched sessions, competed for room with the account and notes controls, and had space for an icon and a few words. In the sidebar it is always in the same place and wide enough to carry the tip itself, plus a count of how many you have not been shown yet. It sits under Ask Conductor because both are the app talking to you rather than your work, and it is in its own colour so the two read as a pair rather than as the same button twice.
- The tips have been rewritten for what the app actually does now. The library had not had a proper pass since June, so it could tell you about notes and command sections while having nothing at all to say about the Agent Canvas, plan mode, Ask Conductor, the sidebar dock the tips themselves now live in, pages opening as tabs, remote sessions that survive a dropped connection, Codex, running more than one account, or the Feature Guide. Eleven tips cover those. They also retire themselves properly: opening the canvas, saving a Codex config and moving a session to another account are now recorded, so a tip stops introducing a feature once you have found it — and the plan-mode tip waits until you have opened a canvas at all, because it is meaningless before then.
- GPU terminal rendering now only ever runs in the terminal you are looking at. Sessions stay loaded in the background so switching to one is instant, and every one of them used to hold its own GPU drawing context -- which runs into two hard limits at once. A browser engine allows about sixteen of those contexts and takes the oldest away when you ask for a seventeenth, and that taking-away arrives as the same failure a crashed graphics driver would; separately, all of them share ONE cache of drawn characters, so any session rebuilding that cache could blank the text in the others. Both problems are the same problem -- more than one context -- and there is now never more than one. A terminal you cannot see draws with it released, and takes it again when you switch back, which costs a repaint that tab was going to do anyway. GPU rendering is still off by default while this is measured on real hardware.
- The command bar now tells you where a button runs. A command could be targeted at Claude, at your partner shell, or at "Any" -- and "Any" was the default. An "Any" button sat in the Claude row but ran in whichever pane happened to be open at the moment you clicked it, so a button under the Claude mark could execute a shell line, and which it did depended on something invisible. "Any" is gone: a button lives in the row it runs in. Existing ones move to the Claude row, which is where they were already filed and where they landed most of the time, and any that belong in the shell are one drag away.
- Both command rows are now always there when a session has a partner shell, and each says which pane it is. The shell row used to appear the moment you created your first command for it and disappear when you deleted the last, so the bar changed height under the pointer -- and if you had never made one, nothing on screen suggested the row could exist.
- A command that belongs to every config now says so, with a small dashed "global" mark. Global commands and this-config commands sat side by side looking identical, so editing or deleting one could reach every config you own with nothing warning you first.
- The command dialog explains two things it never did. Arguments are appended to your command separated by spaces and nothing is quoted for you, so an argument containing a space arrives as two -- the chips implied more structure than there is. And you can Ctrl+click any command button to change its arguments for a single run without editing the command, which was a real feature taught only by a tip you may never have been shown.

### Fixed
- Security: the one call that loads your configuration into the window was also handing it the token that authenticates the app's local Conductor tool server, and the legacy SSH credential store, and any registered configuration file could be saved back from the window. A compromised window could have read that token (which unlocks the tool server, including running script in the embedded browser) or planted its own. The window now receives only the files it uses and can only save those; the code in the app that needs the token still reads it directly. Fixed in this release; 2.0.0-rc.1 through 2.1.0-beta.15 are affected. Advisory GHSA-m8p2-cf72-7p35: it requires a compromise of the app's own window first.
- On Windows, a secret argument — for a terminal config or a command button — that PowerShell cannot hand to a command intact is now refused when you type it, with the reason under the field, instead of being saved and then silently corrupting the command line. The app starts Windows PowerShell 5.1, which rebuilds a command's arguments into one line and never escapes a double quote inside a value; a value containing one, or ending in a backslash, or (for tools installed by npm) containing & | ^ < > %, would arrive split, truncated, or in the worst case re-parsed by cmd.exe. The app cannot rewrite a secret, so it says no up front. Secrets without those characters are unaffected; macOS and Linux are unaffected because the reference there is quoted.
- Three more ways a configuration the app could not READ was being WRITTEN over are closed. The earlier fix stopped the app saving defaults when loading your config failed outright; it did not see the quieter failures. If the folder holding your configuration could not be reached when the app started — a network drive not mounted yet, a USB stick not plugged in — the app treated that as a brand-new install and, once the folder came back, wrote default settings over yours. If a single file could not be read or did not parse, it was treated as if it had never existed, and the first save replaced it. And one store, the Agent Library, saved straight to disk and never checked the "do not write" latch at all. All three now take the same path: saving is paused, the notice names the file it could not read, and you choose whether to start fresh. Separately, a damaged usage-tracking file could make the app open to an error page on every launch; it now opens normally and forgets what it could not read. And the saved-sessions file is now under the same rule: a launch that could not read it — a scanner holding the file for a moment, a permissions hiccup — no longer saves an empty session list over it when you close, and a file that does not parse is moved aside rather than destroyed.
- Light mode now reaches SSH and Codex sessions. The app tells a newly launched Claude which way the terminal is lit (light or dark) so Claude picks the matching theme at startup — but only the local Claude path ever received that signal, so a session over SSH, or a Codex session, launched while the app was in light mode came up with Claude's dark theme and black message blocks on a light terminal. The same signal now rides the SSH launch line (quoted for the remote shell, and through the tmux wrap) and the Codex environment. Dark mode is unchanged.
- Pressing any command button while reading a page in the browser no longer yanks the browser back to the watched URL. The re-check of a watched page still runs and still tints the Browser button; it only points the pane at the page when the pane is showing nothing yet.
- The smaller grey text throughout the sidebar is readable. Session status, group headings, config counts and the Ask Conductor subtitle were all drawn in a grey that measured between 3.2 and 4.3 against a minimum of 4.5 — failing on every surface it appeared on, not just the marginal ones. It has been lightened in dark mode and darkened in light mode to clear the minimum everywhere, and the app now measures this for itself so it cannot drift back.
- A long stretch of work no longer quietly disconnects an agent from the app's own tools. The connection the app keeps open for the Agent Canvas and Vision carried no traffic at all between tool calls, so an agent that spent an hour building, testing or running a job came back to "transport session not found" — the connection had been dropped for being idle and rebuilt underneath it, and the next call was addressed to one that no longer existed. Nothing had crashed, which is why it was hard to see. The connection now sends a heartbeat every 30 seconds, so it stays open through however long the agent is busy elsewhere.
- GPU rendering no longer blanks the text in your other terminals, and the repair this time addresses the actual cause. Drawing terminals on the GPU keeps ONE cache of character images for the whole app, so when any session rebuilds that cache the others are left drawing from an empty one. The previous attempt told those other sessions to redraw, which sounds right and is exactly what made them go blank: a terminal skips any part of the screen it believes has not changed, so it redrew the same characters against the now-empty cache. Each affected session now discards its own idea of what is on screen FIRST and then redraws, which is what a window resize was doing all along. A session that was not on screen at the time catches up the moment you switch to it, so one missed moment no longer leaves a terminal blank until you resize it. GPU rendering is still off by default and still marked experimental — a second, separate limit (the browser engine allows only 16 GPU canvases per window) has to be dealt with before it can be on for everyone.
- What is new in a release is shown on the full-screen page, never again as a wall of release notes in a small box. The full-screen format existed and was meant to be what you saw; a modal was still wired up underneath it for one case — a version change where the app decided not to run the tour — and that case turned out to be almost every case, for a reason nothing on screen could reveal. Notes for a release are written before the version number is stamped, so any build between two releases believed it was one release further ahead than it really was, took the "no tour" path every launch, and opened the box. There is now one surface. If you have already been through setup you get the notes page and nothing else; if a release actually added something you need to set up, that page follows, badged as new.
- The app no longer records you as having seen a version you have never run. It stamped the newest version mentioned in the release notes rather than the version in front of you, which on any build in between put a number in your settings that had not shipped yet — and when it did ship, the app compared the two, decided you had already read them, and showed you nothing at all. It now records the version you actually ran. If your copy already holds one of these stamps it corrects itself on the next launch.
- One thing at a time on launch. Release notes, the "restore your sessions?" prompt and the Sentinel findings panel could all paint at once, over each other, on the first launch after an update — three decisions stacked in one frame with no way to tell which was on top. The app has had a queue for first-launch screens for a while, but those last two were never in it: the resume prompt only knew to stand aside for the setup tour, and the findings panel stood aside for nothing. Both are in the queue now, and the panel keeps whatever it found and shows it once the rest have cleared.
- Files the app copies into your resources folder are now locked to your own account on Windows. The one-time backup of your Claude login, and the folder the Ask Conductor session reads its instructions from, were created with whatever permissions the folder you picked happened to hand down — and a folder you choose yourself, especially on a second drive, usually grants read access to every account on the machine. Both now get the owner-only lock the app already applied to its other credential folders, and the instructions folder refuses to be redirected through a link planted in its place. If you share this machine with another account, update; and if you want to be thorough, sign out and back in afterwards so the stored token is replaced.
- A question typed into Ask Conductor while its session is still starting is asked, not run. A terminal exists for a moment before the thing it is going to run has started, and anything sent in that gap went to the bare shell instead — so a question arriving in that window was executed as a command rather than asked of Claude. Input is now held until the session is actually running, then delivered. It applies to every session, not just Ask Conductor: anything you send while one is starting now waits for it rather than landing in the shell underneath.
- The multi-account strip along the bottom no longer gets cut in half. With several accounts signed in and a narrower window, the row was wider than the space between the version label and the disclaimer, and the overflow was clipped — so the first account was sliced down the middle and looked like a rendering fault. Accounts now wrap onto another line and the bar grows to fit them instead.
- The cause of terminals losing their text while other sessions run is now understood, and it was not what months of fixes assumed. Drawing terminals on the GPU keeps one shared cache of character images for the WHOLE app, not one per terminal, so whenever any session rebuilds that cache, every OTHER open session keeps its background colours and loses its characters until you resize, scroll or switch to it. That is why it struck at random, why more sessions made it worse, and why a window resize always cured it. Every previous fix treated the cache as going stale inside a single terminal and tried to refresh more often, which quietly made things worse: the refresh was the thing doing the damage. GPU rendering is off by default, so you are not exposed to this unless you turn it on.
- Onboarding no longer presents an account you have switched off as though it were live. If you have set an account inactive in Settings, it now carries an Inactive badge on the accounts step, with the row dimmed and a line explaining what that means — shown only if you actually have one. Before, it was listed identically to every other account, with nothing on the screen suggesting the idea of an inactive account existed at all.
- The saved-configs panel uses the space it has. It capped itself at a fixed fraction of the window height, so with a couple of dozen configs the list was cut off partway down a row while empty sidebar sat underneath it. It now measures what is actually free below it, keeping room for your sessions, and the list fills whatever height the panel gets.
- The Agent Canvas library can open your canvases again. Every row refused with "that canvas could not be opened here — it may belong to a session that is still running", on a list showing your own work from the session you were sitting in. A session keeps one canvas active but can author many, because showing a new subject files the previous one; the check that stops a session taking someone else's canvas ran before the check for "this one is already mine", so once a session had drawn anything it could never reopen any of its own. Switching between your own canvases moves no ownership and is now simply allowed. The guard against taking another live session's canvas is unchanged, and is tested by reverting it.
- The account usage strip along the bottom was drawing each account in a near-white outline with no fill. It asked for a colour that does not exist, and a stray custom property makes the whole rule invalid, so the border quietly fell back to the text colour and the background was dropped altogether. Each account now carries a soft rim and tint in its OWN identity colour — and only that: the separate coloured dot is gone, because the rim, the fill and the dot were three ways of saying the same thing and the dot was the one costing width in the tightest bar in the app. The tint is a little softer too, so the accounts frame the meters instead of competing with them. The expanded "+N" list keeps its dots, where they are the only identity marking there is.
- When the canvas refuses a render for being in the wrong folder it now says which folders would have worked, including the isolated worktree, instead of only restating the rule. Two separate agent sessions lost time to that message in one day: one wrote its mockup to a scratch folder the canvas will never serve, and the message it got back gave it nothing to correct.
- Sessions on a secondary account now load your user-scope CLAUDE.md. A session launched under an account reads its global instructions from that account's own home, and the app never placed your ~/.claude/CLAUDE.md there — so unless the folder you opened happened to carry its own project CLAUDE.md, the session ran with none of your standing instructions, silently. Each account's home now gets a copy of your shared ~/.claude/CLAUDE.md, plus an optional per-account CLAUDE.overlay.md concatenated after it, refreshed on every launch so edits to the shared file always take. It is written safely: some setups had these as hardlinks back to the real file, where a normal save would have written through and corrupted it for every account, so the app breaks the link before writing.
- A tip now counts as seen when you have actually seen it. One was chosen about two seconds after launch and marked as shown at that moment, whether or not anything ever drew it — and a tip marked shown does not come back for a week. So if you launched onto the Tokenomics tab, or with the sidebar collapsed, that tip was spent without a pixel of it reaching the screen, and the next one would go the same way the next day. It is now marked when the row is actually on screen. Nothing else changed, but it means the tips you have "already been shown" are the ones you were really shown, and the count of new ones beside the tip row is telling the truth.
- Tips stop explaining features you already use. Several of them are meant to switch to a shorter "you have found this" note once you have used the thing they point at — effort levels, SSH sessions, customising the status line, editing a command's arguments with Ctrl+click, the Copilot credit meter, running an agent team. Nothing in the app ever recorded those six as used, so the switch never happened and the tips carried on introducing you to features you had been using for months. Each is now recorded at the moment you use it. There is also a check that fails the build if a tip is ever again gated on something the app does not record.
- Usage tracking no longer keeps rows for features that no longer exist. The file the tips system uses to remember what you have tried accumulated entries from removed features, which made it misleading to anyone reading it. Dead rows are now dropped on startup — worked out from what the app can actually record rather than from a hand-written list, so it stays correct as features come and go.
- The usage figures you last saw for an account now survive closing the app. They were already kept for the case where a refresh cannot complete — a lapsed token, a rate-limit burst, a network blip — so the account card shows real figures marked as out of date rather than going blank. But they were only held in memory and thrown away on exit, which meant the moment they were most wanted, reopening the app and choosing an account before any session has run, was the one moment they were never there. They are now written down, along with when they were taken, so the account picker can show you where each account stood as of the last time it was read. Nothing is shown until at least one reading has been taken and saved, so on a brand-new install you will start seeing this from the second time you open the app.
- Codex usage figures were undercounting by roughly half, and this release corrects them — so your Codex totals will go UP, not because you spent more but because the app was counting less than you did. A Codex session that spawns a subagent writes the subagent's turns to their own file, but the app filed those turns under the PARENT session, where their numbering collided with the parent's own turns and the duplicates were silently dropped — measured at 647 of 1312 turns lost on a real sample, 49.3%. Subagent turns are now kept under their own session, so nothing collides. Because the correction changes how past turns are identified, the app re-reads your Codex history once on the next launch and the figures rise to what was actually spent; that takes a moment on first run. Claude figures are unaffected and unchanged.
- The question asking whether you really want to hide tips or Ask Conductor now appears over the window, not squeezed into the sidebar. It was drawn inside the sidebar rail it was launched from, so it came out as a narrow column barely wider than the button you right-clicked, with its own title wrapped over two lines. Every other dialog in the app centres itself over the window and this one now does too.
- A launch that cannot read your configuration no longer overwrites it. If one config file was damaged -- a half-finished write, an edit by hand -- the app started on defaults, which is right, and then SAVED those defaults: your custom commands replaced with an empty list and your settings with a fresh set, on a launch where nothing was wrong with either of them. Nothing warned you, because from the inside a file it cannot read looks identical to a file you never had. Three things changed. It no longer trips over an unreadable entry in the first place, and leaves anything it cannot understand exactly as it found it instead of rewriting it. If the read fails anyway, saving is paused for that launch, so quitting loses nothing and everything is still on disk as it was. And it now says so on screen, with the option to start fresh anyway if you would rather have a working app than the config you cannot load.
- The app has stopped rewriting your commands file on every launch. A one-time migration from an old command format reported that it had changed something whenever it ran, whether or not it had, so the file was rewritten with identical contents every time you started up. Harmless in itself -- but it was also the mechanism by which a failed launch wrote an empty list over it.
- A question asked of Ask Conductor after its session has ended now reopens it and asks, instead of vanishing. A session stays in your tab strip after the process inside it exits -- it shows [Process exited] and otherwise looks exactly like a live one -- so asking again from the Feature Guide or from Discuss on a tip handed the question to something that was no longer listening. The box you typed it into was cleared, you were taken to the tab, and nothing happened there: the question was not delayed, it was gone. Ask Conductor now notices that its session has ended and starts it again in the same tab, with your question delivered the moment it comes up. The sidebar also stops showing an ended session as running.
- When your agent starts a new subject on the canvas, what it is told about the canvas it just filed is now something it can act on. It used to be handed the reference numbers of the reviews still open on that filed canvas -- but those numbers restart on every canvas, and the tool the agent uses to read a review only ever looks at the one currently open. So the agent either got told the canvas has no reviews at all, contradicting what it had just been told, or -- when the numbers happened to line up -- was shown a DIFFERENT canvas's notes as though they were the right ones, and could then mark those notes as handled. It is now told how many reviews are still open and that they are on the filed canvas, which you reopen from the library. The same reply also stops calling it a new canvas when your agent has simply gone back to a subject it started earlier.
- "Launch webview on completion" has been renamed to say what it does: it watches for a page and opens the browser when it responds. The poll starts when the command is SENT, not when it finishes, which is the whole point -- it is waiting for a server that is still starting up.

## [2.1.0-beta.15] - 2026-08-19

> The terminal stops going unreadable during long output and switching between sessions repaints them clean; Tokenomics stops sitting on "Indexing usage data" forever and counts Codex spend correctly; every page — Tokenomics, Settings, the new Feature Guide — now opens as a tab beside your sessions instead of taking over the window; the Agent Canvas gets a library, keeps subjects apart, and can be deleted safely; What's New and the first-run tour know which version you came from, and What's New is readable whenever you want it; and the README finally describes, and shows, the app that ships.

### Added
- Tokenomics, Logs, Memory, Insights, Settings, Account, the Agent Hub, Conductor MCP and the Feature Guide now open as tabs in the same strip as your sessions, and behave the way tabs should: several can be open at once, each closes with its own button, and one you leave alone stays where you left it — go to a session and come back and you are still at the same place on the page, with whatever you had scrolled to or typed in still there. Before, a page took over the whole main area, only one could be open at a time, and reaching a session meant losing it. Clicking an icon in the nav rail opens its page, or jumps to it if it is already open.
- Help is now a Feature Guide page rather than a floating panel that covered whatever was underneath it. It opens as its own tab, with a card for every feature — a screenshot, what it does, what is worth knowing, how to open it and a tip — gathered into Getting started, Productivity, Integrations, Admin & data and Tips & shortcuts, alongside the full reference text. One search box covers the features and the reference together. Ask the Conductor is still on the overview: it launches a real Claude session that has already read the app documentation, so you can ask about the app inside the app.
- The Agent Canvas has a library: every canvas on this machine, newest first, with what it is of, the project it came from and how many versions it holds — and each can be deleted, which nothing could do before. Deleting was reviewed hard: it takes an id and never a path, is confined to the canvas store, and refuses to follow a link planted inside a canvas folder on the runtime the app actually ships. A locked file no longer leaves a half-deleted canvas that reports either success or failure untruthfully.
- A canvas now holds one subject. Claude names what it is showing on every render — "Title bar logo placement", "Checkout flow" — so re-rendering the same subject adds a version, and rendering a different one files the current canvas and starts fresh. That stops the panel showing "open notes from earlier reviews" that belong to something else entirely, anchored to elements that are not on the page. Coming back to a filed subject reopens it with its versions and its notes; a restart reopens the one you were last working on; and it works in every script, not only English.
- What's New and the first-run tour now decide what to show from the version you came from, not just whether the version changed. A fresh install gets the tour and no release notes; an upgrade across a release line — 2.0 to 2.1 — gets everything new since 2.0 and walks the tour again; a move within a line gets the notes only. The notes cover every release you missed rather than the newest one, the tour's upgrade page finally describes 2.1 instead of 2.0, and the release-notes surface that had been silently missing for anyone updating within a stable line is back.
- When you approve a canvas review in chat rather than in the pane — "C is fine", "option B" — the notes no longer sit open forever. Claude can now mark the notes it acted on as addressed; they stay in the pane's checklist with an "addressed" chip until you approve or re-annotate them, because the verdict is still yours. Claude never approves on your behalf.

### Changed
- The usage page no longer tells you it has finished while it is still reading. Because large files are now read in pieces, a sweep can end with most of your spend still to come, and that was being presented as the final figure. It now waits until everything it can read has been read — and if something could not be read at all, it says so on the page and shows you the rest rather than hiding behind a spinner forever.
- What changed in each release is now readable whenever you want it, not only in the window that appears once after an update. The Feature Guide has a What's New section holding the whole release history, newest first. Both surfaces render the same notes, so they cannot drift apart.
- The tab shortcuts now cover the whole strip. Ctrl+Tab and Ctrl+Shift+Tab cycle through sessions and open pages together instead of stopping at the last session, Ctrl+1 to Ctrl+9 jump to the nth tab whatever kind it is, and Ctrl+W closes the page tab you are on — before, it only ever closed a session.
- After you finish a canvas review and submit, the pane hands back to the terminal on its own, and a mode badge says whether you are looking at a mockup or the real built site.
- Every session card now shows its type in one place: a Claude, Codex or terminal icon in the top-right cluster, immediately left of the effort pill. Before, a Claude Code session had no icon at all while Codex and terminal sessions had one after the name and SSH had a text badge in the same spot. SSH and SSH+tmux stay as separate badges next to it. Codex is purple now (green was tmux's colour) and the terminal icon is a prompt with a block cursor rather than code brackets.
- Saved configs that are not in a section or group are now divided from the ones that are, so they stop reading as the tail of the last group — and they are the only rows you can drag to reorder, since a drag between grouped rows changed nothing you could see.
- The brand mark now sits beside the app name in the title bar rather than stranded at the far edge with the sidebar button between them.
- The README was rewritten against what the app actually does. Download names, notarisation, the permissions description, the outbound-traffic list, the engine versions and several described-but-never-built features were all wrong; the 2.1 line — remote sessions that survive a dropped link, the Agent Canvas, in-app sign-in, Insights — was absent. It now opens on a banner and carries seven moving screenshots of the running app — sessions, the Agent Canvas, Tokenomics, Logs, Memory and Insights — all captured against an invented workspace, so nothing real is on show.

### Fixed
- The terminal no longer STAYS unreadable during a long stream of output, with the mouse wheel the only thing that clears it. Characters going missing or breaking up is the glyph atlas needing a rebuild, and a wheel was doing that by hand; it now happens on its own, so the text repairs itself within a few seconds instead of sitting there until you scroll. The font atlas is now rebuilt in the pauses between output, and — because a build log or a long Claude Code response never pauses — also after at most five seconds of staleness. Switching to a session repaints it as you arrive, which is the moment you are about to read it and the one moment a rebuild cannot be seen; a session left streaming in the background is the likeliest to have gone stale unseen. GPU rendering can also be switched off entirely in Settings for anyone whose driver misbehaves.
- Tokenomics no longer sits on "Indexing usage data" and never finish. Codex keeps its sessions in files that reach 2.5 GB, and they were being read whole — which either took tens of seconds each or hit a hard limit in Node and threw, and the error was swallowed without recording how far it had got, so every sweep started the same file again and never reached the end of the list. One machine sat like that for nine hours over a database that had been complete since July. Those files are now read a piece at a time, skipping the megabytes of tool output without decoding them, and each piece is recorded so the next pass carries on. A sweep of an 80 GB folder went from not finishing to about half a minute.
- Codex spend is counted correctly. Three separate faults were adding up: quitting while indexing counted some turns a second time, permanently and cumulatively, because the record of what had been read was written separately from the rows themselves; about a fifth of turns were priced at nothing, because a session announces its model once at the top of the file and anything read after that point had no model to price against; and a session whose opening line grew past a size limit was dropped in its entirety, silently, with nothing to say it had happened. That limit was already three-quarters used on a real machine and grows with every MCP server you add.
- The title bar tints to the service status again when Claude Code or claude.ai reports a problem. It had quietly stopped in June — the tint had become invalid CSS and the bar was falling to transparent, which is the "colour shifts when a chip leaves green" that was reported.
- Saved-config labels in the sidebar are no longer truncated against invisible hover buttons.

## [2.1.0-beta.14] - 2026-08-18

> Fixes severe terminal flashing and unreadable, broken text introduced in 2.1.0-beta.13. If you are on beta.13, update.

### Fixed
- The terminal no longer flashes constantly and drops most of its text while Claude is working. A repaint added in 2.1.0-beta.13 to clear leftover "ghost" characters was rebuilding the entire font atlas on every burst of output — and because Claude Code draws in the normal scrollback, that ran for the whole life of every session, so characters were being redrawn faster than they could be prepared. The repaint now rebuilds the font atlas only when scrolling, which is where the ghosting actually comes from, and does the cheap redraw everywhere else. 2.1.0-beta.13 is the only affected release.

## [2.1.0-beta.13] - 2026-08-18

> Remote sessions survive a dropped connection: SSH sessions now run inside tmux on the remote, so closing the lid, losing wifi or switching networks no longer kills the work — reconnecting picks it back up where it was. Signing in to claude.ai now happens inside the app, which is what finally gets past Cloudflare's "verify you are human" loop.

### Added
- SSH sessions can now survive a dropped connection. The remote session runs inside tmux, so a closed lid, lost wifi, a network switch or a VPN drop no longer ends it — Claude keeps working on the remote, and reconnecting attaches to the same session with your conversation and scrollback intact. If the remote has no tmux, the app can fetch a verified copy for it, or push one down the existing connection when the remote has no internet access of its own; where none of that is possible it falls back to an ordinary session and resumes your conversation on reconnect instead. A "Detachable" switch on the session controls the whole thing, and the session header says plainly whether this session is persistent or not.
- Closing a persistent remote session now asks what you meant: leave it running on the remote and just close the tab here, or end it properly. Quitting the app leaves persistent sessions running rather than killing them, and the session header shows which remote account the session is signed in as.

### Changed
- Sessions now show connection pills for Claude Code and claude.ai at a glance, the account strip along the bottom separates accounts from services, and the launcher shows which account you last used. Signing in to an account is offered only where it can actually apply.
- Settings now look like one surface: every tab shares the same card, input and accent styling, and the GitHub tab no longer sits on a slightly different black. Both light and dark themes were brought in line.
- The updater will keep finding releases through the repository rename that is coming, by checking the new location first and falling back to the current one. Nothing changes for you now; this is here so the rename cannot strand anyone on an old version.

### Fixed
- Signing in to claude.ai for an account now happens in a window inside the app rather than your system browser. That is the fix for the "verify you are human" loop that could never be completed: the previous sign-in ran with a debugging port open, which claude.ai flags. Accounts using a company or Google sign-in still open the system browser, as those providers require.
- Fixed a fault that could make an account's shared folders — projects, memory, agents, skills — point at themselves, which made memory and project history unreadable for that account until repaired. The app now refuses to create such a link and repairs any it finds. Nothing was lost in that state: it was a broken shortcut, not a broken store.
- The terminal no longer leaves stale "ghost" characters painted over the screen when output arrives while you are scrolled to the bottom. The previous fix only covered output that arrived while you were scrolled up.
- The Agent Canvas now serves the working copy the app actually gave the session, so a page built in a session's own worktree can be previewed instead of having to be pasted in.

## [2.1.0-beta.12] - 2026-08-17

> A stability-and-hardening release: stale glyphs left on the terminal after scrolling are cleared, the attention pulse now covers blocked sub-agent and elicitation prompts, the model and effort pill stops flickering to a sub-agent's value, and the SSH connection's argument handling is hardened.

### Changed
- The attention pulse that marks a session as needing you now also fires when a sub-agent is blocked waiting for input and when Claude opens an elicitation dialog, not only on the top-level permission prompt. A background session whose sub-agent was quietly waiting could previously look idle when it actually needed you.

### Fixed
- The terminal no longer leaves stale "ghost" characters painted over the screen. When output streamed while you were scrolled up, the GPU renderer could freeze a fragment of recent text over the live rows until the window was resized; the app now reproduces that full repaint itself on the conditions that trigger it, throttled so a firehose of output costs at most a few repaints a second, and only when the GPU renderer is actually in use.
- The model and reasoning-effort pill in the status strip no longer briefly flickers to a sub-agent's or background workflow's value. It stays pinned to the main session for the whole time a Task, Agent, or Workflow tool is running, including the moment that tool finishes, and returns to the main value only on the next real main-session activity.
- Security hardening: the SSH connection's username, host, and session id are now validated and constrained before they build the ssh command line and the remote setup script, as defence in depth against a crafted value being read as an ssh option or breaking out of the setup script. It is not exploitable in shipped builds; this closes the gap so a future change cannot turn it into one.

## [2.1.0-beta.11] - 2026-08-16

> A security-and-stability release. The Agent Canvas review surface arrives, per-account claude.ai web sign-in rides through Cloudflare's check, and three local-attacker security issues are closed, two of them with advisories published alongside.

### Added
- The Agent Canvas can now show a page Claude is working on and report what it actually looks like once laid out: element names, sizes, form state, and measured problems such as clipped text, targets too small to tap, and unreadable contrast, so Claude can review and improve a page it built. It reads only files inside the project folders you open sessions in.

### Changed
- Per-session account actions in the sidebar (Open artifacts, Authenticate claude.ai) are now offered only for sessions that can actually use them, and "Open artifacts" correctly enables for your primary account. Terminal-only sessions, which have no /login to run, no longer show them.
- The account strip along the bottom now wraps to two rows with a "+N" overflow when you have several accounts, so none are pushed off the edge, and the sidebar session cards give the context meter its own row so a long model name can no longer squeeze it out.

### Fixed
- Security: the terminal paste protection added last release did not cover every way text can be pasted. Pasting through the Edit menu, or with Ctrl+V while a dialog was open, still fed the clipboard to the terminal without the safety filter, so a page that quietly put a command on your clipboard could run it when you pasted. Every paste route into a terminal now goes through the same filter, which strips the control characters that let pasted text execute. Fixed in this release; 2.1.0-beta.10 and earlier are affected. It requires being tricked into copying attacker-chosen text.
- Security: on Windows the folder holding each account's Claude sign-in tokens was never actually locked down. The hardening step did nothing off macOS and Linux, so any other user signed in to the same PC could read or modify those tokens. The folder and the token files are now restricted to your Windows account, and repaired to that if found otherwise. Fixed in this release; 2.1.0-beta.10 and earlier are affected. Advisory GHSA-3ghm-39v2-53ph, severity high: it requires another user account on the same machine.
- Security: the app's local Conductor service checked that a request carried a valid session token but did not confirm the request was aimed at that same session's connection, so one local session could post messages into another session's stream if it learned that connection's id. Each message is now bound to the connection opened by the authenticated session. Fixed in this release; 2.1.0-beta.10 and earlier are affected. Advisory GHSA-f3wv-ppx5-m3v4, severity medium: it requires another program or session running locally that can reach the app's local service.
- Signing in to claude.ai for an account no longer fails when Cloudflare shows its "verify you are human" check. The sign-in used to run page script on every poll, which kept the check re-arming, and a routine mid-check page reload could close the sign-in window and abandon the flow. The sign-in now waits out the check without touching the page, and rides through a reload instead of aborting.
- Accounts that were fully signed in could show as "not signed in" and tell you to run /login. The app was looking for the sign-in token in the wrong folder; it now reads the same location the CLI writes, so a signed-in account is recognised. The check also no longer briefly freezes the app while it runs.
- The usage page now respects parked (inactive) accounts. A parked account is greyed and no longer offers a sign-in button, on the usage page and in the Insights re-authenticate banner, so it is never signed back in behind your back, matching what parking an account is meant to do.

## [2.1.0-beta.10] - 2026-08-14

> Fixes an upgrade that could fail with "AI Code Conductor cannot be closed" even with nothing running, and settles the rename: downloads now carry one name, and the first-run tour finally matches the brand.

### Changed
- Downloads now carry a single name. Releases used to attach every installer twice — once under the old product name and once under the current one — which made it unclear which file to take. Only AI-Code-Conductor-… is published now. If you are on 2.1.0-beta.5 or older, download this release by hand from the releases page: that build looks for the old file name and will not see the update.
- The first-run tour and guided setup now use the AI Code Conductor blue instead of the previous product's orange, so the logo no longer sits inside mismatched styling, and the "What's new" page shows the version you are actually installing rather than always saying 2.0.
- A Microsoft Store package is now built alongside the Windows installer — the first step towards listing the app in the Store.

### Fixed
- Upgrading could stop partway with "AI Code Conductor cannot be closed. Please close it manually and click Retry" — with the app shut down, after a reboot, and with no such program running anywhere. The message was misleading: it appears when the installer cannot run the previous version's uninstaller, not because anything is open. Installations in that state are now detected and repaired silently, with nothing for you to do.
- Earlier renames could leave the app installed inside a folder named after the previous one, nesting a level deeper each time. The installer now recognises every folder name the app has shipped under, moves the installation to a clean folder, and removes the old tree. Your settings, data and resources folder are untouched.
- Security hardening: one file written during SSH session setup — the status-line helper — could follow a symbolic link planted in advance in the remote account's ~/.claude folder, redirecting where it was written. It is now created fresh and refuses to follow a planted link, matching the protection already applied to the token files written beside it. Reported privately.

## [2.1.0-beta.9] - 2026-08-13

> Each account can hold its own claude.ai web session, signed in through a dedicated per-account browser and kept fully separate. This is also a security release: two local-attacker vulnerabilities are fixed, with their advisories published alongside it.

### Added
- Each account can now hold its own claude.ai web session, signed in through a dedicated per-account browser. Signing in to one account no longer disturbs another account's web session, so your accounts stay fully separated end to end.

### Changed
- The Settings "Check for Updates" panel and the bottom-bar update button now show which version and release channel you are currently running, so your installed build is visible at a glance whether or not an update is available.

### Fixed
- Security: the app's local Conductor service — which lets a running session take host screenshots and drive the vision browser — used a single token shared across every session on your computer, and trusted an unverified field in each request to say which session was calling. Another local program that obtained that token, or a second session, could impersonate any session and drive those tools. Each session now gets its own token that is cryptographically bound to it, and the app identifies the calling session from the verified token rather than the request; the shared value became a signing key that is never handed out and is rotated on upgrade. Fixed in this release; 2.1.0-beta.8 and earlier are affected. Advisory GHSA-q83v-phcc-hgv4, severity high: it requires another program or session running locally that can reach the app's local service.
- Security: when the app sets up a remote SSH session it writes small token files into the remote account's ~/.claude folder. If that folder already existed it was not re-secured to your user only, and the token writes could follow a symbolic link planted in advance — letting another user on the remote host read the tokens or redirect the write. The folder is now always secured to your user, and the token files are created fresh and refuse to follow a planted link. Fixed in this release; 2.1.0-beta.8 and earlier are affected. Advisory GHSA-phr3-g5qh-q4v5, severity medium: it requires another user account on the remote SSH host.
- Windows: SSH sessions no longer fail to start when your global SSH configuration enables connection multiplexing (ControlMaster). Windows' built-in OpenSSH does not support it, which could make every SSH session in the app error out before it connected; the app now turns multiplexing off for its own SSH sessions on Windows and leaves your configuration untouched on macOS and Linux.

## [2.1.0-beta.8] - 2026-08-11

### Added
- Accounts can now be marked inactive. An inactive account still appears in the accounts list but cannot be chosen when you switch a session's account — it shows up greyed and labelled "inactive" in the switch menus. Toggle it from Settings › Accounts; every existing account stays active, and the primary account is always active. Handy for parking an account you are not using without removing it.

### Changed
- Windows releases are now digitally code-signed. The installer and the app carry a verified publisher, so Windows no longer shows an "unknown publisher" warning when you download or install them. SmartScreen may still show a reputation prompt for a little while — trust accrues to the new certificate with each install. Update downloads continue to be verified by SHA-256 checksum, as before.
- The product mark now appears in the title bar, and in the empty window before you start a session in place of the old terminal-prompt placeholder — so the app carries the same mark as its icon and start-up screen throughout.
- Terminal-only ("no AI") sessions now have a Restart control in the bottom-right, the same as Claude sessions — restart re-runs the shell without disturbing your other tabs.
- The per-session Draw button is now labelled Canvas and opens the same freehand sketchpad as before. This is the groundwork for an upcoming agent-assisted review surface; there is no change to how you sketch today.

### Fixed
- Terminal-only sessions no longer show a context-usage percentage on their sidebar card. A shell session has no reliable context signal, so the number could be stale or borrowed from another session; it is hidden until terminal integration improves. The model and mode still show.
- Switching a session's account no longer leaves a usage limit from the previous account showing. Changing accounts mid-session could keep the old account's exhausted-usage state painted on the meter until you restarted; the session now clears it on switch.

## [2.1.0-beta.7] - 2026-08-10

> A security release. Two high-severity local-attacker vulnerabilities are fixed — their advisories publish alongside this release — and every open dependency security alert on the project is cleared.

### Changed
- Security: updated bundled third-party components to clear every open dependency vulnerability alert on the project, including the id generator, URI parser, network-address parser, diagram renderer and HTML sanitiser the app ships. All updates are minor or patch releases, and the full test suite passed unchanged.
- A privacy policy now ships with the project, naming exactly what personal information the app handles and where it goes.

### Fixed
- Security: the token that protects the app's local browser-control service was stored in a file other users of the same computer could read. On a shared machine, another local user who read it could connect to that service and run code inside the app's embedded browser. The token file and the folder holding it are now created private to your user account and repaired to private if found otherwise, the token is rotated on upgrade, and the per-session files that carry it are private too. Fixed in this release; 2.1.0-beta.6 and earlier are affected. Advisory GHSA-58r3-f5hg-vxcq, severity high: it requires another user account on the same machine.
- Security: files the app saves safely (write-then-swap) used a predictable temporary name in a location where another local user could plant a link in advance, redirecting the write — including the sign-in credential file — and defeating its private-file protection. Staging names are now unpredictable, the swap refuses to follow planted links, and credential copies go through a hardened path. Fixed in this release; 2.1.0-beta.6 and earlier are affected. Advisory GHSA-pwfw-2ggq-569x, severity high: it requires another user account on the same machine.
- Windows: an Insights run could report itself as failed for no visible reason. Security software on Windows briefly holds a file open just after it has been written, and that could make saving the list of runs fail — more often when the machine was busy. Saving now waits a moment and tries again.
- Insights could get stuck insisting a report was already being generated when nothing was running, leaving restarting the app as the only way out. If saving the list of runs failed at the wrong moment, the app never cleared its "in progress" marker. That marker is now always cleared, however the run ends.
- The Saved Configs pin fix from the previous beta now also covers app launch: a pinned panel starts open, rather than pinned-but-collapsed, the first time the sidebar renders.

## [2.1.0-beta.6] - 2026-08-04

> The app is now AI Code Conductor, with a new icon, start-up animation and a rebuilt session setup dialog. Insights can also look at all of your accounts at once: one click generates every account's report and then a combined report that compares them side by side.

### Added
- The app is now called AI Code Conductor. Only the name and the artwork change: your saved configs, settings, history and accounts stay exactly where they are, the app installs and updates over the top of your existing copy, and nothing needs migrating.
- A new app icon, and a new start-up screen that draws the mark as the app loads.
- The session setup dialog has been rebuilt around the two questions that actually matter: what you are launching (Claude Code, Codex, or a plain terminal) and where it runs (this PC or over SSH). The rest of the form follows from those answers instead of showing every field at once, so a plain terminal no longer asks you about models and a Codex session no longer shows Claude-only options. Starting model and starting effort are now explicit choices, listed newest first.
- Insights: a "Run all" button generates a report for every signed-in account and then one combined cross-account report. It lines every metric the accounts have in common up side by side, marks the best and worst account for each, totals the counts, and adds a written comparison — where your work actually lives, which account is costing you the most friction, and what one account should copy from another. It appears once you have two or more accounts signed in; with a single account nothing changes.
- The combined report is kept alongside your normal reports and appears in the same dropdown as "All accounts", so you can go back to any earlier comparison. Each account's own full report is still generated and still there.
- The accounts view now tells you when each account will force you to sign in again — "Forced sign-in in 12 days" — and turns amber under a week, red under two days. It also offers "Refresh sign-in" on accounts that are working fine, so you can reset the clock at a convenient moment instead of finding out when something fails. The countdown deliberately tracks only the long-lived credential: the short one behind each session renews itself and is not shown, because showing it would look alarming for no reason.

### Changed
- A brand-new installation now carries the new name everywhere — the program folder, the executable you see in Task Manager, and the folders your data is kept in. Upgrading over an existing copy is unaffected: your data stays exactly where it is, and the app moves its own program folder across for you and clears the old one out.
- Downloads are now published under the new name as well. The previously-named files are still published alongside them, because existing installations look for that exact name when they check for updates — so updating keeps working either way.
- A terminal-only launcher no longer insists on a working directory, and the "run as administrator" wording now matches the platform you are on.
- Installed builds now enforce the same content restrictions the development build has always run under — an extra layer around anything the app displays, including text that comes from your repositories and sessions.
- The drawing canvas no longer fetches its fonts from the internet when you open it. They ship with the app, so it draws correctly offline and makes no outside requests.
- The in-app walkthrough screenshots have been retaken against the current app.
- A combined report never invents a number, and never claims two accounts measured the same thing unless they agree that they did. Where accounts describe a metric differently the report shows both wordings and stops ranking them, rather than silently treating one account's definition as the shared one. Totals appear only where adding up actually means something, and are dropped entirely when the accounts cover reporting periods of different lengths — each column shows its own period so you can see why.
- Metrics only one account reported now get their own section instead of being dropped. In practice that is most of them, and it is often the most interesting part: a tool or a kind of error that shows up in one account and nowhere else says more than a metric you already had side by side. Each account's top tools, languages and goals are carried into the comparison too.
- If the written analysis cannot be produced, you still get the measured comparison and the report says so rather than quietly leaving it out.
- While a cross-account run is in progress it reports which account it is on, and finishing accounts no longer pull the report you are reading out from under you.
- Generating the combined report costs roughly a tenth of what it did: it is now handed the comparison the app has already worked out rather than every account's full metric dump. That also makes it a better report, because the alignment is done before the analysis starts instead of during it.
- Generating Insights is far cheaper. Each analysis was quietly loading everything your account has configured — every connected tool server, every skill, your instruction files — into a job that only needed to read one report. Measured on a real setup that was about 193,000 words of context per account; it is now about 14,000. Nothing about the analysis itself changes.

### Fixed
- Security: the Insights page accepted a report identifier without checking it, and that identifier was used to build a file path — so a crafted one could point outside the Insights folder and read another file on your machine. Identifiers are now validated before they are used to build any path, both there and in the equivalent account-profile lookups. Fixed in this release; 2.1.0-beta.5 and earlier are affected. Advisory GHSA-rj3p-wqj3-p7w8, severity low: it needs something already running inside the app to make the request, and nothing in the app sends one.
- macOS, when upgrading by dragging the new app over: because the application has been renamed, the old "Claude Command Center" app is left behind in your Applications folder rather than being replaced. You can safely drag it to the Trash; your data and accounts belong to the new app. A brand-new install is unaffected.
- Pinning the Saved Configs list open now survives closing and reopening the app. The pin was being remembered correctly, but the list itself came back collapsed — so it looked pinned, with nothing under it, until you unpinned and re-pinned to bring it back.
- A pinned Saved Configs list can now be collapsed and expanded with its arrow. Previously pinning it also froze it open, so the arrow did nothing. Collapsing applies to the current session only — a pinned list starts open again next time you launch.
- Fixed: every button in the sidebar could end up announcing itself with the same label. That broke the guided tour and made the app significantly harder to use with a screen reader.
- Fixed: two of the tips could never appear, because they were waiting on activity the app never actually recorded.
- The accounts view now warns when two accounts are signed into the SAME Anthropic account, and explains why it matters: each time one refreshes, it invalidates the other, so they take turns mysteriously expiring. This is easy to cause by accident — sign one account in while your browser is still signed in as another and it happens silently.
- Signing an existing account back in now opens a tab labelled with that account, e.g. "Sign in: you@example.com". Previously the tab had no name at all for any account you had not manually renamed, which made it impossible to tell two of them apart when signing more than one account back in.
- Insights now tells you when an account needs signing in again, on the Insights page itself, with a button that signs it in. Previously an expired sign-in showed up as an unexplained "KPI extraction failed" and there was no way to tell which account was the problem — the report generated fine, so nothing looked broken, and the metrics simply never appeared. A combined cross-account report also no longer loses its written analysis just because the primary account is the expired one.
- Insights: when the analysis step fails, the report no longer just says "KPI extraction failed" with nothing to go on. The full reply is saved next to the report, and the actual reason is written to the log. Previously the result was discarded even when the work had already been paid for.
- Insights: the analysis result is read back much more tolerantly. Anything wrapped in explanation or code fences is now recovered instead of thrown away, which previously lost a complete and correct analysis. A result that arrives cut off part-way is still rejected rather than half-saved, so you never see a report built from a fragment.
- Multi-account: a report was able to compare itself against the wrong run — a combined cross-account report could be picked as the "previous run" for a single account, so the trend arrows were measuring against something unrelated. Comparisons now only ever pair a single account with its own earlier reports.

## [2.1.0-beta.5] - 2026-08-02

> A runtime refresh. The app now runs on Electron 43, with the terminal backend and the local database updated to match. No feature changes: this build exists so the beta channel is actually running what the beta line has been carrying.

### Changed
- Updated the application runtime to Electron 43, which brings a newer Chromium and Node.js underneath the app. A foundation update with no feature changes, carrying the browser and platform security fixes released with those versions.
- Updated the two native components the app depends on: the terminal backend that runs your sessions, and the local database that stores transcripts and usage. Both were rebuilt against the new runtime and exercised in a real launch before this release. Existing data is unchanged and nothing needs migrating.
- Updated the screen-capture component used when you attach a screenshot to a session.
- Updated the build pipeline that produces and publishes the installers. No effect on the application.

## [2.1.0-beta.4] - 2026-07-31

> Security fixes for the session-launch path, and 1M-context models now launch correctly on macOS. Recommended for everyone on the beta channel.

### Fixed
- Selecting a 1M-context model (Opus 1M) now launches correctly on macOS. The model name contains square brackets, which the macOS default shell treats as a filename pattern, so the whole launch command was aborted before the session started and nothing appeared to happen.
- Restoring a session on Windows no longer mangles the paths the app passes to Claude. The default data folder contains a space and the relaunch was splitting on it, which could silently drop per-session settings and turn the leftover text into an accidental first prompt.
- Extra command-line arguments set on a config can no longer override the flags the app manages for a session, including its per-session settings file. Certain spellings slipped past the existing check.
- Regenerating the changelog no longer fails when a comment in the source contains an apostrophe. Developer tooling only.

## [2.1.0-beta.3] - 2026-07-31

> Ctrl+V pastes into terminals — which also makes voice dictation and text expanders work — Check for Updates can install the update it finds, and a broad round of security hardening lands across the local tools server, the updater and the bundled dependencies.

### Changed
- Updated bundled dependencies to close 12 published security advisories, plus two more found while checking. No feature changes.

### Fixed
- Ctrl+V now pastes into terminals. Previously only right-click pasted: Ctrl+V was passed straight through to the session as a raw control code, which a shell happened to treat as its own paste command, while Claude ignored it entirely. Cmd+V, Shift+Insert and Ctrl+Shift+V work too, and if the clipboard has no text the app now says so instead of appearing to do nothing.
- Voice dictation and text-expander tools now work in terminals. Tools of that kind type into whatever is focused by copying text and sending Ctrl+V, so they were silently doing nothing in a Claude session — the same root cause as above.
- Settings -> Check for Updates can now install the update it finds. It used to only report that one existed, leaving you to hunt for the small Update pill in the bottom bar. Open sessions are still saved before the app restarts.
- Copying with Ctrl+Shift+C no longer fires for every open terminal at once, and no longer competes with a focused text box.
- Hardened the authentication check on the local Conductor server that Claude and Codex sessions use to reach the built-in tools. Its token check accepted some malformed credentials it should have rejected, and a crafted request could make the check do far more work than it needed to. Both are fixed. The server still listens only on your own machine, and no session behaviour changes.
- Session, config, team and agent-template identifiers are now generated with a cryptographic random number generator instead of a predictable one. Existing items keep the identifiers they already have and nothing needs migrating.
- The in-app updater now verifies every installer it downloads against the SHA-256 checksums published with the release, and refuses to run one that does not match. Previously it launched whatever it downloaded, with no client-side check on any platform. If a download fails the check it is discarded and you are told why, rather than the update silently doing nothing.
- Fixed a flaw in how a session's conversation transcript was located. A machine you opened an SSH session to could name a file outside the Claude projects folder — a private key or token elsewhere on your drive — and the app would open it and read its contents into that session's local transcript store. Transcript locations are now confined to the projects folder, and the status information a remote host sends is checked before it is used. Exploiting this needed you to connect to a host the attacker controlled, and the file contents stayed on your own machine. Advisory GHSA-hw7c-g5pw-w725.

## [2.1.0-beta.2] - 2026-07-29

> Resuming your work is far easier to read, your own Claude hooks now run in the app's sessions, and each config can set its own permission mode and CLI arguments.

### Added
- Each config can now set its own Claude permission mode and extra command-line arguments, instead of every session sharing one global setting.
- Sessions can be given a work name (renamed) independently of their config, so restored windows are recognisable at a glance. The startup "Resume previous sessions?" card is wider, lists each session on two lines so long names are not chopped, shows a count, and has a refresh button that picks up a session you restarted after launch.
- A development instance can now run alongside your installed copy with fully separate data, ports, and an amber DEV badge, so testing a change can no longer disturb your day-to-day sessions.

### Changed
- The Resume Conversation picker shown in the terminal is much easier to scan: it now fills the width of your window instead of being capped at a narrow column, leads each entry with a recognisable title (your session's work name when you renamed it, otherwise Claude's own summary of the conversation), and strips the slash-command markup that used to crowd out the actual content. Conversations that only showed "(continued session)" now show what they were about.

### Fixed
- Hooks you configure yourself now run in the app's sessions. The app was replacing the whole hooks block with its own, so hooks from your user settings or a project's .claude/settings.json never fired in an app session even though they worked in a plain Claude session in the same folder. They are now merged, so an app session behaves like a normal Claude session in that folder, plus the app's own hooks.
- The text cursor is visible and blinking again in shell terminals on Windows and macOS.
- Startup no longer freezes for roughly half a minute: two long synchronous sweeps during boot now run in the background.
- macOS: fixed the "A keychain cannot be found to store" error at launch, which was caused by the app redirecting your home directory away from your login keychain.
- Multi-account: sessions belonging to a signed-in account whose per-account project folder had been orphaned are recovered, so cross-account resume finds your conversations again.

## [2.1.0-beta.1] - 2026-07-17

> Experimental Linux support — Claude Command Center now runs on Linux as an AppImage, alongside Windows and macOS.

### Added
- Linux (experimental): download the AppImage, make it executable (chmod +x), and run it. Verified on Ubuntu 24.04 and Rocky Linux 10; needs a modern glibc (2.39+, i.e. Ubuntu 24.04+, Rocky 10+, Fedora 40+). Older distributions are not covered by this build yet.

### Changed
- The in-app updater and the vision browser tool now understand Linux. On Linux the vision tool needs a deb/rpm build of Chrome or Chromium — the Ubuntu snap build is sandboxed away from the debug port, so vision stays off there.

## [2.0.0-rc.2] - 2026-07-15

> Release Candidate 2: terminal scrolling holds your place during live output, and relaunch reopens every session under its saved account — the first community-contributed fixes.

### Fixed
- Scrolling up with the scrollbar or keyboard now holds your place while a session streams output. Previously only mouse-wheel scrolling was recognised, so any other way of scrolling up got yanked back to the bottom by the next burst of output.
- Relaunching the app reopens each session under the account it was closed with, instead of re-asking which account to use for every restored session.

## [2.0.0-rc.1] - 2026-07-10

> v2.0 Release Candidate 1: in-app updates work again, every signed-in account shows live usage, the stray blank browser window is gone, and a full dependency security refresh.

### Changed
- Security refresh: the one remaining vulnerable dependency (the WebSocket client used for browser automation) is patched, and the dependency audit is clean — 0 known vulnerabilities across the shipped tree.

### Fixed
- In-app update checks now find newer releases. Releases were being tagged against a stale commit, which mis-dated them so the updater never saw them; they are now tagged at the exact commit that was built, the updater scans the full release list, and it understands release-candidate versions.
- The all-accounts usage panel now shows live usage for every signed-in account — even ones you have not opened a session with recently. It quietly refreshes each account's short-lived key in the background, only for accounts with no running session or sign-in in progress. Your primary account is deliberately left untouched (its credentials are shared with Claude outside the app) — it shows last-known usage until you open a session.
- Codex sessions no longer double-count cached input and reasoning tokens in the statusline and Tokenomics — token counts and dollar costs for cache-heavy Codex sessions were inflated (input could read nearly double).
- Fixed a blank browser window that could appear on startup (and linger after closing the app) when the browser/vision tool was enabled. The automation browser is now kept off-screen and is reliably shut down together with the app.
- The automation browser no longer runs Chrome's first-run setup on every launch, which was touching the desktop shortcuts and making the Chrome icon flicker on OneDrive-synced desktops.
- Codex sessions: the context meter now shows how full the context window actually is (the last request against the window), instead of the session's lifetime token total — which pinned the bar red at ~100% on long sessions whose window was mostly free.
- Resumed sessions: after the resume replay finishes, the terminal geometry is re-confirmed and the view repainted — targeting the garbled overlay text (stray line fragments over the input box) that could appear and persist after resuming a session.

## [2.0.0-beta.6] - 2026-07-08

> The all-accounts usage panel is far more reliable — no more spurious "Sign in" or "HTTP 429" on accounts that are actually fine.

### Changed
- When a live refresh can't complete (rate-limit, a network blip, or a lapsed token), the panel keeps showing each account's last-known figures with their age, instead of blanking the card.

### Fixed
- The account usage panel no longer loads every account at once, which was triggering rate-limit (HTTP 429) errors on perfectly valid accounts. Accounts now load staggered, with automatic retry, so a transient rate-limit recovers on its own instead of showing an error.
- Accounts that are still signed in no longer show a false "Sign in" prompt. Between sessions only the short-lived access token lapses — the account stays logged in — so the panel now shows the last-known usage (or a quiet "open a session to refresh") instead of a misleading Sign in button. A real Sign in appears only when an account genuinely has no credentials.

## [2.0.0-beta.5] - 2026-07-07

> Two SSH fixes: Conductor tools and the session status line both work again inside SSH sessions.

### Fixed
- Conductor tools (host screenshot and browser vision) work in SSH sessions again. The reverse tunnel that carries them was connecting to the wrong loopback address on the host — the server listens on IPv4 while the tunnel was landing on IPv6 — so remote sessions saw the connection close immediately. It now targets the right address.
- The session status line shows again in SSH sessions on Linux hosts (model, context, cost, and rate limits). Over SSH, Claude runs the status-line command without a terminal of its own, so the update was being dropped; it is now routed back through the session's terminal.

## [2.0.0] - 2026-07-02

> Claude Command Center 2.0: a guided first-run setup, an in-app Ask Command Center guide, a modernized engine, and a privacy pass that keeps every Claude config write per-session.

### Added
- New guided setup on first launch (and once after this upgrade): pick your theme, point the app at your Claude install, see how accounts and GitHub connect, and switch on exactly the features you want. Every step shows real state from your machine, and nothing runs or gets enabled without you seeing it.
- A live guided tour follows setup: coach marks anchored to the real app walk you to your first session. The old static tour and the stack of first-launch popups are retired.
- Ask Command Center: the ? button in the sidebar opens a searchable guide to every feature, or hands your question to a Claude session primed with the app's docs so you can ask in plain language.
- Built-in tools are now under your control: a master switch plus per-tool toggles (vision, code review, host transfer) in setup and Settings, enforced everywhere a session spawns: local, SSH, and Codex.
- The status line has a real master switch: turn it off and the app stops injecting it into sessions entirely, local and SSH alike.
- Codex support is now clearly marked Beta with its own master switch, and you can sign in during setup with the browser flow or an API key. Off means off: Codex configs are marked disabled (with the reason) and will not launch while the master is off.

### Changed
- Engine modernization: Electron 42, React 19, xterm.js 6, Vite 7, and TypeScript 6. A faster renderer on a current Chromium security baseline.
- Privacy pass: the status line and the Conductor MCP server are now delivered per session instead of being written into your global Claude config, legacy global entries are cleaned up on boot, per-session SSH files are swept on close, and your ~/.claude/CLAUDE.md is never touched.
- Claude Code 2.1.195+ renders its questions with clickable answer options; inside the app a stray terminal click could select one, so they are switched off by default and answers stay keyboard-driven. Opt back in under Settings, General, Terminal.
- Sentinel and cloud-agent permissions now default to off. Both are opt-in, with the ask made plainly during setup, so nothing spends tokens or grants permissions without your say-so.
- Agent Hub is reorganized into Tasks, Pipelines, and Library, with clearer first-run guidance.
- Insights reliability round: runs compare against the previous run of the same account, concurrent runs are locked per account, failed runs and KPI-extraction failures are surfaced instead of silently vanishing, and KPI extraction no longer bypasses permissions.
- Security hardening: external links open only over verified https, config files are validated as they load, the vision browser's debug port binds to loopback only, memory files are contained against symlink escape, and all known dependency vulnerabilities are resolved (undici, ws).

### Fixed
- Alt+V now pastes copied image files (not just screenshots), with inline feedback when the clipboard has no usable image.
- Each rate-limit window in the status line shows its own reset time (5-hour and weekly), instead of one shared timestamp.

## [1.5.45] - 2026-06-14

> Sentinel's status dot now only turns amber when a finding actually affects your setup.

### Changed
- The Sentinel status dot is graded by reachability: amber means a compatibility finding reaches the accounts and features you actually use, and a calm grey state shows once you have reviewed the report.

## [1.5.44] - 2026-06-14

> Light theme: Claude sessions now start with a matching light terminal theme.

### Fixed
- When the app is in light mode, new Claude sessions are told about it (via the standard COLORFGBG signal) so Claude picks its light terminal theme instead of rendering dark-on-light. Applies to newly started sessions.

## [1.5.43] - 2026-06-14

> The Copilot AI-credits meter now tracks your current billing cycle, with a progress bar.

### Changed
- The Copilot chip counts credits used in the current billing cycle instead of a lifetime total, and gains an inline progress bar matching the Claude rate-limit meters.
- Copilot meter configuration (including your plan's included-credits cap) now lives in Settings, Status Line, next to the other status-line elements.

## [1.5.42] - 2026-06-13

> GitHub settings, round two: re-auth now targets the right account and asks only for what it needs, and a Copilot usage meter lands in the session status strip.

### Added
- A Copilot AI-credits meter in the session status strip, with a toggle to show or hide it.

### Changed
- Re-auth requests are additive and minimal: the scopes asked for are derived from the features you actually have enabled, so you never grant more than the app uses.
- GitHub settings are recomposed account-first, with one consistent panel per account and an app-wide group for the settings that span accounts.

### Fixed
- Re-authenticating a GitHub account now works per account and per auth kind (OAuth, PAT, or gh CLI), fixing the long-standing bug where re-auth could target the wrong profile or silently do nothing.

## [1.5.41] - 2026-06-13

> Copy the Sentinel compatibility report to your clipboard.

### Added
- The Sentinel report gains copy buttons: copy the whole report or a single finding, ready to paste into an issue or a Claude session.

## [1.5.40] - 2026-06-13

> Fix: conversations recorded outside an app session now show up in the resume picker.

### Fixed
- The resume picker now surfaces and resumes conversations that were recorded without a companion log folder (for example, work done directly in a repo before or outside the app's sessions). Existing conversations are backfilled on the next scan.

## [1.5.39] - 2026-06-13

> GitHub settings are rebuilt around your accounts, plus a batch of fixes: first-launch prompts no longer stack, the Sentinel watcher no longer hangs, and the Tokenomics cost donut is cleaner.

### Added
- GitHub settings are rebuilt around accounts. Each connected account gets its own panel with a Status and permissions tab and a Features tab, so you can see and control each account on its own terms instead of one flat list.
- A new "Features for all accounts" master section sits above the per-account panels: each feature shows a tri-state (on, off, or mixed across your accounts) with an "apply to all accounts" action to set it everywhere at once.
- Per-account feature toggles. Turn features like active PR, CI, reviews, linked issues, notifications, and AI credits on or off for each account independently, with the state held per account.

### Changed
- Honest re-auth surfacing. When a feature is switched on for an account whose token cannot power it yet, the account now shows a clear "switched on but needs re-auth" state instead of silently doing nothing, and a collapsible "what each feature needs" reference shows which scopes the features you enabled require.

### Fixed
- First-launch prompts (logging consent, What's New, setup steps) now appear one at a time in priority order instead of stacking on top of each other.
- Sentinel's background compatibility analysis no longer hangs on a shared login or leaves stray claude processes behind: it now runs against one of your signed-in accounts and tears the whole process tree down on timeout.
- The Tokenomics cost donut no longer shows a "<synthetic>" slice; those system rows are labelled and excluded from the cost breakdown.

## [1.5.38] - 2026-06-12

> Memory is now a full dashboard -- KPIs, charts, ranked projects, drilldown, and a reading drawer -- and the Sentinel status dot is now a labelled chip.

### Added
- The Memory page is rebuilt as a dashboard: a KPI strip (memories, projects, total size, stale over 30 days, and an index-health KPI that replaces the old warning banner), an activity area-chart, and a type donut for the whole store.
- Ranked project list with staleness dots, index warnings, and live-session chips. Click a project to drill in: a sortable memory table plus a sessions rail where live sessions jump straight to the terminal and recent sessions deep-link into the Logs viewer.
- New reading drawer for distraction-free memory reading, and the search view restyled to match.

### Changed
- The Sentinel status dot is now a persistent labelled "Sentinel" chip, so the compatibility watcher is easier to find.

### Fixed
- The memory scanner no longer warns about custom frontmatter fields or types, silencing hundreds of spurious warnings on stores with custom metadata while keeping real signals.

## [1.5.37] - 2026-06-11

> New: Sentinel -- an opt-in watcher that flags when a Claude Code update might affect the app, plus Memory and Hooks fixes.

### Added
- Sentinel (opt-in, fail-open) detects Claude Code version changes on startup, checks the CC changelog against the app's compatibility assumptions, and surfaces findings in a status dot plus a panel. It proposes model and effort registry fixes you apply yourself (never automatically) and reports compatibility for everything else. Toggle it in Settings, Sentinel.

### Changed
- A new hot-reloadable model and effort registry replaces around ten hardcoded model-identity sites, so an unknown or brand-new model now gets a colour, a label, and flagged pricing instead of vanishing.
- Memory scanning now runs off the main thread, so opening Memory on a large store no longer stalls the UI. Spurious "unknown frontmatter field" warnings for the standard metadata block are gone, and the close button is back on sessions.

### Fixed
- Raised the hooks request body cap from 256 KiB to 4 MiB so large file-edit events are no longer dropped from the activity feed; the first oversized payload per session is now logged.

## [1.5.36] - 2026-06-11

> Three big workstreams land: Logs v2 (a chat-transcript viewer), a ground-up Tokenomics rebuild, and the removal of the permission tray.

### Added
- Logs v2: a clean-slate transcript system. The app indexes Claude's own conversation transcripts and renders them back as a readable chat with a timeline rail and full-text search. Restart and relaunch now resume the conversation you were actually in, worktree-aware. The old logging stack is removed.

### Changed
- Tokenomics is rebuilt on its own background indexer that reads ALL transcripts including subagent and sidechain files (the old scan missed around half the events), dedups globally, computes cost at query time from live pricing, attributes by config, and opens instantly with an indexing state and a green nav badge.
- Heads up: life-to-date spend will read LOWER than the old page. The old ledger priced Opus at a stale 3x tier and double-counted statusline costs. The new number is the deduped API-equivalent at current pricing.
- Security: dependency updates (vitest, ws, hono, tmp). The Electron 38 to 39 upgrade is deferred to a dedicated task.

### Fixed
- The permission tray has been removed. Claude's permission notifications are generic and fire for auto-approved subagent tools, producing phantom cards no heuristic could filter. The session attention pulse is kept.

## [1.5.34] - 2026-06-09

> Fix: closing all your sessions now reliably means no resume prompt on the next launch -- even when you update via the installer.

### Fixed
- The "Resume previous sessions?" prompt no longer offers sessions you already closed. Your open sessions are now saved continuously as you open and close them, so the next launch always reflects what was actually open -- even if the app was force-closed by an external installer or a crash (which previously left a stale list and re-offered phantom sessions). Close everything, and there is nothing to resume.

## [1.5.33] - 2026-06-09

> Fable 5 support -- Anthropic's new flagship model (the tier above Opus) is now a first-class choice across the app.

### Added
- Fable 5 is now selectable in the session model dropdown and the agent/config model pickers. It is Anthropic's most capable model (the tier above Opus) and runs roughly 2x faster than Opus.
- Tokenomics now prices Fable 5 correctly out of the box ($10/$50 per 1M tokens) and gives it its own colour in the model breakdown, so Fable spend is tracked and shown distinctly. LiteLLM live pricing still wins when reachable.

## [1.5.32] - 2026-06-06

> Critical fix: importing your existing logs no longer freezes the app. Tested against a real 16 GB log set, with live progress, a completion notice, and safe interruption.

### Added
- A notice now appears when the log import finishes, wherever you are in the app, with a View report shortcut to the reconciliation report. If anything failed it says so clearly, and nothing is deleted.
- Closing the app while a log import runs now asks first. Quitting is safe: the import stops cleanly and continues from where it left off the next time you run it.
- New startup choice for saved sessions: Resume or Don't open. You are no longer forced to resume your saved sessions on every launch.

### Fixed
- Importing existing logs no longer freezes the app. The import now runs entirely in the background logging worker, streams the data in small pieces, keeps the app fully usable throughout, and shows live progress. Verified end to end against a real 16 GB, 990-session log set.
- An interrupted log import is now safe by design: anything already imported stays, the interrupted session is automatically redone on the next run, re-runs skip completed sessions instantly, and the permanent space reclaim stays locked until an import completes 100% cleanly.
- The per-session Logs pane no longer goes blank after running /clear in a session. The replay now keeps the full history scrollable and marks where the screen was cleared with a divider. Your captured logs were never lost; this was purely a display issue.

## [1.5.31] - 2026-06-05

> More accurate per-account cost tracking under the hood, plus a clearer warning in the account attribution tool.

### Changed
- Per-account cost tracking is now anchored to a stable account id captured when each session starts, so your usage stays attributed to the right account even if you later rename that account or change its sign-in email.
- Daily cost totals now keep a per-account breakdown, so your per-account spending history stays correct over time even as older session details age out.

### Fixed
- The account attribution tool now explains that its email suggestions come from a history that records one sign-in at a time, so they can be wrong for a setup that ran several accounts at once. Double-check each before applying, or mark a group as mixed.

## [1.5.30] - 2026-06-04

> Critical multi-account stability: upgrades no longer disrupt a running session memory, and your last-used account survives a crash.

### Fixed
- Upgrades no longer disrupt session memory. A session left running across an app update could end up pointing at an old per-session home that the update had cleaned away, so on resume it looked like it had lost its memory. The update now keeps those old homes and re-points them at your shared memory store, so resuming or switching accounts across an update always reaches the same memory. No data was affected, your memory is shared as designed.
- Your last-used account now survives a crash. The account you pick for a session is saved to disk immediately instead of only on a clean close, so after an unexpected shutdown a session still defaults to the account you last used for it.

## [1.5.29] - 2026-06-04

> Keeps your Claude login working in scripts outside the app, read each session effort and fast mode at a glance, with a tidier, more consistent dark and light theme, plus a new terminal-health view in the Conductor diagnostics.

### Added
- Session cards now show a colour-coded effort pill (Low through Ultracode) in the top-right, tinted from green to red as effort rises, so you can read each session effort level at a glance without opening it.
- Session cards now show a lightning bolt when a session is running in Fast Mode, so you can spot fast-mode sessions at a glance. It appears only while Fast Mode is actually on and clears the moment you turn it off.
- The Conductor diagnostics console gained a PTY integrity section with live terminal metrics per session (bytes received, resize events and width desyncs) to help track down terminal display glitches.

### Changed
- The effort pill now waits for live data before it appears, so a card no longer briefly shows a stale or default effort (for example XHIGH) before the real level loads. A restarted session stays calm until its new effort is known.
- Tidied the session cards by removing the small leading dot. It only showed grey when idle and duplicated the status pill already shown on the right.

### Fixed
- Running the Claude CLI outside the app (e.g. claude -p in your own scripts) no longer breaks authentication. The app now keeps your real Claude login in lockstep with your main account, so a token refresh inside a session never leaves your outside scripts on a dead login. Only your main account's token is mirrored, and only when both sides are still that account.
- Themed the Settings pages and the top and tab bars to match the rest of the app, removing the leftover near-black backgrounds and making dark and light mode consistent throughout. The window background now follows the theme instead of staying dark in light mode.

## [1.5.28] - 2026-06-02

> Per-account statusline stats, settable account colours, and the account follows a mid-session sign-in.

### Added
- Set a colour for each account in Settings that sticks, so you can tell your accounts apart at a glance.

### Fixed
- Each account now shows its own usage and rate limits in the statusline. Previously the usage numbers could briefly show another account figures.
- When you sign in to a different account inside a session, the account name and colour now follow the new account.
- Your captured main account now shows its email instead of a generic placeholder name.

## [1.5.27] - 2026-06-02

> Per-session account isolation, plus a safety backup of your Claude config taken before anything runs.

### Added
- Safety backup: on first launch the app snapshots your existing Claude login and settings to a backup folder before the multi-account feature does anything, so your original login is always recoverable.

### Fixed
- Two sessions running the same account are now fully isolated. Previously they shared one login on disk, so signing into a different account in one session changed the other and could overwrite the saved account. Each session now gets its own private home.

## [1.5.26] - 2026-06-02

> Multi-account is always on and clobber-proof: your accounts are protected and signing in never overwrites your main login.

### Added
- No on/off switch any more. On first run your current Claude login is captured into a protected account, and every session runs under a saved account, so you are multi-account ready from the start.
- New account detection: run /login as a different account inside a session and the app offers to add it as a separate named account, keeping your original account intact.

### Changed
- The Accounts list shows every account the same way, with the captured original marked as primary (and never deletable).

### Fixed
- Your main login can no longer be overwritten. A session never runs on the bare global login, so running /login in a session can no longer replace the account you are signed in with globally.

## [1.5.25] - 2026-06-01

> Sessions now genuinely run under the account you choose, with no impact on your other tools.

### Changed
- Zero degradation to your other tools: each account home mirrors your real home, so git, ssh, npm and the rest behave exactly as before. Only the Claude account is private; your memory and history stay shared.
- Cleaner session cards: removed the redundant right-side dots. The account colour dot stays next to the account name.

### Fixed
- Added accounts are now truly isolated. Previously only the credentials were separated, not the account identity, so a session could still run as the wrong account. Each added account now runs under its own private home, so the account you pick is the account Claude uses.
- One-time after this update: re-run /login once per added account so it re-establishes its isolated login.

## [1.5.23] - 2026-06-01

> Pick the account a session runs under when it starts, and a clearer Accounts list.

### Changed
- Account is now chosen when a session starts, not saved on the config. The first time a session launches you pick which account it runs under, so the account stays a live choice rather than a buried setting.
- The Accounts list in Settings now shows each account by its email, with a clearly labelled Name field below it to give the account a friendly label. Add and remove accounts as before.
- The start-session account picker now shows the friendly name you gave each account, including your default account.
- Added the independent-project disclaimer to the startup splash screen.

### Fixed
- If you run /login inside a session and change account, the status strip, session card and statusline now update to the new account (previously they stayed on the account the session started with).
- You can now switch a session between your Default account and a single added account from the status strip (previously this needed two added accounts).
- Removed the leftover Setup Statusline command from existing setups.

## [1.5.19] - 2026-06-01

> Run multiple Claude accounts in the app: add accounts, switch per session, keep them isolated.

### Added
- Multiple accounts: add a second or third Claude account and run different sessions under different accounts. A first-run prompt walks you through it, and you can manage accounts anytime in Settings then Accounts.
- Switch a session to another account from the status strip pill or the right-click menu (it respawns and resumes under the chosen account). Signing in or out of an added account never touches your other accounts.

### Changed
- The status strip shows which account a session is using, and the account chip now resolves correctly for single-account users.
- Effort level now reflects live /effort changes in the status line, and you can toggle the Effort and Account elements in Statusline settings.
- Removed the Mode pill from the status strip (use Shift+Tab to change permission mode) and the redundant Setup Statusline command.

## [1.5.18] - 2026-05-31

### Changed
- Permission tray no longer shows a card for the session you are currently viewing (Claude prompts you right there). The card appears if you switch to another session while the prompt is still waiting.
- Added a footer note clarifying this is an independent project, not affiliated with or endorsed by Anthropic.

### Fixed
- Permission cards now reliably show which tool and command Claude is asking about, even when several tools run at once.
- Permission cards are now mouse-only: they never steal keyboard focus or interrupt your typing, and a stray Enter or Escape can no longer action a card.

## [1.5.17] - 2026-05-31

### Added
- Each card has Go to session and Ignore; a Settings toggle disables the tray.

### Changed
- Permission tray now surfaces only genuine prompts Claude is blocked on, honoring your Claude settings (no more cards for auto-approved commands).

## [1.5.16] - 2026-05-30

### Added
- Permission tray: approve or deny any tool request from one place, across all sessions

### Changed
- Attention indicator no longer re-fires when you revisit a session

### Fixed
- Effort level now shows permanently in the status line
- Settings toggles no longer overlap their labels

## [1.5.15] - 2026-05-29

> Removes the per-session account alias feature. Showing which Claude account a session is on is not reliable without isolating each session's config (which would fragment your shared memory and settings), so the alias label on session rows, the right-click Account tagging, and the Settings account-alias list are gone. Per-account spend tracking on the Tokenomics page is unaffected.

### Changed
- Removed the session account-alias feature: the alias label on session rows, the right-click 'Account' tagging menu, and the Settings account-aliases list. Claude exposes no reliable per-session account signal (it is global / last-login only), so the labels were frequently wrong whenever more than one account was in use
- Tokenomics per-account spend (the Account filter and group-by-account view) is unchanged -- it uses a separate ledger-side mechanism, not the live session label

## [1.5.14] - 2026-05-29

> Polish pass: the session duration in the status strip now reads as hours and days past an hour (no more '1731m 38s'), the Permission Attention Tray stops false-flagging safe commands, and sessions whose saved folder no longer exists open in your home directory instead of dying on launch.

### Fixed
- Status strip: session duration rolls up to hours past 60 minutes and days past 24 hours, showing two units max (e.g. '1d 4h'). Long-running or resumed sessions no longer show an unreadable raw-minutes count
- Permission tray: `git push --force-with-lease` (the safe push form) is no longer flagged as a high-risk force-push, and `sudo` detection only fires when sudo is the command being run -- not when it appears inside a quoted string or a path like /etc/sudoers
- Sessions with a working directory that no longer exists (a deleted worktree, an un-cloned repo, a demo path) now fall back to your home directory instead of exiting immediately with '[Process exited with code 1]'

## [1.5.13] - 2026-05-29

> Day-two Opus 4.8 polish: Ultracode effort level (xhigh + automatic dynamic workflows), a global Disable Claude Code dynamic workflows toggle in Settings > Security, and new tour + tips entries for the Permission Attention Tray and Dynamic Workflows so they actually show up in /help.

### Added
- Effort dropdown: **Ultracode** option added. Sets `--effort ultracode` so Claude Code (2.1.154+) automatically plans dynamic workflows for every substantive task. Resets when you start a new session
- Settings > Security: **Disable Claude Code dynamic workflows** toggle writes `disableWorkflows: true` into the per-session Claude settings so workflows are off for newly spawned sessions. Applies on next spawn; existing sessions keep their setting
- Tour: dedicated **Permission Attention Tray** step covering the high-risk Bash patterns, the 50-entry cap, and how the gateway intercepts before Claude runs the command
- Tour: dedicated **Dynamic Workflows** step covering the three ways to invoke (workflow keyword, Ultracode, /deep-research), the /workflows progress view, the 1000-subagent cap, and the global disable

### Changed
- Tips: new entries for the Permission Tray and Dynamic Workflows so the contextual tip system surfaces them after first use

## [1.5.11] - 2026-05-29

> Opus 4.8 lands as the new default, with Extra high effort and a Fast mode toggle (2.5x speed at 2x cost). The Permission Attention Tray from v1.5.10 is now actually wired -- v1.5.10 shipped the toast stack but the hook injection was disabled, so no toast ever fired; v1.5.11 fixes the wiring and ties it to Claude Code's real PreToolUse hook.

### Added
- Opus 4.8 default: new Claude sessions land on Opus 4.8 (Anthropic's newest model, released 2026-05-28). The model dropdown uses the `opus` alias so the default stays current as Anthropic releases new versions
- Effort levels: Extra high (xhigh) and Max added to the Session dropdown; Opus 4.8 supports xhigh as its hardest-task setting
- Fast mode toggle for Opus 4.8: 2.5x speed at 2x cost ($10/$50 per 1M tokens vs standard $5/$25). Tokenomics tracks Fast spend through a separate `<model>-fast` pricing row

### Changed
- Tokenomics: hardcoded fallback pricing for Opus 4.8 + 4.7 ($5/$25 standard, $10/$50 fast). LiteLLM live pricing still wins when reachable

### Fixed
- Permission Attention Tray wiring: v1.5.10 had injectHooks disabled and the gateway only matched a 'PermissionRequest' event Claude Code never fires. v1.5.11 re-enables hook injection per Claude session, ties the gateway to the real PreToolUse hook for Bash, and updates the disposition rule so the tray only fires for the high-risk patterns (rm -rf, sudo, force-push, dd, mkfs, chmod 777, fork bombs)

## [1.5.10] - 2026-05-28

> V2 UX uplift across Tokenomics, Insights, Logs, Settings, and Agent Hub -- plus a new Permission Attention Tray for high-risk Bash prompts. Insights drops its iframe and renders natively, Logs paginates large buffers, and Tokenomics gains a Project / Account / Model group-by lens.

### Added
- Permission Attention Tray: high-risk Bash commands (rm -rf, dd, mkfs, force-push, etc.) now stack as toasts in the top-right corner. Keyboard shortcuts let you approve or reject without scrolling back to the prompt; auto-allow handles read-only commands transparently
- Tokenomics: new Group by lens (Project / Account / Model) pivots the breakdown panel + sessions table without re-running anything

### Changed
- Insights: native renderer replaces the iframe + injected dark theme CSS, so the report loads faster, follows your theme cleanly, and inherits the V2 surface tokens
- Logs: chunked virtualization (500 entries per page with a Load older button) plus incremental filter diff -- big session logs no longer freeze the UI
- Settings and Agent Hub: V2 primitive pass (StatusDot, MetricChip, SectionLabel, Kbd) and accent-token rails for tab + filter selection
- TitleBar and Session Status Strip lifted onto the V2 raised-surface tier so they read as a single instrument cluster against the chrome below

### Fixed
- Cloud agent status colours now go through semantic tokens; status dot uses the StatusDot primitive (no more broken hex+alpha concat on the box-shadow)

## [1.5.9] - 2026-05-27

> Account labels are now user-managed -- you set them once in Settings and tag any session by right-click. The v1.5.7 auto-detected email chip was structurally unreliable (the field it read is global, not per-session) and has been removed.

### Added
- Settings > General > Account Aliases lets you keep a short list of email + alias rows; right-click any session in the sidebar to tag it with one. The alias shows after the project name in non-bold text

### Fixed
- Removed the per-session account-email chip from the session header and status strip -- it was reading a global file and could display the wrong account when you switched logins in another session
- Use this repo: clicking on a freshly-spawned session now persists correctly instead of silently doing nothing (regression introduced in v1.5.8 where the session state had not yet been flushed to disk before the IPC write)

## [1.5.8] - 2026-05-27

> Three bug fixes: 'Use this repo' in the auto-detect banner now persists across restarts and skips the Settings detour when you are already authed; the Codex MCP server's 'Session not found' 404 now logs diagnostics and returns an actionable recovery message.

### Changed
- Conductor MCP /messages 404 now logs the requested transport id, active-transport count, sample ids and user-agent, and returns a multi-line recovery message instead of a bare 'Session not found' (helps when Claude reports the Codex review tool as unavailable mid-session)

### Fixed
- Clicking 'Use this repo' in the auto-detect banner now writes the repo to the parent saved config (not just the live session), so the selection survives an app restart
- When at least one GitHub auth profile already exists, 'Use this repo' enables the integration in place and auto-picks a matching profile by repo or username -- no more bounce to the Settings tab

## [1.5.7] - 2026-05-27

> Your account email is back in the status line and session header -- coloured per account -- and you can now pin a fixed colour to any account in Settings. The Update pill also appears on its own now, without needing a restart.

### Added
- Assign a fixed colour to any account email in Settings > General > Account Colours. Detected accounts are listed automatically, or add one manually; the chosen colour tints that account's email everywhere it shows

### Changed
- The app now re-checks for updates periodically and when the window regains focus, so the Update pill appears on its own instead of only after a manual restart

### Fixed
- The active account email is shown again in the per-session status line and the session header, coloured per account -- it was dropped during the V2 shell refactor

## [1.5.6] - 2026-05-26

> Identity colours now span the full hue wheel so sessions are instantly distinguishable, the GitHub panel slides in when shown, and a few first-launch papercuts are fixed.

### Changed
- Identity colours are re-tuned across the whole colour wheel (blues, teals, greens, ambers, oranges, roses, purples) so saved configs and active sessions are instantly distinguishable in the left rail, tabs, and inactive dots -- not all variations of purple
- The GitHub panel now slides in and fades when shown, and the collapsed floating logo button fades in (both respect reduced-motion)

### Fixed
- The Claude service-status pills (Code / Claude.ai) now appear immediately on launch instead of staying blank until the first background poll minutes later
- Pasting an image with Alt+V now works on the first try -- previously the first attempt after copying could report 'no image detected' until you typed something (a Windows clipboard timing quirk)

## [1.5.5] - 2026-05-26

> Bottom-region rework from UAT: the per-session status line now sits directly above the command rows, CLI/version is a slim status bar at the bottom-left, and the GitHub panel ends above the command rows with a floating logo button when collapsed.

### Changed
- The per-session status line (model, tokens, context, rate limits) and the Mode / Model / Compact / Restart controls now sit directly above the command rows, where the old context bar lived
- CLI, version and channel are now a slim global status bar pinned to the bottom-left of the window, spanning the full width -- separate from the per-session status line
- When the GitHub panel is collapsed it is now a floating GitHub-logo button in the top-right corner instead of a thin vertical bar (with a coloured hover)
- The update notification is no longer duplicated. The large 'Update Available' card is gone; the status-bar Update pill gently pulses when an update is ready
- Command chips and the Mode / Model / Compact / Restart controls restyled into one consistent set; the model name shows properly and Restart is set apart

### Fixed
- The GitHub panel no longer stretches down past the status line and command rows. It ends above them, beside the terminal
- The 'New: GitHub sidebar' onboarding popup no longer reappears on every launch once you have a GitHub account configured

## [1.5.4] - 2026-05-26

> V2 shell polish from first-look feedback: the bottom instrument bar now sits under the terminal only, inactive sessions keep their identity colour, and the global/custom command rows follow the theme.

### Fixed
- The bottom instrument bar is now scoped to the content area instead of spanning the full window width underneath the sidebar
- Inactive sessions keep a muted identity-colour rail, so you can still tell sessions apart at a glance; the selected session shows the full rail, tint, and border
- Global and custom command rows now use the theme's surface tokens instead of a fixed dark background, so they follow light and dark correctly

## [1.5.3] - 2026-05-26

> V2 command-center shell -- a ground-up visual redesign: dense session cards, a single bottom instrument bar, a cleaner header and terminal framing, light/dark theming, and per-session identity colours.

### Added
- New 'Command Workbench' shell. The session list is rebuilt as dense two-line cards with an unmistakable selected state (identity rail, tint, elevation, bold name, chip); health reads only as a status dot and pill; keyboard focus is a quiet dashed ring distinct from selection
- Single bottom instrument bar replaces the old status bar, the per-terminal context bar, and the dead toolbar: runtime (CLI, version, channel, update) on the left, live session telemetry inline in the middle, and Mode / Model / Compact / Restart controls on the right
- Per-session identity colours, resolved per theme, shown consistently on cards, tabs, and the header accent -- a curated non-status palette that never collides with running/warning/error status or the teal focus ring. Legacy session colours are migrated once, with a dismissible notice
- Light and dark themes with a one-click Light/Dark flip in the title bar; the full Dark / Light / System choice lives in Settings
- A passive breadcrumb strip in the header (working directory + detected repo), a quieter info-style repo auto-detect suggestion, and a collapsible command bar with neutral command chips

### Changed
- Context-aware empty state: with saved configs you get launch cards plus 'Show all configs'; with none, a clear 'Create a terminal config' action. Saved configs are reachable by keyboard, not hover-only
- Terminal container framing -- comfortable padding and a real left gutter so text no longer crowds the edge

### Fixed
- Theme toggle no longer shows duplicate icons or dead clicks -- every click reliably and visibly changes the theme
- Session attention pulse no longer re-fires when you simply switch away from a session; it only re-arms on genuine new keyboard input, not focus or mouse reports
- New branded startup splash

## [1.5.2] - 2026-05-24

> Per-session account attribution -- see which Claude/Codex account each session and dollar belongs to. Plus the Electron 38 engine upgrade.

### Added
- Per-session account attribution. The active account email now shows in the context bar, coloured deterministically per account, so you can tell at a glance which login a session is running under. Works for both Claude (read live from ~/.claude.json) and Codex (decoded from the session JWT)
- Tokenomics page gains an Account filter. Slice spend by account email, or by (Mixed) and (Unknown) for sessions that span logins or predate attribution
- Account attribution back-fill wizard. Historic sessions recorded before this release are bucketed by config and suggested an account from your ~/.claude backup timeline -- confirm, override, or mark mixed. Runs once on first launch and is re-openable from the tokenomics page

### Changed
- Removed the global account picker from the title bar. Attribution is now per-session and automatic -- no manual switching, and historic spend is never silently re-stamped to whoever is logged in now
- Electron 33 to 38 engine upgrade (Chromium 132 to 140). Newer rendering engine and security baseline under the hood

### Fixed
- Codex sessions no longer open to a blank terminal on Windows. ConPTY does not do PATH lookup, so the bare 'node' spawn failed silently -- now resolved to a full node.exe path
- Codex MCP handshake now speaks streamable HTTP alongside SSE, so the conductor tools (vision, codex review) connect correctly under Codex CLI 0.128+
- Codex resume picker reads the newer 0.133 rollout format, so resuming a Codex session lists the right sessions with readable labels instead of '(continued session)'
- GitHub sidebar can be collapsed when open, and its per-session enablement now persists across app restarts

## [1.5.1] - 2026-05-08

> Codex provider, mega release

### Fixed
- Removed the peak/off-peak indicator -- Anthropic no longer differentiates peak hours in their rate-limit policy, so the badge was reporting outdated information

## [1.4.3] - 2026-04-29

> New branded splash now actually shows on launch, plus a refreshed README with v1.4 feature highlights

### Changed
- README overhaul. Branded splash at the top, six new feature highlight cards (Excalidraw, Combined Mode, Insights, Logs, GitHub sidebar, Vision), accurate v1.4 feature audit, dedicated 'What's New' section, corrected installer naming, and a 'Defence in Depth' security subsection covering daily CONFIG backups

### Fixed
- Splash window now displays the new branded artwork. The 1.5 MB PNG was being inlined into a data: URL that exceeded Electron's loadURL size limit, so the window was created but never reached ready-to-show. Switched to writing the wrapper HTML to a temp file and loading via loadFile -- works for any image size

## [1.4.2] - 2026-04-28

> Safety-net daily backups of your CONFIG directory -- never lose a session list to a corrupted write again

### Added
- Daily auto-backup of CONFIG/*.json under CONFIG/_backups/YYYY-MM-DD/ on every app launch. Last 7 days kept, prunes older. Recovery is a manual copy back into CONFIG/ -- but the data is always there if anything goes sideways

### Fixed
- Capture-training script no longer destroys real config data on cleanup. PID lock prevents concurrent captures; cleanup only restores files it explicitly backed up; never blind-deletes by filename match
- Memory frontmatter writer now produces valid YAML for values containing backslashes, newlines, and other control chars. Previously only escaped quotes -- anything else round-tripped as malformed YAML. Switched to JSON-stringify which is a strict subset of YAML 1.2's double-quoted scalar grammar

## [1.4.0] - 2026-04-24

> GitHub sidebar -- PR, CI, reviews, linked issues, and session context next to the terminal

### Added
- New GitHub sidebar. Collapsible right panel that shows the PR for your current branch, CI runs, reviews, linked issues, local git state, and a session-context summary of what this terminal is working on
- Sign in with GitHub via OAuth device flow, fine-grained PAT, or gh CLI adoption. Nothing runs until you opt in per session
- Per-session enable with repo auto-detection banner. Ctrl+/ (Cmd+/ on Mac) toggles the panel
- PR-body reference scanning. Closes/fixes/resolves #N and owner/repo#N refs in a PR body all surface in the session context
- Notifications mini-section with mark-read, plus rate-limit and expiry banners on your auth profiles
- First-launch onboarding modal for the GitHub sidebar, with a Set up now button that deep-links into the GitHub settings tab

### Changed
- HTTP Hooks Gateway plumbing. Opt-in loopback 127.0.0.1 listener that receives tool-call, permission, and lifecycle events from your Claude Code sessions via per-session UUID secrets. No UI in this release - it's the foundation for desktop notifications and external automations in upcoming versions. Toggle under Settings > GitHub
- What's New modal fade-out now uses a shared 200 ms constant matched to the Tailwind transition, so the animation never truncates

### Fixed
- Right-click paste in terminals now respects bracketed-paste mode. Pasting multi-line text into Claude Code (or any other app that enables the mode) lands as a single atomic paste instead of submitting on the first newline
- Session labels no longer leak into Claude as user prompts. Dropped the --name CLI flag whose value was being split by Windows shell quoting, sending part of the label as the first message

## [1.3.1] - 2026-04-15

> First public release -- open-sourced on GitHub

### Added
- Command bar sections: drag commands into named sections, right-click to rename/delete, custom text colors, independent Claude/Partner row sections
- SSH statusline now shows full second line (rate limits, extra spend, peak/off-peak) -- fetches from Anthropic API on the remote
- Insights report links now open in your system browser instead of showing blank pages

### Changed
- Tips updated for new section features with trackUsage calls
- Pre-release checklist prompt added to release script

### Fixed
- SSH sessions now auto-start Claude (was broken for sessions without a post-connect command)
- SSH setup script no longer echoes binary text -- suppressed with stty
- Logs tab no longer freezes the UI -- async file reads with loading spinner
- Memory manager: 'originSessionId' recognized as valid field, warnings now expandable
- Insights KPI extraction: prompt piped via stdin instead of fragile shell arguments

## [1.2.166] - 2026-04-08

> Branching model: beta + main with promote flow

### Added
- New `npm run promote` command merges the beta→main PR and ships a stable release at the same version as the current beta
- New --no-bump flag on the release script reuses the current package.json version instead of incrementing -- used by the promote flow to keep beta and stable version numbers aligned
- New --ff-only and --yes flags on the promote script for partial/automated runs

### Changed
- New branching model: all feature work happens on the `beta` branch; the `main` branch is stable-only and receives fast-forwards from beta
- Release script now enforces branch ↔ channel correspondence -- --stable must run on main, --beta/--dev must run on beta (bypass with --skip-branch-check in emergencies)

## [1.2.165] - 2026-04-08

> Release script hotfix: cross-platform sleep + proper workflow watching

### Changed
- Run-ID detection picks the newest workflow_dispatch run regardless of branch, so the filter doesn't miss the just-dispatched run due to API pagination lag

### Fixed
- Local release script now uses Node-native sleep instead of shelling out to `timeout`/`sleep`, which was silently failing inside execSync and preventing the script from finding the dispatched workflow run ID
- Release script now surfaces real errors from the run-ID polling loop instead of swallowing them -- gives a useful hint if GitHub API is unreachable

## [1.2.164] - 2026-04-08

> Unified release pipeline + channel label on update button

### Added
- Check for Updates button now shows the active channel -- 'Check for Beta Updates' / 'Check for Stable Updates' / 'Check for Dev Updates' -- so you always know what you're checking against without opening the dropdown

### Changed
- Release script now dispatches the GitHub Actions workflow for canonical dual-platform builds (Windows EXE + macOS DMG, both signed/notarized, both VirusTotal-scanned, single release with checksums) instead of doing a Windows-only local build
- Local release script does fast smoke checks (typecheck + unit tests + build) for fast feedback before pushing to CI, then watches the workflow run to completion and verifies both .exe and .dmg are attached
- Release script now supports stable / beta / dev channels via --stable / --beta / --dev (default: interactive prompt with beta as fallback)

## [1.2.163] - 2026-04-08

> SSH statusline + unified MCP image transport + dual service status indicator

### Added
- Image paste, snap, and storyboard now work in BOTH local and SSH sessions via the conductor-vision MCP fetch_host_screenshot tool -- one unified code path, no path-vs-base64 hacks
- vision_screenshot returns inline image content directly -- no second Read tool call needed to view the captured browser screenshot
- Conductor MCP server now starts at app launch independent of browser/vision config so fetch_host_screenshot is always available
- Title bar service status redesigned: separate Claude Code + Claude.ai pills with colored dots, plus API status surfacing only when degraded

### Changed
- All screenshot capture sites cap longest edge to 1920px and use JPEG q85 (q78 for storyboard frames) to reduce token cost
- Clipboard paste regression fixed -- was sending raw base64 to the PTY, now uses saveImage path through the MCP fetch tool

### Fixed
- SSH statusline now updates: a tiny shim deployed to the remote ~/.claude emits an OSC sentinel via /dev/tty that the host parses out of the PTY stream (no SMB mount needed)
- 'Got it' tip button now actually clears the tip pill from the session header (markTipActed clears currentTipId)
- Snap, storyboard, and clipboard image resize now preserve aspect ratio -- was previously distorting non-square images by passing both width and height to nativeImage.resize()

## [1.2.162] - 2026-04-07

> Update system refactor: GitHub-only with stable/beta/dev channels + PTY dedupe

### Added
- Update checker now polls GitHub releases directly instead of a local WebSocket server
- New update channel selector next to Check for Updates button -- stable / beta / dev with full keyboard accessibility
- Dev channel for experimental builds (alongside existing stable and beta)

### Changed
- Update checker works without gh CLI once the repo is public (tries public GitHub API first, falls back to gh CLI only when needed)
- Safer update downloads: HTTPS-only redirects, Windows retry safety (unlinks stale files before rename), no shell injection risk
- Proper prerelease ordering (beta.2 > beta.1, final > beta)
- CI workflow on every PR -- typecheck, tests, build on both Windows and macOS

### Fixed
- Duplicate Claude prompts: PTY now suppresses identical submitted payloads within 300ms (prevents double-sends that triggered rate limits)

## [1.2.161] - 2026-04-07

> Intelligent tips system with 26 seed tips and transparency disclosures

### Added
- Animated tip pill in the session header shows contextual, one-per-session feature discovery hints
- Clicking a tip opens a platform-aware modal with full details, optional navigation, and dismiss/silence controls
- New Transparency category: explicit tips about statusline injection, Vision MCP, session logging, credential storage, resources folder, and all network activity
- Usage tracking persists to CONFIG/usage-tracking.json -- tips intelligently skip features you've already used or show 'did you know' variants
- Toggle 'Show intelligent tips' in Settings > General to disable the system

### Changed
- Platform-aware tip copy: Partner Terminal, Credential Storage, Resources Folder, and Session Logs tips show correct Windows vs macOS paths

## [1.2.160] - 2026-04-07

> Guided first-run config + terminal column fix

### Added
- New users see a 'Get Started' card with a guided split-view to create their first config with inline help

### Fixed
- Terminal column mismatch: wait for custom fonts to load before computing cols (no more text fragments on the right edge)

## [1.2.159] - 2026-04-07

> First CI/CD release: parallel Windows + macOS builds with signing

### Added
- GitHub Actions workflow builds Windows EXE and macOS DMG in parallel
- macOS DMG is code-signed and notarized via Apple Developer ID

### Changed
- Tour walkthrough consolidated to 7 focused steps with matching screenshots

### Fixed
- Splash screen now shows before main window renders
- CLI setup dialog now works on macOS via login shell PATH
- Setup dialog no longer crashes with null ResizeObserver target

## [1.2.158] - 2026-02-11

> Maintenance release with internal improvements

### Changed
- Internal code maintenance and stability improvements

## [1.2.68] - 2026-02-11

> Automated release pipeline with Claude CLI, VirusTotal, and GitHub Releases

### Added
- Release pipeline now auto-generates changelog and release notes via Claude CLI
- VirusTotal scan of installer with results linked in GitHub Release
- SHA-256 checksums generated and attached to each release
- GitHub Releases created automatically with installer download

### Changed
- Old installer versions auto-cleaned from project root on each release
- npm audit pre-check blocks release if critical vulnerabilities found

## [1.2.67] - 2026-02-08

> Platform v9 theme, rate limits, enriched statusline, config improvements

### Added
- Rate limit tracking -- 5-hour and weekly usage with colored dot bars, reset times, and extra usage cost shown in context bar
- Enriched context bar -- now shows model name, token count (135k/200k), context %, cost, lines changed, and session duration
- Config right-click menu now includes Edit and Delete options alongside group management

### Changed
- New platform v9 dark theme -- deeper blue-black backgrounds replace the old purple-tinted Catppuccin palette
- Config items show Claude/Shell badges and colored left borders. Active tabs have colored bottom border

### Fixed
- Command button context menu no longer truncates at window edge -- opens upward when near bottom

## [1.2.36] - 2026-02-07

> Insights fix, command button fix, update reliability

### Fixed
- Insights now works -- /insights runs via PTY with proper TTY instead of headless spawn that hung forever
- Custom command buttons no longer re-fire when pressing Enter -- buttons no longer steal keyboard focus
- Update process simplified -- copies installer to Downloads, kills PTYs, launches installer, exits immediately

## [1.2.24] - 2026-02-07

> Debug logging overhaul, input protection, crash recovery

### Changed
- Debug toggle now controls verbose app logging instead of screenshot capture -- logs persist across updates
- Log rotation increased to 10MB with 3 backup files for better diagnostic history
- Insights timeout increased from 5 to 10 minutes
- Error boundary catches renderer crashes and shows error with recovery button instead of blank screen
- Verbose PTY lifecycle logging (spawn, exit, kill) for debugging session issues

### Fixed
- Restored image paste handler -- clipboard images saved as JPEG (max 1920px, 85%) with file path sent to Claude
- Right-click in terminal pastes clipboard text when no text is selected
- Input bar blocks multi-char text when Claude is asking a question -- prevents losing typed content
- Image paste debounced (3s) to prevent duplicate sends via Alt+V or Ctrl+V

## [1.2.20] - 2026-02-06

> Config and session groups with collapsible tree view

### Added
- Group saved configs into named groups -- collapsible tree view in sidebar
- Launch all configs in a group at once with the group play button
- Active sessions auto-group based on their config's group
- Right-click configs to move between groups or create new ones
- Group field in config dialog for assigning during create/edit

### Fixed
- Context remaining indicator now works for SSH sessions (accumulation buffer for chunked data)

## [1.2.5] - 2026-02-06

> Image optimization, yellow cursor fix, and update button fix

### Fixed
- Clipboard images (Alt+V) now resized to max 1920px and saved as JPEG -- drastically reduces context usage
- Screenshot capture also switched from PNG to JPEG for smaller files
- Yellow cursor block eliminated by stripping yellow background color sequences
- Screenshot dropdown labels render properly (SVG icons instead of broken Unicode)
- Update button now runs pre-built installer instead of rebuilding from source

## [1.2.3] - 2026-02-06

> Smart insights with AI-powered analysis and actionable summaries

### Added
- KPI extraction now uses smart Claude skill that compares to previous run and produces actionable bullet points
- Insights sidebar shows improvements (green), regressions (red), and suggestions (purple) at the top

### Changed
- KPI format is now fully dynamic -- the skill decides categories, metrics, and lists without hardcoded schemas
- What's New modal now triggers on version change, not every build

## [1.2.2] - 2026-02-06

> Screenshot button redesign, input persistence, and release automation

### Added
- npm run release -- single command for full build, package, and update notification

### Changed
- Screenshot button restyled to match app design (no more garish cyan)

### Fixed
- Input text no longer lost when switching between sessions and other views

## [1.2.1] - 2026-02-06

> Better insights rendering, screenshot button fix, and clipboard paste fix

### Added
- CLI availability indicator (green/red dot) in status bar

### Changed
- Insights report now renders with full Catppuccin dark theme matching the app

### Fixed
- Screenshot button replaced with clean SVG icon instead of emoji
- Ctrl+V paste no longer intercepts clipboard images -- screenshot workflow uses right-click only
- Stuck insight runs automatically marked as failed on app restart
- Restart button now works for SSH/remote sessions (kills old PTY before re-spawning)

## [1.2.0] - 2026-02-06

> Insights analytics with KPI tracking and trend comparison

### Added
- Insights integration: run claude /insights from the sidebar and view reports in-app
- KPI extraction via Claude headless with automatic trend comparison between runs
- Insights archive with history browsing and versioned reports
- KPI sidebar showing metrics grouped by category with trend arrows
- Auto-seeds existing report on first launch so your data is immediately available

### Fixed
- Update process now properly rebuilds, runs the installer, and relaunches the app

## [1.1.0] - 2026-02-05

> Session restore, Docker screenshot support, and graceful shutdown

### Added
- Sessions are now saved on close and restored on launch with /resume
- Graceful shutdown sends /exit to Claude before closing
- Screenshots now work in Docker containers via docker cp
- Shell-only terminals (without Claude) option added
- Push-based update notifications via WebSocket

### Changed
- Build timestamp shown in status bar for version tracking
- Expanded color palette with 24 vibrant colors

### Fixed
- Log viewer now properly displays terminal logs
- Yellow cursor issue resolved by hiding cursor layer

## [1.0.0] - 2026-02-01

> Initial release

### Added
- Multi-session Claude Code terminal management
- SSH session support with password authentication
- Custom commands per session/config
- Session logging with history viewer
- Tab attention indicators for waiting prompts
- Context usage tracking via statusline API

[2.1.0-rc.12]: https://github.com/nubbymong/claude-command-center/releases/tag/v2.1.0-rc.12
[2.1.0-rc.11]: https://github.com/nubbymong/claude-command-center/releases/tag/v2.1.0-rc.11
[2.1.0-rc.10]: https://github.com/nubbymong/claude-command-center/releases/tag/v2.1.0-rc.10
[2.1.0-rc.9]: https://github.com/nubbymong/claude-command-center/releases/tag/v2.1.0-rc.9
[2.1.0-rc.8]: https://github.com/nubbymong/claude-command-center/releases/tag/v2.1.0-rc.8
[2.1.0-rc.7]: https://github.com/nubbymong/claude-command-center/releases/tag/v2.1.0-rc.7
[2.1.0-rc.6]: https://github.com/nubbymong/claude-command-center/releases/tag/v2.1.0-rc.6
[2.1.0-rc.5]: https://github.com/nubbymong/claude-command-center/releases/tag/v2.1.0-rc.5
[2.1.0-rc.4]: https://github.com/nubbymong/claude-command-center/releases/tag/v2.1.0-rc.4
[2.1.0-rc.3]: https://github.com/nubbymong/claude-command-center/releases/tag/v2.1.0-rc.3
[2.1.0-rc.2]: https://github.com/nubbymong/claude-command-center/releases/tag/v2.1.0-rc.2
[2.1.0-rc.1]: https://github.com/nubbymong/claude-command-center/releases/tag/v2.1.0-rc.1
[2.1.0-beta.17]: https://github.com/nubbymong/claude-command-center/releases/tag/v2.1.0-beta.17
[2.1.0-beta.16]: https://github.com/nubbymong/claude-command-center/releases/tag/v2.1.0-beta.16
[2.1.0-beta.15]: https://github.com/nubbymong/claude-command-center/releases/tag/v2.1.0-beta.15
[2.1.0-beta.14]: https://github.com/nubbymong/claude-command-center/releases/tag/v2.1.0-beta.14
[2.1.0-beta.13]: https://github.com/nubbymong/claude-command-center/releases/tag/v2.1.0-beta.13
[2.1.0-beta.12]: https://github.com/nubbymong/claude-command-center/releases/tag/v2.1.0-beta.12
[2.1.0-beta.11]: https://github.com/nubbymong/claude-command-center/releases/tag/v2.1.0-beta.11
[2.1.0-beta.10]: https://github.com/nubbymong/claude-command-center/releases/tag/v2.1.0-beta.10
[2.1.0-beta.9]: https://github.com/nubbymong/claude-command-center/releases/tag/v2.1.0-beta.9
[2.1.0-beta.8]: https://github.com/nubbymong/claude-command-center/releases/tag/v2.1.0-beta.8
[2.1.0-beta.7]: https://github.com/nubbymong/claude-command-center/releases/tag/v2.1.0-beta.7
[2.1.0-beta.6]: https://github.com/nubbymong/claude-command-center/releases/tag/v2.1.0-beta.6
[2.1.0-beta.5]: https://github.com/nubbymong/claude-command-center/releases/tag/v2.1.0-beta.5
[2.1.0-beta.4]: https://github.com/nubbymong/claude-command-center/releases/tag/v2.1.0-beta.4
[2.1.0-beta.3]: https://github.com/nubbymong/claude-command-center/releases/tag/v2.1.0-beta.3
[2.1.0-beta.2]: https://github.com/nubbymong/claude-command-center/releases/tag/v2.1.0-beta.2
[2.1.0-beta.1]: https://github.com/nubbymong/claude-command-center/releases/tag/v2.1.0-beta.1
[2.0.0-rc.2]: https://github.com/nubbymong/claude-command-center/releases/tag/v2.0.0-rc.2
[2.0.0-rc.1]: https://github.com/nubbymong/claude-command-center/releases/tag/v2.0.0-rc.1
[2.0.0-beta.6]: https://github.com/nubbymong/claude-command-center/releases/tag/v2.0.0-beta.6
[2.0.0-beta.5]: https://github.com/nubbymong/claude-command-center/releases/tag/v2.0.0-beta.5
[2.0.0]: https://github.com/nubbymong/claude-command-center/releases/tag/v2.0.0
[1.5.45]: https://github.com/nubbymong/claude-command-center/releases/tag/v1.5.45
[1.5.44]: https://github.com/nubbymong/claude-command-center/releases/tag/v1.5.44
[1.5.43]: https://github.com/nubbymong/claude-command-center/releases/tag/v1.5.43
[1.5.42]: https://github.com/nubbymong/claude-command-center/releases/tag/v1.5.42
[1.5.41]: https://github.com/nubbymong/claude-command-center/releases/tag/v1.5.41
[1.5.40]: https://github.com/nubbymong/claude-command-center/releases/tag/v1.5.40
[1.5.39]: https://github.com/nubbymong/claude-command-center/releases/tag/v1.5.39
[1.5.38]: https://github.com/nubbymong/claude-command-center/releases/tag/v1.5.38
[1.5.37]: https://github.com/nubbymong/claude-command-center/releases/tag/v1.5.37
[1.5.36]: https://github.com/nubbymong/claude-command-center/releases/tag/v1.5.36
[1.5.34]: https://github.com/nubbymong/claude-command-center/releases/tag/v1.5.34
[1.5.33]: https://github.com/nubbymong/claude-command-center/releases/tag/v1.5.33
[1.5.32]: https://github.com/nubbymong/claude-command-center/releases/tag/v1.5.32
[1.5.31]: https://github.com/nubbymong/claude-command-center/releases/tag/v1.5.31
[1.5.30]: https://github.com/nubbymong/claude-command-center/releases/tag/v1.5.30
[1.5.29]: https://github.com/nubbymong/claude-command-center/releases/tag/v1.5.29
[1.5.28]: https://github.com/nubbymong/claude-command-center/releases/tag/v1.5.28
[1.5.27]: https://github.com/nubbymong/claude-command-center/releases/tag/v1.5.27
[1.5.26]: https://github.com/nubbymong/claude-command-center/releases/tag/v1.5.26
[1.5.25]: https://github.com/nubbymong/claude-command-center/releases/tag/v1.5.25
[1.5.23]: https://github.com/nubbymong/claude-command-center/releases/tag/v1.5.23
[1.5.19]: https://github.com/nubbymong/claude-command-center/releases/tag/v1.5.19
[1.5.18]: https://github.com/nubbymong/claude-command-center/releases/tag/v1.5.18
[1.5.17]: https://github.com/nubbymong/claude-command-center/releases/tag/v1.5.17
[1.5.16]: https://github.com/nubbymong/claude-command-center/releases/tag/v1.5.16
[1.5.15]: https://github.com/nubbymong/claude-command-center/releases/tag/v1.5.15
[1.5.14]: https://github.com/nubbymong/claude-command-center/releases/tag/v1.5.14
[1.5.13]: https://github.com/nubbymong/claude-command-center/releases/tag/v1.5.13
[1.5.11]: https://github.com/nubbymong/claude-command-center/releases/tag/v1.5.11
[1.5.10]: https://github.com/nubbymong/claude-command-center/releases/tag/v1.5.10
[1.5.9]: https://github.com/nubbymong/claude-command-center/releases/tag/v1.5.9
[1.5.8]: https://github.com/nubbymong/claude-command-center/releases/tag/v1.5.8
[1.5.7]: https://github.com/nubbymong/claude-command-center/releases/tag/v1.5.7
[1.5.6]: https://github.com/nubbymong/claude-command-center/releases/tag/v1.5.6
[1.5.5]: https://github.com/nubbymong/claude-command-center/releases/tag/v1.5.5
[1.5.4]: https://github.com/nubbymong/claude-command-center/releases/tag/v1.5.4
[1.5.3]: https://github.com/nubbymong/claude-command-center/releases/tag/v1.5.3
[1.5.2]: https://github.com/nubbymong/claude-command-center/releases/tag/v1.5.2
[1.5.1]: https://github.com/nubbymong/claude-command-center/releases/tag/v1.5.1
[1.4.3]: https://github.com/nubbymong/claude-command-center/releases/tag/v1.4.3
[1.4.2]: https://github.com/nubbymong/claude-command-center/releases/tag/v1.4.2
[1.4.0]: https://github.com/nubbymong/claude-command-center/releases/tag/v1.4.0
[1.3.1]: https://github.com/nubbymong/claude-command-center/releases/tag/v1.3.1
[1.2.166]: https://github.com/nubbymong/claude-command-center/releases/tag/v1.2.166
[1.2.165]: https://github.com/nubbymong/claude-command-center/releases/tag/v1.2.165
[1.2.164]: https://github.com/nubbymong/claude-command-center/releases/tag/v1.2.164
[1.2.163]: https://github.com/nubbymong/claude-command-center/releases/tag/v1.2.163
[1.2.162]: https://github.com/nubbymong/claude-command-center/releases/tag/v1.2.162
[1.2.161]: https://github.com/nubbymong/claude-command-center/releases/tag/v1.2.161
[1.2.160]: https://github.com/nubbymong/claude-command-center/releases/tag/v1.2.160
[1.2.159]: https://github.com/nubbymong/claude-command-center/releases/tag/v1.2.159
[1.2.158]: https://github.com/nubbymong/claude-command-center/releases/tag/v1.2.158
[1.2.68]: https://github.com/nubbymong/claude-command-center/releases/tag/v1.2.68
[1.2.67]: https://github.com/nubbymong/claude-command-center/releases/tag/v1.2.67
[1.2.36]: https://github.com/nubbymong/claude-command-center/releases/tag/v1.2.36
[1.2.24]: https://github.com/nubbymong/claude-command-center/releases/tag/v1.2.24
[1.2.20]: https://github.com/nubbymong/claude-command-center/releases/tag/v1.2.20
[1.2.5]: https://github.com/nubbymong/claude-command-center/releases/tag/v1.2.5
[1.2.3]: https://github.com/nubbymong/claude-command-center/releases/tag/v1.2.3
[1.2.2]: https://github.com/nubbymong/claude-command-center/releases/tag/v1.2.2
[1.2.1]: https://github.com/nubbymong/claude-command-center/releases/tag/v1.2.1
[1.2.0]: https://github.com/nubbymong/claude-command-center/releases/tag/v1.2.0
[1.1.0]: https://github.com/nubbymong/claude-command-center/releases/tag/v1.1.0
[1.0.0]: https://github.com/nubbymong/claude-command-center/releases/tag/v1.0.0
