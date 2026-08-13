# Code signing

How installers are signed for release, and how to sign local builds.

## Golden rule

**A signing certificate's private key is a top-tier secret.** Never commit it
(the repo gitignores `*.pfx`/`*.p12`/`*.key`/… as a backstop), never paste it
into chat/issues/PRs, never bake it into a script that gets committed. If a key
is ever exposed, it must be revoked. Keys live in exactly two places: **on your
own machine** (for local builds) or **GitHub Actions encrypted secrets** (for
CI). Nowhere else.

## What's signed today

| Platform | Status | Mechanism |
|---|---|---|
| macOS (.dmg/app) | **Signed + notarized** in CI | `release.yml` imports `APPLE_CERTIFICATE` (base64 `.p12`) into a temp keychain, then `electron-builder --mac` signs with `hardenedRuntime` + `notarize: true` (package.json). |
| Windows (.exe/NSIS) | **Signed** in CI | SSL.com eSigner CKA (cloud HSM) inside electron-builder — see "CI: Windows" below. |
| Linux (AppImage) | Intentionally unsigned | No signing convention; verified via `CHECKSUMS.txt`. |

## Local builds

electron-builder (v26) auto-signs when the standard env vars are set — **no code
change needed**. Point the env at a cert file that lives **outside the repo**.

### Windows

The release certificate is cloud-held (see "CI: Windows" below) — there is no
`.pfx` to point at. Local Windows builds are normally left **unsigned** (fine
for dev). To produce a locally signed build, install eSigner CKA on your own
machine, load the certificate into your user store, then:

```powershell
npx electron-builder --win "-c.win.signtoolOptions.certificateSha1=<thumbprint>"
```

(For a hypothetical file-based cert, electron-builder's standard
`CSC_LINK`/`CSC_KEY_PASSWORD` — or the Windows-scoped `WIN_CSC_*` variants —
still work with no code change.) Output installer:
`dist/ClaudeCommandCenter-<version>.exe`.

Verify the signature:

```powershell
Get-AuthenticodeSignature "dist\ClaudeCommandCenter-<version>.exe" | Format-List Status, SignerCertificate
```

> The key never leaves your machine and is never seen by tooling beyond
> signtool. Don't hardcode the password in a committed file — use a per-session
> env var or a prompt.

### macOS (local, optional)

Same idea with `CSC_LINK`/`CSC_KEY_PASSWORD` pointing at your Developer ID `.p12`
+ `APPLE_ID`/`APPLE_APP_SPECIFIC_PASSWORD`/`APPLE_TEAM_ID` for notarization, then
`npm run package:mac`. (CI already does this — local signing is only for testing
the signed artifact.)

## CI: Windows (implemented — SSL.com eSigner CKA)

Windows installers are signed in `release.yml` with an SSL.com Personal ID (IV)
certificate via **eSigner CKA**. The private key lives in SSL.com's cloud HSM
and never exists as a file anywhere — not on the runner, not in secrets. CKA
registers a Windows KSP so the cloud key appears in the runner's user
certificate store, and electron-builder's normal signtool path signs with it
**during packaging**. That placement is load-bearing: `latest.yml`'s sha512,
the `.blockmap`, and `CHECKSUMS.txt` all hash the final signed binary — signing
after packaging would silently break auto-update.

The pieces:

- **`release.yml` (build-windows):** downloads the pinned CKA installer (URL +
  SHA-256 verified in the workflow), configures it from secrets, loads the
  certificate, and injects the store thumbprint via
  `-c.win.signtoolOptions.certificateSha1=…`. Signing runs only when the
  secrets are present.
- **`package.json` (`build.win.signtoolOptions`):** `signingHashAlgorithms:
  ["sha256"]` (electron-builder's default still tries SHA-1, which modern CAs
  refuse), SSL.com's RFC3161 timestamp server (`http://ts.ssl.com`), and
  `publisherName: "Nicholas Moger"`. `publisherName` does **not** verify
  anything at build time — electron-builder's only use of it is to write it into
  the packaged `app-update.yml`. Keep it equal to the certificate CN so it is
  correct if electron-updater is ever adopted; it is otherwise inert. The real
  build-time signature check is the verify gate below.

> **What signing does and does not change for updates.** Signing gives the
> installer a *verified publisher* in Windows' UAC/SmartScreen prompts — no
> more "unknown publisher". It does **not** add publisher verification to the
> in-app updater: this app ships a custom updater (`src/main/github-update.ts`),
> not electron-updater, and it verifies each downloaded update by **SHA-256
> against `CHECKSUMS.txt`** (unchanged by this work). `publisherName` above only
> writes `app-update.yml` (metadata a hypothetical future electron-updater would
> read) — no current runtime code consults it. If we ever want the updater to
> also check the Authenticode publisher, that is separate runtime work (and its
> own adversarial pass).
- **Verification gate:** after packaging, the workflow fails unless the
  installer has a Valid Authenticode signature whose leaf **thumbprint matches
  the certificate loaded at signing time** (and whose CN is the expected one),
  with an RFC3161 timestamp. This gate — not `publisherName` — is what enforces
  the signer identity. A stable/beta run without signing secrets fails outright;
  we never silently ship unsigned again. Only `channel=dev` may build unsigned,
  and only when the secrets are absent.

**Secrets (Actions):** `ES_USERNAME` (SSL.com account username), `ES_PASSWORD`,
`ES_TOTP_SECRET` (the eSigner TOTP *secret* from the enrollment QR — not a
6-digit code). `ES_CREDENTIAL_ID` is also set but **not currently consumed** by
`release.yml` — CKA auto-selects the sole signing credential; it is reserved for
if the account ever holds more than one. To rotate the TOTP secret,
use "reset eSigner PIN or get new QR Code" in the SSL.com portal — the old
secret dies instantly everywhere it was copied.

**eSigner account requirement:** the eSigner **Malware Blocker** must be
*disabled* (eSigner portal → Settings). When it is on, the cloud refuses any
hash that was not pre-scanned — CKA cannot pre-scan, so signing fails with
"hash needs to be scanned first before submitting for signing". This is
SSL.com's documented configuration for CKA-based CI signing.

**Test without releasing:**

```bash
gh workflow run release.yml --ref <branch> -f channel=dev -f skip_vt=true -f dry_run=true
```

`dry_run` builds, signs and verifies the Windows installer only — no macOS or
Linux jobs, no tag, no release; the artifact hangs off the workflow run.

**SmartScreen expectations:** signatures are valid immediately, but SmartScreen
reputation accrues to the certificate over time — early installs may still see
a reputation prompt (with the publisher named, not "Unknown"). Reputation
survives app renames; it keys on the certificate.

## Setting GitHub secrets safely

`gh secret set` reads from a file or a hidden prompt and **never echoes the
value**. Always set secrets this way (or via the Settings UI) — never on a
command line where the value would land in shell history.
