# 2026-09-09 — #226: dev preflight for a missing Electron binary

Closed out with the 2.1 line on owner instruction. Dev-tooling only — no app
code, no user-facing surface, so deliberately **no changelog entry** (that file
drives the in-app What's New).

## The failure

A worktree can look completely installed while the one file that matters is
missing. `node_modules/electron/` exists, `package.json` is satisfied and
`npm ls` is clean, but `node_modules/electron/path.txt` and the binary it names
are absent. The repo's `postinstall` is
`electron-rebuild --only=node-pty,better-sqlite3`: it rebuilds the two native
addons and does nothing about Electron itself, whose binary is downloaded by the
`electron` package's own install script. When that does not run, or does not
finish, nothing notices.

What the operator actually sees is `Error: Electron uninstall` thrown from inside
electron-vite — in a launcher window that closes the instant the command dies,
with the real message only in `dev-logs/ccc-dev-*.log`. Observed on three
occasions across two worktrees (`ccc-wt/209`, `ccc-wt/216`); each debugging
session started at "the app crashed" and ended at "the dev environment was never
set up". None was about the code under test.

## The fix

`scripts/preflight-electron.mjs`, wired as **`predev`** — so `npm run dev` and
the `ccc` launcher (which shells out to `npm run dev`) both get it without either
having to remember. Two stat calls when the tree is healthy.

It resolves the binary exactly as electron-vite does: read `path.txt`, which
holds a path relative to the package, and check the file it names. Both halves
matter — `path.txt` present with the binary gone is the state that fails, and it
is precisely what a half-finished install leaves behind, so a presence check on
`node_modules/electron/` alone would call it healthy.

On a broken tree it re-runs `node node_modules/electron/install.js` — the same
step that fixed it by hand both times — and re-checks. A missing **package** is
reported separately and NOT healed: `install.js` cannot conjure one, and reaching
for `npm install` is the very thing that breaks these trees.

## The rule

`AGENTS.md` now says it outright: **never `npm install` in a worktree — use
`npm ci`**, in the worktree you are working in. The preflight is a safety net for
when it happens anyway, not permission to keep doing it.

## Verification

`tests/unit/scripts/preflight-electron.test.ts` (8 cases) drives the detector
against a fake fs, so no real `node_modules` is touched. It pins the observed bug
(`path.txt` present, binary gone), each failure reason as distinct — the remedies
differ — and two traps: an empty `path.txt` must not resolve to the `dist`
directory and read as healthy, and an unreadable one must be reported rather than
thrown into electron-vite. Deleting the binary check turns the bug case red.
