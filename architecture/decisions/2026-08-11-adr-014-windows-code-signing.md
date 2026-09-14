# ADR-014: Sign Windows releases with SSL.com eSigner CKA, inside electron-builder

- **Status:** Accepted (2026-08-11)
- **Deciders:** @nubbymong (owner)
- **Related:** #251, `docs/code-signing.md`, ADR-009 (adversarial review), #111 (updater checksum verification), #225 (MSIX/Store — separate, opt-in), CONTEXT.d/2026-08-10-windows-code-signing-esigner.md

## Context

Windows installers shipped unsigned, so SmartScreen showed an "unknown publisher"
warning and every download had to be trusted purely by its SHA-256. macOS was already
signed + notarized in CI; Windows was the gap.

Two constraints shaped the choice:

1. **The owner is a UK individual, not a registered company.** Azure Trusted Signing —
   the modern OIDC-federated option — does not offer individual identity validation in
   the UK, and its org route needs a registered entity with D-U-N-S and multi-year
   history. It was a dead end (proven, not assumed). A physical hardware token (the
   classic EV path) can't be plugged into a GitHub-hosted runner.
2. **Auto-update must keep working.** The release job computes `latest.yml` (sha512),
   the `.blockmap`, and `CHECKSUMS.txt` from the built binary, and clients since #111
   refuse any download they can't verify against `CHECKSUMS.txt`. Signing a binary
   *after* packaging would change its bytes and invalidate all three.

## Decision

Sign Windows releases with an **SSL.com Personal ID (IV) code-signing certificate** held
in **SSL.com's eSigner cloud HSM**, driven by the **eSigner CKA** adapter, **inside**
electron-builder's packaging step.

- The private key never exists as a file — not on the runner, not in secrets. CKA
  registers a Windows KSP so the cloud key appears in the runner's certificate store;
  electron-builder's normal signtool path signs during packaging, so the updater hashes
  cover the signed bytes.
- `release.yml` installs the pinned CKA adapter (URL + SHA-256 verified before it runs),
  configures it from `ES_*` secrets, loads the cert, and injects only the store
  thumbprint via `-c.win.signtoolOptions.certificateSha1=…`.
- A **fail-closed verify gate** after packaging requires a Valid Authenticode signature
  whose leaf thumbprint matches the cert loaded at signing time, with an RFC3161
  timestamp. A stable/beta run that is not validly signed **fails**; only `channel=dev`
  may build unsigned, and only when the secrets are absent.
- `build.win.signtoolOptions` pins `signingHashAlgorithms: ["sha256"]` (electron-builder's
  default still attempts SHA-1, which modern CAs refuse) and timestamps at `ts.ssl.com`.

## Scope boundary — signing is not update-signature verification

This is the load-bearing caveat, surfaced by the ADR-009 adversarial pass on #251.

Signing gives the installer a **verified publisher** in Windows' UAC/SmartScreen prompts.
It does **not** make the in-app updater verify an update's Authenticode publisher: this
app ships a **custom** updater (`src/main/github-update.ts`), not electron-updater, and it
verifies downloads by **SHA-256 against `CHECKSUMS.txt`** (#111), unchanged by this work.
`build.win.signtoolOptions.publisherName` is therefore inert at runtime — electron-builder
only writes it into an `app-update.yml` that no shipped code reads; it is kept equal to the
certificate CN so it is correct if electron-updater is ever adopted. Signer identity in CI
is enforced by the verify gate, not by `publisherName`. Adding true publisher verification
to the updater is separate runtime work and would get its own adversarial pass.

## Consequences

- **Positive:** no more "unknown publisher"; no exportable key to leak or rotate; works on
  ephemeral GitHub-hosted runners; auto-update integrity preserved; the gate makes an
  accidental unsigned stable/beta release impossible.
- **Cost / operational:** ~$309/yr (cert + eSigner Tier 1, 240 signings/yr rolling over,
  then $1 each; ~3 signings per build). The eSigner **Malware Blocker must stay disabled**
  (it refuses unscanned hashes, which CKA cannot pre-scan). The `ES_TOTP_SECRET` is a
  permanent shared secret; rotate via the SSL.com portal.
- **Forward lock-in (CI-only):** every stable/beta build must be signed by a cert whose CN
  the verify gate accepts. At renewal (cert expires 2027-08-10) a changed CN/CA means a
  one-line workflow edit; because no client verifies signatures, there is **no
  client-stranding time-bomb** today. Were client-side signature verification ever added,
  a CN change would become a migration event and need a two-step (accept-both) rollout.
- **SmartScreen** reputation accrues to the certificate over installs and survives app
  renames; early signed builds may still prompt, now with a named publisher. IV does not
  get the instant reputation an EV cert would.
- **MSIX out of scope.** The Store/MSIX path (#225) is opt-in, not in `build.win.target`,
  and not built by `release.yml`; it is unaffected and would need its own signing.
- **Secrets posture (follow-up):** `ES_*` are repo-level, readable by any Write
  collaborator via `workflow_dispatch` on any branch — the same exposure the existing
  `APPLE_*` / `VT_API_KEY` secrets carry. Moving all signing/publish secrets into a
  protected Environment (deployment-branch policy) is recommended and tracked separately;
  it is not a defect in this change.
