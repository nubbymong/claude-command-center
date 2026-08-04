# Privacy Policy

**AI Code Conductor** (the "app")

Last updated: 4 August 2026

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

To show which account a session is running under, the app reads — from files
that the Claude Code and Codex tools already keep on your computer — **your
account email address** and **the access token for that account**. The email
address is displayed in the app so you can tell your accounts apart. The token
is used only to ask that same provider for your usage allowance.

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
- an index of your Claude Code and Codex session transcripts, used to power the
  Logs, Memory and Tokenomics views
- cost and usage figures calculated locally from those transcripts
- application logs
- screenshots and drawings you create in the app

None of this is uploaded anywhere. Deleting the data directory deletes it.

The app reads the credential and configuration files that the Claude Code and
Codex command-line tools maintain in your home directory, in order to show which
account a session is signed in as and to display your usage allowance. Those
credentials are used only to talk to the corresponding provider (below) and are
never sent anywhere else.

Session transcript indexing can be switched off entirely in **Settings →
General**.

## Every network request the app makes

| Destination | Why | When |
| --- | --- | --- |
| `api.anthropic.com` | Reads your Claude usage allowance for the status line, using **your** Claude OAuth token | While a session runs, when the status line is enabled |
| `status.claude.com` | Anthropic's public service-status page | Periodically, to show service health |
| `api.github.com`, `github.com` | Checks for app updates and downloads them; powers the optional GitHub integration | On update checks, and when you use the GitHub features |
| `raw.githubusercontent.com` | Fetches a public model-pricing table (LiteLLM's open dataset) so cost figures are accurate | At most once every 24 hours, cached locally |

The app also runs a small server bound to `127.0.0.1` (localhost) so that Claude
sessions can use its built-in tools. It is not reachable from the network.

Nothing in the list above carries your code, your prompts, your conversations,
or your files.

Separately, the **Claude Code and Codex command-line tools that the app launches
are independent programs** with their own network behaviour and their own
privacy policies. When you run a session, your prompts and code go to Anthropic
or OpenAI through those tools, exactly as they would if you ran them yourself in
a terminal. The app does not add to, intercept, or copy that traffic. See
Anthropic's and OpenAI's privacy policies for how they handle it.

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
