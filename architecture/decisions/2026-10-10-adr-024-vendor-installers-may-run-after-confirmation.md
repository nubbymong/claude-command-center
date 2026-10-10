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
2. **The command runs as documented, and only if it names that address
   alone.** Main types the documented command character for character, and
   only when it names exactly one web address, `scriptUrl`, an HTTPS address
   with no user, port, query or fragment, and holds no control character. Any
   other command gets no line, so the renderer has nothing to type. OpenAI's
   Windows line stays as documented:
   `powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"`.
   The app itself still never changes or bypasses the execution policy of the
   terminal it types into.
3. **Only after an explicit confirmation that names the host.** Run it for me
   opens a confirmation showing the exact line and, for an installer, saying
   that it downloads a script from that host (claude.ai, chatgpt.com) and runs
   it. Only Run it there starts anything. The renderer refuses to run an
   installer whose host main did not send, since the confirmation could not
   name it.
4. **Only in a visible terminal, never on its own, never elevated.** The line
   runs in a visible terminal tab (on the first-run screen, a terminal on that
   screen started with the same options): shell only, never elevated by the
   app, with none of the command-button secrets in its environment. Nothing
   runs without the user's click.
5. **The vendor's installer comes first; npm is the alternative.** Every
   install or update command shows both Run it for me and Copy (owner decision
   D2). When Node.js is not found, an npm command says so and its Run it for
   me is off; Copy still works (D3). No Node.js installer is offered.

Two mechanisms come with it:

- **Every run line ends its shell when its command ends** (`; exit`, and in
  PowerShell `; exit $LASTEXITCODE`), so the surface that opened the terminal
  sees it end and checks again. Whether the tool is there is decided by that
  check, never by the exit code.
- **After an install, the app finds the tool without a restart** (owner
  decision D4). On Windows, before a check the user asked for (Retry, Check
  again, the check after an install ends), main reads the system and user PATH
  values from the registry, expands them, and appends to its own PATH each
  fully qualified folder it does not have. It never drops, reorders or
  rewrites an entry already there. Sessions started afterwards inherit it. On
  macOS and Linux the checks already read the login shell's PATH each time.
  The advice to restart the app appears only when a check still finds nothing.

## Consequences

- A user can install Claude Code or Codex from setup on a computer with
  nothing installed, the way each publisher recommends.
- The app now starts a third party's script at the user's request. It still
  checks no digest of it; what is contained is where it comes from, that the
  user is told so first, and that it runs visibly, unelevated, without the
  command-button secrets in its environment.
- Adding an installer recipe means adding its `scriptUrl` from the vendor's
  docs; a command that names any other address is not run.
- This is a security-sensitive change (PTY line construction, an IPC
  handler's output, the process environment): it needs the ADR-009
  adversarial pass before merge.
