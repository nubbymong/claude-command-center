# ADR-011: Contributors open their own private advisories; the embargo procedure is documented, not inferred

- **Status:** Accepted (2026-07-31)
- **Amends:** ADR-010 (security posture and embargo) — corrects a factual premise, does not reverse the decision
- **Deciders:** @nubbymong (owner)
- **Related:** #167, docs/security-embargo-runbook.md, SECURITY.md, ADR-009, CONTEXT.d/2026-07-31-167-security-embargo-runbook.md

## Context

ADR-010 established the embargo rule: a finding stays out of every tracked artefact until
its fix ships, and development happens in the private fork GitHub attaches to the
advisory. That rule is correct and stands.

What ADR-010 never said is **who can start it**. Its workflow reads "the advisory is
created first" in the passive voice, with no actor. `SECURITY.md` inherited the same gap.

The first real exercise of the process exposed what that omission costs. Working an
embargoed finding as a `write` collaborator, the obvious API call was tried:

```
POST /repos/{owner}/{repo}/security-advisories
403  You must have the repository security advisories scope and
     administrative/security management rights to create an advisory.
```

The conclusion drawn — and written up, and acted on — was that no private channel exists
for a non-owner, that the workflow merged hours earlier was unexecutable by anyone but
@nubbymong, and that the remedy was to grant a collaborator the security-manager role.

**Every part of that was wrong.**

1. Private vulnerability reporting is enabled on this repository. A *different* endpoint,
   `POST /repos/{owner}/{repo}/security-advisories/reports`, is open to **any GitHub
   account**, collaborator or not. It is what the `/security/advisories/new` link in
   `SECURITY.md` has always pointed at.
2. `start_private_fork: true` on that call creates the temporary private fork in the same
   request, so a contributor gets a place to develop the fix without any owner action.
3. Security manager is an **organization-level** role. This repository is owned by a user
   account, so it cannot be granted here at all. The proposed remedy was impossible.

The correct capability boundary, verified empirically rather than inferred: a `write`
collaborator can file the advisory, obtain the private fork, push to it (despite the fork
reporting `permissions.push: false` — that field is not authoritative for advisory forks),
and open a PR inside it. Only accepting the report out of `triage`, merging, and
publishing require the owner.

The failure mode matters more than the specific mistake. It is the same one ADR-010 was
written to prevent: someone holds a live finding, believes no private channel is available
to them, and the nearest writable surface is a tracked file. A workflow that is possible
but not *documented as possible* fails exactly like one that is impossible.

## Decision

**1. Contributors open their own private advisories.** Routing a finding through the owner
out of band is the fallback, not the default. Anyone who finds something can file it and
get a private fork immediately, which shortens the window in which an unfixed
vulnerability exists only in someone's head or on their disk.

**2. The procedure is written down and executable, not inferred from the policy.** A new
`docs/security-embargo-runbook.md` carries the verified permission matrix, working `gh`
recipes, the private-fork workflow, and — deliberately — the traps. `SECURITY.md` remains
the normative rule and links to it.

**3. The traps are documented as first-class content, not footnotes.** Each cost real time
on the first run, and none is discoverable from the API responses:

- the two near-identically-named endpoints with opposite permission requirements, and the
  403 whose wording invites the wrong conclusion
- security manager being org-only, and therefore a dead end here
- the private fork reporting `permissions.push: false` while accepting pushes
- the fork defaulting to `main` when this project lands fixes on `beta`
- PVR submissions landing in `triage` rather than as maintainer drafts
- `dismissed_comment` on code-scanning alerts capping at 280 characters
- Dependabot and CodeQL tracking the **default branch**, so alerts do not clear on a merge
  to `beta` — only after promotion, and CodeQL also needs its next scheduled scan

**4. The rule is repeated in three places, each pointing at the runbook rather than
restating it:** `SECURITY.md` (reporters), `AGENTS.md` (anyone working the repo), and the
adversarial-review skill's Phase 3.5 (the process most likely to generate an embargoed
finding). Phase 3.5 previously said "hand the detail to the maintainer and let them open
the advisory" — now corrected to say the agent can and should open it itself.

## Consequences

**Positive.** The embargo path is executable by the people most likely to need it. The
window between discovery and containment shrinks, because containment no longer waits on
owner availability. The traps are recorded once instead of being rediscovered.

**Negative.** More documentation surface to keep true — `SECURITY.md`, the runbook,
`AGENTS.md`, and the skill all describe one process. Mitigated by making the runbook the
single procedural source and the other three pointers to it. The runbook also encodes
GitHub API behaviour that GitHub may change; the permission matrix should be re-verified
if a step ever behaves unexpectedly, rather than trusted indefinitely.

**Rejected alternative — grant collaborators elevated repository roles.** The original
proposal, and impossible as stated: security manager is org-only, and a personal
repository cannot give a collaborator admin. Even where possible it would be the wrong
trade, handing out broad repository administration to solve a documentation problem.

**Rejected alternative — move the repository to an organization.** This would make
security manager grantable and is worth considering on its own merits, but it is a large
change to fix a gap that documentation closes completely. PVR already provides the needed
capability.

**Rejected alternative — leave it to the owner and say so.** Honest, and strictly worse.
It would institutionalise a delay between finding and containment for no benefit, when the
platform already supports contributor self-service.
