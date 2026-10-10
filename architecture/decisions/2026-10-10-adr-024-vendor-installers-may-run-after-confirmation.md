# ADR-024: The vendors' own installers may run, after a confirmation that names their host

- Status: Accepted (owner decision D1, 2026-10-10)
- Date: 2026-10-10
- Supersedes: design 8.4's rule that a remote pipe-to-shell installer is only
  shown and copied, never run by the app (the header of
  `src/main/providers/codex/install-recipes.ts` before this change)

## Context

Design 8.4 let the app run only a package-manager recipe (npm, Homebrew), from
its argv, in a visible terminal after the user confirmed its line. A vendor's
own installer, a script fetched and piped to a shell, was shown and copied,
never run: it fetches code at run time with no publisher digest the app could
check, and OpenAI's Windows line starts a PowerShell with its execution policy
bypassed.

Both publishers now recommend their own installer first. Anthropic's setup page
for Claude Code (https://code.claude.com/docs/en/setup) lists the native
installer as the recommended install and npm as an alternative that needs
Node.js 22 or later. OpenAI's README lists its installer before npm and
Homebrew. On a new computer without Node.js, the only commands the app could
run were the npm ones, which cannot work there, so first-run setup could not
install either tool by itself.

## Decision

The app may run a vendor's own installer, with this containment:

1. **The address is fixed in code.** Each installer recipe carries `scriptUrl`,
   the one HTTPS address its command downloads the script from, copied
   verbatim, with the command, from the vendor's own install docs: for Claude
   Code, `https://claude.ai/install.ps1` and `https://claude.ai/install.sh` from
   Anthropic's setup page; for Codex, `https://chatgpt.com/codex/install.ps1`
   and `https://chatgpt.com/codex/install.sh` from the openai/codex README at
   the pinned commit. Nothing is scraped or fetched to decide what runs.
2. **The command runs as documented, and only in a documented shape.** Main
   runs the documented command character for character, and only when it is
   exactly one of the documented shapes filled in with `scriptUrl`:
   `irm <url> | iex`, `curl -fsSL <url> | bash`, `curl -fsSL <url> | sh`, or
   `powershell -ExecutionPolicy ByPass -c "irm <url> | iex"`, `scriptUrl`
   being an HTTPS address with no user, port, query or fragment. So it names
   that one address and runs nothing else: a second fetch (with or without a
   scheme), a chained command or a substitution gets no line, so the renderer
   has nothing to type. (Amended 2026-10-10: the first version only counted
   the addresses written with a scheme, which let a scheme-less second fetch
   or a chained command through; the recipes are code constants pinned by
   tests, so nothing shipped could use that.) OpenAI's Windows line stays as
   documented:
   `powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"`.
   The app itself still never changes or bypasses the execution policy of the
   terminal it types into.
3. **Only after an explicit confirmation that names the host.** Run it for me
   opens a confirmation showing the exact line and, for an installer, saying
   that it downloads a script from that host (claude.ai, chatgpt.com) and runs
   it. Only Run it there starts anything. The renderer refuses to run an
   installer whose host main did not send, since the confirmation could not
   name it. The confirmation is the renderer's: main builds every line and
   hands it out as data only, but the terminal that types it accepts a
   command from the renderer, as every terminal command does. The renderer
   stays trusted for terminal input, as it was before this decision (the
   pty:spawn threat model).
4. **Only in a visible terminal, never on its own, never elevated.** The line
   runs in a visible terminal tab (on the first-run screen, a terminal on that
   screen started with the same options): shell only, never elevated by the
   app, with none of the command-button secrets in its environment. Nothing
   runs without the user's click.
5. **The vendor's installer comes first; npm is the alternative.** Every
   install or update command shows both Run it for me and Copy (owner decision
   D2). When Node.js is not found, an npm command says so and its Run it for
   me is off; Copy still works (D3). No Node.js installer is offered.

Three mechanisms come with it:

- **Every run line ends its shell when its command ends, however it ends.**
  POSIX: `<command>; exit`. PowerShell:
  `$failed = $true; try { <command>; $failed = $false } catch { $_ } finally { if ($failed) { exit 1 } }; exit $LASTEXITCODE`.
  The documented command is still typed character for character, inside
  that wrapper. Anthropic's Windows installer runs through iex in the tab's
  own PowerShell and sets `$ErrorActionPreference` to Stop, so each of its
  failures is an error that abandoned the rest of a plain typed line,
  `; exit` included: the tab stayed open and nothing checked again. In the
  wrapper, an error is shown and ends the shell with 1, Ctrl+C runs the
  finally and ends it with 1, and otherwise the shell ends with the command's
  own code (checked in a ConPTY with Windows PowerShell 5.1). An installer
  that ends with its own `exit 0` inside the try would be reported as 1;
  neither documented installer does. A POSIX shell interrupted by Ctrl+C may
  stay at its prompt. Every surface's Check again works while the command
  still runs, so there is always a way on. Whether the tool is there is
  decided by the check, never by the exit code.
- **After an install, the app finds the tool without a restart** (owner
  decision D4). On Windows, before a check the user asked for (Check again,
  the check after an install ends), main reads the system and user PATH
  values from the registry, through Windows PowerShell by its full path with
  every character intact (each value comes back as its registry type and its
  UTF-16 text in base64), expands them against its own environment, and
  appends to its own PATH each fully qualified folder it does not have. It
  never drops, reorders or rewrites an entry already there. A failed read
  adds nothing and is logged. Sessions started afterwards inherit it. On
  macOS and Linux the checks already read the login shell's PATH each time.
- **A tool its publisher's installer left off PATH is said as such, and on
  Windows the app may add that one folder** (the PATH finding of the
  first-run test, 2026-10-10). Anthropic's native installer puts claude.exe
  in `%USERPROFILE%\.local\bin` (`~/.local/bin/claude` elsewhere) and never
  adds that folder to PATH. When a check finds nothing, main looks in the
  publisher's fixed folder, computed from the user's home folder: on Windows,
  a regular file there (never a link) whose folder neither registry PATH
  names gets "Add it to PATH for me" (and "Not now"); on macOS and Linux,
  Claude Code or Codex in `~/.local/bin` gets the shell file the login shell
  reads and the exact line to add, to copy. The app never edits a shell file.
  "Add it to PATH for me" sends only a provider id (a closed set) over IPC;
  main appends exactly that one folder to HKCU\Environment `Path`: the value
  as stored, then `;` and the folder, in its own registry type (a
  REG_EXPAND_SZ stays one), only when neither PATH names it already (case, a
  trailing backslash, quotes and %VARIABLES% read as Windows reads them), and
  only when the value still reads as it did (else it reads again, once).
  Values go to the script through its environment, never in its text. It
  then tells running programs the environment changed, adds the folder to
  its own PATH and checks again, so setup moves on and later sessions, the
  version check and terminals find the tool. One log line records the folder
  and the outcome. The advice to quit and start the app again is given only
  when that would help: the tool is in a folder the registry's PATH names
  that the running app could not take in.

## Consequences

- A user can install Claude Code or Codex from setup on a computer with
  nothing installed, the way each publisher recommends. With Anthropic's
  installer on Windows that takes one more click, Add it to PATH for me; on
  macOS and Linux, one line the user adds to their shell file.
- The PATH refresh is process-wide, and any provider's check runs it. A
  lookup that walks PATH folder by folder finds what it found before, since
  new folders come last, but Claude Code is looked for by name (claude.exe in
  every folder before claude.cmd in any), so once a folder holding claude.exe
  is appended, a PATH that resolved to npm's claude.cmd resolves to that
  claude.exe for every later session, check and launch. That is the program
  a restart of the app would pick from the same PATH.
- The app now writes the user's PATH, once, at the user's request, and only
  ever appends the publisher's folder it computed. A registry PATH entry
  that uses a variable defined after the app started is still not taken in
  while it runs.
- The app now starts a third party's script at the user's request. It still
  checks no digest of it; what is contained is where it comes from, that the
  user is told so first, and that it runs visibly, unelevated, without the
  command-button secrets in its environment.
- Adding an installer recipe means adding its `scriptUrl` from the vendor's
  docs; a command that names any other address is not run.
- This is a security-sensitive change (PTY line construction, an IPC
  handler's output, the process environment): it needs the ADR-009
  adversarial pass before merge.
