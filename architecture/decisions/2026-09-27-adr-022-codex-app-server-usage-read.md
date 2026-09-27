# ADR-022: A short-lived Codex app-server read for a closed account's usage

- Status: Accepted
- Date: 2026-09-27

## Context

The Account usage page shows each Claude account's allowances. Claude's are
read with one HTTPS request per closed account; an open account is served
from its live status line figure with no call. For Codex, the owner approved
D1 = C (`docs/wp1/owner-decisions-2026-09-27.md`, M1): an open Codex account
shows its live session figure, and a closed one gets a fresh reading where
that can be done safely, else the last-seen reading from its newest session,
stamped with its age.

A closed Codex account has no live figure, and this app never reads Codex's
sign-in files, so it cannot make the request itself. The Codex CLI can:
`codex app-server` speaks a JSON-RPC protocol on stdio, and its
`account/rateLimits/read` method returns the same allowance windows a session
writes to its rollout (used percentage, window length, reset time, limit id
and name, plan), for the account whose folder it runs in.

Until now every Codex process this app starts is either the interactive
terminal wrapper or a one-shot CLI run through the Codex runner
(`src/main/providers/codex/cli-runner.ts`: version, sign-in status, sign-in,
sign-out, review), each writing its input once and reading to exit. The
app-server is a third kind: a protocol helper that stays up until its stdin
closes. Its subcommand is labelled `[experimental]` in the help of 0.153.4,
0.155.1 and 0.157.1, and WP1.41 keeps experimental provider features off unless the
owner enables them. The owner granted a scoped exception on 2026-09-27; their
words are recorded verbatim in `docs/wp1/owner-decisions-2026-09-27.md` (M2).

## Decision

The app may start `codex app-server` for one purpose only: reading a closed
Codex account's allowances for the Account usage page. It is the scoped WP1.41
exception, and these bounds are part of it. Widening any of them needs a new
owner decision and a new ADR.

1. **Usage reads only.** The client sends exactly three code-built messages:
   `initialize` (`clientInfo` naming the Codex CLI and its proven version,
   `capabilities: null`), the `initialized` notification, and
   `account/rateLimits/read` with no parameters. It never sends a
   conversation, thread or turn method, `account/read` with a refresh, the
   legacy `getAuthStatus`, or any other method; it never opts into
   `experimentalApi` or any other capability, parameter or flag that turns on
   an experimental or experiment-exposure feature (0.155.1's optional
   `supportsLunaReserve` included). Argv is the constant `app-server` on the
   default stdio transport: never `daemon`, `proxy`, `--listen` to a socket, or
   `--enable`. A request from the server to the client (an approval, a sign-in
   refresh) is never answered and fails the read.

2. **Only for an enabled, signed-in Codex account with no open session.** The
   read runs only when Codex is answered on, the account is active and signed
   in with ChatGPT, and nothing uses it: no session, review or sign-in. An
   API-key account ("per token") and this computer's own Codex sign-in folder,
   which the user's own Codex tools share, are never read (parity with Claude,
   whose primary profile is never refreshed). A read may refresh that
   account's sign-in, as Codex itself does when it runs (and as Claude's
   guarded refresh does); that is why an account in use is never read, and
   why a launch, sign-in, sign-out, archive or inactivate on an account with a
   read in flight aborts the read and waits for its process chain to end
   first.

3. **Isolated to that account's realm.** The helper runs in the account's own
   folder: `CODEX_HOME` is the realm, the environment is the allowlisted one
   the other CLI runs use (ambient OpenAI and Codex authority stripped), and
   the run holds the realm as a reader under an operation lease. The
   `initialize` answer's `codexHome` must equal the realm folder
   (canonicalised, case-insensitive on Windows and macOS); anything else
   refuses the read and marks that CLI unsupported.

4. **Shut down after each read.** After the answer the client closes stdin and
   gives the helper 3 s to exit, then the Codex runner's deadline kill ends the
   whole process chain (the same kill chain as every other Codex CLI run,
   bounded by `CODEX_KILL_WORST_MS`). The realm hold and the lease are released
   only once the chain has ended. One helper at a time app-wide; a deadline of
   20 s per read.

5. **Supported versions only, proven by probe.** The owner said "Test the
   supported versions": a read is tried only when discovery proved the CLI and
   its version classifies as `supported` (`classifyCodexVersion`, today
   0.153.4 to 0.156.1, `cli-contract.ts`). A `too-new` CLI (0.157.1
   included), a `too-old` one or an `unknown` version is never read; it shows
   the last-seen reading. The run itself is then the probe: a schema-valid
   `initialize` answer within 12 s naming the realm, then a schema-valid
   `rateLimits`. Method-not-found, an invalid request, a schema mismatch or a
   wrong `codexHome` marks that executable unsupported until it changes; a
   timeout, early exit, spawn error, sign-in or backend error, or cancel is
   transient. Widening the supported range is the version work's own
   evidence step (real-CLI qualification), not this ADR's.

6. **Fail closed to the last-known usage.** Every failure, refusal or version
   outside the supported range shows the last-seen reading with its
   timestamp (or no reading, if there is none).

7. **Only when asked, never in the background.** Reads start only from the
   Account usage page (open, Refresh, a card's Retry): never from the footer,
   the strip, Settings or Tokenomics. 300 ms between accounts, single-flight
   per account, a result reused for 60 s, and after three transient failures
   in one pass the rest fall to the last-seen reading without trying. Codex
   over SSH stays refused; the read is local only.

8. **Output treated as untrusted.** One bounded line reader (64 KiB per
   message), own-property plain values only, percentages clamped to 0-100,
   reset times within 60 days of now, window lengths positive integers, the
   plan from the known list only, stderr capped and never shown. The app keeps
   percentages, reset times, window lengths, limit name and plan; it never
   reads `auth.json`.

## Evidence

The three messages were compared offline on 0.153.4 (the minimum), 0.155.1
(the pinned reference) and 0.157.1 (newer than tested) with
`codex app-server generate-json-schema`, an empty `CODEX_HOME` and every proxy
pointed at a closed port; the app-server was never started and nothing signed
in. The excerpts, each message with the closure of the definitions it
references, are `tests/fixtures/codex/app-server/<version>/usage-schema.json`.
What the read sends and uses is identical on all three; the later versions add
optional fields only (0.155.1: optional `account/rateLimits/read` parameters,
`ordinaryUsageAllowed` in the answer, `normalModelSlug` in each snapshot;
0.157.1: the `explicitGatewayOauth` initialize capability). The validator must
therefore accept unknown extra fields and must not require the new ones.
0.157.1 was checked for drift only: it is `too-new` and is not read (bound 5).

A real read on 0.153.4 and 0.155.1 with a signed-in account, with the hosts
contacted during it recorded, is owed before the live read ships (MP8).

## Consequences

- A third kind of Codex process exists beside the terminal wrapper and the
  one-shot CLI runs. Its spawn, argv, stdin and kill chain are
  security-sensitive (ADR-009): the runner's open-stdin mode, the protocol
  client and the orchestration each get an adversarial pass.
- The only new network traffic is the request Codex itself makes to OpenAI
  with that account's own sign-in (and, when due, its sign-in refresh; bound
  2), the same kind of call a Codex session makes.
- The exception is narrow by construction: every bound above is a test in the
  phases that build it, and a change to any of them is a new owner decision.
- If a future CLI removes or changes the method, the page keeps working on the
  last-seen reading; nothing else depends on the helper.
