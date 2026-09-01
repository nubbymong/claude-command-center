#!/usr/bin/env node
/**
 * fleet-matrix.mjs — orchestrate the live connectivity matrix across FROM hosts.
 *
 * The release matrix (tests/live/master-connectivity-cases.csv) is a permutation
 * table of FROM host x TO host x session shape. The live pack
 * (tests/live/*.live.ts) proves a fixed set of combos from whichever box it runs
 * on. This script automates the whole loop for every FROM host so a release run
 * is a command, not an afternoon:
 *
 *   node scripts/fleet-matrix.mjs provision ROCKY_LINUX   # ship tree, deps, keys
 *   node scripts/fleet-matrix.mjs run ROCKY_LINUX --wait  # launch pack, poll
 *   node scripts/fleet-matrix.mjs harvest ROCKY_LINUX     # pull log + dumps
 *   node scripts/fleet-matrix.mjs report                  # per-CaseID scoreboard
 *
 * Config (both gitignored, colocated):
 *   tests/live/hosts.local.json — TARGET slots used by the pack (existing).
 *   tests/live/fleet.local.json — FROM hosts:
 *     { "ROCKY_LINUX": { "ssh": "user@ip", "password": "...", "node": "/usr/bin/node",
 *                        "repo": "~/ccc", "os": "linux",
 *                        "hostOverrides": { "windows": "192.168.50.192" } } }
 *     password present => every ssh/scp is wrapped in a local PTY and the
 *     password prompt auto-answered (same mechanism the app itself uses).
 *
 * NO SILENT FAILURES: report lists every runnable CSV row; a row is PASS only
 * with parsed evidence, otherwise it prints as NOT-RUN / NOT-AUTOMATED(reason) /
 * DOCKER-PHASE / DROPPED — each class explicit, none omitted.
 */
import { execFileSync, spawn } from 'child_process'
import { createRequire } from 'module'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const liveDir = path.join(repoRoot, 'tests', 'live')
const resultsDir = path.join(liveDir, 'results')
const require_ = createRequire(path.join(repoRoot, 'package.json'))

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'))
const fleetPath = path.join(liveDir, 'fleet.local.json')
const hostsPath = path.join(liveDir, 'hosts.local.json')

function loadFleet() {
  if (!fs.existsSync(fleetPath)) fail(`missing ${fleetPath} — seed it from fleet.example.json`)
  return readJson(fleetPath)
}

function fail(msg) { console.error(`fleet-matrix: ${msg}`); process.exit(1) }

/* ---------------- remote exec (key or password auth) ---------------- */

function sshArgs(def, extra = []) {
  return ['-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=10', ...extra, def.ssh]
}

/** Run a command on the FROM host. Password hosts go through a local PTY so the
 * prompt can be auto-answered; key hosts use plain ssh. Returns stdout. */
function sshRun(def, cmd, { timeoutMs = 120000 } = {}) {
  if (!def.password) {
    return execFileSync('ssh', [...sshArgs(def), cmd], { encoding: 'utf8', timeout: timeoutMs })
  }
  return ptyRun('ssh', [...sshArgs(def), cmd], def.password, timeoutMs)
}

/** scp a local file to (or from) the FROM host, honouring password auth. */
function scpFile(def, from, to, { timeoutMs = 300000, direction = 'to' } = {}) {
  const remote = (p) => `${def.ssh}:${p}`
  const args = ['-o', 'StrictHostKeyChecking=accept-new', '-q',
    ...(direction === 'to' ? [from, remote(to)] : [remote(from), to])]
  if (!def.password) {
    execFileSync('scp', args, { encoding: 'utf8', timeout: timeoutMs })
    return
  }
  return ptyRun('scp', args, def.password, timeoutMs)
}

/** PTY-wrapped exec with password prompt auto-answer (ssh/scp/sudo). */
function ptyRun(bin, args, password, timeoutMs) {
  const pty = require_('node-pty')
  const exe = process.platform === 'win32' ? `${bin}.exe` : bin
  return new Promise((resolve, reject) => {
    const p = pty.spawn(exe, args, { cols: 200, rows: 50 })
    let out = ''
    let answered = 0
    p.onData((d) => {
      out += d
      if (answered < 3 && /password[^\n]*:/i.test(out)) { p.write(password + '\r'); answered++; out = '' }
    })
    const t = setTimeout(() => { p.kill(); reject(new Error(`${bin} timed out`)) }, timeoutMs)
    p.onExit(({ exitCode }) => {
      clearTimeout(t)
      const clean = out.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07?/g, '')
      exitCode === 0 ? resolve(clean) : reject(new Error(`${bin} exited ${exitCode}: ${clean.slice(-400)}`))
    })
  })
}

/** Await-friendly wrapper: sshRun returns string (key) or Promise (password). */
async function run(def, cmd, opts) { return await sshRun(def, cmd, opts) }

/* ---------------- provision ---------------- */

async function provision(fromName) {
  const fleet = loadFleet()
  const def = fleet[fromName] || fail(`unknown FROM host ${fromName}`)
  if (def.os === 'windows') fail('windows FROM provisioning: use the existing VM bundle flow (run-job.ps1) — automation lands with the W1 runner')
  const repo = def.repo.replace(/^~\//, '$HOME/')

  console.log(`[1/6] shipping source tree (git archive HEAD)`)
  const tar = path.join(os.tmpdir(), `ccc-fleet-${Date.now()}.tar.gz`)
  execFileSync('git', ['-C', repoRoot, 'archive', '--format=tar.gz', '-o', tar, 'HEAD'], { encoding: 'utf8' })
  await run(def, `mkdir -p ${repo}`)
  await scpFile(def, tar, '/tmp/ccc-src.tar.gz')
  fs.unlinkSync(tar)
  // Faithful sync, not an overlay: tar xzf leaves behind files that were
  // DELETED at HEAD (the split retired ssh-statusline.live.ts, but an overlay
  // extract left the stale monolith running ALONGSIDE the new lanes — dup
  // combos, wrong runtime). Wipe the tracked CODE dirs before extracting so the
  // tree matches HEAD exactly; node_modules and the gitignored hosts/fleet files
  // live outside these and are (re)created in the later steps.
  await run(def, `cd ${repo} && rm -rf src tests scripts && tar xzf /tmp/ccc-src.tar.gz`)

  console.log(`[2/6] hosts.local.json (with per-FROM host overrides)`)
  const hosts = readJson(hostsPath)
  for (const [slot, ip] of Object.entries(def.hostOverrides ?? {})) {
    if (!hosts[slot]) fail(`hostOverrides names unknown slot ${slot}`)
    hosts[slot] = { ...hosts[slot], host: ip }
  }
  const tmpHosts = path.join(os.tmpdir(), `ccc-hosts-${Date.now()}.json`)
  fs.writeFileSync(tmpHosts, JSON.stringify(hosts, null, 2))
  await scpFile(def, tmpHosts, `/tmp/ccc-hosts.json`)
  fs.unlinkSync(tmpHosts)
  await run(def, `mv /tmp/ccc-hosts.json ${repo}/tests/live/hosts.local.json`)

  console.log(`[3/6] ssh key (generate if missing)`)
  const pub = (await run(def,
    `[ -f ~/.ssh/id_ed25519.pub ] || ssh-keygen -t ed25519 -N "" -f ~/.ssh/id_ed25519 -q; cat ~/.ssh/id_ed25519.pub`)).trim().split('\n').pop()
  console.log(`      pubkey: ${pub.slice(0, 40)}…`)

  console.log(`[4/6] authorizing key on key-slot targets (185, windows, mac)`)
  authorizeEverywhere(pub, hosts)

  console.log(`[5/6] seeding known_hosts on ${fromName}`)
  const ips = [...new Set(Object.values(hosts).map((h) => h.host))]
  await run(def, `for h in ${ips.join(' ')}; do ssh-keyscan -T 5 $h 2>/dev/null; done >> ~/.ssh/known_hosts; sort -u ~/.ssh/known_hosts -o ~/.ssh/known_hosts`)

  console.log(`[6/6] npm ci (skipped when lockfile hash unchanged)`)
  const lockHash = hashFile(path.join(repoRoot, 'package-lock.json'))
  const marker = `${repo}/.fleet-lock-hash`
  const prev = (await run(def, `cat ${marker} 2>/dev/null || true`)).trim()
  if (prev === lockHash) {
    console.log('      node_modules up to date')
  } else {
    // Detach + poll: a foreground npm ci dies with the ssh channel when the
    // orchestrator (or its caller) hits a timeout — transport playbook rule.
    await run(def,
      `cd ${repo} && (nohup ${path.posix.dirname(def.node)}/npm ci > /tmp/ccc-npmci.log 2>&1 && echo ${lockHash} > ${marker} &) ; echo launched`)
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 30000))
      const done = (await run(def, `cat ${marker} 2>/dev/null || true`)).trim()
      if (done === lockHash) { console.log('      npm ci done'); break }
      const alive = (await run(def, `pgrep -f "npm ci" >/dev/null && echo yes || echo no`)).trim()
      if (alive.endsWith('no')) fail(`npm ci exited without success — see /tmp/ccc-npmci.log on ${fromName}`)
      if (i === 39) fail('npm ci still running after 20 min — check the host')
    }
  }
  console.log(`provisioned ${fromName}`)
}

/** Push a pubkey to each key-auth target we can reach from the orchestrator box. */
function authorizeEverywhere(pub, hosts) {
  const short = pub.split(' ').slice(0, 2).join(' ')
  const tryStep = (label, fn) => {
    try { fn(); console.log(`      ${label}: ok`) } catch (e) { console.log(`      ${label}: FAILED — authorize manually (${e.message.split('\n')[0]})`) }
  }
  tryStep('185', () => execFileSync('ssh', ['-o', 'BatchMode=yes', `${hosts.linuxKey.username}@${hosts.linuxKey.host}`,
    `grep -qF '${short}' ~/.ssh/authorized_keys 2>/dev/null || echo '${pub}' >> ~/.ssh/authorized_keys`], { encoding: 'utf8', timeout: 20000 }))
  tryStep('mac', () => execFileSync('ssh', ['-o', 'BatchMode=yes', `${hosts.mac.username}@${hosts.mac.host}`,
    `grep -qF '${short}' ~/.ssh/authorized_keys 2>/dev/null || echo '${pub}' >> ~/.ssh/authorized_keys`], { encoding: 'utf8', timeout: 20000 }))
  tryStep('windows(admin keys)', () => execFileSync('ssh', ['-o', 'BatchMode=yes', `${hosts.windows.username}@${hosts.windows.host}`,
    `findstr /c:"${short.slice(0, 60)}" C:\\ProgramData\\ssh\\administrators_authorized_keys >nul 2>&1 || echo ${pub}>> C:\\ProgramData\\ssh\\administrators_authorized_keys`], { encoding: 'utf8', timeout: 20000 }))
}

function hashFile(p) {
  const { createHash } = require_('crypto')
  return createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0, 16)
}

/* ---------------- run ---------------- */

async function runPack(fromName, { phase = 'known', name = '', wait = false } = {}) {
  const fleet = loadFleet()
  const def = fleet[fromName] || fail(`unknown FROM host ${fromName}`)
  if (def.os === 'windows') fail('windows FROM runner not wired yet — use run-job.ps1 on the VM')
  const repo = def.repo.replace(/^~\//, '$HOME/')
  const suffix = `${name || 'all'}-${phase}`
  const script = [
    '#!/bin/bash',
    `export PATH=${path.posix.dirname(def.node)}:$PATH`,
    `cd ${repo}`,
    `export CCC_LIVE_HOSTS=${repo}/tests/live/hosts.local.json`,
    `export CCC_LIVE_DUMP=/tmp/ccc-dump-${suffix}`,
    'mkdir -p "$CCC_LIVE_DUMP"; rm -f "$CCC_LIVE_DUMP"/* 2>/dev/null',
    ...(phase === 'unknown' ? ['mv ~/.ssh/known_hosts ~/.ssh/known_hosts.cleared 2>/dev/null || true'] : []),
    `node node_modules/vitest/vitest.mjs run --config vitest.live.config.ts ${name ? `-t '${name}'` : ''} > /tmp/ccc-live-${suffix}.log 2>&1`,
    `echo DONE-MARKER >> /tmp/ccc-live-${suffix}.log`,
  ].join('\n')
  const tmp = path.join(os.tmpdir(), `ccc-run-${Date.now()}.sh`)
  fs.writeFileSync(tmp, script + '\n')
  await scpFile(def, tmp, `/tmp/ccc-run-${suffix}.sh`)
  fs.unlinkSync(tmp)
  await run(def, `chmod +x /tmp/ccc-run-${suffix}.sh && (nohup /tmp/ccc-run-${suffix}.sh >/dev/null 2>&1 &) && echo LAUNCHED`)
  console.log(`launched ${fromName} pack (${suffix})`)
  if (!wait) { console.log(`poll: node scripts/fleet-matrix.mjs harvest ${fromName} --phase ${phase}${name ? ` --name ${name}` : ''}`); return }
  for (;;) {
    await new Promise((r) => setTimeout(r, 60000))
    const done = (await run(def, `grep -c DONE-MARKER /tmp/ccc-live-${suffix}.log 2>/dev/null || true`)).trim()
    const prog = (await run(def, `grep -c "payload: account=" /tmp/ccc-live-${suffix}.log 2>/dev/null || true`)).trim()
    console.log(`  …payloads=${prog} done=${done}`)
    if (done !== '0' && done !== '') break
  }
  console.log('pack finished')
}

/* ---------------- harvest ---------------- */

async function harvest(fromName, { phase = 'known', name = '' } = {}) {
  const fleet = loadFleet()
  const def = fleet[fromName] || fail(`unknown FROM host ${fromName}`)
  const suffix = `${name || 'all'}-${phase}`
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const dir = path.join(resultsDir, `${fromName}-${suffix}-${stamp}`)
  fs.mkdirSync(dir, { recursive: true })
  await scpFile(def, `/tmp/ccc-live-${suffix}.log`, path.join(dir, 'run.log'), { direction: 'from' })
  try {
    await run(def, `cd /tmp/ccc-dump-${suffix} && tar czf /tmp/ccc-dump-${suffix}.tar.gz .`)
    await scpFile(def, `/tmp/ccc-dump-${suffix}.tar.gz`, path.join(dir, 'dump.tar.gz'), { direction: 'from' })
  } catch { console.log('  (no dump files)') }
  const parsed = parseRunLog(fs.readFileSync(path.join(dir, 'run.log'), 'utf8'))
  fs.writeFileSync(path.join(dir, 'parsed.json'), JSON.stringify({ from: fromName, phase, ...parsed }, null, 2))
  console.log(`harvested → ${path.relative(repoRoot, dir)}`)
  console.log(`  tests: ${parsed.tests.filter((t) => t.ok).length}/${parsed.tests.length} passed; payload lines: ${parsed.payloads.length}`)
  for (const t of parsed.tests.filter((t) => !t.ok)) console.log(`  FAILED: ${t.title}`)
  return dir
}

function parseRunLog(log) {
  const clean = log.replace(/\x1b\[[0-9;]*m/g, '')
  // Dedupe by title, LAST occurrence wins: a targeted rerun appended to the
  // main log (harvest-log stitches them) supersedes the earlier outcome.
  const byTitle = new Map()
  // Mark glyph families: unix ✓/✗/×; Windows sometimes √/×; and the WINDOWS_1
  // scheduled-task pipeline double-mangles UTF-8 through cp437 into UTF-16
  // (`✓`→`Γ£ô`, `✗`→`Γ£ù`, `×`→`├ù`) — accept those verbatim rather than
  // attempting a cp437 round-trip.
  for (const m of clean.matchAll(/^\s*(✓|√|Γ£ô|×|✗|x|Γ£ù|├ù)\s+(.+?)\s+\d+ms$/gm)) {
    if (/tests[\\/]live[\\/]/.test(m[2])) continue
    byTitle.set(m[2].trim(), m[1] === '✓' || m[1] === '√' || m[1] === 'Γ£ô')
  }
  const tests = [...byTitle.entries()].map(([title, ok]) => ({ ok, title }))
  const payloads = [...clean.matchAll(/^\s*(T\S+[^:]*): account=(\S+) buckets=(\S+).*$/gm)]
    .map((m) => ({ combo: m[1].replace(/ payload$/, ''), account: m[2], buckets: m[3] }))
  const doneMarker = /DONE-MARKER/.test(clean)
  return { doneMarker, tests, payloads }
}

/** Import externally-produced run logs (e.g. the WINDOWS_1 VM's scheduled-task
 *  run, plus any targeted rerun logs) into the results store: logs are
 *  concatenated in the order given, so a rerun's outcome supersedes the main
 *  run's for the same test title. UTF-16 logs (PowerShell redirects) are
 *  detected and converted. */
function harvestLogs(fromName, files, { phase = 'known' } = {}) {
  if (!files.length) fail('harvest-log needs at least one log file')
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const dir = path.join(resultsDir, `${fromName}-all-${phase}-${stamp}`)
  fs.mkdirSync(dir, { recursive: true })
  const text = files.map((f) => {
    const b = fs.readFileSync(f)
    return b[0] === 0xff && b[1] === 0xfe ? b.toString('utf16le') : b.toString('utf8')
  }).join('\n')
  fs.writeFileSync(path.join(dir, 'run.log'), text)
  const parsed = parseRunLog(text)
  fs.writeFileSync(path.join(dir, 'parsed.json'), JSON.stringify({ from: fromName, phase, ...parsed }, null, 2))
  console.log(`imported ${files.length} log(s) → ${path.relative(repoRoot, dir)}`)
  console.log(`  tests: ${parsed.tests.filter((t) => t.ok).length}/${parsed.tests.length} passed; payload lines: ${parsed.payloads.length}`)
  for (const t of parsed.tests.filter((t) => !t.ok)) console.log(`  FAILED: ${t.title}`)
}

/* ---------------- report ---------------- */

/** Which pack test proves a CSV row, given the pack's fixed slot bindings.
 * Returns { test } or { status, why } for rows automation cannot prove. */
function coverageFor(row) {
  const docker = row.TO.includes('&DOCKER')
  if (row.Runnable !== 'YES') return { status: 'NOT-RUNNABLE', why: row.Notes || 'marked not runnable' }
  if (/UBUNTU_HYPER_V/.test(row.TO) || row.FROM === 'UBUNTU_HYPER_V') return { status: 'DROPPED', why: 'owner dropped Ubuntu (2026-08-31)' }
  if (docker) {
    const toRole = row.TO.replace('&DOCKER', '')
    if (toRole === 'ROCKY_LINUX') {
      // Container fixture live on the Rocky host (podman rootless + rootful).
      if (row.SessionType === 'Tmux') return { status: 'NOT-SUPPORTED', why: 'container persistence pending the hop-1 design (in-container tmux breaks delivery — ladder forced off; T23 proves the gate)' }
      const dkey = `${row.SshAuth}|${row.DockerAuth}`
      const dmap = {
        'Keyless|nosudo': 'T20 docker exec (podman rootless, key)',
        'Password|sudo': 'T21 docker exec (podman rootful, sudo+password)',
      }
      if (dmap[dkey]) return { test: dmap[dkey] }
      return { status: 'NOT-AUTOMATED', why: `no docker-lane slot for ${dkey}` }
    }
    if (toRole === 'WINDOWS_2') return { status: 'NOT-RUNNABLE', why: 'no container runtime on WINDOWS_2 (WSL2 needs nested virtualization — owner action)' }
    if (toRole === 'MAC_254') return { status: 'NOT-SUPPORTED', why: 'container on macOS cannot reach the host-loopback tunnel bind (probed 2026-08-31: host.docker.internal→127.0.0.1:port unreachable via colima/Lima); needs the reachability-injection design (0.0.0.0 -R bind or app-injected relay)' }
    return { status: 'DOCKER-PHASE', why: 'local container spawn path pending' }
  }
  if (row.TO === row.FROM || row.Hops === '0') return { status: 'NOT-AUTOMATED', why: 'local session — covered by unit/e2e, not the SSH pack' }
  const key = `${row.TO}|${row.SessionType}|${row.SshAuth}`
  if (row.TO === 'WINDOWS_2' && row.SessionType === 'Tmux') {
    return { status: 'NOT-SUPPORTED', why: 'Windows target has no tmux; psmux staging rung pending (ledger item c)' }
  }
  if (row.TO === 'SERVER_UBUNTU' && row.SshAuth === 'Password') {
    return { status: 'NOT-RUNNABLE', why: 'sshd on 185 offers no password method (publickey,keyboard-interactive; probed 2026-08-31)' }
  }
  const map = {
    'SERVER_UBUNTU|Tmux|Keyless': 'key + tmux wrap (fresh)',
    'SERVER_UBUNTU|Standard|Keyless': 'key + NO tmux (detachable off)',
    'PI_MINER|Tmux|Password': 'password + tmux',
    'PI_MINER|Standard|Password': 'password + NO tmux',
    'PI_MINER|Tmux|Keyless': 'pi key + tmux',
    'PI_MINER|Standard|Keyless': 'pi key + NO tmux',
    'MAC_254|Tmux|Keyless': 'mac key: statusline updates',
    'MAC_254|Standard|Keyless': 'mac key: statusline updates',
    'WINDOWS_2|Standard|Keyless': 'windows remote (tunnel POST)',
    'ROCKY_LINUX|Tmux|Password': 'rocky password + tmux (staged)',
    'ROCKY_LINUX|Standard|Password': 'rocky password + NO tmux',
    'ROCKY_LINUX|Tmux|Keyless': 'rocky key + tmux (staged)',
    'ROCKY_LINUX|Standard|Keyless': 'rocky key + NO tmux',
  }
  const test = map[key]
  return test ? { test } : { status: 'NOT-AUTOMATED', why: `no pack slot for ${key}` }
}

function report() {
  const csv = fs.readFileSync(path.join(liveDir, 'master-connectivity-cases.csv'), 'utf8').trim().split(/\r?\n/)
  const hdr = csv[0].split(',')
  const rows = csv.slice(1).map((l) => Object.fromEntries(l.split(',').map((c, i) => [hdr[i], c])))
  // newest harvest per FROM+phase wins
  const harvests = fs.existsSync(resultsDir)
    ? fs.readdirSync(resultsDir).filter((d) => fs.existsSync(path.join(resultsDir, d, 'parsed.json'))).sort()
    : []
  const latest = {}
  for (const d of harvests) {
    const p = readJson(path.join(resultsDir, d, 'parsed.json'))
    latest[`${p.from}|${p.phase}`] = { dir: d, ...p }
  }
  const counts = {}
  const lines = []
  for (const row of rows) {
    const cov = coverageFor(row)
    let status, detail
    if (cov.test) {
      const h = latest[`${row.FROM}|known`]
      const t = h?.tests.find((t) => t.title.startsWith(cov.test))
      if (!h) { status = 'NOT-RUN'; detail = `no harvest for ${row.FROM}` }
      else if (!t) { status = 'NOT-RUN'; detail = `pack ran but test missing: ${cov.test}` }
      else if (t.ok) { status = 'PASS'; detail = `${cov.test} @ ${h.dir}` }
      else { status = 'FAIL'; detail = `${cov.test} FAILED @ ${h.dir}` }
    } else { status = cov.status; detail = cov.why }
    counts[status] = (counts[status] ?? 0) + 1
    lines.push(`${row.CaseID.padStart(3)} ${row.FROM.padEnd(15)} ${row.TO.padEnd(22)} ${(row.SessionType + '/' + row.SshAuth).padEnd(17)} ${status.padEnd(14)} ${detail}`)
  }
  console.log(`CaseID FROM            TO                     shape             status         evidence/reason`)
  for (const l of lines) console.log(l)
  console.log('\nTotals: ' + Object.entries(counts).map(([k, v]) => `${k}=${v}`).join('  '))
  const md = ['# Live connectivity matrix — scoreboard', '', '```', ...lines, '```', '',
    'Totals: ' + Object.entries(counts).map(([k, v]) => `${k}=${v}`).join('  ')].join('\n')
  fs.mkdirSync(resultsDir, { recursive: true })
  fs.writeFileSync(path.join(resultsDir, 'scoreboard.md'), md)
  console.log(`\nwritten: ${path.relative(repoRoot, path.join(resultsDir, 'scoreboard.md'))}`)
}

/* ---------------- cli ---------------- */

const [cmd, arg, ...rest] = process.argv.slice(2)
const opt = (name, dflt) => {
  const i = rest.indexOf(`--${name}`)
  return i >= 0 ? (rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[i + 1] : true) : dflt
}
const main = async () => {
  if (cmd === 'provision') await provision(arg)
  else if (cmd === 'run') await runPack(arg, { phase: opt('phase', 'known'), name: opt('name', ''), wait: !!opt('wait', false) })
  else if (cmd === 'harvest') await harvest(arg, { phase: opt('phase', 'known'), name: opt('name', '') })
  else if (cmd === 'harvest-log') harvestLogs(arg, rest.filter((r) => !r.startsWith('--') && r !== opt('phase', 'known')), { phase: opt('phase', 'known') })
  else if (cmd === 'report') report()
  else fail('usage: fleet-matrix.mjs provision|run|harvest <FROM> [--phase known|unknown] [--name filter] [--wait] | harvest-log <FROM> <log...> [--phase p] | report')
}
main().catch((e) => fail(e.message))
