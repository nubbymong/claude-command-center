## 2026-07-31 -- Document the embargo procedure; contributors can self-serve (#167)

#159 wrote the embargo RULE correctly and never said who could execute it or how. Its
workflow is in the passive voice -- "the advisory is created first" -- with no actor. The
first real run of the process showed what that omission costs. Decision in ADR-011, which
amends ADR-010 without reversing it; procedure in docs/security-embargo-runbook.md.

What happened, recorded because the mistake is the whole reason the doc exists: working an
embargoed finding as a `write` collaborator, the obvious endpoint was tried --
`POST /repos/{owner}/{repo}/security-advisories` -- which 403s with "you must have ...
administrative/security management rights". The conclusion drawn was that no private
channel existed for a non-owner, that the policy merged hours earlier was unexecutable by
anyone but the owner, and that the fix was to grant the security-manager role. All three
were wrong:

- Private vulnerability reporting is enabled here, so
  `POST /repos/{owner}/{repo}/security-advisories/reports` is open to ANY account. It is
  what the /security/advisories/new link in SECURITY.md always pointed at. The two
  endpoints differ by one path segment and have opposite permission requirements.
- `start_private_fork: true` on that same call creates the temporary private fork, so a
  contributor gets somewhere to develop the fix with zero owner involvement.
- Security manager is an ORGANISATION-level role. This repo is owned by a user account, so
  it cannot be granted here at all -- the proposed remedy was impossible, and sent the
  owner to change a setting that does not exist.

Verified capability boundary for a `write` collaborator: file the advisory, get the private
fork, push to it, open a PR inside it. Only accepting the report out of `triage`, merging,
and publishing need the owner.

The failure mode is the point, not the individual error. It is the same one #159 exists to
prevent -- someone holds a live finding, believes there is no private channel available to
them, and the nearest writable surface is a tracked file. A workflow that is possible but
not DOCUMENTED as possible fails exactly like one that is impossible.

Changes:
- NEW docs/security-embargo-runbook.md -- permission matrix (verified against this repo,
  not quoted from general docs), gh recipes for both paths, private-fork workflow, what
  must not be written down, publishing order, and a gotcha table.
- SECURITY.md Embargo section: states plainly that you do not need to be the owner, names
  both endpoints and why the 403 misleads, links the runbook.
- AGENTS.md: same correction where agents will hit it.
- adversarial-review SKILL.md Phase 3.5: previously said "hand the detail to the maintainer
  and let them open the advisory". Now says open it yourself, with the fallback noted. Also
  adds the base-branch rule (fix goes on `beta`; the fork inherits `main` as default and
  main runs behind).

Gotchas captured in the runbook, each of which cost time and none discoverable from the API
responses: the two endpoints; security manager being org-only; the private fork reporting
`permissions.push: false` while accepting pushes; the fork defaulting to `main`; PVR
submissions landing in `triage`; `dismissed_comment` capping at 280 chars; and Dependabot
+ CodeQL tracking the DEFAULT branch, so alerts do not clear on a merge to `beta` -- only
after promotion, and CodeQL also needs its next scheduled scan.
