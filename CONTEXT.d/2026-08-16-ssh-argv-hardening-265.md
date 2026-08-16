## 2026-08-16 -- SSH argv boundary hardening (#265)

Defence-in-depth around SSH argv / remote-setup construction. Four controls the
#241 ControlMaster fix (shipped beta.9 via #260) did not carry, surfaced by an
adversarial pass on a parallel implementation. None is a completing exploit on
beta today -- issue #265 is public, non-exploitable -- each is a control that
should exist and didn't. Same threat model throughout: a caller that already
controls the renderer or local config (real ids/hosts never trip these).

- **host / username charset-gated at the IPC boundary** (`ipc/pty-handlers.ts`).
  Both were `z.string().min(1)`, then fused into `${username}@${host}` = argv[0].
  ssh parses any argv entry beginning with `-` as an OPTION, so `-oProxyCommand=...`
  is an argument-injection primitive (local RCE). It does not complete on today's
  builder -- consuming argv[0] as an option leaves ssh no destination, so it
  usage-errors first -- but that safety is accidental. Gate rejects a leading `-`
  and any whitespace (`/^[^-\s]\S*$/`), matching the remotePath precedent from #188
  while still admitting IPv6 (`[::1]`), internal dashes, and `DOMAIN\user`.

- **sink-side guard in `buildSshArgs`** (`ssh-args.ts`). The builder now re-asserts
  the same charset at the point of interpolation, so a call site that bypasses the
  Zod schema cannot rebuild the primitive -- mirrors `assertSafeRemotePath`.

- **sessionId charset-gated** (`sessionIdSchema`, now `/^[A-Za-z0-9_-]+$/`) and the
  one remaining raw embedding fixed: the statusLine `command` in `ssh-shim.ts` used
  the raw id, which lands inside a single-quoted JS literal in the base64'd remote
  setup script AND becomes the command claude runs via `sh -c`. Now uses `safeSid`
  (a no-op for real hex ids); every other embedding was already neutralised (URL via
  encodeURIComponent, filenames via safeSid).

- **call-site test** pins that the spawn path actually CALLS `buildSshArgs`
  (`ssh-spawn-callsite.test.ts`): mocks node-pty + `os.platform()`=win32 and asserts
  the argv pty.spawn receives, so a revert to an inline array -- dropping the #241
  win32 mux flags -- fails instead of leaving the suite green.

Every guard mutation-proven (revert -> named test red). Full suite green, typecheck
clean, byte-scan clean. Security-sensitive (PTY argv / IPC boundary) so ran the
ADR-009 adversarial pass before merge is recommended.
