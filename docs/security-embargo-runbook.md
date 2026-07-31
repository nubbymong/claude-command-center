# Security embargo runbook

How to take a vulnerability from "I just found this" to "the fix has shipped", without
disclosing it on the way.

`SECURITY.md` is the policy — *what* the rule is. This is the procedure — *how* to execute
it, and who can. Read the Embargo section of `SECURITY.md` first; it is the normative
text and this document only tells you how to comply with it.

> **The one-line version.** You do not need to be the repository owner to open a private
> channel. Private vulnerability reporting is enabled, so any contributor can file a
> private advisory and get a private fork to fix it in.

## Who can do what

Verified against this repository, not quoted from general documentation.

| Action | Needs | A `write` collaborator? |
| --- | --- | --- |
| File a private report (PVR) | Any GitHub account | **Yes** |
| Get a temporary private fork | Filing the report with `start_private_fork` | **Yes** |
| Push to that private fork | Being on the advisory | **Yes** |
| Open a PR inside the private fork | Same | **Yes** |
| Create a *maintainer* draft advisory | Owner / org owner / admin / security manager | No |
| Accept a report out of `triage` | Owner or admin | No |
| Merge the fix and publish | Owner or admin | No |

So a contributor can do everything up to the point of merging. That is the whole job — the
finding is contained, the fix exists and is reviewable, and the owner's remaining work is
a review and two clicks.

### The trap that makes people think otherwise

There are two endpoints with nearly the same name and completely different permissions:

```
POST /repos/{owner}/{repo}/security-advisories          <- MAINTAINER. Needs admin.
POST /repos/{owner}/{repo}/security-advisories/reports  <- PVR. Anyone.
```

Hitting the first one as a collaborator returns:

```
403  You must have the repository security advisories scope and
     administrative/security management rights to create an advisory.
```

That message is easy to read as "you cannot open a private channel". It means "you cannot
use *this* endpoint". The `/security/advisories/new` link in `SECURITY.md` points at the
second one.

Related dead end: **"security manager" is an organization-only role.** This repository is
owned by a user account, so it cannot be granted here. Do not spend time on it.

## Path A — you found a vulnerability (any contributor)

### Web

Go to **Security → Advisories → Report a vulnerability**, or straight to
`/security/advisories/new`. Fill in the summary, description, severity, and affected
versions. Tick **"Start a temporary private fork"**.

### CLI

Equivalent, and easier to get right for a long description. Write the description to a
file first so Markdown survives intact:

```sh
# 1. description in its own file (NOT inside the repo -- see Embargo below)
#    ~/sec/desc.md

# 2. build the payload
node -e "
const fs=require('fs');
fs.writeFileSync('payload.json', JSON.stringify({
  summary: 'One line, <=1024 chars',
  description: fs.readFileSync('desc.md','utf8'),
  cvss_vector_string: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:U/C:H/I:N/A:N',
  cwe_ids: ['CWE-22'],
  vulnerabilities: [{
    package: { ecosystem: 'other', name: 'claude-command-center' },
    vulnerable_version_range: '<= 2.1.0-beta.2',
    vulnerable_functions: ['theFunction']
  }],
  start_private_fork: true
}));
"

# 3. file it
gh api -X POST \
  repos/nubbymong/claude-command-center/security-advisories/reports \
  --input payload.json
```

`ecosystem: 'other'` is correct — this app is not published to a package registry.

The response carries `ghsa_id`, `state: "triage"`, and `private_fork.full_name`. Keep the
GHSA id; you need it next. **The report lands in `triage`** — it is a submission awaiting
the owner, not a maintainer-authored draft. That is expected.

If `start_private_fork` was omitted, create the fork from the advisory page
("Start a temporary private fork").

## Path B — you are the owner or an admin

Use the maintainer endpoint or the **New draft advisory** button. Everything below is the
same from here.

## Developing the fix

The temporary private fork is a real repository named
`<repo>-ghsa-xxxx-xxxx-xxxx`. Work there, never on a branch of the public repo.

```sh
FORK=https://github.com/nubbymong/claude-command-center-ghsa-xxxx-xxxx-xxxx.git
git push "$FORK" my-local-fix-branch:fix/short-description
```

Two things will look wrong and are not:

- **The fork reports `permissions.push: false`.** Push anyway — it works. Advisory
  collaborator rights override the repository permission field, which is not authoritative
  for these forks.
- **The fork's default branch is `main`.** This repository lands fixes on `beta` and
  promotes to `main` (see `AGENTS.md`, Release Process), and `main` can be many releases
  behind. **Open the PR against `beta`, not the default.** The fork mirrors every branch,
  so `beta` is there and is normally identical to the public head:

```sh
gh pr create --repo nubbymong/claude-command-center-ghsa-xxxx-xxxx-xxxx \
  --base beta --head fix/short-description \
  -t "fix(scope): what it does" -F prbody.md
```

Base your fix commit on `beta` for the same reason.

### Regression tests

Ship them with the fix — this is the one thing that necessarily describes the bug, and it
is fine because it lands at the same moment the fix does.

**Verify the test fails against the unfixed code.** Revert the fix, run the test, watch it
fail, restore. A green test proves nothing on its own; this project has already produced
regression tests that passed against the very code they were written to catch. See the
adversarial-review skill for why this is a standing rule.

## What must not be written down, and where people slip

Full rule in `SECURITY.md`. The operational summary:

**Anything that gets pushed is publication.** During an embargo, nothing about the finding
goes in issues, PRs on the public repo, commit messages, branch names, `CONTEXT.d/`
fragments, ADRs, or the changelog.

`CONTEXT.d/` is the one that catches people, because the running log feels like a private
notebook and is a tracked file. A fragment for embargoed work may record *that* a finding
exists and was routed privately — never the component, the mechanism, or the repro.

Two practical habits:

- Keep advisory drafts, patches, and scratch notes **outside the repository**. A
  `~/sec/` directory, not a gitignored path inside the checkout.
- Do not cite the GHSA id in any tracked file before publication. It is not resolvable to
  outsiders, but it signals that an unpublished advisory exists and becomes a live link
  the moment you publish.

## Publishing, and the public record

In order:

1. Owner accepts the report out of `triage`.
2. Owner reviews and merges the PR **inside the private fork**.
3. Owner publishes the advisory. Request a CVE at this point if it warrants one.
4. **Only now** write the public record, all together:
   - the `CONTEXT.d/` fragment for the work
   - the changelog entry in `src/renderer/changelog.ts`, then `npm run changelog`
   - a public issue for any follow-up hardening

Step 4 last is the whole point. Writing any of it earlier is the disclosure the embargo
exists to prevent.

## Gotchas

Each of these cost real time on the first run of this process.

| Symptom | Cause and fix |
| --- | --- |
| `403` creating an advisory | Wrong endpoint. Use `.../security-advisories/reports` |
| "Ask for the security manager role" | Org-only. Not grantable on a user-owned repo |
| Fork shows `permissions.push: false` | Not authoritative. `git push` works |
| PR wants to target `main` | Retarget to `beta`; `main` is behind |
| Report sits in `triage` | Normal for PVR. The owner accepts it |
| `422` dismissing a code-scanning alert | `dismissed_comment` is capped at **280 characters** |
| A scanner alert stays open after merging to `beta` | Dependabot and CodeQL track the **default branch** (`main`). Alerts clear after promotion, and CodeQL also needs its next scheduled scan |

## See also

- `SECURITY.md` — the policy, including the normative embargo rule
- `architecture/decisions/2026-07-30-adr-010-security-posture-and-embargo.md`
- `architecture/decisions/2026-07-31-adr-011-contributors-self-serve-embargo.md`
- `.claude/skills/adversarial-review/SKILL.md` — Phase 3.5 routes findings into this
  process
