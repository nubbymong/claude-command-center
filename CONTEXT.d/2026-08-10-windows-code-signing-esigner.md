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
  `publisherName: "Nicholas Moger"` — from the first signed release onward,
  electron-updater verifies the publisher of every downloaded Windows update.
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

Details in `docs/code-signing.md` (rewritten: the old text still recommended
Azure Trusted Signing, which is unavailable to UK individuals and was a dead
end). Security-sensitive change (release pipeline + updater verification path)
→ adversarial review before merge per ADR-009.
