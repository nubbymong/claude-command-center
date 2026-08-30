#!/usr/bin/env node
/**
 * Seed the "MATRIX TESTS" config section on a FROM machine (harmonise-remote).
 *
 * The master connectivity matrix (master-connectivity-cases.csv) drives real
 * app sessions from each FROM box, so every FROM box needs one launchable
 * config per TO × session-type combination. Hand-creating them per machine
 * does not scale and drifts; this script generates them from the SAME
 * hosts.local.json the live pack uses, so the matrix and the app configs
 * cannot disagree about a host.
 *
 * Usage (run ON the FROM machine, app CLOSED):
 *   node seed-matrix-configs.mjs [--config-dir <path>] [--hosts <path>]
 *
 * --config-dir defaults to %LOCALAPPDATA%/AI Code Conductor/resources/CONFIG
 * (the installed app's config dir on Windows); pass it explicitly elsewhere.
 * --hosts defaults to hosts.local.json next to this script.
 *
 * Idempotent: every generated entry carries the `mx-` id prefix and lives in
 * the `sec-matrix` section; re-running REPLACES exactly that set and touches
 * nothing else (a screenshot-staging workspace's fake configs survive intact).
 * Both files are backed up (.bak-<epoch>) before writing.
 *
 * Passwords are NOT seeded: the app stores SSH passwords DPAPI/keychain-
 * encrypted per config (credential-store.ts) which only the app itself can
 * write. The script prints which configs need a password typed once in the
 * Edit modal, and which need the FROM machine's SSH key authorised on the
 * target.
 */
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

function arg(name, dflt) {
  const i = process.argv.indexOf(name)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt
}

const configDir = arg(
  '--config-dir',
  process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'AI Code Conductor', 'resources', 'CONFIG')
    : '',
)
const hostsPath = arg('--hosts', path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), 'hosts.local.json'))

if (!configDir || !fs.existsSync(configDir)) {
  console.error(`config dir not found: ${configDir || '(none)'} — pass --config-dir`)
  process.exit(1)
}
if (!fs.existsSync(hostsPath)) {
  console.error(`hosts file not found: ${hostsPath} — pass --hosts`)
  process.exit(1)
}

const hosts = JSON.parse(fs.readFileSync(hostsPath, 'utf-8'))
const configsFile = path.join(configDir, 'configs.json')
const sectionsFile = path.join(configDir, 'config-sections.json')
const configs = fs.existsSync(configsFile) ? JSON.parse(fs.readFileSync(configsFile, 'utf-8')) : []
const sections = fs.existsSync(sectionsFile) ? JSON.parse(fs.readFileSync(sectionsFile, 'utf-8')) : []
if (!Array.isArray(configs) || !Array.isArray(sections)) {
  console.error('configs.json / config-sections.json did not parse to arrays — refusing to touch them')
  process.exit(1)
}

const SECTION_ID = 'sec-matrix'
const COLORS = ['slate-blue', 'pink', 'indigo', 'violet', 'plum', 'lavender', 'rose', 'orchid', 'mauve', 'periwinkle']
let colorIdx = 0
const claudeOptions = { model: 'sonnet', effortLevel: 'medium', loggingEnabled: true, agentIds: [] }
const needsPassword = []
const needsKey = []
const out = []

function add(id, label, ssh, opts = {}) {
  const cfg = {
    id: `mx-${id}`,
    label,
    workingDirectory: ssh ? ssh.remotePath : (process.env.USERPROFILE || process.env.HOME || '~'),
    color: '',
    identityColorKey: COLORS[colorIdx++ % COLORS.length],
    sessionType: ssh ? 'ssh' : 'local',
    provider: 'claude',
    sectionId: SECTION_ID,
    claudeOptions,
    ...(ssh ? { sshConfig: ssh } : {}),
  }
  out.push(cfg)
  if (ssh) (opts.auth === 'pw' ? needsPassword : needsKey).push(label)
}

function sshCfg(slot, { detachable, remoteOs, auth }) {
  return {
    host: slot.host,
    port: slot.port ?? 22,
    username: slot.username,
    remotePath: slot.remotePath ?? '~',
    hasPassword: false, // set by the app when the password is typed in Edit
    detachable,
    remoteOs: remoteOs ?? 'auto',
    postCommand: '',
    dockerContainer: '',
  }
}

// Local — the FROM machine itself.
add('local', 'Local (this machine)', null)

// Windows target (WINDOWS_2): standard pw + standard key + detach-degrade.
if (hosts.windows) {
  const w = hosts.windows
  add('win2-std-pw', 'Win2 · standard · pw', sshCfg(w, { detachable: false, remoteOs: 'windows', auth: 'pw' }), { auth: 'pw' })
  add('win2-std-key', 'Win2 · standard · key', sshCfg(w, { detachable: false, remoteOs: 'windows', auth: 'key' }), { auth: 'key' })
  add('win2-detach', 'Win2 · detach degrade · pw', sshCfg(w, { detachable: true, remoteOs: 'windows', auth: 'pw' }), { auth: 'pw' })
}
// Unix password target (Pi): tmux + standard.
if (hosts.linuxPassword) {
  const p = hosts.linuxPassword
  add('pi-tmux-pw', 'Pi · tmux · pw', sshCfg(p, { detachable: true, auth: 'pw' }), { auth: 'pw' })
  add('pi-std-pw', 'Pi · standard · pw', sshCfg(p, { detachable: false, auth: 'pw' }), { auth: 'pw' })
}
// Unix key target (185): tmux + standard.
if (hosts.linuxKey) {
  const k = hosts.linuxKey
  add('185-tmux-key', '185 · tmux · key', sshCfg(k, { detachable: true, auth: 'key' }), { auth: 'key' })
  add('185-std-key', '185 · standard · key', sshCfg(k, { detachable: false, auth: 'key' }), { auth: 'key' })
}
// Rocky (password, no tmux installed — detachable ON exercises the staging rung).
if (hosts.linuxRocky) {
  const r = hosts.linuxRocky
  add('rocky-tmux-pw', 'Rocky · tmux(staged) · pw', sshCfg(r, { detachable: true, auth: 'pw' }), { auth: 'pw' })
  add('rocky-std-pw', 'Rocky · standard · pw', sshCfg(r, { detachable: false, auth: 'pw' }), { auth: 'pw' })
}
// mac (key): tmux + standard.
if (hosts.mac) {
  const m = hosts.mac
  add('mac-tmux-key', 'Mac · tmux · key', sshCfg(m, { detachable: true, auth: 'key' }), { auth: 'key' })
  add('mac-std-key', 'Mac · standard · key', sshCfg(m, { detachable: false, auth: 'key' }), { auth: 'key' })
}

// Docker combinations are deliberately NOT generated yet: the structured
// Runtime field (ledger item e) and the docker installs on the fleet are
// still owed; free-text postCommand configs would encode exactly the shape
// that work replaces. Add them here when item (e) lands.

const stamp = Date.now()
for (const f of [configsFile, sectionsFile]) {
  if (fs.existsSync(f)) fs.copyFileSync(f, `${f}.bak-${stamp}`)
}

const keptConfigs = configs.filter((c) => !(typeof c?.id === 'string' && c.id.startsWith('mx-')))
const keptSections = sections.filter((s) => s?.id !== SECTION_ID)
keptSections.push({ id: SECTION_ID, name: 'MATRIX TESTS' })
fs.writeFileSync(configsFile, JSON.stringify([...keptConfigs, ...out], null, 2))
fs.writeFileSync(sectionsFile, JSON.stringify(keptSections, null, 2))

console.log(`Wrote ${out.length} matrix configs into section "MATRIX TESTS" (${configDir})`)
console.log(`Preserved ${keptConfigs.length} existing configs and ${keptSections.length - 1} existing sections; backups .bak-${stamp}`)
if (needsPassword.length) console.log(`\nType the SSH password ONCE in Edit → Save for:\n  - ${needsPassword.join('\n  - ')}`)
if (needsKey.length) console.log(`\nNeed this machine's SSH key authorised on the target for:\n  - ${needsKey.join('\n  - ')}`)
