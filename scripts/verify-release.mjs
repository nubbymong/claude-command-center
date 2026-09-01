// Unified release gate — one command that verifies a build is releasable.
//
//   node scripts/verify-release.mjs            # smoke (default): typecheck + unit + fast live matrix
//   node scripts/verify-release.mjs --full     # include the slow (480s) tmux-reattach live combos
//   node scripts/verify-release.mjs --no-live   # unit + typecheck only (no fleet needed)
//   node scripts/verify-release.mjs --live-only # just the live SSH matrix
//
// Three fail-fast phases, non-zero exit on any real failure:
//   1. typecheck  (npm run typecheck)
//   2. unit suite (vitest, default config)
//   3. LIVE SSH connectivity matrix (opt-in; needs tests/live/hosts.local.json)
//
// Phase 3 drives the REAL statusline-over-SSH pipeline against the fleet and
// asserts the thing users actually see: a statusline update arrived, the
// account resolved, and (where the host's account is authed) the usage buckets
// incl. the per-model "Fable" bucket came through. It parses the pack's own
// report() lines into a per-host PASS/WARN/FAIL table.
//
// TRANSPORT NOTES (hard-won — do not "simplify" these away):
//  - The live pack lives in tests/live/ and is matched ONLY by
//    --config vitest.live.config.ts. Run without that flag and vitest silently
//    finds 0 tests (the default config excludes tests/live).
//  - We target tests/live/ssh-statusline.live.ts SPECIFICALLY. The live config
//    also globs tests/live/ssh-multisession.live.ts, whose "-R port coexistence"
//    test fails in a headless runner for an UNRELATED reason: it reuses the real
//    force-TTY (`-t`) ssh argv under spawnSync (no tty), so its preflight gets
//    "Pseudo-terminal will not be allocated..." instead of its PREFLIGHT marker.
//    That is not a harmonise/statusline failure, so it must not pollute this gate.
//  - Under the live config the process EXITS cleanly, so plain stdout capture
//    works (no exit-hang to babysit).
//  - vitest is invoked as `node node_modules/vitest/vitest.mjs` — never npx/.cmd
//    — so the smoke `-t` negative-lookahead regex passes literally with no shell
//    mangling.
//  - EMPTY buckets are a HOST AUTH-STATE condition (that host's stored token is
//    empty/expired/missing), NOT a code failure — verified: 185 (empty token)
//    and Mac (no credentials file) legitimately show no buckets while the SAME
//    live.co.uk account shows Fable:93% on Pi/WINDOWS_2/Rocky. So empty buckets
//    are WARN, never FAIL.
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const REPO = fileURLToPath(new URL('..', import.meta.url))
const STATUSLINE_PACK = 'tests/live/ssh-statusline.live.ts'
const HOSTS_FILE = join(REPO, 'tests', 'live', 'hosts.local.json')
const VITEST = join(REPO, 'node_modules', 'vitest', 'vitest.mjs')

// ── Pure, unit-tested parsing ────────────────────────────────────────────────

const ANSI = /\x1b\[[0-9;]*m/g
export function stripAnsi(s) { return String(s).replace(ANSI, '') }

/** Parse `5h:0%,Weekly:100%,Fable:93%` (or `-`) into [{label,percent}]. */
export function parseBuckets(raw) {
  if (!raw || raw === '-') return []
  const out = []
  for (const part of raw.split(',')) {
    const m = part.match(/^(.+):(\d+)%$/)
    if (m) out.push({ label: m[1], percent: Number(m[2]) })
  }
  return out
}

/**
 * Parse the live pack's stdout into per-combo results + the vitest tally.
 * The pack emits, per combo, a `<label> payload: account=… buckets=… 5h=… wk=…`
 * line and a `<label>: updates=N … wrapped=BOOL …` line. Pure: stdout in,
 * structured result out (no I/O), so the classification is unit-testable.
 */
export function parseLiveMatrixOutput(stdout) {
  const text = stripAnsi(stdout)
  const byLabel = new Map()
  const get = (label) => {
    let c = byLabel.get(label)
    if (!c) { c = { combo: label, account: '', buckets: [], updates: null, wrapped: null }; byLabel.set(label, c) }
    return c
  }
  for (const line of text.split(/\r?\n/)) {
    const p = line.match(/(T\d+[^:]*?) payload: account=(\S*) buckets=(\S+) 5h=(\S*) wk=(\S*)/)
    if (p) {
      const c = get(p[1].trim())
      c.account = p[2] === '-' ? '' : p[2]
      c.buckets = parseBuckets(p[3])
      continue
    }
    const s = line.match(/(T\d+[^:]*?): updates=(\d+) .*?wrapped=(true|false)/)
    if (s) {
      const c = get(s[1].trim())
      c.updates = Number(s[2])
      c.wrapped = s[3] === 'true'
    }
  }
  const tally = text.match(/Tests\s+(?:(\d+)\s+failed\s+\|\s+)?(\d+)\s+passed/)
  const summary = tally ? { failed: Number(tally[1] ?? 0), passed: Number(tally[2]) } : null
  return { combos: [...byLabel.values()], summary }
}

/** PASS = statusline + account + >=1 bucket; WARN = statusline+account, no buckets
 *  (host auth-state); FAIL = no statusline update or no account. */
export function classifyCombo(c) {
  if (!c.updates || c.updates < 1) return 'FAIL'
  if (!c.account) return 'FAIL'
  if (!c.buckets || c.buckets.length === 0) return 'WARN'
  return 'PASS'
}

/** Roll combos + vitest tally into a gate verdict. Gate fails on any FAIL row
 *  or a real vitest assertion failure; WARN rows do not fail it. */
export function summarizeGate(parsed) {
  const rows = parsed.combos.map((c) => ({ ...c, verdict: classifyCombo(c) }))
  const fails = rows.filter((r) => r.verdict === 'FAIL')
  const warns = rows.filter((r) => r.verdict === 'WARN')
  const vitestFailed = parsed.summary ? parsed.summary.failed : 0
  const ok = fails.length === 0 && vitestFailed === 0 && rows.length > 0
  return { ok, rows, fails, warns, vitestFailed, summary: parsed.summary }
}

// ── Orchestration (not exported) ─────────────────────────────────────────────

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: REPO,
      stdio: opts.capture ? ['inherit', 'pipe', 'pipe'] : 'inherit',
      shell: !!opts.shell,
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
    })
    let out = ''
    if (opts.capture) {
      child.stdout.on('data', (d) => { out += d; process.stdout.write(d) })
      child.stderr.on('data', (d) => { out += d; process.stderr.write(d) })
    }
    child.on('close', (code) => resolve({ code: code ?? 1, out }))
    child.on('error', (e) => { process.stderr.write(String(e) + '\n'); resolve({ code: 1, out }) })
  })
}

function banner(t) { console.log(`\n${'═'.repeat(64)}\n  ${t}\n${'═'.repeat(64)}`) }

async function main() {
  const argv = new Set(process.argv.slice(2))
  const full = argv.has('--full')
  const noLive = argv.has('--no-live')
  const liveOnly = argv.has('--live-only')

  if (!liveOnly) {
    banner('Phase 1 — typecheck')
    const tc = await run('npm', ['run', 'typecheck'], { shell: true })
    if (tc.code !== 0) { console.error('\n❌ typecheck failed — gate stops here.'); process.exit(1) }

    banner('Phase 2 — unit suite')
    const unit = await run(process.execPath, [VITEST, 'run'])
    if (unit.code !== 0) { console.error('\n❌ unit suite failed — gate stops here.'); process.exit(1) }
  }

  if (noLive) { console.log('\n✅ typecheck + unit green (--no-live: live matrix skipped).'); process.exit(0) }

  banner(`Phase 3 — live SSH matrix (${full ? 'full' : 'smoke'})`)
  if (!existsSync(HOSTS_FILE)) {
    console.log('no tests/live/hosts.local.json — skipping live matrix (seed it from tests/live/hosts.example.json to enable).')
    console.log('\n✅ typecheck + unit green; live matrix not run (no fleet configured).')
    process.exit(liveOnly ? 0 : 0)
  }

  const dump = mkdtempSync(join(tmpdir(), 'ccc-verify-dump-'))
  // Smoke: skip the two 480s tmux-reattach combos via a negative-lookahead
  // testNamePattern. `node vitest.mjs` (not npx/.cmd) means this regex reaches
  // vitest literally, no shell interpretation.
  const args = [VITEST, 'run', '--config', 'vitest.live.config.ts', STATUSLINE_PACK]
  if (!full) args.push('-t', '^(?!.*reattach)')
  const live = await run(process.execPath, args, { capture: true, env: { CCC_LIVE_DUMP: dump } })

  const parsed = parseLiveMatrixOutput(live.out)
  const gate = summarizeGate(parsed)

  banner('Live matrix result')
  if (gate.rows.length === 0) {
    console.error('❌ no combos parsed from the live run — the pack produced no report() lines (a spawn/config error).')
    process.exit(1)
  }
  for (const r of gate.rows) {
    const b = r.buckets.length ? r.buckets.map((x) => `${x.label}:${x.percent}%`).join(',') : '(none)'
    const icon = r.verdict === 'PASS' ? '✅' : r.verdict === 'WARN' ? '⚠️ ' : '❌'
    console.log(`${icon} ${r.verdict.padEnd(4)} ${r.combo.padEnd(26)} account=${r.account || '(none)'} updates=${r.updates ?? '?'} buckets=${b}`)
  }
  if (gate.warns.length) {
    console.log(`\n⚠️  ${gate.warns.length} host(s) delivered statusline+account but no usage buckets — a HOST AUTH-STATE condition (that account's stored token is empty/expired/missing on that host), not a code failure. Re-auth that host's claude to populate buckets.`)
  }
  if (gate.summary) console.log(`\nvitest: ${gate.summary.passed} passed | ${gate.summary.failed} failed`)
  console.log(`dump: ${dump}`)

  if (!gate.ok) {
    console.error(`\n❌ RELEASE GATE FAILED — ${gate.fails.length} FAIL row(s), vitest ${gate.vitestFailed} failed.`)
    process.exit(1)
  }
  console.log(`\n✅ RELEASE GATE PASSED — ${gate.rows.length} combos, ${gate.rows.filter((r) => r.verdict === 'PASS').length} full / ${gate.warns.length} warn, live=${live.code === 0 ? 'clean' : 'non-zero'}.`)
  process.exit(0)
}

// Only orchestrate when run directly; importing (the unit test) gets the pure fns.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => { console.error(e); process.exit(1) })
}
