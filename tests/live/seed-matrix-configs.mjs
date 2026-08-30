#!/usr/bin/env node
/**
 * Seed the "MATRIX TESTS" config section on a FROM machine (harmonise-remote).
 *
 * CSV-DRIVEN and FROM-SPECIFIC: the master matrix (master-connectivity-cases.csv)
 * is the single source of truth for which FROM→TO×type cells exist; this script
 * takes `--from <ROLE>` and generates ONE app config per runnable case for that
 * FROM, labelled by CaseID, so each FROM box gets exactly its own launchable
 * slice of the matrix (WINDOWS_1 ≠ MAC_254 ≠ ROCKY_LINUX ≠ UBUNTU_HYPER_V).
 * Host IPs/usernames come from the SAME hosts.local.json the live pack reads,
 * so the matrix, the pack and the app configs cannot disagree about a host.
 *
 * Usage (run ON the FROM machine, app CLOSED):
 *   node seed-matrix-configs.mjs --from WINDOWS_1
 *     [--config-dir <path>] [--hosts <path>] [--csv <path>]
 *
 * --config-dir defaults to %LOCALAPPDATA%/AI Code Conductor/resources/CONFIG.
 * --hosts / --csv default to files next to this script.
 *
 * NOTHING IS SKIPPED SILENTLY: every case NOT generated is printed with its
 * reason (Runnable=NO with the CSV's note; a TO role with no hosts.local.json
 * slot; a case shape the app cannot express yet). Idempotent: replaces only
 * ids with the `mx-` prefix and the `sec-matrix` section; everything else
 * (e.g. a screenshot-staging workspace) survives. Files are backed up first.
 *
 * Passwords are NOT seeded — the app stores them DPAPI/keychain-encrypted per
 * config (credential-store.ts); the script prints which configs need a
 * password typed once in Edit, which need this machine's SSH key authorised
 * on the target, and which need docker provisioning.
 */
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

function arg(name, dflt) {
  const i = process.argv.indexOf(name)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt
}

const scriptDir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const fromRole = arg('--from', '')
const configDir = arg(
  '--config-dir',
  process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'AI Code Conductor', 'resources', 'CONFIG')
    : '',
)
const hostsPath = arg('--hosts', path.join(scriptDir, 'hosts.local.json'))
const csvPath = arg('--csv', path.join(scriptDir, 'master-connectivity-cases.csv'))

if (!fromRole) { console.error('pass --from <ROLE> (e.g. WINDOWS_1, MAC_254, ROCKY_LINUX, UBUNTU_HYPER_V)'); process.exit(1) }
if (!configDir || !fs.existsSync(configDir)) { console.error(`config dir not found: ${configDir || '(none)'} — pass --config-dir`); process.exit(1) }
if (!fs.existsSync(hostsPath)) { console.error(`hosts file not found: ${hostsPath} — pass --hosts`); process.exit(1) }
if (!fs.existsSync(csvPath)) { console.error(`matrix csv not found: ${csvPath} — pass --csv`); process.exit(1) }

/** Minimal CSV parse — the matrix has no quoted commas today; refuse if one appears. */
function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0)
  const headers = lines[0].split(',')
  return lines.slice(1).map((line) => {
    if (line.includes('"')) { console.error(`CSV line has quotes — extend the parser before trusting this: ${line}`); process.exit(1) }
    const cells = line.split(',')
    const row = {}
    headers.forEach((h, i) => { row[h.trim()] = (cells[i] ?? '').trim() })
    return row
  })
}

const hosts = JSON.parse(fs.readFileSync(hostsPath, 'utf-8'))
const rows = parseCsv(fs.readFileSync(csvPath, 'utf-8'))

/** CSV TO-role → hosts.local.json slot + per-role extras. A role mapping to a
 *  missing slot is reported per case, never silently dropped. */
const ROLE_SLOTS = {
  WINDOWS_2: { slot: 'windows', remoteOs: 'windows' },
  PI_MINER: { slot: 'linuxPassword' },
  ROCKY_LINUX: { slot: 'linuxRocky' },
  SERVER_UBUNTU: { slot: 'linuxKey' },
  MAC_254: { slot: 'mac' },
  UBUNTU_HYPER_V: { slot: 'ubuntuHyperV' }, // no slot yet — creds TBC (fleet map)
}
const DOCKER_CONTAINER = 'ccc-test'

const COLORS = ['slate-blue', 'pink', 'indigo', 'violet', 'plum', 'lavender', 'rose', 'orchid', 'mauve', 'periwinkle']
const claudeOptions = { model: 'sonnet', effortLevel: 'medium', loggingEnabled: true, agentIds: [] }

const mine = rows.filter((r) => r.FROM === fromRole)
if (mine.length === 0) { console.error(`no matrix rows have FROM=${fromRole} — check the role name`); process.exit(1) }

const out = []
const skipped = [] // { id, why }
const needsPassword = []
const needsKey = []
const needsDocker = new Set()

for (const r of mine) {
  const id = r.CaseID
  if (r.Runnable !== 'YES') { skipped.push({ id, why: `Runnable=NO — ${r.Notes || 'per matrix'}` }); continue }

  const docker = r.TO.endsWith('&DOCKER')
  const toRole = docker ? r.TO.slice(0, -'&DOCKER'.length) : r.TO

  if (r.SessionType === 'Local') {
    if (docker) { skipped.push({ id, why: 'Local+Container needs the structured Runtime field (ledger item e) — not expressible as a config yet' }); continue }
    out.push({
      id: `mx-c${id}`,
      label: `C${id} · Local (${fromRole})`,
      workingDirectory: process.env.USERPROFILE || process.env.HOME || '~',
      color: '',
      identityColorKey: COLORS[out.length % COLORS.length],
      sessionType: 'local',
      provider: 'claude',
      sectionId: 'sec-matrix',
      claudeOptions,
    })
    continue
  }

  const roleMap = ROLE_SLOTS[toRole]
  const slot = roleMap ? hosts[roleMap.slot] : undefined
  if (!roleMap) { skipped.push({ id, why: `TO role ${toRole} has no role→slot mapping in this script` }); continue }
  if (!slot) { skipped.push({ id, why: `hosts.local.json has no "${roleMap.slot}" slot (add it, e.g. Ubuntu Hyper-V creds TBC) — re-run after` }); continue }

  const tmux = r.SessionType === 'Tmux'
  const pw = r.SshAuth === 'Password'
  const sudo = r.DockerAuth === 'sudo'
  const label =
    `C${id} · ${toRole} · ${tmux ? 'tmux' : 'standard'} · ${pw ? 'pw' : 'key'}` +
    (docker ? ` · docker-${r.DockerAuth}` : '')

  out.push({
    id: `mx-c${id}`,
    label,
    workingDirectory: slot.remotePath ?? '~',
    color: '',
    identityColorKey: COLORS[out.length % COLORS.length],
    sessionType: 'ssh',
    provider: 'claude',
    sectionId: 'sec-matrix',
    claudeOptions,
    sshConfig: {
      host: slot.host,
      port: slot.port ?? 22,
      username: slot.username,
      remotePath: slot.remotePath ?? '~',
      hasPassword: false, // flips when the password is typed in Edit (DPAPI)
      detachable: tmux,
      remoteOs: roleMap.remoteOs ?? 'auto',
      postCommand: docker ? `${sudo ? 'sudo ' : ''}docker exec -it ${DOCKER_CONTAINER} bash` : '',
      ...(docker && sudo ? { hasSudoPassword: true } : {}),
      dockerContainer: docker ? DOCKER_CONTAINER : '',
    },
  })
  ;(pw ? needsPassword : needsKey).push(label)
  if (docker) needsDocker.add(`${toRole} (${slot.host}) — container "${DOCKER_CONTAINER}"`)
}

out.sort((a, b) => Number(a.id.slice(4)) - Number(b.id.slice(4)))

const configsFile = path.join(configDir, 'configs.json')
const sectionsFile = path.join(configDir, 'config-sections.json')
const configs = fs.existsSync(configsFile) ? JSON.parse(fs.readFileSync(configsFile, 'utf-8')) : []
const sections = fs.existsSync(sectionsFile) ? JSON.parse(fs.readFileSync(sectionsFile, 'utf-8')) : []
if (!Array.isArray(configs) || !Array.isArray(sections)) {
  console.error('configs.json / config-sections.json did not parse to arrays — refusing to touch them')
  process.exit(1)
}

const stamp = Date.now()
for (const f of [configsFile, sectionsFile]) if (fs.existsSync(f)) fs.copyFileSync(f, `${f}.bak-${stamp}`)

const keptConfigs = configs.filter((c) => !(typeof c?.id === 'string' && c.id.startsWith('mx-')))
const keptSections = sections.filter((s) => s?.id !== 'sec-matrix')
keptSections.push({ id: 'sec-matrix', name: `MATRIX TESTS — FROM ${fromRole}` })
fs.writeFileSync(configsFile, JSON.stringify([...keptConfigs, ...out], null, 2))
fs.writeFileSync(sectionsFile, JSON.stringify(keptSections, null, 2))

console.log(`FROM ${fromRole}: ${mine.length} matrix cases → ${out.length} configs written (section "MATRIX TESTS — FROM ${fromRole}")`)
console.log(`Preserved ${keptConfigs.length} existing configs; backups .bak-${stamp}`)
if (skipped.length) {
  console.log(`\nNOT generated (${skipped.length}) — every one has a reason, none silent:`)
  for (const s of skipped.sort((a, b) => Number(a.id) - Number(b.id))) console.log(`  C${s.id}: ${s.why}`)
}
if (needsPassword.length) console.log(`\nType the SSH password ONCE in Edit → Save for (${needsPassword.length}):\n  - ${needsPassword.join('\n  - ')}`)
if (needsKey.length) console.log(`\nNeed this machine's SSH key authorised on the target for (${needsKey.length}):\n  - ${needsKey.join('\n  - ')}`)
if (needsDocker.size) console.log(`\nDocker provisioning owed before these connect:\n  - ${[...needsDocker].join('\n  - ')}`)
