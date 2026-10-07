# ADR-023: More than one Claude account on macOS, behind an experimental setting

- Status: Accepted
- Date: 2026-10-07

## Context

On Windows and Linux each Claude account profile runs under its own home
(`USERPROFILE`, plus `HOME` on Linux), and Claude Code keeps that account's
sign-in in a file under it. WP1 owner decision D1
(`docs/wp1/owner-decisions-2026-09-20.md`) fixed that as the realm mechanism
and ruled `CLAUDE_CONFIG_DIR` out as an implementation mechanism. D2 kept the
existing macOS limit -- one Claude account -- for WP1, "not a permanent
architectural exclusion".

macOS is different because of where the sign-in lives. Claude Code stores it
in the login Keychain, and macOS finds the login Keychain through `$HOME`.
Pointing `HOME` at a profile folder (which mirrors dot-entries, not
`~/Library`) leaves `claude` with no Keychain at all -- the "A keychain cannot
be found" dialog, #117 -- so `withProfileHome` leaves `HOME` real on macOS. With
`HOME` real and nothing else redirected, every profile reads the same Keychain
item: added accounts would silently share one sign-in. That is why the
Accounts panel offered no second account on macOS.

Claude Code documents `CLAUDE_CONFIG_DIR` as moving both its config folder
and its macOS Keychain entry. A hand check on a Mac (2026-10-06, CLI only) found
the item named `Claude Code-credentials-<first 8 hex of sha256(dir)>` for a
given `CLAUDE_CONFIG_DIR=dir`, `.claude.json` written inside `dir`, and two
sign-ins coexisting, isolated both ways. On 2026-10-07 `claude auth status`
was confirmed to report `"configDirectory": "<dir>"` (and
`"projectsDirectory": "<dir>/projects"`) under `CLAUDE_CONFIG_DIR`, and
`~/.claude` without it, on Claude Code 2.1.292. The oldest CLI version that
behaves this way is not established (2.1.56 or later is expected, unverified).

## Decision

Recorded on aicc_planning#172 by ssbn on 2026-10-07. This ADR records those
decisions; it does not claim the owner's ratification beyond that record.

1. **`CLAUDE_CONFIG_DIR` is allowed as the macOS realm mechanism.** This
   supersedes D1 for macOS only. A non-primary macOS profile runs with
   `CLAUDE_CONFIG_DIR` and `CLAUDE_SECURESTORAGE_CONFIG_DIR` set to one stable
   string, `path.resolve(<profile home>, '.claude')` in NFC, and
   `ANTHROPIC_CONFIG_DIR` under it; `HOME` stays real (#117). The primary
   profile is the user's normal sign-in and is not redirected. Windows and
   Linux are unchanged.
2. **The macOS single-account limit is lifted behind an experimental setting**
   (`experimentalMacMultiAccount`, off by default, Settings > Accounts > Claude
   card, macOS only). This supersedes D2.
3. **With the setting off, a non-primary macOS profile's launch is refused**
   (`MANAGED_LAUNCH_REFUSAL`, "multiple Claude accounts on macOS is turned
   off..."), rather than run on the primary's sign-in under its own label. When
   the primary cannot be told (profiles list unreadable, or more than one
   profile and none marked primary) every profile-home launch is refused; with
   zero or one profile none is.
4. **Guard: a non-primary launch is refused unless the CLI proves it isolates.**
   Before a realm launch, `claude auth status` runs under the same realm
   environment with the CLI the launch will run, and its `configDirectory` must
   be exactly the realm folder (both normalised with `path.resolve` + NFC, the
   rule the Keychain hash uses). A missing field, unparseable output, a
   non-zero exit without JSON, or another folder refuses the launch with "the
   installed Claude Code does not keep a separate sign-in per account folder;
   update Claude Code". A probe that times out or cannot start refuses it
   with a retryable message. A positive verdict is cached per (realm folder,
   CLI path, CLI file identity: realpath, size, mtime), and the installed CLI
   is re-resolved at most every 10 minutes.

## Consequences

- **Where the guard is enforced.** `src/main/mac-realm-guard.ts` runs the
  probe; `src/main/mac-realm-verdict.ts` holds the cache. Every launch path
  awaits the check before its choke point (sessions and the add-account shell
  in `pty-manager`, headless runs, Insights, cloud agents, the Claude
  reviewer, the Accounts panel's status probe), and the synchronous choke
  points -- `withProfileHome` and `profileRealmLaunch` -- refuse a realm launch
  with no positive verdict, so a caller that forgets to ask fails closed. Only
  the verdict probe itself is exempt (`realmVerdictProbe`). A pinned legacy
  CLI needs its own verdict; an uninstalled pin is refused on the realm.
- **Setting off is base behaviour, with two exceptions.** The
  `claude auth status` probe no longer sets `HOME` to a profile home on macOS
  (the #117 fix, applied to the probe), and non-primary launches are refused
  (item 3). Deleting a non-primary profile also deletes its suffixed Keychain
  item, best-effort.
- **A Keychain credential backend.** With the setting on, every reader and
  writer of a profile's credential goes through one seam
  (`profileCredentialLocation`): `/usr/bin/security` via `execFile`, the secret
  only on stdin, never on argv; the fallback file is read only after the
  Keychain confirmed the item absent; detected-account capture moves the token
  Keychain to Keychain, serialised per profile, and keeps exactly one holder of
  the single-use refresh token (details in
  `CONTEXT.d/2026-10-06-mac-multiaccount.md`).
- **Not yet verified inside the app on a Mac.** The mechanism was checked by
  hand with the CLI; the app build needs the Mac checklist in the CONTEXT
  fragment run, and the CLI version floor recorded.
- **What the guard proves.** It proves that the CLI honours
  `CLAUDE_CONFIG_DIR` for its config folder (`configDirectory`). On the
  verified CLI, Claude Code 2.1.292, that coincides with the Keychain item
  being suffixed for that folder (the 2026-10-06 hand check); the guard does
  not read the Keychain item itself. On 2.1.292 a SIGNED-OUT realm's
  `claude auth status` also prints `configDirectory`, verbatim as given
  (e.g. `/tmp/ccc-x`, not realpath'd), so the add-account shell passes.
- **The launch runs the binary that was checked.** Every realm launch runs
  the absolute path its verdict was taken for, not a bare `claude` its own
  shell would look up (an interactive zsh reads `.zshrc`, the verdict's
  lookup is a login, non-interactive shell): sessions and the resume picker
  (`CCC_CLAUDE_BIN`), Insights, headless runs and the status probe (no
  shell), cloud agents (quoted), and the reviewer (refused unless its
  executable is the same file). A realm shell-only session -- the add-account
  and re-auth shells, or a plain shell on that account -- gets a `claude`
  shell function pinned to that binary (zsh, bash, sh, ksh, dash; another
  shell is logged and keeps its PATH). A pinned legacy CLI keeps its own
  path. After the 10-minute TTL an unchanged CLI keeps serving while a fresh
  lookup runs in the background; a launch within 30 seconds of the TTL
  counts as pending. Output with no JSON object (or over 1 MB) is refused as
  unreadable, with its own message.
- **Open items.** Pending refreshed tokens kept in memory are lost on an app
  exit before a locked Keychain answers. A command the user types in a realm
  shell other than `claude` itself (an absolute path to another CLI, or a
  shell that cannot take the pinning function) is not covered by the guard.
  The oldest CLI version that honours `CLAUDE_CONFIG_DIR` this way is not
  established; only 2.1.292 is verified.