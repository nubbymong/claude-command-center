# Security Policy

## Reporting a Vulnerability

Report privately via [GitHub Security Advisories](../../security/advisories/new). Private
reporting is enabled on this repository, so that link works for anyone — you do not need
write access.

**Do not open a public issue, and do not describe the finding in a pull request, commit
message, or any other file in the repository.** See [Embargo](#embargo) for why that list
is longer than it looks.

If GitHub advisories are unreachable for you, open a public issue containing **only** the
words "security report, requesting a private channel" and no detail, and a maintainer will
open the advisory and invite you to it.

### What to include

A repro is worth more than a description. Ideally: affected version and platform, the
exact input or sequence, what you expected, what happened, and what an attacker gains.
If you have a patch, hold it until the advisory exists — see [Embargo](#embargo).

### What to expect

This is a small project. These are honest targets, not a service commitment:

| Stage | Target |
| --- | --- |
| Acknowledgement | 7 days |
| Triage and severity assessment | 14 days |
| Fix, or a written plan and timeline | case by case, communicated at triage |
| Public disclosure | when the fix ships, or 90 days after the report, whichever is first |

If the 90-day window expires without a fix, we will publish the advisory anyway with the
current status. You are welcome to disclose after that window; we would appreciate a
heads-up first. If something is already being actively exploited, say so and we will drop
everything.

We credit reporters in the advisory by default. Tell us if you would rather not be named.

### Safe harbour

We will not pursue or support legal action against research conducted in good faith under
this policy: testing against **your own installation**, stopping once you have
demonstrated the issue, not accessing or exfiltrating anyone else's data, and not
degrading anyone else's service. Nothing here authorises testing against third parties —
Anthropic's services, Microsoft's, or anyone's — and this policy cannot grant permission
that is not ours to give.

## Supported versions

Security fixes land on the current release line only. The channel model is described in
`docs/versioning.md` and `AGENTS.md`.

| Version | Supported |
| --- | --- |
| Latest stable release | Yes |
| Current beta / rc | Yes |
| Anything older | No — upgrade |

There are no long-term-support branches. Because the app self-updates, "upgrade" is
usually a restart.

## Embargo

**A finding stays out of every tracked artefact until its fix has shipped.** Not just the
issue tracker:

- issues and pull requests
- commit messages and branch names
- `CONTEXT.d/` fragments — these are **tracked files in a public repository**
- ADRs under `architecture/decisions/`
- `src/renderer/changelog.ts` and `CHANGELOG.md`

`CONTEXT.d/` is the one people get wrong, and it is the one this rule was written for. The
running log feels like a private notebook. It is not — it is committed, and pushing it
publishes a diff containing the repro. "Don't file a public issue" is the wrong mental
model. The right one is: **anything that gets pushed is publication.**

The workflow:

1. The advisory is created first. It is private.
2. Development happens in the **private fork GitHub attaches to the advisory** — not in a
   branch on this repo, however innocently named.
3. The fix merges and releases. Only then is the public record written: the `CONTEXT.d/`
   fragment, the changelog entry, and the advisory publication, together.
4. A public issue may be opened at that point to track follow-up hardening.

A fragment written during an embargo may record *that* a finding exists and was routed
privately. It must not name the component, the mechanism, or the repro.

Regression tests are the one careful exception: a test that pins the fix ships with the
fix, and its name and comments will describe the bug. That is correct and unavoidable —
write them at release time, not before.

## Scope

The following are in scope:

- **Update and installer integrity** — the in-app updater downloads and launches
  installers. This ships code to a user's machine and is the highest-consequence surface
  in the product. (Checksum verification is tracked in #111 and is not yet complete;
  reports are welcome, but that specific gap is already known.)
- **Credential storage and handling** — OS credential store usage, and any place a token
  or secret is written to disk or handed to a child process
- **IPC message handling** between main, preload, and renderer
- **PTY input and command injection** — argument construction for spawned shells
- **Prompt injection leading to command execution** — CCC runs an agent that acts on
  untrusted repository content and can spawn shells. Anything that turns content a user
  merely *opened* into a command the machine *ran* is in scope, and is the threat class we
  most want reports about.
- **MCP server access control** — the loopback Conductor server, its auth token, and the
  tools it exposes. Some exposed tooling executes code by design (browser evaluation via
  the vision tools); the boundary under test is *authentication and authorisation of that
  tooling*, not its existence.
- **Malicious or compromised MCP upstreams** reached through Conductor Proxy
- **SSH session handling**, including data a remote host can send back to the app
- **Local file access outside intended directories** — path traversal, symlink handling
- **Privilege boundaries between local user accounts** on a shared machine

## Out of scope

- Issues in Claude Code CLI itself — report to [Anthropic](https://github.com/anthropics/claude-code)
- Issues in Electron, Node, or Chromium — report upstream
- Social engineering
- Attacks requiring physical access to an unlocked machine. Credentials are machine-bound
  by design; an attacker at the keyboard of an unlocked session has already won.
- Anything requiring the user to already be running attacker-controlled code under their
  own account
- Missing hardening with no demonstrated impact (absent headers, version disclosure, and
  similar) unless you can show what it buys an attacker

## Security posture

These are the properties the project is *built for*. They are stated as posture, not as
guarantees, because the difference matters: an unqualified guarantee tells a reporter a
boundary is already covered, so they stop looking — which is exactly where bugs
accumulate. Where a property is conditional, it says so.

- **No telemetry.** The app sends no analytics or tracking data.
- **Local-only storage.** Config, logs, and session state stay on the machine. Network
  egress is to provider APIs, hosts you explicitly SSH to, and the update endpoint.
- **Renderer sandboxing — enforced.** Application windows run with
  `contextIsolation: true`, `nodeIntegration: false`, and `sandbox: true`. All
  renderer↔main communication crosses a typed preload bridge.
- **Credential storage — the OS credential store for the credentials CCC owns.** Provider
  OAuth credentials are held by the OS store. This is *not* a claim that no secret is ever
  on disk: the app also mints local secrets (for example the loopback MCP token) that are
  persisted in the resources directory and passed to child processes, because a spawned
  session has to be able to read them. Those are local-trust values rather than account
  credentials, and they are only as protected as the user's own file permissions.
- **IPC validation — enforced at the preload bridge.** Renderer↔main channels are typed
  and schema-validated. Data arriving over *other* paths is not uniformly held to the same
  standard, and hardening those paths is ongoing. Treat them as in scope for reports.
- **Code execution — no `eval` of remote content, but some tooling executes code by
  design.** The app loads no remote scripts and does not `eval` untrusted input.
  Separately and intentionally, the vision MCP tools evaluate JavaScript in the controlled
  browser instance; that capability sits behind the MCP token. A bypass of that
  authentication is a vulnerability. The capability itself is a feature.

## How we find these ourselves

So contributors know what bar applies, and reporters know what has already been swept:

- **CodeQL** — static analysis on push and on a schedule. Dismissing an alert is itself a
  security decision and is reviewed like a code change.
- **Dependabot** — dependency alerts, with transitive fixes pinned through the `overrides`
  block in `package.json`.
- **Adversarial review** (ADR-009) — security-sensitive changes get an independent
  multi-agent pass that tries to break them before merge, instead of an author re-reading
  their own diff. The path table deciding when it applies lives in
  `.claude/skills/adversarial-review/SKILL.md` and is derived from the Scope section
  above, so this document and that gate stay in step.
