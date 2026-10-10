# ADR-025: The first start of a new Claude Code or Codex program runs off the main thread

- Status: Proposed (2026-10-10); the ADR-009 adversarial pass is owed before merge
- Date: 2026-10-10
- Related: ADR-009 (adversarial review), ADR-024 (vendor installers)

## Context

On Windows the first start of a newly written program holds the start call
(`CreateProcessW`) for one to four seconds while the OS checks the new
program. Later starts of the same file take milliseconds. Node's `spawn` and
`execFile` and node-pty's ConPTY start all make that call on the thread that
asks, and this app asks on the Electron main thread, so the whole window
froze for that long. The jank detector logged it as `[jank] main loop stalled
2079ms ... near tick`.

It happens wherever the app is the first to start a new `claude.exe` or
`codex.exe`:

- Claude Code and Codex discovery's `--version` run: at start, Check again,
  the check after "Add it to PATH for me" (the first run of a freshly
  installed `%USERPROFILE%\.local\bin\claude.exe`, about 260 MB), and a
  reviewer launch's re-proof after Claude Code updated itself;
- the boot `[claude-version]` probe, after an update installed while the app
  was closed;
- the first-run setup terminal and the /insights terminal, which start
  `claude.exe` itself through node-pty.

Measured on a Windows host with the same mechanism (copies of a large
executable, never a real CLI): a first `spawn()` of a never-run copy held the
calling thread 1.7 to 4.3 s; the second start of the same file took 5 ms; an
asynchronous read of the file first did not help (the start cost was
unchanged); and the same first `spawn()` inside a `worker_threads` Worker
took 4.3 s inside the worker with no main-thread stall. An Electron 44 main
process runs an eval worker that starts a program, shares memory with it
(`SharedArrayBuffer`, `Atomics.wait`) and stops it.

ADR-024 decides what the app may install. This is a separate decision: how
the app makes the first start of a program that was just installed or
updated, whoever installed it. It gets its own record rather than an
amendment to ADR-024.

## Decision

Before a main-process caller's own start of a Claude Code or Codex program
that this app run has not started yet, the caller awaits a **first-start
warm-up** (`src/main/first-start-warmup.ts`): the same file, started once in a
worker thread (`src/main/first-start-worker.cjs`), so the OS check holds the
worker, never the main thread. The caller's own start then finds the check
done. Containment:

1. **A pre-start, never a gate.** Whatever the warm-up's outcome (exit code,
   failure to start, time-out, no answer), the caller goes on to do exactly
   what it did before. It never waits longer than
   `FIRST_START_CALLER_BOUND_MS` (13 s: the 10 s time-out, 2 s for an ended
   program to exit, 1 s more), and the warm-up never rejects.
2. **Which program.** Only a direct `.exe` on Windows, named by a drive or
   share path, never a device path or a name ending in a dot or a space. A
   `.cmd` or `.bat` shim is started through `cmd.exe`, which the OS already
   knows, so its main-thread start is not the first start of a new program.
   The worker starts the canonical (real) path of what the caller's own
   discovery or resolution found. Every caller is main-process code; no
   renderer input reaches the module (its importers are pinned by a test,
   and no IPC channel, preload or renderer file names it).
3. **Which arguments.** `FIRST_START_ARGS`, a constant: `--version`, which
   both CLIs answer and this app already runs. No caller passes arguments.
4. **Which environment.** The one the caller's own `--version` run is built
   with, as a prototype-free copy of its own string values: for Claude Code,
   `claudeVersionRunEnv` (reviewerEnv over this process's variables: no
   Conductor variable, fully qualified PATH folders only,
   `NoDefaultCurrentDirectoryInExePath=1`); for Codex, `codexCliEnv` over a
   fresh throwaway home (the CLI prepares its home before it parses
   `--version`), removed once the program has finished, never the user's own
   home or an account's folder. The worker thread's own environment is
   empty. No shell; the working folder is the program's own; stdin is
   ignored; stdout is read up to 4 KiB and the rest dropped.
5. **Once per file.** Keyed by identity: canonical path, size, modification
   time, device and file id. One warm-up per identity is in flight; one that
   started the program is not repeated this run; a changed file (an update
   in place) is a new identity. A start that failed is tried again next time.
6. **Local only.** Never for an SSH session: the accounts service awaits a
   package's `launch.warmFirstStart` only for a launch with `remote !== true`.
7. **Quit.** A warm-up still running at quit is ended with the CLI runs' own
   kills (`flushPendingProviderCliKills`): a program not yet started never is,
   and a running one is ended through its handle, with a bounded wait.

The callers routed through it:

- Claude Code discovery's `--version` (`review-launch.ts`), which start-up
  discovery, Check again, Add it to PATH and the reviewer's re-proof all run;
- Codex discovery's `--version` (`codex/discovery.ts`, real ports in
  `codex/index.ts`);
- the boot `[claude-version]` probe (`claude-cli-version.ts`);
- the first-run setup terminal (`ipc/setup-handlers.ts`, before node-pty);
- the /insights terminal (`insights-runner.ts`, before node-pty);
- every local launch the accounts service prepares (`accounts-service.ts`):
  Codex sessions, reviews and background runs, and Claude reviews.

Not routed, and why: Claude Code sessions start PowerShell in the PTY, which
then starts `claude`, so the shell takes the hold, not the main thread;
headless Claude runs (`claude-headless.ts`) go through `cmd.exe`
(`shell: true`); the session PTY start itself lives in `pty-manager.ts`, inside
the SSH status-line blast radius (AGENTS.md), so a Codex session is warmed by
its prepared launch instead, which runs exactly the file discovery proved.

**Attribution.** The synchronous starts the app makes on the main thread
(the CLI runner, the boot probe, the setup and /insights terminals) are timed
(`main-thread-ops.ts`); one over 500 ms is logged as
`[spawn] <program> took N ms to start`, by the program's base name only,
never its folder, arguments or environment. A warm-up's own slow start is
logged the same way, marked "first start, off the main thread". The
`[jank]` line names the tracked operation in flight during the stall (`near
start of claude.exe`) or says `near tick (no tracked app operation in
flight)`. Only those starts are tracked, so the second form means "not one of
them", not "nothing": another synchronous call, or the browser side's own
work, which a main-thread label cannot see.

## Alternatives considered

- **Running the `--version` proof itself in the worker.** It moves only the
  discovery run, changes what discovery's result is made from, and leaves
  every other first start (terminals, launches) on the main thread. The
  pre-start leaves each caller's own run unchanged.
- **Reading the file first.** Measured: no effect on the start's cost.
- **An Electron `utilityProcess`.** A whole process per warm-up, for a single
  start call; a worker thread is enough and needs no file on disk.
- **A worker file loaded by path.** Loading a script from inside the app
  archive in a worker thread is not something this app relies on anywhere; the
  worker's text is bundled (`?raw`) and run as an eval worker instead.

## Consequences

- A program the app has not started yet this run is started one more time,
  with `--version`, before the caller's own start: the same run discovery
  already makes, in the same environment (Codex's in a throwaway home).
- `src/main` gains its first `worker_threads` worker. The spawn-site inventory
  lists its start (`first-start-worker.cjs :: spawn(req.file`).
- This is a new way of starting the Claude Code and Codex CLIs, so it takes an
  ADR-009 adversarial pass before merge.
- The session PTY start in `pty-manager.ts` is not timed or labelled: it is
  in the SSH status-line blast radius, and changing it needs the live SSH
  matrix.
