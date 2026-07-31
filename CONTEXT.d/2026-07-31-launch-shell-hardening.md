## 2026-07-31 -- Launch-shell hardening: spawn without a shell, and stop backslash defeating the flag guard

Two hardening changes on the session-launch path, both surfaced by the adversarial pass on
#176 (#144) as PRE-EXISTING -- neither was introduced by that change. Tracked privately per
SECURITY.md ("Embargo"); this fragment records WHAT changed and why the shape is right, not a
repro.

### 1. scripts/resume-picker.js spawns with shell:false

Both spawn sites used `shell: os.platform() === 'win32'`. Node with `shell:true` on Windows
joins `[file, ...args]` with spaces and hands the result to `cmd.exe /d /s /c` UNESCAPED --
the documented child_process caveat. Every forwarded argument is therefore re-parsed by
cmd.exe after the launch shell already parsed it correctly once. Two consequences:

- Metacharacters inside a forwarded VALUE become cmd.exe syntax. `--agents` carries
  user-authored agent-template text, so that is a code path, not a theoretical one.
- Spaces inside a path SPLIT it. The default Windows data root is
  `%LOCALAPPDATA%\Claude Command Center` -- it always contains spaces -- so `--settings` was
  being truncated on every restored Windows session and the tail was landing as a positional
  argument, i.e. an accidental initial prompt. That is a live correctness bug independent of
  the security one, and nobody had reported it because the symptom (a stray prompt) does not
  look like a quoting failure.

New `buildSpawnTarget()` returns `{file, argv}` and is the only way the picker spawns.
`shell:false` unconditionally; a `.cmd`/`.bat` shim is routed through `cmd.exe /c` with an
ARGS ARRAY, the same shape `providers/codex/spawn.ts` already used. cmd.exe still parses the
shim path, but arguments stay separate argv elements instead of being concatenated.

The first attempt put the helper inside `main()`, so the module export could not see it and
the test failed with "buildSpawnTarget is not defined" -- hoisted to module scope.

### 2. The extraArgs managed-flag refine collapses backslashes before matching

The refine rejects CCC-managed flags so the escape hatch cannot clobber `--settings` and
friends. It matched literal flag text, but the value is emitted UNQUOTED and POSIX shells
strip unquoted backslashes at word expansion -- so a backslash-spelled flag matched nothing,
passed the guard, and arrived at the CLI as the real flag. Worst case substitutes CCC's
per-session settings file, and a Claude settings file carries `hooks`, i.e. arbitrary
commands.

FIRST ATTEMPT WAS WRONG and is worth recording. I removed `\` from the charset outright. The
full suite caught it: an existing test pins that extraArgs accepts Windows backslash paths,
which is a legitimate use of an advanced escape hatch. Banning the character to fix a POSIX
word-expansion quirk would have broken Windows users for no reason -- on Windows the launch
shell is PowerShell, where backslash is not an escape character at all.

The right fix keeps the character and accounts for its behaviour: the refine now tests a
backslash-COLLAPSED copy of the value. A trailing backslash is additionally rejected outright
-- on SSH it turns the launch line into a shell line continuation, so the remote shell prompts
`>` and swallows the user's next line as arguments while claude never launches.

### 3. agentsConfig bounded, deliberately NOT charset-guarded

The fields were unbounded `z.string()`. Bounded now (name 200, description 2000, prompt 100k,
array 200). Deliberately no metacharacter charset: `prompt` and `description` are free-form
natural language, so a charset would break the feature for anyone writing an ordinary English
sentence. It is the wrong control. The real control is that the value never reaches a shell
as command TEXT -- which is what change 1 above establishes. These bounds are defence in
depth against an oversized payload, nothing more.

### Tests

`tests/unit/scripts/resume-picker-spawn-target.test.ts` and
`tests/unit/main/extra-args-guard.test.ts`.

The extraArgs test initially MIRRORED the schema field rather than importing it, which meant
reverting the fix in the source left every case green -- a vacuous guard, the fourth time
this pattern has appeared in two days. It now imports the real exported `spawnOptionsSchema`,
so the mirror cannot drift. Verified by reverting the collapse in the real source: 10 of 19
cases fail, and pass again with it restored. The picker test carries a source-level
assertion that no spawn option is anything but `shell: false`, scoped to code lines so the
rationale comment (which contains the words "shell: true" while explaining why not to) does
not trip it.

Full suite 3314 passed; typecheck clean.
