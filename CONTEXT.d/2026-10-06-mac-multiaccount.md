## 2026-10-06 -- Experimental macOS Claude multi-account (CLAUDE_CONFIG_DIR realm + Keychain backend), off by default

**What.** An opt-in setting, `experimentalMacMultiAccount` (saved in
settings.json, default absent = off), lifts the D2 single-account limit on
macOS. Rule in `src/shared/mac-multi-account.ts`; main reads the same saved
key at every launch (`src/main/mac-multi-account.ts`, injected into
account-profiles as a probe because config-manager imports account-profiles);
the renderer reads it from the settings store. Toggle: Settings, Accounts,
Claude card, macOS only. win32/linux, setting on or off: unchanged. Setting
off on macOS = base behaviour EXCEPT (a) the `claude auth status` probe no
longer sets HOME to the profile home (the #117 keychain fix, applied to the
primary and to any profile when no primary is recorded) and (b) a NON-primary
profile's managed launch is REFUSED (MANAGED_LAUNCH_REFUSAL, reason `multiple
Claude accounts on macOS is turned off...`) instead of silently running on
the primary's Keychain sign-in under its own label; when the primary cannot
be told (profiles.json unreadable, or more than one profile and none marked
primary) every profile-home launch is refused, with 0-1 profiles none is.
Base macOS never created non-primary profiles, so (b) only affects states
this feature creates (and, for the unknown-primary case, a corrupt profiles
list). With the setting off, deleting a non-primary profile still runs one
`security delete-generic-password` for its suffixed item, best-effort: a
Keychain that does not answer does not block the delete (it fails closed
only with the setting on).

**Realm (darwin, setting on).** A non-primary profile runs with
`CLAUDE_CONFIG_DIR` and `CLAUDE_SECURESTORAGE_CONFIG_DIR` =
`path.resolve(<home>, '.claude').normalize('NFC')` and `ANTHROPIC_CONFIG_DIR`
= `<that>/anthropic`; HOME stays the real home (#117). The primary profile is
the user's normal sign-in: no redirect, real `~/.claude`, unsuffixed Keychain
item. `macClaudeStore(home)` names which of the two a home is; a home that
resolves to no profile id is neither (null, unmanaged). The Claude
package owns `CLAUDE_CONFIG_DIR`; its manifest ruling stays `strip`.

**Credential backend (pass 2, parity).** `src/main/claude-credential-store-darwin.ts`
talks to `/usr/bin/security` via execFile (no shell, 8 s timeout). Service =
`Claude Code-credentials` (primary) or `Claude Code-credentials-<first 8 hex
of sha256(UTF-8 of the NFC dir string)>` (realm); account = `$USER`, else the
OS user name (the CLI's order).
Read: `find-generic-password -a -s -w`; exit 44 = not found, any other
failure or timeout = unknown (never "signed out"); hex output decoded; the
secret must parse as the `.credentials.json` shape or it is unknown.
Concurrent reads of one service share one process; an unknown answer is
reused for 30 s (no stacked unlock dialogs from the 4 s polls); every read a
write or delete decision rests on bypasses both (`fresh`, its own process,
started after any mutation it verifies). The re-auth baseline uses a
`latest` read: skips the 30 s cache but shares the in-flight read and starts
at most one process per 10 s per service. Every write and delete drops the
shared/cached state for its service, and a read that started before one
never records its answer for later readers. Write:
`security -i` with ONE line on stdin, `add-generic-password -U -a "<user>" -s
"<service>" -X <hex>`; argv is only `-i`, so the token never reaches the
process table; hex cannot break security's line parser (split_line); lines
of 4000 bytes or more are refused with `credential too large for the Keychain
write path` (security truncates at 4096); success means
the item reads back byte-equal. Delete: `delete-generic-password`, refused by
shape for the unsuffixed item.
`profileCredentialLocation(id)` in account-profiles is the one seam: `file`
(unchanged path) or `keychain` (service + the fallback file). The fallback
file is read ONLY after the Keychain confirmed not-found (exit 44); a
Keychain that cannot be asked is unknown overall, so neither a capture nor a
refresh ever acts on a file token the item may have rotated past. Routed through it: account usage read and refresh
write-back (`account-usage.ts`), auth info (`readProfileAuthInfoAsync`),
re-auth stamp (`readProfileCredentialStampAsync`, a truncated sha256 of the
secret; an unreadable item is an explicit `unknown`, never a baseline), `claude auth status` fallback, detected-account capture and identity
restore (`captureDetectedAccountAndClearSource`: token moved Keychain item to
Keychain item; refused when the source cannot be read, has no credential,
or the Keychain and the fallback file hold different tokens; before the
source is deleted it is re-read and must still hold the exact secret that
was copied; captures AND deletes of one profile are serialised in main, so a
source that is already gone at the re-read or the delete was signed out
elsewhere (CLI /logout, an external delete) and the copy, then the only
holder, is kept; the source's
Keychain item is deleted FIRST and its fallback and identity files only
after that succeeded; if it was not deleted (or changed, or raced) the new
item and profile are rolled back, nothing on the source was touched, and
the prompt shows an error saying so; once it WAS deleted the capture is
committed and a later failure (identity restore, fallback file) is logged,
never rolled back; a new item that cannot be confirmed deleted on rollback
leaves its profile row to remove by hand -- one holder of the refresh
token, always; messages to the renderer carry no local paths), profile delete
(`removeProfileKeychainItem`, fail closed, in-use re-checked after the
Keychain call), the /login watcher
(primary identity = real `~/.claude.json`; no capture prompt for the primary),
Insights report path for the primary (`claudeDataHomeFor`), and the local
statusline bridge on macOS (identity from `$CLAUDE_CONFIG_DIR/.claude.json`,
usage fetch dropped for realm sessions; that snippet is deployed only once
the setting has been on during the run, and reads the identity only when it
is a regular file under 5 MB). The legacy file writers (session-home
salvage, home-layout migration, primary/global credential sync, global-login
capture) write no credential file for macOS profiles with the setting on. Refresh race: same contract as the
file path (in-use guard, in-flight publication, compare refresh token before
write, abort if rotated or removed); no lock on either platform. One
deliberate difference: a refresh whose POST succeeded but whose Keychain
write-back met a locked/unanswering Keychain keeps the minted tokens in
memory and retries the write at the next fetch (no second POST meanwhile);
an app exit first loses them. They are written only over the exact refresh
token that was spent (a newer sign-in, even one with no refresh token, wins
and they are dropped), dropped when the profile's credential is removed,
and a launch waiting on the profile's refresh waits up to 10 s for them to
land before it reads the item (then starts anyway, logged). Before any
refresh POST the item is re-read on its own and must still hold the refresh
token being spent. The toggle's failed save is replaced by the
reverted settings in the BottomBar Retry queue, and the statusline script is
written temp-file-then-rename.

**Not at parity / decisions.** (1) Capture of a /login made in a PRIMARY
session on macOS is refused: that /login replaced the user's normal sign-in
itself; moving it would sign the terminal `claude` out, copying it would
create two holders of one refresh token. (2) With the setting off and the
profile list unreadable (or no primary recorded), a non-primary launch is
refused unless there are 0-1 profiles (re-attack r7); this can refuse the
real primary's sessions while profiles.json is corrupt.
(3) Realm sessions' statusline shows only the 5h/weekly figures from stdin;
per-model buckets come from the Account usage page. (4) Decisions recorded on aicc_planning#172 (2026-10-07):
CLAUDE_CONFIG_DIR allowed as the macOS realm mechanism (supersedes D1 for
macOS), the limit lifted behind the setting (supersedes D2), setting-off
refusal approved, and a GUARD: architecture/decisions/
2026-10-07-adr-024-macos-claude-multi-account.md. The guard
(src/main/mac-realm-guard.ts, cache in mac-realm-verdict.ts): before a
non-primary realm launch, `claude auth status` runs under the same realm env
with the CLI the launch runs and must report `configDirectory` equal to the
realm folder (path.resolve + NFC); otherwise refused (`the installed Claude
Code does not keep a separate sign-in per account folder; update Claude
Code`), or refused retryably on a timeout / a probe that cannot start.
Positive verdicts cached per (folder, CLI path, CLI realpath+size+mtime),
CLI re-resolved at most every 10 min; every launch path (sessions + the
add-account shell, headless, Insights, cloud agents, reviewer, the status
probe) awaits it, and withProfileHome / profileRealmLaunch refuse a realm
launch with no verdict (fail closed). Verified 2026-10-07 on the operator's
Mac, CLI 2.1.292: a SIGNED-OUT realm's `claude auth status` still prints
configDirectory (`/tmp/ccc-x`, reported verbatim, not realpath'd to
/private/tmp), so the add-account shell passes the guard. Re-attack r3 on
the guard (fixed, each with a revert-proven test): every realm launch now
RUNS the binary its verdict was taken for -- sessions and the resume picker
(CCC_CLAUDE_BIN), Insights, headless and the status probe (absolute path, no
shell), cloud agents (quoted), the reviewer (must be the same file) -- and a
realm shell-only session (add-account, re-auth, plain) gets its hand-typed
`claude` pinned to that binary by a shell function (zsh/bash/sh/ksh/dash;
other shells logged) -- since re-attack r4 typed as separate lines AFTER the
unchanged base `cd ...; clear` line (`unalias claude` alone first: an rc
alias made the one-line form a bash/dash syntax error that ran the alias and
lost the cd; checked in real bash and dash), control characters in the path
refused, and the verified folder first on PATH for children (a login shell's
path_helper may reorder it: accepted limitation); after the 10-min TTL an unchanged CLI keeps serving
while a background lookup runs (a slow login shell no longer refuses);
launches within 30 s of the TTL count as pending; the probe's output is
scanned for the last JSON object with configDirectory, and output with no
JSON (or over 1 MB) is refused as unreadable with its own message. (5) ADR-009
adversarial review: pass 3 findings (4 MAJOR on capture/refresh token
handling and setting-off launches, 12 minor) fixed with regression tests,
each shown to fail with its fix reverted; re-attack round 1 (4 MAJOR on the
rollback ordering, concurrent captures and the toggle Retry; 8 minor) fixed
the same way; round 2 PASS (no MAJOR) with 6 minor, fixed the same way.
Merged with beta 1a5e9de5 (WP2 PRs 3-4): the ADR is renumbered ADR-024 (beta
owns ADR-023); beta's sign-in status / sign-out runner gets the verified
binary on the realm (compose.ts claudeAuthExecutable, after the check); a
realm profile's sign-out needs no computer-sign-in acknowledgement; with the
setting off a non-primary macOS sign-out is refused like its sessions. A macOS
run of the SSH live matrix (statusline.ts) is not yet run. CI on PR #629
(3fa8fade): two code fixes on darwin, setting off -- the SYNC profile auth
read is base again (reads home/.claude.json; only the Keychain path asks for
the identity file), and a home whose profile id cannot be derived is not
refused (base behaviour) instead of throwing out of the launch choke point.
Test-only: the refused-gate test counts only an `auth` run (the preflight's
read-only `command -v claude` version lookup also runs on POSIX); the C1
characterization asserts the non-primary refusal on macOS and characterizes
the primary there; pty-spawn-waits-for-refresh runs as linux on a macOS host
(its profiles are non-primary by design). Mac desktop test: Switch account
did not resume the conversation. Cause (all platforms, lost on macOS): the
renderer's Restart kills the old PTY in its own IPC before the respawn; a
fast exit ends the run and the transcript binder drops the exact bind, so
the spawn captured no target and opened the picker. Fix: killPty with reason
'restart' captures the target while the bind is held; the next spawn of the
id takes it when its own capture is empty (pty-manager.ts). Transcripts were
already shared (<profile>/.claude/projects links to ~/.claude/projects).

**Mac check (2026-10-06, operator's Mac, manual CLI, not the app).** With
`CLAUDE_CONFIG_DIR=<dir>` and `/login`: Keychain item
`Claude Code-credentials-<sha256(dir)[0:8]>` created; `.claude.json` written
inside `<dir>`; `claude auth status` loggedIn true with configDirectory =
`<dir>`. Unset, the default login is the unsuffixed item and `~/.claude`.
Both logins coexisted, isolated in both directions.

**Mac test checklist (app build from this branch; Settings, Accounts, Claude
card, toggle "Experimental: multiple Claude accounts on macOS" ON).**
0. DONE 2026-10-07 (CLI 2.1.292): signed-out `CLAUDE_CONFIG_DIR=/tmp/ccc-x`
   `claude auth status` prints `configDirectory` = `/tmp/ccc-x`. Re-run it on
   any other CLI version tested.
0b. With `alias claude=...` in ~/.zshrc, open the add-account tab and run
    `pwd` and `type claude`. Expect: the configured folder (the cd ran), and
    `claude is a shell function`. Also run `echo $PATH` in a B session's Bash
    tool: the verified binary's folder should come first (if not, record it:
    path_helper reordered it).
    In the add-account tab, run `type claude`. Expect: `claude is a shell`
   `function`; it runs the absolute path the app checked. Put an older
   `claude` first on PATH in ~/.zshrc and start a B session: the session runs
   the checked binary (`ps -o args` shows the absolute path), not the older.
1. Add another account, `/login` as account B in the tab that opens. Expect:
   the account row shows B within ~5 s; Keychain Access shows a new item
   `Claude Code-credentials-XXXXXXXX`; no Keychain password dialog.
2. In Terminal: `printf '%s' "<profiles root>/<id>/.claude" | shasum -a 256`.
   Expect: first 8 hex = the item's suffix from step 1.
3. Open a session on B and on the primary side by side; run `/status` in
   each. Expect: different accounts; the session chips show the right email.
4. Account usage page with no B session open. Expect: B shows live figures
   (not "Sign in", not "open a session").
5. Wait for B's access token to lapse (or edit expiresAt down in the item
   via `security`), close all B sessions, open the usage page. Expect: live
   figures; then `security find-generic-password -a "$USER" -s <B service> -w`
   shows a new accessToken; `ps aux | grep security` during the refresh never
   shows token text.
6. Run this after step 7 (which leaves B signed out): usage page, "Sign in"
   on B, `/login` as B. Expect: the login tab's guidance clears and B shows
   live figures.
7. In a B session run `/login` as a NEW account C. Expect: the "new account
   detected" prompt; Add creates profile C signed in as C (no new login
   needed); B's row then reads Sign in; B's old item is gone from Keychain
   Access; C's item exists.
8. In a PRIMARY session run `/login` as another account. Expect: the chip
   changes, no capture prompt (documented refusal).
9. Delete profile C (no C session open). Expect: the row disappears and C's
   Keychain item is gone; the unsuffixed `Claude Code-credentials` item is
   untouched.
10. Make B the Claude reviewer; run a Claude review from a Codex session.
    Expect: it runs as B.
11. Insights on the primary and on B. Expect: a report for each.
12. Lock the login keychain (`security lock-keychain`), open Accounts.
    Expect: "Sign-in state unknown" (not "Not signed in"); unlock restores.
13. Toggle OFF, restart. Expect: the D2 note, one account, no `security`
    process started by the app (Activity Monitor), primary works as before.
14. Record `claude --version` used, so the version floor can be stated.
    Also: with B present, put an OLD Claude Code first on PATH (one that
    ignores CLAUDE_CONFIG_DIR, if one is at hand) and start a B session.
    Expect: refused, `update Claude Code`; the primary still starts.
15. Lock the login keychain with a stale `<B config dir>/.credentials.json`
    present (copy B's item text into it, then rotate B by using a B session).
    Open Accounts and the usage page. Expect: B reads unknown / last-known,
    no token refresh request, and capture from a B session is refused.
16. In a B session `/login` as C, and before clicking Add, make the B item
    undeletable (lock the keychain). Click Add. Expect: the prompt stays open
    with an error; no C profile; B's item unchanged; no second item.
17. Same as 16 but use a running B session to rotate B's token between the
    prompt opening and Add. Expect: error `changed while it was being
    copied`, no C profile, B's item holds the newer token.
18. With a B profile present, toggle OFF (or make settings.json unreadable).
    Start a B session, an Insights run on B, and a cloud agent on B. Expect:
    each refuses with `multiple Claude accounts on macOS is turned off`; the
    primary still works; `/login` never reaches the normal sign-in from B.
19. Toggle ON while the settings save fails (e.g. settings.json read-only).
    Expect: the toggle flips back with `could not be saved`; then make it
    writable and press the BottomBar Retry: the toggle stays OFF.
20. Double-click Add on the new-account prompt (or trigger two adds).
    Expect: one new profile, one new Keychain item, the source item gone.
21. Lock the keychain right after a B refresh starts (expired B, usage page).
    Expect: usage still shows; after unlock and a refresh of the page, B's
    item holds the new token and no second refresh request is made. Repeat,
    but start a B session instead of refreshing the page: the session starts
    within ~10 s and runs signed in (the pending token lands first).
22. In a B session `/login` as C; before clicking Add, run `/logout`
    in another B session. Click Add. Expect: profile C is added and signed in
    as C; no error; B reads Sign in.
23. Delete profile B while the Add prompt for a capture out of B is being
    processed (click Add, then Delete at once). Expect: the add finishes first,
    then the delete; never two items holding one sign-in.
24. Lock the keychain and open a B re-auth tab; watch Activity Monitor.
    Expect: at most one `security` process about every 10 s, not every 4 s.
