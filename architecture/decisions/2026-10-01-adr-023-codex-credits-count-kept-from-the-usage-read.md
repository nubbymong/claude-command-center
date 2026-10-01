# ADR-023: Keep a Codex account's credits count from the usage read

- Status: Accepted by the orchestrator under the owner-approved plan; the owner confirms it on return
- Date: 2026-10-01
- Amends: ADR-022, bound 8 only

## Context

ADR-022 bound 8 lists what the app keeps from the Codex app-server's answer:
"percentages, reset times, window lengths, limit name and plan". Credits are
not on that list, and the Account usage page's Codex card has no credits row,
where Claude's card has one. `docs/wp2/parity-checklist.md` row 17 asked for
it ("credits: parity, shown once a real read shows their unit", recorded with
the usage plan on 2026-09-27), and the owner-approved completion plan carries
it as P3.14 (`docs/wp2/completion-plan.md`, section 8). ADR-022 says widening a
bound needs a new decision and a new ADR; this is that ADR.

The unit was the open question. P3.1 ran on a managed account that has credits
(`docs/wp2/evidence/codex-cli-capabilities-2026-09-27.md`, answer 7). The
schemas declare the fields and no unit: `CreditsSnapshot` in
`tests/fixtures/codex/app-server/<version>/usage-schema.json` is `hasCredits`
(boolean), `unlimited` (boolean) and `balance` (string or null), identical in
0.153.4, 0.155.1 and 0.157.1. The unit is read from the CLI's own wording,
which prints the balance followed by "credits" (a string search of the binary,
not a live read of that screen), and from the real balance, a decimal string
with 10 fraction digits. So the unit is Codex credits, a count, not money.

## Decision

The app keeps one more thing from a Codex usage reading, and nothing else:

1. **What is kept.** The credits count: `hasCredits` (boolean), `unlimited`
   (boolean) and `balance` (a decimal string, kept as a number). Bound 8 now
   reads "percentages, reset times, window lengths, limit name, plan and the
   credits count"; every other part of it stands.
2. **Where it is read from.** The answer's own `rateLimits.credits` for a fresh
   read, and the `rate_limits.credits` of a rollout's `token_count` event for
   the live and last-seen figures. Never the credits of an entry of the
   per-limit map. The reset-credit grants (`rateLimitResetCredits`) are a
   different thing and stay unread.
3. **How it is treated (bound 8's rule).** Own properties of a plain object
   only. A flag that is not a boolean drops the whole credits. A balance must
   match `^\d{1,13}(\.\d{1,12})?$`, else it is null. No other key is copied.
   The client's schema checks (bound 5) are not widened: a credits object of
   the wrong shape is dropped, never a reason to call the CLI unsupported.
4. **What does not change.** The three code-built messages, the argv, the realm,
   the lease, the lifecycle, the supported versions, the triggers and the
   verdict rules (bounds 1 to 7) are exactly as before. The usage IPC channels
   and the preload are untouched: the page's view gains an optional `credits`
   of the same three fields.
5. **How it is shown.** A "Credits" row under a Codex card's bars, in the
   styling of Claude's, in Codex's own unit: "N credits" (the CLI's wording), or
   "Unlimited". It is a count and is never formatted as money. An account that
   reports no credits, or `hasCredits: false` with no balance, has no row;
   `hasCredits: false` has not been observed, so nothing is invented for it.

## Consequences

- The privacy wording (`PRIVACY.md`) names the credits count beside the
  allowance figures and the plan.
- Parsing the helper's untrusted output is security-sensitive (ADR-009): the
  change gets an adversarial pass. The exact change for the attackers is the
  addition in item 1 and the one reader that implements items 2 and 3
  (`readCredits` in `src/main/providers/codex/rate-limits.ts`).
- Rejected: taking credits from rollouts only. A closed account on a supported
  CLI is shown from the fresh read, which replaces last-seen, so its row would
  vanish exactly when the page reads afresh; that is not parity.
- Rejected: showing the raw balance with no unit, or no row. The CLI's own
  wording is the unit.
- The live check (a closed account read afresh, an open session, last-seen with
  its age) runs on the test VM's managed account at release.
