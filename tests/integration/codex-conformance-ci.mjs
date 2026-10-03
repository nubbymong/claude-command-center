#!/usr/bin/env node
// P4.8 (rows 59, 60; OD20 D7, WP1.71): the CI codex-conformance job's two
// small steps, kept out of the workflow so no expression is ever spliced into a
// shell line.
//
//   node tests/integration/codex-conformance-ci.mjs version <minimum|pinned|rc>
//     The version this run installs: the minimum and pinned versions are read
//     from the app's own contract (src/main/providers/codex/cli-contract.ts),
//     never restated in the workflow; the release candidate is the dispatched
//     input, from the RC_VERSION environment variable, and must be a plain
//     semver (it becomes an npm package spec). Writes `version=` to
//     GITHUB_OUTPUT.
//   node tests/integration/codex-conformance-ci.mjs bin <prefix>
//     Where `npm install -g --prefix <prefix>` put the CLI: `<prefix>\codex.cmd`
//     on Windows (the npm shim the app resolves there), `<prefix>/bin/codex`
//     elsewhere. Fails unless it exists. Writes `bin=` and `dir=` to
//     GITHUB_OUTPUT and the folder to GITHUB_PATH, for the flag-drift suite.
//   node tests/integration/codex-conformance-ci.mjs homes <name>...
//     A fresh, empty folder per name under the runner's temp folder, each a
//     CODEX_HOME for one step that runs the CLI outside the suite (Codex
//     prepares its home before it parses even --version, and refuses one that
//     does not exist). Writes `<name>=<folder>` to GITHUB_OUTPUT.
//   node tests/integration/codex-conformance-ci.mjs own-home record|check <file>
//     A read-only picture of the runner's own ~/.codex (every entry's path,
//     size and modified time, or "absent"), recorded before the CLI is
//     installed and checked after its last run: no run used it.
//
// The vitest suite checks the installed version against the same contract
// again (codex-conformance-lib.ts, expectedVersion), so the two cannot drift.
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdtempSync, readdirSync, lstatSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const fail = (msg) => { console.error(`codex-conformance: ${msg}`); process.exit(1) }
const output = (pairs) => {
  const lines = Object.entries(pairs).map(([k, v]) => `${k}=${v}\n`).join('')
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, lines)
  process.stdout.write(lines)
}

const [what, arg] = process.argv.slice(2)
if (what === 'version') {
  const src = readFileSync(join(ROOT, 'src/main/providers/codex/cli-contract.ts'), 'utf8')
  const pick = (name) => {
    const m = new RegExp(`^export const ${name} = '([^']+)'`, 'm').exec(src)
    return m ? m[1] : null
  }
  const version = arg === 'minimum' ? pick('CODEX_MIN_SUPPORTED_VERSION')
    : arg === 'pinned' ? pick('CODEX_PINNED_CLI_VERSION')
      : arg === 'rc' ? (process.env.RC_VERSION ?? '').trim()
        : fail(`unknown version class ${JSON.stringify(arg)} (minimum, pinned or rc)`)
  if (!version || !SEMVER.test(version)) fail(`no plain semver for the ${arg} version (got ${JSON.stringify(version)})`)
  output({ version })
} else if (what === 'bin') {
  if (!arg) fail('bin needs the install prefix')
  const prefix = resolve(arg)
  const bin = process.platform === 'win32' ? join(prefix, 'codex.cmd') : join(prefix, 'bin', 'codex')
  if (!existsSync(bin)) fail(`npm put no CLI at ${bin}`)
  output({ bin, dir: dirname(bin) })
  if (process.env.GITHUB_PATH) appendFileSync(process.env.GITHUB_PATH, `${dirname(bin)}\n`)
} else if (what === 'homes') {
  const names = process.argv.slice(3)
  if (names.length === 0 || names.some((n) => !/^[a-z][a-z0-9]*$/.test(n))) fail('homes needs one or more plain names')
  const base = process.env.RUNNER_TEMP || tmpdir()
  output(Object.fromEntries(names.map((n) => [n, mkdtempSync(join(base, `codex-home-${n}-`))])))
} else if (what === 'own-home') {
  const file = process.argv[4]
  if ((arg !== 'record' && arg !== 'check') || !file) fail('usage: own-home record|check <file>')
  const dir = join(homedir(), '.codex')
  const picture = () => {
    if (!existsSync(dir)) return 'absent'
    const out = []
    const walk = (d, rel) => {
      for (const n of readdirSync(d).sort()) {
        const p = join(d, n)
        const r = rel ? `${rel}/${n}` : n
        const st = lstatSync(p)
        if (st.isDirectory() && !st.isSymbolicLink()) walk(p, r)
        else out.push(`${r} ${st.size} ${Math.floor(st.mtimeMs)}`)
      }
    }
    walk(dir, '')
    return out.join('\n') || 'empty'
  }
  if (arg === 'record') {
    const now = picture()
    writeFileSync(file, now)
    console.log(`the runner's own ${dir}: ${now === 'absent' ? 'absent' : `${now.split('\n').length} entries`} before the CLI is installed`)
  } else {
    const before = readFileSync(file, 'utf8')
    const after = picture()
    if (after !== before) fail(`a run of the CLI used the runner's own ${dir}; before:\n${before}\nafter:\n${after}`)
    console.log(`the runner's own ${dir} is as it was before the CLI was installed (${before === 'absent' ? 'absent' : 'unchanged'})`)
  }
} else {
  fail('usage: codex-conformance-ci.mjs version <minimum|pinned|rc> | bin <prefix> | homes <name>... | own-home record|check <file>')
}
