# Privacy Policy

**AI Code Conductor** (the "app")

Last updated: 25 September 2026

## The short version

The app collects nothing about you and sends nothing to its developer. There is
no analytics, no telemetry, no crash reporting, and no account with us — there
is no "us" to send anything to. Every file the app creates stays on your
computer. The only network requests it makes are listed in full below, and each
one goes to a service you are already using.

It does handle some personal information locally, because it has to in order to
show you which account you are signed in as. Exactly what, and where it goes, is
set out in the next section.

## What personal information the app handles

To show which Claude account a session is running under, the app reads, from
files that Claude Code already keeps on your computer, **your account email
address** and **the access token for that account**. The email address is
displayed in the app so you can tell your accounts apart. The token is used only
to ask Anthropic for your usage allowance.

For Codex, the app reads no sign-in file at all. It asks the Codex command-line
tool whether each Codex account is signed in, and whether with ChatGPT or with
an API key, and it learns no email address or token from Codex. A Codex account
is shown under the name you give it. How Codex sign-ins are kept is set out in
"Codex accounts and sign-ins" below.

If you turn on the optional GitHub integration, the app reads your GitHub
account details for the same purpose.

Your session transcripts may contain personal information, because they contain
whatever you typed. The app indexes them locally so it can show your history and
costs, and that indexing can be switched off (see below).

None of this is transmitted anywhere except to the provider it already belongs
to, and none of it ever reaches the developer of this app.

## What the app stores, and where

All of it is ordinary files on your own machine, in a data directory you choose
during installation (and can change later in Settings):

- your saved session configurations, command buttons, and app settings
- the list of your Claude and Codex accounts: the names and colours you give
  them, and which account is the default and which the reviewer
- one sign-in folder for each Codex account you add (see "Codex accounts and
  sign-ins" below)
- an index of your Claude Code session transcripts, used to power the Logs
  and Tokenomics views, and of your Codex session transcripts, used for
  Tokenomics
- cost and usage figures calculated locally from those transcripts
- application logs
- screenshots and drawings you create in the app

None of this is uploaded anywhere. Deleting the data directory deletes it.

The app reads the credential and configuration files that the Claude Code
command-line tool maintains in your home directory, in order to show which
account a session is signed in as and to display your usage allowance. Those
credentials are used only to talk to Anthropic (below) and are never sent
anywhere else. The app does not read Codex's credential files.

Indexing your transcripts for the Logs page can be switched off in **Settings →
General** (Index conversation logs). The Tokenomics cost index is separate and
is not affected by that switch.

## Codex accounts and sign-ins

- **Each Codex account you add has its own sign-in folder.** The app creates it
  inside its resources folder, under `codex-realms/`, before you sign in, and
  Codex keeps that account's sign-in there.
- **The app never opens or reads the sign-in Codex keeps.** It asks Codex
  (`codex login status`) whether an account is signed in. The only other thing
  it does with that file is check whether it exists, before it removes the
  folder of a setup you abandoned, so that a folder still holding a sign-in is
  never deleted.
- **An API key you enter goes to Codex, and the app does not store it.** It
  travels once from the sign-in dialog to the app's main process over a
  one-way channel, and from there to Codex on its standard input. The app never
  writes it to disk or to a log, and drops it as soon as Codex has it, or after
  two minutes if the sign-in never starts.
- **Your own Codex folder (`~/.codex`, or the folder `CODEX_HOME` named when
  the app started) is used only when you confirm it.** The app asks Codex
  whether that folder is signed in only after you have said you use Codex. A
  session runs in it only after you confirm that launch, it is never used for
  a code review, and the app never signs in to it; signing out of it asks you
  first. Two things are read regardless: the conversation files in
  `~/.codex/sessions` (for the local Tokenomics index, like the ones in each
  Codex account's folder), and, when the app's built-in tool server starts or
  stops, Codex's `config.toml` in your own Codex folder, from which the app
  removes an entry that older versions of this app added, if one is still
  there. Checking which Codex version is
  installed runs it against a new, empty folder, never your own.

## Every network request the app makes

| Destination | Why | When |
| --- | --- | --- |
| `api.anthropic.com` | Reads your Claude usage allowance for the status line, using **your** Claude OAuth token | While a session runs, when the status line is enabled |
| `status.claude.com` | Anthropic's public service-status page | Periodically, to show service health |
| `api.github.com`, `github.com` | Checks for app updates and downloads them; powers the optional GitHub integration | On update checks, and when you use the GitHub features |
| `raw.githubusercontent.com` | Fetches a public model-pricing table (LiteLLM's open dataset) so cost figures are accurate | At most once every 24 hours, cached locally |

The app also runs a small server bound to `127.0.0.1` (localhost) so that Claude
and Codex sessions can use its built-in tools. It is not reachable from the
network.

If you ask the Set up Codex page to run an install or update command, it types
that npm or Homebrew command into a visible terminal tab, and the package manager
downloads Codex from its own registry, exactly as if you had typed the command
yourself.

Nothing in the list above carries your code, your prompts, your conversations,
or your files.

Separately, the **Claude Code and Codex command-line tools that the app launches
are independent programs** with their own network behaviour and their own
privacy policies. When you run a session, your prompts and code go to Anthropic
or OpenAI through those tools, exactly as they would if you ran them yourself in
a terminal. A code review works the same way: a Codex review asked for from a
Claude session sends the change under review to OpenAI through Codex, and a
Claude review asked for from a Codex session sends it to Anthropic through
Claude Code; each review direction can be switched off in Settings. Signing in
to a Codex account runs Codex's own sign-in, which talks to OpenAI directly. The app does not add to, intercept, or copy that traffic.
See Anthropic's and OpenAI's privacy policies for how they handle it.

## What we receive

Nothing. The app has no server, no account system, and no data collection of any
kind. We cannot see who uses the app or how.

If you choose to report a bug on GitHub, anything you paste into that report is
public and handled under GitHub's privacy policy.

## Children

The app is a developer tool and is not directed at children.

## Changes

Any change to this policy will be committed to this file in the public
repository, so its history is visible.

## Contact

Questions about this policy: open an issue at
<https://github.com/nubbymong/claude-command-center/issues>.
