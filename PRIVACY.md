# Privacy Policy

**AI Code Conductor** (the "app")

Last updated: 4 August 2026

## The short version

The app collects nothing. There is no analytics, no telemetry, no crash
reporting, and no account with us — there is no "us" to send anything to. Every
file the app creates stays on your computer. The only network requests it makes
are listed in full below, and each one goes to a service you are already using.

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
