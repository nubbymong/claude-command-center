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
| Windows (.exe/NSIS) | **Unsigned** in CI (SmartScreen warns) | Not yet wired — see "CI: Windows" below. |
| Linux (AppImage) | Intentionally unsigned | No signing convention; verified via `CHECKSUMS.txt`. |

## Local builds

electron-builder (v26) auto-signs when the standard env vars are set — **no code
change needed**. Point the env at a cert file that lives **outside the repo**.

### Windows (traditional OV `.pfx`)

PowerShell, per session (nothing persisted, nothing committed):

```powershell
$env:CSC_LINK = "C:\secure\path\outside-repo\codesign.pfx"   # path OR base64 OR file://
$env:CSC_KEY_PASSWORD = "<pfx password>"                       # or read from a prompt
npm run package:win
```

Use `WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD` instead if you want to scope it to
Windows explicitly (won't touch a mac build in the same shell). Output installer:
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

## CI: Windows (best-practice options)

Pick one when you're ready; then the release workflow gets a small signing step.

- **Recommended — Azure Trusted Signing** (managed signing service): no
  exportable private key, short-lived certs, OIDC federation from GitHub Actions
  (no long-lived secret to rotate). Setup: create a Trusted Signing account +
  certificate profile in Azure, federate a GitHub OIDC credential, add the
  `azure/trusted-signing-action` (or electron-builder's `azureSignOptions`) to
  `release.yml`. This is the modern standard and avoids handling a `.pfx` in CI.
- **Simpler fallback — `.pfx` in GitHub secrets:** base64 the OV `.pfx`, store as
  a secret, decode + sign at build time. Reuses the same env-var path as local:
  - Create the `.b64` **outside the repo** (same rule as the `.pfx` itself) and
    `cd` there to run the command below; delete it once the secret is set. It is
    a base64-wrapped private key, not a safer form of one — `*.b64` is
    gitignored as a backstop, not a license.
  - `gh secret set WIN_CSC_LINK --repo <owner>/<repo> < cert.b64`  (base64 of the `.pfx`; command never prints it)
  - `gh secret set WIN_CSC_KEY_PASSWORD --repo <owner>/<repo>`  (prompts, hidden)
  - workflow: add `WIN_CSC_LINK` + `WIN_CSC_KEY_PASSWORD` to the Windows build
    step's `env:` (electron-builder does the rest). Trade-off: a long-lived key
    in secrets that must be rotated and revoked carefully.

DigiCert KeyLocker / other cloud-HSM signtool integrations are equivalent to the
Azure option (key never exportable) if that's your CA.

## Setting GitHub secrets safely

`gh secret set` reads from a file or a hidden prompt and **never echoes the
value**. Always set secrets this way (or via the Settings UI) — never on a
command line where the value would land in shell history.
