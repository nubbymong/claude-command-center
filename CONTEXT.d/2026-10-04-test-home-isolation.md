## 2026-10-04 -- Tests and probes never act on a real home (enforced by the harness)

**Why.** A written rule did not stop a test or a review probe from acting on a
real home folder, so the guarantee is now enforced by the test harness itself.

**What.** Every vitest run (`vitest.config.ts`, `vitest.native.config.ts`, both in
forks) loads `tests/helpers/home-isolation.ts` as its FIRST setup file. It points
HOME, USERPROFILE, APPDATA, LOCALAPPDATA, CLAUDE_CONFIG_DIR and CODEX_HOME (plus
HOMEDRIVE/HOMEPATH on Windows and the XDG folders elsewhere) at a fresh folder per
worker, re-asserts them before every test, pins the app's data folder
(`CCC_E2E_DATA_DIR`) per test file under the worker's temp folder (an inherited
value is kept only if it is already inside the temp area), fails loudly if
`os.homedir()` does not follow, and installs the guard in
`tests/helpers/home-guard-core.mjs`. The guard throws `TEST_ISOLATION_VIOLATION`
for:

- the wrapped fs calls (deletes, moves, writes, creates, opens and reads whose
  flags are not read-only, fd and FileHandle calls on a real-home file opened
  read-only, through the prototype too, a recursive copy into a folder holding a
  link into a real home) aimed at a real home, in sync, callback and `fs.promises`
  form and every import form;
- `child_process`, `ChildProcess.prototype.spawn` and `node-pty` spawns whose
  working folder, child environment (built exactly as Node and libuv build it:
  inherited keys, coerced values, the variables Windows copies in; home, temp, XDG,
  `GIT_CONFIG_GLOBAL`, `npm_config_*` and the CLI and app config-folder variables
  such as `ANTHROPIC_CONFIG_DIR`, `CLAUDE_SECURESTORAGE_CONFIG_DIR` and
  `CCC_CONFIG_DIR`) or a path written in an argument (drive, UNC, MSYS, Cygwin incl.
  `/proc/cygdrive`, WSL, `~user`, globs, after `=`, embedded, at any length, checked
  in linear time, links followed past every cap) is in a real home. In a shell line
  (exec, `shell: true`, `cmd /c`, `sh -c`, `pwsh -Command`) a `cd` / `chdir` /
  `pushd` (glued `cd/d`, `cd\`, `cd..` included) or `Set-Location` / `sl` /
  `Push-Location` into or above a real home, a root that holds one included, is
  refused. A child environment that omits a home variable gets it under the home
  the caller gave, or else the isolated one; one that omits TEMP, TMP or TMPDIR gets
  this process's (POSIX does not copy them in); a RUNNER_TEMP a caller sets in it
  is checked like TEMP. The executable itself, the running node binary (that exact
  spelling) as the command word of a command line written in an argument or of a
  shell line (a git hook command; macOS runners keep node under HOME), never as an
  operand, a node script, and the command word (that position only) of a
  `cmd /c` / `sh -c` line in a real home's npm or nvm folder are not refused; an
  install folder handed to a child must be an npm or nvm folder holding no real home;
- `worker_threads` Workers (also through `Worker.prototype.constructor`) other
  than a toolchain worker, `process.execve` and `process.binding('fs')` (they
  would bypass it). A toolchain worker, one whose script is in the project's own
  `node_modules` (esbuild's sync service), starts with the guard loaded first, the
  guard marker in its environment and no preload in its execArgv (one the caller
  names is refused); eval code and any other script are refused.

Node children load the same guard: every spawn adds it to the child's
`NODE_OPTIONS`, and the child removes it from its own view. A refusal the code
under test catches is still recorded and fails the test in a shared `afterEach`;
a probe that swallows one exits non-zero. Probes and fake CLIs outside vitest use
`node --import <file URL of tests/helpers/probe-guard.mjs>` with an env from
`isolatedProbeEnv(root)`, which is fresh (PATH-style essentials only) and carries
the caller's real roots and the guard preload.

**Not covered.** Native addons (they write natively); a child that is not node,
beyond its environment, working folder and arguments (a native tool that finds the
profile through the OS rather than the environment, for example to expand `~`,
reaches the real one); shell re-assembly of an argument: quotes or carets inside a
word, `%VAR%` / `$VAR` expansion, a PowerShell `-EncodedCommand`, and a relative
path after a `cd` the guard did not see are not read the way the shell will read
them; anything started outside these entry points. A refusal inside a toolchain
worker fails that worker's call but is not recorded in the test's own thread. `vitest.live.config.ts` (real ssh, real keys) and Playwright are
deliberately out of scope.

**Decisions.**

- Real roots: the original home variables, HOMEDRIVE+HOMEPATH, `os.homedir()`,
  `os.userInfo().homedir` (which ignores the environment), and any
  `account-profiles` folder above one of them. Allowed roots: the isolated root,
  the temp folder (on Windows it sits under LOCALAPPDATA), a CI runner's
  `RUNNER_TEMP` in GitHub's layout only (`<work>/_temp` where `<work>` holds the
  checkout) and holding no trusted home (GitHub keeps it under HOME on Linux and
  macOS; a child whose environment was rebuilt without it, such as a CLI the app
  runs, learns it from the marker), and the project root (CI runners keep the
  checkout under HOME). A home only the environment names inside the runner temp
  folder (a CI step's own CLI home) stays a real home. The more specific root wins;
  only the isolated root wins a tie.
- Paths are compared after resolving `..`, separators, case (win32, darwin),
  trailing dots and spaces, stream suffixes, `\\?\`, `\\.\` and `\??\` prefixes,
  file: URLs and URL-like objects, Buffers, and the real path of the nearest
  existing ancestor. Every UNC path except a named pipe, and every device path the
  guard cannot map, fails closed. An operation on the folder entry itself (unlink,
  rm, rmdir, rename, lchmod, lchown, lutimes) does not follow a link that is the last
  component, written without a trailing separator: it removes, moves or touches the
  link, never what it points at (Node's recursive rm of a CLI home holding a link to
  the CLI's own binary is no refusal). Any other entry is checked by its real path as
  well, so an 8.3 alias of a home, or a subst or mapped drive root that is one, stays a
  home; with a trailing separator, `.` or `..` the path is checked the full way.
- Arguments are scanned for drive, UNC, MSYS, Cygwin and WSL spellings, `~user`,
  globs that reach a real home, values after any `=` and inside brackets, at any
  length. A bare `~` expands from the child's HOME, which the guard has already
  checked, so it is not refused.
- A guard marker handed to a child can add real roots but cannot widen the allowed
  area: a temp root it names must hold the child's own temp folder, be named like a
  temp folder and hold no trusted real home; a runner temp folder it names gets the
  same rule as RUNNER_TEMP itself (absolute, `<work>/_temp` beside the checkout,
  holding no home).
- `npm_config_*` and `GIT_CONFIG_GLOBAL` values that name a real home (npm sets
  them for every script it runs) are pointed into the isolated home in each worker,
  so the children inherit safe ones.
- The per-test reset puts back a home variable that is unset or points outside the
  isolated or temp area; a temp home a test file chose for itself is kept.
- CLAUDE_CONFIG_DIR is not filled into a child env that omits it (the managed
  launch strips it, and a real child proves it stays unset); unset it falls back
  to the filled, isolated HOME.
- On Windows the isolated home is the long form of its path: a runner's TEMP carries
  8.3 short names (`RUNNER~1`), which a real profile path never has.
- No escape hatch.

**Tests.** `tests/unit/test-isolation/home-guard.test.ts` [host] covers each
operation family, each import form, the path and argument spellings, spawns
(working folder, explicit, inherited, prototype and coerced env, the Windows
variables libuv copies in, arguments, node-pty), node children, env fill-in, the
per-test reset, recording, markers, the npm-folder exception, the pure checker on
simulated roots, plain-node probes under `probe-guard.mjs`, and toolchain workers. A case whose fs
API this Node lacks is skipped and says so. Every real-home target in it is
harmless without the guard. `home-guard-links.test.ts` [CI] [VM]
(HOST QUARANTINE) follows real links and junctions. Each check was removed in turn
and its tests went red.
