# Claude Command Center — User Guide

A task-oriented manual: *how do I…* for everyday use. For the feature tour and
install instructions see [`README.md`](../README.md); for running a dev build
next to your install see [`dev-alongside-prod.md`](./dev-alongside-prod.md).

---

## Getting started

1. Install (see README → Install) and launch. On first run, CCC picks a data
   directory and checks that the `claude` CLI is on your PATH.
2. Create a **saved config** — a reusable launch template (working directory,
   account, model, provider, options). Configs live in the sidebar.
3. Click a config to start a **session**. Each session is a live terminal running
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
Account*. (macOS runs a single account — see the keychain note in the README.)

## Logs & transcript viewer

Every session's conversation is indexed locally (never leaves your machine). The
**Logs** tab is a chat-style transcript viewer with search and a timeline. Slots
are labeled by the session's work name (or config label), so a renamed session is
easy to find later.

## Tokenomics, Memory, and the rest

The README covers these in depth: **Tokenomics** (cost/usage analytics),
**Memory** dashboard, **Sentinel**, **Conductor MCP** (incl. vision capture),
**Agent Hub**, **Codex** provider, **GitHub** PR context, **Combined Mode /
Draw**, **Snap / Vision**, and **Dynamic workflows**. See README → *Highlights*
and *The rest of the surface*.

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

- **CLI not found:** ensure `claude` is on your PATH (Onboarding → *Find Claude*).
- **No terminal cursor:** the caret is a thin bar; it shows a hollow outline when
  the terminal isn't focused. (Claude/TUI sessions deliberately hide it — they
  draw their own.)
- **Slow first paint in dev:** use a current build — the boot-time backfill and
  dev source-watcher now run deferred/async.
- **Where's my data?** Prod uses the data dir chosen at setup (default
  `%LOCALAPPDATA%\Claude Command Center`); a dev build uses `…\Claude Command
  Center\dev`.
