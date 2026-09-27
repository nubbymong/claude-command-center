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
   `supportsLunaReserve` included). Argv is the constant
   `app-server --disable remote_plugin` on the default stdio transport: never
   `daemon`, `proxy`, `--listen` to a socket, or `--enable`. The one flag
   turns a default-on feature (remote plugins) off for that process only (it
   is `-c features.remote_plugin=false`; nothing is written); it turns nothing
   on. A request from the server to the client (an approval, a sign-in
   refresh) is never answered and fails the read.

2. **Only for an enabled, signed-in Codex account with no open session.** The
   read runs only when Codex is answered on, the account is active and signed
   in with ChatGPT, and nothing uses it: no session, review or sign-in. An
   API-key account ("per token") and this computer's own Codex sign-in folder,
   which the user's own Codex tools share, are never read (parity with Claude,
   whose primary profile is never refreshed). A read may refresh that
   account's sign-in, as Codex itself does when it runs (and as Claude's
   guarded refresh does); that is why an account in use is never read, and
   why nothing that changes the sign-in runs beside a read. One rule: the
   read holds its account (an operation lease) and its realm's sign-in lock
   (the lock a sign-in or sign-out takes; a status check still runs beside
   it). A launch, a sign in again, a sign-out and every lifecycle change
   (inactivate, archive) first stop a read of that account and wait for its
   process chain to end, so none of them is refused because of one;
   anything that still meets a read at the realm lock (a sign-in, a
   sign-out, a folder removal) is refused as busy, never run beside it. The
   rule that lets a read start (Codex on, nothing open on the account, its
   record signed in with ChatGPT, managed, not blocked) is asked when the
   lease is taken and again right before the spawn, after every wait.

3. **Isolated to that account's realm.** The helper runs in the account's own
   folder: `CODEX_HOME` is the realm, the environment is the allowlisted one
   the other CLI runs use (ambient OpenAI and Codex authority stripped), and
   the run holds the realm's sign-in lock under an operation lease (bound
   2). The `initialize` answer's `codexHome` must equal the realm folder
   (canonicalised: case-insensitive on Windows and macOS, a `\\?\` prefix
   dropped and `\\?\UNC\` read as the `\\` share it names); anything else
   refuses the read. That failure is about the realm, not the CLI, so it is
   transient, never the sticky verdict of bound 5.

4. **Shut down after each read.** After the answer the client closes stdin and
   gives the helper 3 s to exit, then the Codex runner's deadline kill ends the
   whole process chain (the same kill chain as every other Codex CLI run,
   bounded by `CODEX_KILL_WORST_MS`). The realm hold and the lease are released
   only once the chain has ended. One helper at a time app-wide; a deadline of
   20 s per read. At app quit every read under way is stopped before the
   Codex runner's pending-kill flush, so the flush kills its helper too, and
   no read starts again.

5. **Supported versions only, proven by probe.** The owner said "Test the
   supported versions": a read is tried only when discovery proved the CLI and
   its version classifies as `supported` (`classifyCodexVersion`, today
   0.153.4 to 0.156.1, `cli-contract.ts`). A `too-new` CLI (0.157.1
   included), a `too-old` one or an `unknown` version is never read; it shows
   the last-seen reading. The executable discovery proved is captured when
   the read begins, and the helper starts only if discovery still names that
   same executable (path, size, times, file id) at the same version, still
   `supported`, asked in the same turn as the spawn's own executable check.
   The run itself is then the probe: a schema-valid `initialize` answer
   within 12 s naming the realm and, first in its `userAgent`, the proven
   version, then a schema-valid `rateLimits`. Only an answer about the CLI's
   version or protocol (method-not-found, an invalid request to `initialize`,
   a schema mismatch) marks that executable unsupported until it changes. Any
   other error answer to `account/rateLimits/read` is about the realm and
   transient: the real CLI answers a signed-out realm with -32600 "codex
   account authentication required to read rate limits". A wrong
   `codexHome`, another version in the `userAgent`, a malformed or
   oversized line, a timeout, early exit, spawn error, sign-in or backend
   error, a request from the server, or a cancel is transient. Widening the supported range is the version work's own
   evidence step (real-CLI qualification), not this ADR's.

6. **Fail closed to the last-known usage.** Every failure, refusal or version
   outside the supported range shows the last-seen reading with its
   timestamp (or no reading, if there is none).

7. **Only when asked, never in the background.** Reads start only from the
   Account usage page (open, Refresh, a card's Retry): never from the footer,
   the strip, Settings or Tokenomics, and not from the page's own quiet
   reloads (the window regaining focus, an account the registry changed),
   which show the live, kept or last-seen reading. 300 ms between accounts,
   single-flight per account (a stopped read is not joined), a result reused
   for 60 s (10 s for a Retry), and after three transient failures in one
   pass the rest fall to the last-seen reading without trying (a stopped
   read is not a failure). Closing the page stops its reads, a Retry's
   included. Codex
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

A real read on 0.153.4 and 0.155.1 with a signed-in account was made on the
test VM (MP8, 2026-09-27; the VM journal in the session record). The hosts
contacted during a read, recorded by process from the DNS client log and TCP
connections: `chatgpt.com` only on 0.153.4 (about eight TLS connections in a
read of about a second: the usage endpoint
`https://chatgpt.com/backend-api/wham/usage` and more), and on 0.155.1 also
`sdmntprsouthcentralus.oaiusercontent.com` (OpenAI's content storage). No
other host, and no sign-in refresh was due. So a read is not only the usage
request: the CLI refetched its model catalogue into the realm on every read
and checked its remote plugin cache. The helper now runs with remote plugins
off (bound 1), the only one of those two the supported CLIs let a caller
turn off: `codex app-server --help` shows `--disable <FEATURE>` and
`codex features list` lists `remote_plugin` (stable, on by default) on
0.153.4 and 0.155.1 alike, while no flag or feature for the model catalogue
refresh exists on either (`remote_models` is listed as removed). The model
catalogue is therefore still refetched; the VM re-verifies which hosts
remain with remote plugins off. A CLI in the supported range that refused
the flag would end the helper early: a transient failure, the last-seen
reading shown.

## Consequences

- A third kind of Codex process exists beside the terminal wrapper and the
  one-shot CLI runs. Its spawn, argv, stdin and kill chain are
  security-sensitive (ADR-009): the runner's open-stdin mode, the protocol
  client and the orchestration each get an adversarial pass.
- The new network traffic is what the Codex CLI itself does at start with
  that account's own sign-in, to OpenAI only: the usage request, and the
  model catalogue refresh a Codex session also makes (and, when due, its
  sign-in refresh; bound 2); the remote plugin checks are turned off (see
  Evidence).
- The exception is narrow by construction: every bound above is a test in the
  phases that build it, and a change to any of them is a new owner decision.
- If a future CLI removes or changes the method, the page keeps working on the
  last-seen reading; nothing else depends on the helper.
