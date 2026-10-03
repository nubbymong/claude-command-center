# Owner decisions, 2026-09-27: multi-provider usage, and the app-server exception

This record supplements `owner-decisions-2026-09-20.md` and
`owner-decisions-2026-09-26.md`. It records the owner's decisions of
2026-09-27 on the multi-provider usage UX (the Account usage page, the usage
footer, the session strip and Tokenomics), and the one scoped exception to
WP1.41 they need. Where the earlier records disagree, this one wins for usage.

M4 records the owner's decision of the same day on Ask Conductor with both
providers on (parity checklist row 53).

The work is the multi-provider usage track of package P3, phases MP1 to MP13
(parity checklist rows 17 to 21, 26 and 28 to 30). The architecture decision is
ADR-022 (`architecture/decisions/2026-09-27-adr-022-codex-app-server-usage-read.md`).

## M1. The usage mockup is approved

The owner approved the multi-provider usage mockup (canvas review
"Multi-provider usage review", version 1, with no notes; the mockup and its
brief are local and not in the repo). D2, D3, D5 and the D4 rail rule are
approved as drawn, which is each one's recommended option.

| Decision | As approved |
| --- | --- |
| D1 = C | An open Codex account shows its live session figure. A closed account gets one short-lived `codex app-server` read on a supported CLI version where the probe passes; otherwise it shows the last-seen reading from the newest session in that account's own folder, stamped with its age. |
| D2 (drawn) | A window whose reset time has passed shows no figure: the page reads "Reset 3:10 pm, no reading since"; the footer and the strip show a static no-reading meter (the pending style without the shimmer, `--%`). Claude too. |
| D3 (drawn) | A Codex group that will never report keeps its pill with its mark and one word: "per token" (an API key) or "no reading" (no session ever claimed). No shimmer. |
| D4 (drawn) | The Account usage rail entry shows with two or more accounts in total across the providers that are on. |
| D5 (drawn) | A provider that is off (or Codex not set up) has no section and makes no calls. Claude Code off in Codex-only mode shows one muted line: "Claude Code is off. Turn it on in Settings, Accounts to see its accounts." Codex off in Claude-only mode shows nothing. |

## M2. The scoped WP1.41 exception: app-server for usage reads only

`codex app-server` is labelled `[experimental]` in the help of 0.153.4, 0.155.1
and 0.157.1, although the one method the read
needs, `account/rateLimits/read`, is in its stable protocol. WP1.41 keeps
experimental provider features off unless the owner enables them and they are
labelled. Asked whether the D1 = C approval counts as that enablement, the
owner answered:

Owner, verbatim: "approve app-server specifically for reading usage when an
enabled, signed-in Codex account has no open session. Test the supported
versions, isolate it to the correct account, and shut the helper down
afterwards. Do not start an agent conversation or enable unrelated
experimental features. If the check fails or is unsupported, show the
last-known usage with its timestamp. Record this as the scoped WP1.41
exception and continue."

What it allows, and nothing more (ADR-022 holds the full bounds):

- **Usage reads only.** The helper is sent `initialize`, the `initialized`
  notification and `account/rateLimits/read`, nothing else. Never a
  conversation, thread or turn method, and no other experimental feature or
  opt-in.
- **Only for an enabled, signed-in Codex account with no open session.** Codex
  answered on, the account active and signed in with ChatGPT; an account with
  a session, a review or a sign-in in progress is never read. An API-key
  account and this computer's own Codex sign-in (shared with the user's own
  Codex tools) are never read either.
- **A read may refresh that account's sign-in**, as Codex itself does when it
  runs. That is why an account in use is never read, and why a launch,
  sign-in, sign-out, archive or inactivate waits for a read in flight to end.
- **Isolated to that account.** The helper runs in the account's own folder
  (`CODEX_HOME` is the account's realm), and its `initialize` answer must
  name that same folder, or the read is refused.
- **Shut down afterwards.** Each read ends the helper and its whole process
  chain before the account is released.
- **Supported versions only.** A read is tried only on a CLI whose version is
  in the supported range (`classifyCodexVersion` says `supported`: today
  0.153.4 to 0.156.1). A newer CLI (0.157.1 included), an older one or an
  unknown version is not read and shows the last-known usage. On a supported
  version the run is still a probe: anything that answers differently fails
  closed.
- **Fail closed.** Anything unexpected, unsupported or failed shows the
  last-known usage with its timestamp.

WP1.41 itself is unchanged for every other experimental or unknown feature.
Device-code sign-in stays off (`owner-decisions-2026-09-26.md`, U3).

## M3. Evidence recorded with this decision

- **Protocol on the supported versions (offline).** The JSON schema of the
  three messages was generated with `codex app-server generate-json-schema`
  and an empty `CODEX_HOME`, with every proxy pointed at a closed port; the
  app-server itself was never started and nothing signed in. 0.153.4 on the
  development machine; 0.155.1 (installed into a separate folder) and 0.157.1
  on the Windows test VM (WINDOWS_1). The excerpts are
  `tests/fixtures/codex/app-server/<version>/usage-schema.json`.
- **Result.** Everything the read sends and uses is identical on 0.153.4,
  0.155.1 and 0.157.1. The later versions only add optional fields: 0.155.1
  gives `account/rateLimits/read` optional parameters (`excludeResetCreditDetails`,
  `supportsLunaReserve`; the read sends none), and adds `ordinaryUsageAllowed`
  to the answer and `normalModelSlug` to each snapshot; 0.157.1 adds the
  `explicitGatewayOauth` initialize capability (the read sends no
  capabilities). No field was removed and no required list changed. 0.157.1
  was checked for drift only: it is newer than the supported range and is not
  read.
- **Owed.** A real read on 0.153.4 and 0.155.1 with a signed-in account
  (MP8). A 0.155.1 rollout fixture: the test VM has no 0.155.1 session (its
  sessions are from 0.137.0 and 0.142.4), and making one needs a real signed-in
  session, so it is owed for MP8.

## M4. Ask Conductor with both providers on (row 53)

The question: with Claude Code and Codex both on, which assistant runs Ask
Conductor? Until now there was one provider, so there was no Claude behaviour
to copy, and the choice was the owner's (`owner-decisions-2026-09-26.md`, P1,
second case). A Codex-only install was already settled: Ask runs on the one
provider that is on.

The owner approved the mockup (canvas review "Ask Conductor provider choice",
version 1, with no notes; the mockup and its brief are local and not in the
repo). Option B is approved as drawn, which is the recommended option.

| Decision | As approved |
| --- | --- |
| Q1 = B (drawn) | A row in Settings, General, beside "Show Ask Conductor": "Ask Conductor runs on: Claude Code / Codex". It shows only while both providers are on, and its default is Claude Code. A Codex-only install uses Codex without asking. While both are on, the Ask Conductor dock row wears the provider's type badge. Turning a provider off never rewrites the saved choice. |

With both providers on, Sentinel's analysis runs on the provider this setting
names (completion plan, P3.9). The setting and Ask Conductor on Codex are built
in PR 4 (row 53).
