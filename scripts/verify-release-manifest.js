#!/usr/bin/env node
/**
 * Verify that a published release's CHECKSUMS.txt actually lets the CLIENT
 * verify every installer ATTACHED TO THAT RELEASE. (#173, follow-up to #111.)
 *
 * Why this exists
 * ---------------
 * Since #111 the in-app updater REFUSES to install an asset it cannot verify.
 * That makes a defective manifest worse than no manifest: the update is still
 * offered (`checkGitHubRelease` only checks the asset exists), the client
 * downloads it, verification throws, and the user gets a blocked update on
 * every attempt — silently, until the next release.
 *
 * Two ways to reach that state, both live today:
 *   - `release.yml` regenerates the manifest from whatever survived
 *     (`sha256sum *` over artifacts/), and both `build-linux` and its download
 *     step are `continue-on-error`. The rolling re-release path then uses
 *     `gh release upload --clobber`, which replaces same-named assets but NEVER
 *     PRUNES — so a flaked Linux job leaves the OLD AppImage attached while the
 *     new manifest has no line for it.
 *   - `--clobber` is not atomic (`gh` documents "if the upload fails, the
 *     original assets will be lost"). CHECKSUMS.txt can land while an installer
 *     upload flakes, leaving the OLD binary attached under the NEW manifest's
 *     digest. The name is present; the bytes do not match.
 *
 * So the assets MUST be read back from the API, and BOTH halves checked: that
 * the client can resolve a digest for each installer, and that the digest it
 * would resolve matches the bytes GitHub is actually serving.
 *
 * ONE PARSER, NOT TWO
 * -------------------
 * `splitChecksumLine` and `digestForAsset` below are a deliberate, verbatim port
 * of `src/main/github-update.ts`. They are NOT a re-implementation and must not
 * drift: this gate's entire claim is "green means the client can verify this
 * release", which is false the moment the two parsers disagree. The first draft
 * of this file used an independent regex and diverged in four ways within a day
 * — most seriously, it PASSED a manifest carrying two conflicting lines for one
 * asset, which the client refuses outright as doctored.
 *
 * The port cannot be replaced by an import: `github-update.ts` is TypeScript and
 * pulls in `electron`, and this runs as plain node on a CI runner with no build
 * step. `tests/unit/scripts/verify-release-manifest.test.ts` therefore imports
 * the REAL `digestForAsset` and asserts, over a corpus, that this copy agrees
 * with it on every input. That differential test is the thing that stops the
 * drift — not the comment you are reading.
 *
 * `scripts/release.js` already fails when CHECKSUMS.txt is ABSENT. This covers
 * present-but-defective, and it runs on the workflow-dispatch path, where
 * release.js never executes at all.
 *
 * Usage:
 *   node scripts/verify-release-manifest.js <tag>
 *   node scripts/verify-release-manifest.js            (reads $TAG)
 */

const { execFileSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

// ============================================================
// PARSER — verbatim port of src/main/github-update.ts.
// Keep in lockstep; the differential test enforces it.
// ============================================================

/** Hex digest shape. Anchored, fixed length, no quantifier to backtrack on. */
const HEX64 = /^[0-9a-f]{64}$/i

/** SP or HTAB — the only separators `sha256sum` emits. */
function isSpOrHtab(c) {
  return c === ' ' || c === '\t'
}

/**
 * Split one `sha256sum` line into [digest, filename] without a regex that can
 * backtrack.
 *
 * Index-based on purpose. The obvious pattern — `/^([0-9a-f]{64})\s+\*?(.+)$/i`
 * — is QUADRATIC: U+2028 matches `\s` but not `.`, so a long run of spaces
 * followed by a non-whitespace tail makes the greedy `.+` fail and `\s+` give
 * back a character per position. github-update.ts measured 27 s at 256k and the
 * first draft of THIS file measured 15.5 s at 128k before it was replaced. Same
 * shape as the Authorization-header bug in #151.
 */
function splitChecksumLine(line) {
  const sp = line.search(/\s/)
  if (sp !== 64) return null
  const digest = line.slice(0, 64)
  if (!HEX64.test(digest)) return null
  let rest = line.slice(64)
  // Only SP/HTAB separate the digest from the name. Any OTHER whitespace here
  // means a hand-edited or hostile manifest, so refuse the line rather than
  // normalise it — a lenient separator is one more shape a parser and a reader
  // can disagree about.
  let i = 0
  while (i < rest.length && isSpOrHtab(rest[i])) i++
  if (i === 0) return null
  if (i < rest.length && /\s/.test(rest[i])) return null
  rest = rest.slice(i)
  if (rest.startsWith('*')) rest = rest.slice(1)
  if (!rest) return null
  return [digest, rest]
}

/**
 * Find the digest for `assetName` in a `sha256sum`-format manifest.
 *
 * Returns null when the manifest is unparseable, does not mention the asset, or
 * mentions it TWICE with different digests. Null is fatal to the client, so it
 * is fatal here too — treating it as "skip the check" is how the whole control
 * gets bypassed by editing one line.
 */
function digestForAsset(manifest, assetName) {
  if (!manifest || !assetName) return null
  let found = null
  for (const raw of String(manifest).split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const parts = splitChecksumLine(line)
    if (!parts) continue
    // `sha256sum *` emits bare names, but tolerate a path prefix.
    const name = parts[1].trim().replace(/^.*[/\\]/, '')
    if (name !== assetName) continue
    // A second line for the same asset means the manifest is ambiguous or
    // doctored. Refuse rather than pick one.
    if (found !== null && found !== parts[0].toLowerCase()) return null
    found = parts[0].toLowerCase()
  }
  return found
}

/** Refuse a manifest larger than the client will read. Must match
 *  MAX_MANIFEST_BYTES in github-update.ts: a manifest this gate accepts and the
 *  client refuses is a release that passes CI and cannot be installed. */
const MAX_MANIFEST_BYTES = 1024 * 1024

// ============================================================
// AUDIT (pure — see tests/unit/scripts/verify-release-manifest.test.ts)
// ============================================================

/**
 * Extensions to gate. Deliberately a strict SUPERSET of what the client will
 * fetch (`installerExtForPlatform` in github-update.ts, which is
 * case-SENSITIVE and additionally requires a `ClaudeCommandCenter-` prefix):
 * over-covering can only fail a release that would have worked, while
 * under-covering ships the dead end this gate exists to prevent.
 *
 * It is still duplicated knowledge, so the test asserts this set covers
 * everything `installerExtForPlatform` can return, imported from the real
 * module. Adding an electron-builder target without widening this list would
 * otherwise exempt the new installer kind silently.
 */
const INSTALLER_EXTENSIONS = ['.exe', '.dmg', '.appimage']

function isInstaller(name) {
  const lower = String(name || '').toLowerCase()
  return INSTALLER_EXTENSIONS.some((ext) => lower.endsWith(ext))
}

/** Normalise a `gh` asset digest (`sha256:<hex>`) to bare lowercase hex. */
function normalizeApiDigest(digest) {
  if (typeof digest !== 'string') return null
  const m = /^(?:sha256:)?([0-9a-fA-F]{64})$/.exec(digest.trim())
  return m ? m[1].toLowerCase() : null
}

/**
 * Audit one published release.
 *
 * @param {{
 *   attached: Array<string | {name: string, digest?: string|null}>,
 *   manifestText: string|null,
 *   manifestBytes?: number|null,
 * }} input
 * @returns {{ok: boolean, reason: string|null, installers: string[],
 *            problems: Array<{name: string, why: string}>, warnings: string[],
 *            byteChecked: string[]}}
 */
function auditManifest({ attached, manifestText, manifestBytes = null }) {
  const assets = (attached || []).map((a) => (typeof a === 'string' ? { name: String(a), digest: null } : { name: String(a.name), digest: a.digest ?? null }))
  const names = assets.map((a) => a.name)
  const installers = assets.filter((a) => isInstaller(a.name))
  const installerNames = installers.map((a) => a.name)
  const warnings = []
  const byteChecked = []

  const fail = (reason, problems = []) => ({ ok: false, reason, installers: installerNames, problems, warnings, byteChecked })

  if (!names.includes('CHECKSUMS.txt')) {
    return fail('CHECKSUMS.txt is not attached to the release', installerNames.map((name) => ({ name, why: 'no manifest is attached' })))
  }
  if (manifestText === null || manifestText === undefined) {
    return fail('CHECKSUMS.txt could not be read', installerNames.map((name) => ({ name, why: 'manifest unreadable' })))
  }
  // Enforced on the byte count when the caller has it (the file on disk), and
  // on the string length otherwise. The client refuses an oversized manifest
  // before parsing it, so accepting one here would certify an uninstallable
  // release.
  // Take the LARGER of what the caller measured and what the text actually
  // weighs. Trusting a caller-supplied count alone lets an under-reported
  // `manifestBytes` walk an oversized manifest straight past the cap.
  const textBytes = Buffer.byteLength(manifestText, 'utf-8')
  const size = Number.isFinite(manifestBytes) ? Math.max(Number(manifestBytes), textBytes) : textBytes
  if (size > MAX_MANIFEST_BYTES) {
    return fail(`CHECKSUMS.txt is ${size} bytes, over the ${MAX_MANIFEST_BYTES}-byte limit the client will read`)
  }

  // A release with no installer at all passes "every installer is covered"
  // vacuously. That is not a pass — it is a broken release, and letting it
  // through would make this gate green against exactly the state it exists to
  // catch.
  if (installers.length === 0) {
    return fail('no installer (.exe/.dmg/.AppImage) is attached to the release')
  }

  const problems = []
  for (const asset of installers) {
    // Ask the CLIENT's question, not a lookalike: can `digestForAsset` resolve
    // a digest for this name? Null covers absent, malformed, and
    // duplicated-with-conflicting-digests in one predicate.
    const manifestDigest = digestForAsset(manifestText, asset.name)
    if (manifestDigest === null) {
      problems.push({ name: asset.name, why: 'no resolvable CHECKSUMS.txt line (absent, malformed, or duplicated with conflicting digests)' })
      continue
    }
    // Second half: the manifest can name the asset and still describe different
    // bytes than GitHub is serving — the non-atomic `--clobber` case. GitHub
    // returns each asset's own digest, so this costs nothing to check.
    const apiDigest = normalizeApiDigest(asset.digest)
    if (apiDigest === null) {
      warnings.push(`${asset.name}: no digest from the API, so only the manifest LINE was checked, not the bytes`)
      continue
    }
    if (apiDigest !== manifestDigest) {
      problems.push({ name: asset.name, why: `CHECKSUMS.txt says ${manifestDigest.slice(0, 12)}... but the attached asset is ${apiDigest.slice(0, 12)}...` })
      continue
    }
    byteChecked.push(asset.name)
  }

  // Platform coverage is a WARNING, not a failure: build-linux is deliberately
  // continue-on-error, so a Linux-less release is a legitimate (if degraded)
  // outcome. Failing here would block a release the two required platforms
  // built fine. scripts/release.js still fails on it — but release.js does not
  // run on the workflow-dispatch path, so say it loudly here.
  for (const [ext, label] of [['.exe', 'Windows'], ['.dmg', 'macOS'], ['.appimage', 'Linux']]) {
    if (!installerNames.some((n) => n.toLowerCase().endsWith(ext))) {
      warnings.push(`no ${label} installer (${ext}) is attached — that platform gets no update from this release`)
    }
  }

  if (problems.length > 0) {
    return { ok: false, reason: `${problems.length} attached installer(s) the client could not verify`, installers: installerNames, problems, warnings, byteChecked }
  }
  return { ok: true, reason: null, installers: installerNames, problems: [], warnings, byteChecked }
}

// ============================================================
// MAIN
// ============================================================

const DEFAULT_ATTEMPTS = 3

function defaultRunGh(args) {
  return execFileSync('gh', args, { encoding: 'utf-8' }).trim()
}

function defaultSleep(ms) {
  // Synchronous by design: main() is a straight-line script and a blocking
  // wait between retries is simpler than making the whole thing async.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * Retry a read-only `gh` call. The release is queried IMMEDIATELY after
 * `gh release create`, and the API is eventually consistent — scripts/release.js
 * concedes the same race with a flat 3 s sleep. Without this, a 404 or a
 * secondary rate limit turns into a red gate on a perfectly good release, and a
 * gate that cries wolf is a gate people learn to ignore.
 */
function withRetry(fn, { attempts = DEFAULT_ATTEMPTS, sleep = defaultSleep, log = console.error } = {}) {
  let lastErr
  for (let i = 0; i < attempts; i++) {
    try {
      return fn()
    } catch (err) {
      lastErr = err
      if (i < attempts - 1) {
        const wait = 2000 * Math.pow(2, i)
        log(`[verify-release-manifest] attempt ${i + 1}/${attempts} failed (${err.message.split('\n')[0]}) — retrying in ${wait / 1000}s`)
        sleep(wait)
      }
    }
  }
  throw lastErr
}

/** Exit codes are distinct so the workflow (and a human) can tell "GitHub was
 *  unavailable" from "this release is broken". Both fail the job; only one
 *  means the release must be repaired. */
const EXIT_OK = 0
const EXIT_BROKEN_RELEASE = 1
const EXIT_CANNOT_VERIFY = 2

/**
 * Turn one `gh release view --json isDraft` result into a release state.
 *
 * The distinction that matters is ABSENT vs ERROR, and it has teeth: the
 * workflow decides whether to create a release, whether to DELETE one, and
 * whether to publish one from this answer. Reading an API outage as "no release
 * exists" is how a live published release gets deleted by a cleanup step, or
 * shadowed by a duplicate draft nobody looks at. So only the literal
 * "release not found" is absence; everything else is `error`, and `error` makes
 * the caller stop rather than guess.
 *
 * @returns {'draft'|'published'|'absent'|'error'}
 */
function classifyReleaseState({ ok, stdout, stderr }) {
  if (ok) {
    const value = String(stdout === undefined || stdout === null ? '' : stdout).trim()
    if (value === 'true') return 'draft'
    if (value === 'false') return 'published'
    return 'error'
  }
  return /release not found/i.test(String(stderr || '')) ? 'absent' : 'error'
}

/**
 * Ask GitHub what state a release is in, retrying only on `error`. An `absent`
 * or a definite draft/published answer is final and is returned immediately.
 */
function releaseState(tag, { runGh = defaultRunGh, sleep = defaultSleep, log = console.error, attempts = DEFAULT_ATTEMPTS } = {}) {
  let state = 'error'
  for (let i = 0; i < attempts; i++) {
    try {
      state = classifyReleaseState({ ok: true, stdout: runGh(['release', 'view', tag, '--json', 'isDraft', '-q', '.isDraft']) })
    } catch (err) {
      state = classifyReleaseState({ ok: false, stderr: `${err && err.stderr ? err.stderr : ''}\n${err && err.message ? err.message : ''}` })
    }
    if (state !== 'error') return state
    if (i < attempts - 1) {
      const wait = 2000 * Math.pow(2, i)
      log(`[verify-release-manifest] state probe ${i + 1}/${attempts} failed — retrying in ${wait / 1000}s`)
      sleep(wait)
    }
  }
  return state
}

/**
 * @param {{argv?: string[], env?: object, runGh?: Function, sleep?: Function,
 *          log?: Function, errLog?: Function, tmpdir?: Function}} deps
 * @returns {number} process exit code
 */
function main(deps = {}) {
  try {
    return run(deps)
  } catch (err) {
    // An uncaught throw would exit 1 — the same code as "this release is
    // broken", which makes the workflow WITHDRAW a live release over a full
    // temp disk. A crash is never a verdict on the release.
    const errLog = deps.errLog || console.error
    errLog(`[verify-release-manifest] CANNOT VERIFY — the check itself crashed: ${err && err.message ? err.message : err}`)
    return EXIT_CANNOT_VERIFY
  }
}

function run(deps = {}) {
  const argv = deps.argv || process.argv.slice(2)
  const env = deps.env || process.env
  const runGh = deps.runGh || defaultRunGh
  const sleep = deps.sleep || defaultSleep
  const log = deps.log || console.log
  const errLog = deps.errLog || console.error
  const tmpdir = deps.tmpdir || os.tmpdir

  // `--state <tag>` mode: print exactly one word (draft|published|absent) on
  // stdout so a workflow step can branch on it, or exit 2 saying nothing. The
  // workflow needs this in four places and must never infer absence from an
  // error, so it lives here rather than as bash in four `run:` blocks.
  if (argv[0] === '--state') {
    const stateTag = (argv[1] || env.TAG || '').trim()
    if (!stateTag) {
      errLog('[verify-release-manifest] --state needs a tag')
      return EXIT_CANNOT_VERIFY
    }
    const state = releaseState(stateTag, { runGh, sleep, log: errLog })
    if (state === 'error') {
      errLog(`[verify-release-manifest] could not determine the state of ${stateTag}`)
      return EXIT_CANNOT_VERIFY
    }
    log(state)
    return EXIT_OK
  }

  const tag = (argv[0] || env.TAG || '').trim()
  if (!tag) {
    errLog('[verify-release-manifest] FAIL — no tag given (pass as argv[1] or set $TAG)')
    return EXIT_CANNOT_VERIFY
  }

  let attached
  let isDraft = false
  try {
    // `digest` is what makes the byte check possible; `isDraft` decides whether
    // a failure message should describe a live incident or a held-back release.
    const raw = withRetry(() => runGh(['release', 'view', tag, '--json', 'assets,isDraft', '-q', '{assets: [.assets[] | {name, digest}], isDraft: .isDraft}']), { sleep, log: errLog })
    const view = JSON.parse(raw)
    attached = view && view.assets
    isDraft = view ? view.isDraft === true : false
    if (!Array.isArray(attached)) throw new Error('gh did not return an asset array')
  } catch (err) {
    errLog(`[verify-release-manifest] CANNOT VERIFY — could not read the assets of ${tag}: ${err.message.split('\n')[0]}`)
    errLog('  This is a GitHub/API failure, not a verdict on the release. Re-run the job.')
    return EXIT_CANNOT_VERIFY
  }

  log(`[verify-release-manifest] ${tag} (${isDraft ? 'draft' : 'PUBLISHED'}) has ${attached.length} asset(s):`)
  for (const a of attached) log(`    ${a.name}`)

  // Download the manifest that is actually PUBLISHED rather than reading the
  // local artifacts/ copy: on a rolling re-release they can differ, and the
  // published one is what every client fetches.
  let manifestText = null
  let manifestBytes = null
  let downloadFailed = false
  const dir = fs.mkdtempSync(path.join(tmpdir(), 'ccc-manifest-'))
  try {
    withRetry(() => runGh(['release', 'download', tag, '--pattern', 'CHECKSUMS.txt', '--dir', dir, '--clobber']), { sleep, log: errLog })
    const file = path.join(dir, 'CHECKSUMS.txt')
    manifestBytes = fs.statSync(file).size
    // Read the cap's worth at most. statSync already decides the verdict; this
    // just avoids pulling a hostile multi-GB body into memory to reject it.
    manifestText = manifestBytes > MAX_MANIFEST_BYTES ? '' : fs.readFileSync(file, 'utf-8')
  } catch (err) {
    downloadFailed = true
    errLog(`[verify-release-manifest] could not download CHECKSUMS.txt: ${err.message.split('\n')[0]}`)
  } finally {
    // One temp dir per invocation otherwise, and a human runs this by hand.
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
  }

  // A download failure is ambiguous: the manifest may be genuinely absent (a
  // broken release) or the API may have been unavailable (not a verdict). If it
  // is not even listed as an asset, the release IS broken and we can say so.
  const manifestAttached = attached.some((a) => a.name === 'CHECKSUMS.txt')
  if (downloadFailed && manifestAttached) {
    errLog(`[verify-release-manifest] CANNOT VERIFY — CHECKSUMS.txt is attached to ${tag} but could not be fetched.`)
    return EXIT_CANNOT_VERIFY
  }

  const result = auditManifest({ attached, manifestText, manifestBytes })

  for (const name of result.installers) {
    const problem = result.problems.find((p) => p.name === name)
    if (problem) log(`    BROKEN     ${name} — ${problem.why}`)
    // "verified" is reserved for an asset whose BYTES were checked against the
    // manifest. Calling a line-only check "verified" is how the digest half of
    // this gate would quietly stop existing.
    else if (result.byteChecked.includes(name)) log(`    verified   ${name}`)
    else log(`    line-only  ${name} (manifest line present; bytes NOT checked)`)
  }
  const warnPrefix = env.GITHUB_ACTIONS === 'true' ? '::warning::' : '    WARNING  '
  for (const w of result.warnings) log(`${warnPrefix}${w}`)

  if (!result.ok) {
    errLog('')
    errLog(`[verify-release-manifest] FAIL — ${result.reason}.`)
    if (isDraft) {
      errLog(`  ${tag} is still a DRAFT, so no client has seen it. Nothing is broken`)
      errLog('  for users yet — fix the assets and re-run before it is published.')
    } else {
      errLog(`  ${tag} IS PUBLISHED. The in-app updater refuses an asset it cannot`)
      errLog('  verify (#111), so affected platforms are offered this release,')
      errLog('  download it, and are blocked — on every attempt, until it is repaired.')
      errLog(`    gh release edit "${tag}" --draft    # pull it out of client view FIRST`)
    }
    errLog('')
    errLog('  Repair:')
    for (const p of result.problems) {
      errLog(`    gh release delete-asset "${tag}" "${p.name}"    # then re-upload it with a matching manifest`)
    }
    errLog('')
    errLog('  Re-running the release job only helps if the manifest is stale relative')
    errLog('  to artifacts/ — it will NOT remove an attached asset the manifest omits.')
    return EXIT_BROKEN_RELEASE
  }

  // Every installer had a resolvable manifest line, but NOT ONE had its bytes
  // compared — the whole digest half of the gate silently did nothing. That is
  // an environment problem (a gh too old to return `digest`, or GHES), not a
  // verdict on the release, so it exits CANNOT_VERIFY rather than branding the
  // release broken. It must not exit 0: a green run here would mean the gate
  // had quietly reverted to name-only checking.
  if (result.installers.length > 0 && result.byteChecked.length === 0) {
    errLog('')
    errLog('[verify-release-manifest] CANNOT VERIFY — every manifest LINE resolved, but')
    errLog('  not one asset digest was available from the API, so no bytes were checked.')
    errLog('  Half this gate did nothing. Check that `gh` is recent enough to return')
    errLog('  `.assets[].digest` (2.63+) and re-run.')
    return EXIT_CANNOT_VERIFY
  }

  log(`[verify-release-manifest] PASS — the client can verify all ${result.installers.length} attached installer(s) (${result.byteChecked.length} of ${result.installers.length} byte-checked).`)
  return EXIT_OK
}

// Pure-logic exports for unit testing. Guarded so `require()` from a test does
// NOT shell out to gh.
module.exports = {
  splitChecksumLine,
  digestForAsset,
  isInstaller,
  normalizeApiDigest,
  auditManifest,
  withRetry,
  classifyReleaseState,
  releaseState,
  main,
  INSTALLER_EXTENSIONS,
  MAX_MANIFEST_BYTES,
  EXIT_OK,
  EXIT_BROKEN_RELEASE,
  EXIT_CANNOT_VERIFY,
}

if (require.main === module) {
  process.exit(main())
}
