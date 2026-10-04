## 2026-10-04 -- Tests and probes never act on a real home (enforced by the harness)

**Why.** A written rule did not stop a test or a review probe from acting on a
real home folder, so the guarantee is now enforced by the test harness itself.

**What.** Every vitest run (`vitest.config.ts`, `vitest.native.config.ts`) loads
`tests/helpers/home-isolation.ts` as its FIRST setup file. It points HOME,
USERPROFILE, APPDATA, LOCALAPPDATA, CLAUDE_CONFIG_DIR and CODEX_HOME (and
HOMEDRIVE/HOMEPATH on Windows) at a fresh folder per worker, re-asserts them
before every test, and installs the guard in `tests/helpers/home-guard-core.mjs`,
which throws `TEST_ISOLATION_VIOLATION` for:

- any fs delete, move, write or create whose target resolves inside a real home
  (sync, callback and `fs.promises` forms; every import form, because the guard
  re-syncs the builtin ESM bindings);
- any `child_process` or `node-pty` spawn whose working folder or home variable
  is inside a real home, or whose arguments name a real home or its Claude or
  Codex configuration. A spawn whose env omits HOME, USERPROFILE, APPDATA or
  LOCALAPPDATA gets the isolated values. Running an executable that lives under
  a real home is not refused: it is not a mutation.

A refusal that the code under test catches is still recorded and fails the test
in a shared `afterEach`. Probes and fake CLIs outside vitest get the same guard:
`node --import <file URL of tests/helpers/probe-guard.mjs>` with an env from
`isolatedProbeEnv(root)`, which is fresh (only PATH-style essentials are copied)
and carries the caller's real roots so the child protects them too; a probe that
swallows a refusal exits non-zero.

**Decisions.**

- Real roots: the original six variables, HOMEDRIVE+HOMEPATH, `os.homedir()`,
  `os.userInfo().homedir` (which ignores the environment), and any
  `account-profiles` folder above one of them. Allowed roots: the isolated
  root, the original temp folder (on Windows it sits under LOCALAPPDATA) and the
  project root (CI runners keep the checkout under HOME). The more specific root
  wins; a project root that is itself a home stays protected.
- Paths are compared after resolving `..`, separators, case (win32, darwin),
  trailing dots and spaces, stream suffixes, `\\?\`, `\\.\` and `\??\` prefixes,
  administrative shares, file: URLs, Buffers, and the real path of the nearest
  existing ancestor, so a link from an allowed folder into a real home is
  followed. Making a symbolic link into a real home, or a hard link to a file in
  one, is itself refused. A device path the guard cannot map fails closed.
- The per-test reset puts back a home variable that is unset or points outside
  the isolated or temp area; a temp home a test file chose for itself is kept.
- CLAUDE_CONFIG_DIR and CODEX_HOME are not filled into a child env that omits
  them: unset, they fall back to the isolated HOME, and code that strips them on
  purpose stays testable.
- No escape hatch. `vitest.live.config.ts` is deliberately not covered (it runs
  real ssh with the user's real keys); Playwright is out of scope.

**Tests.** `tests/unit/test-isolation/home-guard.test.ts` [host] covers each
operation family, each import form, the path spellings, spawns (working folder,
explicit and inherited env, arguments, node-pty), env fill-in, the per-test
reset, recording, the pure checker on simulated roots, and a plain-node probe
under `probe-guard.mjs`. Every real-home target in it is harmless without the
guard. `tests/unit/test-isolation/home-guard-links.test.ts` [CI] [VM] (HOST
QUARANTINE) follows real links and junctions. Each check family was removed in
turn and its tests went red.

**Follow-up.** Existing tests that trip the guard are fixed in a separate pass;
the guard is not loosened for them.
