# 2026-08-04 — Insights run-id path traversal: fixed, shipped, published (GHSA-rj3p-wqj3-p7w8)

Now that the advisory is public, the record it deliberately did not get during the
embargo. Published 2026-08-04, severity **low**, affected `<= 2.1.0-beta.5`,
patched in **2.1.0-beta.6**.

## The defect

`insights:getReport` / `insights:getKpis` took a renderer-supplied `runId` and
passed it straight into `join(getInsightsDir(), runId, …)`. Nothing validated it,
so an id containing `..` resolved outside the Insights directory and the file was
read and returned. The same shape existed for `profileId`, which is worse in kind
because a profile directory becomes a spawned process's `HOME` — so the guard went
in at `getProfileConfigDir`, the single choke point every profile home is built
from, rather than at each of ~20 call sites.

Severity is low because it is not remotely reachable: something already executing
inside the renderer has to make the call, and no app code path constructs such an
id. It is a defence-in-depth failure, not a live exploit.

## The fix

Charset allowlists (`isValidRunId`, `isValidProfileId`) applied *before* any path
is built — at the IPC boundary and again at the resolvers. An allowlist rather
than a shape-specific regex because the run-id format has already changed once
(older archives are `YYYY-MM-DD-HHMMSS`, newer carry a `-mmmNNN` suffix); a strict
shape would have broken reading old archives, while the charset admits no `.`,
`/` or `\` in any format. Both take `unknown` and type-guard, because `RE.test(x)`
stringifies — a crafted `{ toString: () => 'ok' }` passed the earlier form.

`getProfileConfigDir` throws on an invalid id rather than returning a sentinel
(there is no in-band "invalid" value for a path); callers that can be reached with
an arbitrary id validate first so they take their existing fall-back branch
instead of the throw.

## What this cost us, and the rule that came out of it

The fix was merged from the advisory's temporary private fork, which — like every
such fork — **runs no Actions**. It landed on `beta` untested against `beta`, and
it broke the cross-account Insights tests from #206: that suite mocks
`account-profiles` and predated the guard, so it neither exported
`isValidProfileId` (the runner's call threw) nor used ids that pass it. `beta`
sat red until it was caught while preparing the release, where it would have
failed the release job.

**Rule: after any bypass-merge, run the full suite locally against the merged
branch.** The bypass is sanctioned — required checks can never report on a
private fork — but it means the branch's first real CI is the release itself.

## Sequencing that was followed

Fix merged → shipped in 2.1.0-beta.6 → patched version set on the advisory →
advisory published → *only then* this fragment and the changelog entry. Writing
either earlier is the disclosure the embargo exists to prevent
(`docs/security-embargo-runbook.md`).

Note for next time: the patched version must be set **before** publishing —
publishing does not back-fill it, and a published advisory with a blank patched
version has caught this project before.
