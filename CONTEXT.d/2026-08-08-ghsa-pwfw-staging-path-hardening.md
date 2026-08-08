## 2026-08-08 -- Predictable staging paths let a planted link capture credential writes (GHSA-pwfw-2ggq-569x)

Published, so this can be written down. Severity high, no CVE requested. Affects
2.1.0-beta.6 and earlier; fixed on `beta` by the private-fork merge `aada4ca`.

Every atomic write in the main process staged its payload next to the destination and
renamed it over: `writeFileSync(tmp, ...)` then `renameSync(tmp, file)`. The staging name
was predictable -- `<file>.tmp` in the credential writers, `<file>.tmp.<pid>` elsewhere --
and a plain `writeFileSync` both follows a symlink and happily opens a path that already
exists. Two consequences, and the second is the one that surprised people:

- A link pre-planted at the staging path redirected the write, and on POSIX `rename(2)`
  then moved the SYMLINK over the destination -- so `.credentials.json` itself became a
  link into attacker space, and every later read and write followed it. Persistent across
  restarts and re-logins.
- The `0600` request silently did not apply. A mode passed to `open(2)` is honoured ONLY
  on creation; writing into a pre-existing inode inherits that inode's permissions. The
  compensating `chmodSync` then followed the link and hardened the ATTACKER's file while
  reporting success.

Preconditions, stated honestly because they bound the severity: the attacker needs create
rights in the directory holding the target. On a default single-user install that is
same-uid, which could already read a 0600 file -- no gain. It becomes a real crossing when
the resources dir is shared or group-writable, which the product invites: `config-manager.ts`
documents it as able to "live on a network drive for portability", and the `mkdirSync` calls
on that path pass no mode.

Fixed with two properties that have to travel together:

- `flag: 'wx'` (`O_CREAT|O_EXCL|O_WRONLY`). `open(2)` with `O_CREAT|O_EXCL` fails EEXIST on
  an existing file AND on a symlink, including a dangling one. It also means the file is
  ALWAYS created, which is what makes the mode argument apply -- one change closes both
  halves.
- `randomUUID()` staging names, so the path cannot be pre-created. `github/cache/cache-store.ts`
  and `github/github-config-store.ts` already staged this way; the credential writers did not.

Then `@nubbymong` found the gap in that fix, which is the part worth remembering: `O_EXCL`
guards the staging FILE and does nothing about a junction planted on a DIRECTORY above it.
The leaf is still created fresh -- just inside attacker space, where on Windows it inherits
that directory's ACL and the POSIX mode is a no-op. `mkdir -p` silently ACCEPTS a
pre-existing junction, so it is not even a race. `mkdirSecure` now walks every app-created
segment up to a trusted anchor and refuses a reparse point. The anchor matters: the
resources dir and `~/.claude` may legitimately be symlinks, so inspecting them would turn a
supported layout into a permanent silent credential-write failure.

Two more write-throughs came out of the same pass, both one function away from the one
originally reported: `copyCredentialFile` was a plain `copyFileSync` (opens the destination
through a planted link, then hardens the attacker's file), and `restoreProfileHomeFromCanonical`
read from an identity dir without checking it, so a planted dir restored an attacker-chosen
token into the live home -- account fixation, the inverse of the reported bug.
`backupRealClaudeOnce` also now checks its staging path BEFORE `rmSync`, so a `force`
recursive delete can never be walked through a junction into another tree.

## How it was found, and the process note

An `/adversarial-review` pass on #233 surfaced it as PRE-EXISTING, not as a defect of the
change under review. That is Phase 3.5 working exactly as written: the finding went to a
private advisory and the fix to the private fork, while #233's own four defects stayed in
the public PR discussion. Nothing about the mechanism was written to any tracked file until
publication -- this fragment is the first.

Worth keeping about the tooling: **a GHSA private fork refuses `gh pr comment`
(`addComment forbidden`) and 404s `issues/<n>/comments` on READ as well -- but it ACCEPTS
`gh pr review --comment`.** The earlier note claiming every comment API is blocked was
wrong and would have cost another detour. Because the read side 404s too, a maintainer's
reply in the PR conversation box is invisible to the API; the PR object's `.comments` COUNT
is still readable, which is the honest way to detect one. Filed against the runbook in #211.

Also: merging the private fork's PR pushes the code to the PUBLIC repo immediately
(`aada4ca`, "Merge commit from fork") while the advisory stays draft. Code-public and
advisory-published are two different moments, and the public record still waits for the
second.

## The constraint this puts on #233

#233 consolidates every hand-rolled staging write into one shared helper. Its branch was cut
BEFORE this fix and its helper stages `<file>.<pid>.<seq>.tmp` with a plain write -- so
merging it as it stands would REVERT this advisory on the public repo, under a
performance-refactor title. It must be rebased onto `aada4ca` and its helper must carry
`flag: 'wx'` and an unguessable name before it goes anywhere near `beta`.

The non-credential writers (`config-manager`, `session-state`, `channel-storage`,
`model-registry-service`, `sentinel-state`, the two hooks writers, `codex-review-usage`,
`conductor-mcp-server`) still stage predictably. They carry the arbitrary-file-clobber half
but no secrets, which is why they were left out of the embargoed fix rather than fixed twice
and guaranteed a conflict. #233 is where they get it.

## Gate

Guards were verified against the unfixed code, per the standing rule. Reverting the flag and
the name turns 4 of the platform-agnostic assertions red ON WINDOWS -- deliberate, because
every pre-existing credential-mode guard in this repo is `runIf(platform !== 'win32')` and
therefore silently no-op on the Windows leg. Mutation on the follow-up commit: the
`mkdirSecure` reparse rejection, the `copyCredentialFile` revert and the backup staging check
each killed their mutant; `COPYFILE_EXCL` SURVIVED with no test, and `dcc72f8` closed that.

Two accepted, documented residuals: `mkdirSecure` creates then validates, so a plant already
in place gets directories made inside it before the throw and a plant landing between the
walk and the write still wins (Node exposes no `openat`-style walk); and
`restoreProfileHomeFromCanonical` separates its own throw from an `lstat` failure by matching
message text, which fails safe but is brittle.
