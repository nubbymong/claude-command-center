# 2026-08-10 — Windows release signing via SSL.com eSigner CKA

Windows installers are now code-signed in CI. The SSL.com Personal ID (IV)
certificate is cloud-held (eSigner, no exportable key, no USB token); the
release workflow installs the pinned eSigner CKA adapter (SHA-256-verified
download), loads the cert into the runner's store, and electron-builder signs
during packaging — inside the build, so `latest.yml`/`.blockmap`/`CHECKSUMS.txt`
hash the signed binary and auto-update stays intact.

Decisions that matter later:

- `build.win.signtoolOptions` pins `signingHashAlgorithms: ["sha256"]`
  (electron-builder's default still attempts SHA-1 dual-signing, which modern
  CAs refuse), timestamps at `http://ts.ssl.com`, and sets
  `publisherName: "Nicholas Moger"` — inert at build time (electron-builder only
  writes it into `app-update.yml`); keep it equal to the cert CN for a possible
  future electron-updater. Signer identity is enforced by the workflow verify
  gate, not by `publisherName`.
- **Signing does NOT add publisher verification to updates.** The app ships a
  custom updater (`src/main/github-update.ts`), not electron-updater; it
  verifies downloads by SHA-256 against `CHECKSUMS.txt` (unchanged). No runtime
  code reads `publisherName`. Adversarial review (below) caught an earlier draft
  of the changelog/docs claiming otherwise — corrected before merge. What
  signing buys the user today: a verified publisher in UAC/SmartScreen instead
  of "unknown publisher".
- The workflow gains a hard gate: a stable/beta build that is not validly
  signed by the expected CN fails. Unsigned builds are possible only on
  `channel=dev` with no signing secrets configured.
- New `dry_run` dispatch input: Windows-only build + sign + verify, no tag or
  release — used to prove the pipeline end-to-end before it touched a real
  channel, and useful for any future release-pipeline test.
- Secrets: `ES_USERNAME` / `ES_PASSWORD` / `ES_TOTP_SECRET`
  (+ optional `ES_CREDENTIAL_ID`). Rotation = "reset eSigner PIN or get new QR
  Code" in the SSL.com portal. The TOTP secret was rotated once during setup
  by design.
- SmartScreen reputation keys on the certificate and accrues gradually;
  early signed installs may still see a reputation prompt, now with a named
  publisher.
- The verify gate pins the exact leaf thumbprint captured at load time (not a
  CN substring), and template values are passed via `env:` rather than
  interpolated into PowerShell — both from the adversarial pass.
- **Open owner-action (not a code defect):** the `ES_*` signing secrets are
  repo-level, so any Write collaborator can read them via a `workflow_dispatch`
  on an arbitrary branch — the same exposure the existing `APPLE_*`/`VT_API_KEY`
  secrets already carry, now holding a code-signing identity. Recommended:
  move all signing/publish secrets into a protected Environment with a
  deployment-branch policy (beta + release/*). Deferred to an owner decision.

Details in `docs/code-signing.md` (rewritten: the old text still recommended
Azure Trusted Signing, which is unavailable to UK individuals and was a dead
end). Security-sensitive change (release pipeline + updater verification path)
→ adversarial review before merge per ADR-009.
