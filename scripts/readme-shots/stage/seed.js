// README staging — seed the test VM with the fictional workspace in content.js.
//
//   node seed.js --app-version 2.1.0-beta.15      stage everything (app must be closed)
//   node seed.js --restore                         put the pre-staging state back
//
// Runs ON the VM as the desktop user. Writes only under the app's data/resources
// dirs, the user's ~/.claude and ~/.codex, C:\dev (the fake projects) and the
// npm bin dir (the fake CLIs). The first run moves whatever was there into
// <runner>/backup/ so --restore can undo all of it.
//
// Every path is forward-slash and absolute; nothing here is portable beyond the
// screenshot VM and nothing here should ever run on a developer's machine.

'use strict'

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { execFileSync } = require('child_process')
const C = require('./content')

const argv = process.argv.slice(2)
const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined }
const RESTORE = argv.includes('--restore')
const APP_VERSION = flag('--app-version') || '2.1.0-beta.15'

const HOME = process.env.CCC_STAGE_HOME || 'C:/Users/User'
const DATA = process.env.CCC_STAGE_DATA || 'C:/Users/User/AppData/Local/AI Code Conductor'
const RES = process.env.CCC_STAGE_RES || `${DATA}/resources`
const CONFIG = `${RES}/CONFIG`
const NPM_BIN = process.env.CCC_STAGE_NPM_BIN || 'C:/Users/User/AppData/Roaming/npm'
const RUNNER = process.env.CCC_STAGE_RUNNER || 'C:/Users/user/ccc-cap'
const BACKUP = `${RUNNER}/backup`
const PROJECTS = `${HOME}/.claude/projects`
const CODEX_SESSIONS = `${HOME}/.codex/sessions`
const DEV = process.env.CCC_STAGE_DEV || 'C:/dev'
const NOW = Date.now()

const log = (m) => console.log(m)

// ── small fs helpers ───────────────────────────────────────────────────────
function mkdirp(p) { fs.mkdirSync(p, { recursive: true }) }
function writeJson(p, v) { mkdirp(path.dirname(p)); fs.writeFileSync(p, JSON.stringify(v, null, 2) + '\n', 'utf8') }
function writeText(p, s) { mkdirp(path.dirname(p)); fs.writeFileSync(p, s, 'utf8') }
function readJson(p, fallback) { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return fallback } }
function touch(p, ms) { const d = new Date(ms); fs.utimesSync(p, d, d) }
function rmrf(p) { fs.rmSync(p, { recursive: true, force: true }) }
function moveInto(src, destDir) {
  if (!fs.existsSync(src)) return
  mkdirp(destDir)
  const dest = path.join(destDir, path.basename(src))
  rmrf(dest)
  fs.renameSync(src, dest)
}
function copyInto(src, destDir) {
  if (!fs.existsSync(src)) return
  mkdirp(destDir)
  fs.cpSync(src, path.join(destDir, path.basename(src)), { recursive: true })
}

// Deterministic pseudo-random so the seed is reproducible run to run.
let seedState = 0x9e3779b9
function rnd() { seedState = (Math.imul(seedState, 1664525) + 1013904223) >>> 0; return seedState / 4294967296 }
function rint(lo, hi) { return lo + Math.floor(rnd() * (hi - lo + 1)) }
function hex(n) { let s = ''; while (s.length < n) s += rint(0, 15).toString(16); return s }
function uuid() { return `${hex(8)}-${hex(4)}-4${hex(3)}-${['8', '9', 'a', 'b'][rint(0, 3)]}${hex(3)}-${hex(12)}` }
function slugOf(cwd) { return cwd.replace(/[^A-Za-z0-9]/g, '-') }
const acct = (key) => C.ACCOUNTS.find((a) => a.key === key)
const cfg = (key) => C.CONFIGS.find((c) => c.id === key)

// ── backup / restore ───────────────────────────────────────────────────────
const BACKED = [
  ['config', CONFIG],
  ['account-profiles', `${RES}/account-profiles`],
  ['canvas', `${RES}/canvas`],
  ['insights', `${RES}/insights`],
  ['status', `${RES}/status`],
]
const DB_FILES = ['transcripts.db', 'transcripts.db-wal', 'transcripts.db-shm', 'tokenomics.db', 'tokenomics.db-wal', 'tokenomics.db-shm']

function backupOnce() {
  if (fs.existsSync(`${BACKUP}/.done`)) { log('backup already taken — leaving it alone'); return }
  log('taking the one-time backup → ' + BACKUP)
  for (const [name, dir] of BACKED) copyInto(dir, `${BACKUP}/${name}-parent`)
  for (const f of DB_FILES) copyInto(`${DATA}/${f}`, `${BACKUP}/db`)
  // Real projects and codex sessions move aside so only the staged ones show.
  for (const d of fs.existsSync(PROJECTS) ? fs.readdirSync(PROJECTS) : []) moveInto(`${PROJECTS}/${d}`, `${BACKUP}/projects`)
  moveInto(CODEX_SESSIONS, `${BACKUP}/codex`)
  copyInto(`${NPM_BIN}/claude.cmd`, `${BACKUP}/npm-bin`)
  copyInto(`${NPM_BIN}/codex.cmd`, `${BACKUP}/npm-bin`)
  writeText(`${BACKUP}/.done`, new Date().toISOString())
}

function restore() {
  if (!fs.existsSync(`${BACKUP}/.done`)) { log('no backup to restore'); return }
  log('restoring pre-staging state from ' + BACKUP)
  for (const [name, dir] of BACKED) {
    rmrf(dir)
    const src = `${BACKUP}/${name}-parent/${path.basename(dir)}`
    if (fs.existsSync(src)) fs.cpSync(src, dir, { recursive: true })
  }
  for (const f of DB_FILES) { rmrf(`${DATA}/${f}`); if (fs.existsSync(`${BACKUP}/db/${f}`)) fs.copyFileSync(`${BACKUP}/db/${f}`, `${DATA}/${f}`) }
  // staged projects/codex out, real ones back
  for (const d of fs.existsSync(PROJECTS) ? fs.readdirSync(PROJECTS) : []) rmrf(`${PROJECTS}/${d}`)
  for (const d of fs.existsSync(`${BACKUP}/projects`) ? fs.readdirSync(`${BACKUP}/projects`) : []) fs.renameSync(`${BACKUP}/projects/${d}`, `${PROJECTS}/${d}`)
  rmrf(CODEX_SESSIONS)
  if (fs.existsSync(`${BACKUP}/codex/sessions`)) fs.renameSync(`${BACKUP}/codex/sessions`, CODEX_SESSIONS)
  uninstallFakeClis()
  rmrf(DEV)
  fs.renameSync(`${BACKUP}/.done`, `${BACKUP}/.restored-${Date.now()}`)
  log('restored')
}

// ── fake CLIs on PATH ──────────────────────────────────────────────────────
// `where claude.cmd` is how the app finds Claude on Windows; the fake takes the
// real file's place and the real one is parked beside it as claude.real.cmd.
function installFakeClis() {
  const here = __dirname
  const real = `${NPM_BIN}/claude.cmd`
  if (fs.existsSync(real) && !fs.readFileSync(real, 'utf8').includes('fake-claude.js')) {
    fs.renameSync(real, `${NPM_BIN}/claude.real.cmd`)
  }
  const codexReal = `${NPM_BIN}/codex.cmd`
  if (fs.existsSync(codexReal) && !fs.readFileSync(codexReal, 'utf8').includes('fake-codex.js')) {
    fs.renameSync(codexReal, `${NPM_BIN}/codex.real.cmd`)
  }
  fs.copyFileSync(`${here}/fake-claude.js`, `${NPM_BIN}/fake-claude.js`)
  fs.copyFileSync(`${here}/fake-codex.js`, `${NPM_BIN}/fake-codex.js`)
  fs.copyFileSync(`${here}/content.js`, `${NPM_BIN}/content.js`)
  writeText(`${NPM_BIN}/claude.cmd`, `@echo off\r\nnode "%~dp0fake-claude.js" %*\r\n`)
  writeText(`${NPM_BIN}/codex.cmd`, `@echo off\r\nnode "%~dp0fake-codex.js" %*\r\n`)
  log('fake claude/codex installed on PATH')
}
function uninstallFakeClis() {
  for (const n of ['claude', 'codex']) {
    const fake = `${NPM_BIN}/${n}.cmd`
    const real = `${NPM_BIN}/${n}.real.cmd`
    if (fs.existsSync(fake) && fs.readFileSync(fake, 'utf8').includes(`fake-${n}.js`)) rmrf(fake)
    if (fs.existsSync(real)) fs.renameSync(real, fake)
    rmrf(`${NPM_BIN}/fake-${n}.js`)
  }
  rmrf(`${NPM_BIN}/content.js`)
  log('fake CLIs removed')
}

// ── CONFIG/*.json ──────────────────────────────────────────────────────────
function seedConfig() {
  const configs = C.CONFIGS.map((c) => {
    const { profileKey, ...rest } = c
    const out = { ...rest }
    if (profileKey) out.profileId = acct(profileKey).id
    if (rest.sessionType === 'local' && !rest.machineName) out.machineName = 'workstation'
    return out
  })
  writeJson(`${CONFIG}/configs.json`, configs)
  writeJson(`${CONFIG}/config-groups.json`, C.GROUPS)
  writeJson(`${CONFIG}/config-sections.json`, C.SECTIONS)

  const sessions = C.SESSIONS.map((s) => {
    const c = cfg(s.configKey)
    const base = {
      id: s.id, configId: c.id, label: s.label, workingDirectory: c.workingDirectory,
      color: c.color, identityColorKey: c.identityColorKey, sessionType: 'local',
      provider: s.provider || 'claude', machineName: 'workstation',
    }
    if (s.customName) base.customName = s.customName
    if (s.shellOnly) return { ...base, shellOnly: true, terminalOptions: c.terminalOptions }
    base.profileId = acct(s.accountKey).id
    if (s.provider === 'codex') return { ...base, codexOptions: c.codexOptions }
    return {
      ...base,
      resumeUuid: s.resumeUuid, resumeCwd: c.workingDirectory,
      claudeOptions: { ...c.claudeOptions, model: s.model, effortLevel: s.effort },
    }
  })
  writeJson(`${CONFIG}/session-state.json`, { sessions, activeSessionId: C.ACTIVE_SESSION_ID, savedAt: NOW - 30 * C.MIN })

  const steps = ['whatsNewV2', 'welcome', 'findClaude', 'compatibility', 'accounts', 'github', 'statusline', 'codex', 'codexSignIn', 'builtinTools', 'transparency', 'finish']
  const completedSteps = {}
  for (const s of steps) completedSteps[s] = APP_VERSION
  writeJson(`${CONFIG}/app-meta.json`, {
    setupVersion: APP_VERSION, lastSeenVersion: APP_VERSION, lastTrainingVersion: APP_VERSION,
    onboardingCompletedVersion: '3', onboardingAppVersion: APP_VERSION, completedSteps,
    commandsSeeded: true, colorMigrated: true, hasCreatedFirstConfig: true, firstRunCardDismissed: true,
    accountWizardDismissed: true, accountGateDecided: true, lastSeenGlobalAccount: acct('alex').email,
  })

  const settings = readJson(`${CONFIG}/settings.json`, {})
  Object.assign(settings, {
    loggingConsentSeen: true, loggingEnabled: true, legacyLogsSurfacingSeen: true, showTips: false,
    agentHubExplainerDismissed: true, colourMigrationNoticeDismissed: true, colourMigrationNoticePending: false,
    configHydrationNoticeDismissed: true, localMachineName: 'workstation', updateChannelChosen: true, updateChannel: 'beta',
    statusLineEnabled: true, conductorToolsEnabled: true, codexEnabled: true, sentinelEnabled: false,
    githubAiUsageEnabled: false, theme: 'dark', debugMode: false, hooksEnabled: true,
    defaultModel: 'fable', configPanelPinned: true,
  })
  writeJson(`${CONFIG}/settings.json`, settings)

  writeJson(`${CONFIG}/github-config.json`, {
    schemaVersion: 1, authProfiles: {}, featureToggles: {},
    syncIntervals: { activeSessionSec: 60, backgroundSec: 300, notificationsSec: 300 },
    enabledByDefault: false, transcriptScanningOptIn: false, seenOnboardingVersion: 'permanent',
  })
  writeJson(`${CONFIG}/usage-tracking.json`, {
    features: { 'session.create': { firstSeenAt: NOW - 40 * C.DAY, lastUsedAt: NOW - C.HOUR, count: 212 } },
    tipsShown: {}, tipsDismissed: {}, tipsActed: {},
  })
  log('CONFIG written')
}

// ── accounts ───────────────────────────────────────────────────────────────
function seedAccounts() {
  const root = `${RES}/account-profiles`
  rmrf(root)
  const profiles = C.ACCOUNTS.map((a) => ({
    id: a.id, name: a.name, accountEmail: a.email, colourKey: a.colourKey,
    isPrimary: !!a.primary, active: true, createdAt: NOW - 60 * C.DAY,
  }))
  writeJson(`${root}/profiles.json`, { profiles })
  for (const a of C.ACCOUNTS) {
    const home = `${root}/${a.id}`
    writeJson(`${home}/.claude.json`, {
      numStartups: 212, installMethod: 'npm', autoUpdates: true, hasCompletedOnboarding: true,
      oauthAccount: { accountUuid: uuid(), emailAddress: a.email, organizationUuid: uuid(), organizationName: 'Larkspur', organizationRole: 'admin', workspaceRole: null },
      projects: {},
    })
    writeJson(`${home}/.claude/.credentials.json`, {
      claudeAiOauth: {
        accessToken: 'sk-ant-oat01-' + hex(48), refreshToken: 'sk-ant-ort01-' + hex(48),
        expiresAt: NOW + 7 * C.HOUR, refreshTokenExpiresAt: NOW + 312 * C.DAY,
        scopes: ['user:inference', 'user:profile'], subscriptionType: 'max',
      },
    })
  }
  log('accounts written')
}

// ── status files (the fake CLI keeps these fresh; pre-written so cards light up at once) ──
function seedStatus() {
  const dir = `${RES}/status`
  rmrf(dir); mkdirp(dir)
  for (const s of C.SESSIONS) if (s.status) writeJson(`${dir}/${s.id}.json`, C.statusFor(s, NOW, HOME))
  log('status files written')
}

// ── transcripts: JSONL on disk (tokenomics reads them) + rows for the Logs DB ──
const CC_VERSION = '2.1.198'
function usageFor(model, i, isText, textLen) {
  const cacheRead = 18000 + i * rint(1800, 5200)
  return {
    input_tokens: rint(3, 11),
    cache_creation_input_tokens: rint(180, 2400),
    cache_read_input_tokens: cacheRead,
    output_tokens: isText ? Math.max(40, Math.round(textLen / 3.6) + rint(0, 60)) : rint(55, 190),
    service_tier: 'standard',
  }
}
// Turn a scenario into JSONL lines + Logs rows. Timestamps start at `startMs`.
function renderTranscript({ scenario, uuid: sid, cwd, model, startMs, cap }) {
  const sc = C.SCENARIOS[scenario]
  const gitBranch = 'main'
  const lines = []
  const rows = [] // { ts, role, kind, content, toolName, toolMeta }
  let ts = startMs
  let parent = null
  let n = 0
  const base = () => ({ parentUuid: parent, isSidechain: false, userType: 'external', cwd, sessionId: sid, version: CC_VERSION, gitBranch })
  const push = (obj) => { const id = uuid(); lines.push(JSON.stringify({ ...base(), ...obj, uuid: id, timestamp: new Date(ts).toISOString() })); parent = id }
  const turns = sc.turns.filter((t) => !t.spinner).slice(0, cap)
  for (const t of turns) {
    n++
    if (t.user) {
      ts += rint(20, 240) * 1000
      push({ type: 'user', message: { role: 'user', content: t.user } })
      rows.push({ ts, role: 'user', kind: 'message', content: t.user })
      continue
    }
    if (t.text) {
      ts += rint(4, 18) * 1000
      const msgId = 'msg_01' + hex(22).toUpperCase()
      push({ type: 'assistant', requestId: 'req_011' + hex(21).toUpperCase(), message: { id: msgId, type: 'message', role: 'assistant', model, content: [{ type: 'text', text: t.text }], stop_reason: null, stop_sequence: null, usage: usageFor(model, n, true, t.text.length) } })
      rows.push({ ts, role: 'assistant', kind: 'message', content: t.text })
    }
    if (t.tool) {
      ts += rint(2, 9) * 1000
      const msgId = 'msg_01' + hex(22).toUpperCase()
      const toolId = 'toolu_01' + hex(22).toUpperCase()
      push({ type: 'assistant', requestId: 'req_011' + hex(21).toUpperCase(), message: { id: msgId, type: 'message', role: 'assistant', model, content: [{ type: 'tool_use', id: toolId, name: t.tool, input: t.input }], stop_reason: null, stop_sequence: null, usage: usageFor(model, n, false, 0) } })
      const meta = {}
      for (const k of ['file_path', 'command', 'url', 'query', 'pattern', 'prompt', 'description']) if (t.input[k] !== undefined) meta[k] = String(t.input[k]).slice(0, 200)
      rows.push({ ts, role: 'assistant', kind: 'tool_call', content: '', toolName: t.tool, toolMeta: JSON.stringify(meta) })
      ts += rint(1, 6) * 1000
      const resultText = (t.result || []).join('\n')
      push({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content: resultText }] }, toolUseResult: resultText })
    }
  }
  return { lines, rows, endedAt: ts }
}

function seedTranscripts() {
  mkdirp(PROJECTS)
  const runs = [] // for the Logs DB
  const stamp = (file, ms) => touch(file, ms)

  // history
  for (const h of C.history()) {
    const c = cfg(h.configKey)
    const a = acct(h.accountKey)
    const startMs = NOW - h.daysAgo * C.DAY
    const t = renderTranscript({ scenario: h.scenario, uuid: h.uuid, cwd: c.workingDirectory, model: h.model, startMs, cap: h.cap })
    const dir = `${PROJECTS}/${slugOf(c.workingDirectory)}`
    const file = `${dir}/${h.uuid}.jsonl`
    writeText(file, t.lines.join('\n') + '\n')
    stamp(file, t.endedAt)
    runs.push({ sessionId: hex(24), configId: c.id, configLabel: c.label, projectCwd: c.workingDirectory, accountEmail: a.email, profileId: a.id, provider: 'claude', startedAt: startMs, endedAt: t.endedAt, path: file.replace(/\//g, '\\'), rows: t.rows })
  }
  // live sessions: the same scenario, started a while ago (the fake CLI replays it)
  for (const s of C.SESSIONS) {
    if (!s.scenario || s.provider === 'codex') continue
    const c = cfg(s.configKey)
    const startMs = NOW - s.status.durMs
    const t = renderTranscript({ scenario: s.scenario, uuid: s.resumeUuid, cwd: c.workingDirectory, model: s.status.modelId, startMs, cap: 99 })
    const file = `${PROJECTS}/${slugOf(c.workingDirectory)}/${s.resumeUuid}.jsonl`
    writeText(file, t.lines.join('\n') + '\n')
    stamp(file, NOW - 4 * C.MIN)
  }
  // the app's own install path folder — the CLI-ready probe looks for it
  mkdirp(`${PROJECTS}/C--Users-User-AppData-Local-Programs-AI-Code-Conductor`)
  writeJson(`${RUNNER}/transcripts-seed.json`, { runs })
  log(`transcripts written: ${runs.length} history runs`)
}

// ── memory ─────────────────────────────────────────────────────────────────
function seedMemory() {
  const projectDirs = { storefront: 'C:\\dev\\web\\storefront', 'api-gateway': 'C:\\dev\\platform\\api-gateway', pipeline: 'C:\\dev\\data\\pipeline', 'auth-service': 'C:\\dev\\platform\\auth-service', 'docs-site': 'C:\\dev\\web\\docs-site', notes: 'C:\\dev\\notes', infra: 'C:\\dev\\platform\\infra' }
  const padCounts = { storefront: 22, 'api-gateway': 15, pipeline: 11, 'auth-service': 6, 'docs-site': 4, notes: 2, infra: 3 }
  let total = 0
  for (const [proj, notes] of Object.entries(C.MEMORY)) {
    const dir = `${PROJECTS}/${slugOf(projectDirs[proj])}/memory`
    rmrf(dir); mkdirp(dir)
    const index = [`# ${proj} — memory index`, '']
    const write = (name, type, description, body, ageDays) => {
      const file = `${dir}/${name}.md`
      writeText(file, `---\nname: ${name}\ndescription: ${description}\ntype: ${type}\n---\n\n${body || description}\n`)
      touch(file, NOW - ageDays * C.DAY - rint(0, 12) * C.HOUR)
      index.push(`- [${name}](${name}.md) — ${description.split(/[.;—]/)[0]}`)
      total++
    }
    for (const [name, type, description, body, age] of notes) write(name, type, description, body, age)
    for (let i = 0; i < (padCounts[proj] || 0); i++) {
      const [type, slug, description] = C.PAD_TITLES[i % C.PAD_TITLES.length]
      const suffix = i >= C.PAD_TITLES.length ? `-${Math.floor(i / C.PAD_TITLES.length) + 1}` : ''
      write(`${type}-${slug}${suffix}`, type, description, description, rint(2, 75))
    }
    const idx = `${dir}/MEMORY.md`
    writeText(idx, index.join('\n') + '\n')
    touch(idx, NOW - rint(0, 2) * C.DAY)
    total++
  }
  log(`memory written: ${total} files`)
}

// ── codex rollouts ─────────────────────────────────────────────────────────
function seedCodex() {
  rmrf(CODEX_SESSIONS)
  for (const r of C.CODEX_HISTORY) {
    const start = NOW - r.daysAgo * C.DAY
    const d = new Date(start)
    const dir = `${CODEX_SESSIONS}/${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}`
    const id = uuid()
    const lines = [JSON.stringify({ timestamp: new Date(start).toISOString(), type: 'session_meta', payload: { id, timestamp: new Date(start).toISOString(), cwd: r.cwd, originator: 'codex_cli_rs', cli_version: '0.60.0', model: r.model } })]
    let ts = start
    let total = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 0 }
    for (let i = 0; i < r.turns; i++) {
      ts += rint(15, 120) * 1000
      const last = { input_tokens: rint(9000, 42000), cached_input_tokens: rint(6000, 30000), output_tokens: rint(300, 2600), reasoning_output_tokens: rint(100, 900) }
      last.total_tokens = last.input_tokens + last.output_tokens
      for (const k of Object.keys(total)) total[k] += last[k]
      lines.push(JSON.stringify({ timestamp: new Date(ts).toISOString(), type: 'turn_context', payload: { cwd: r.cwd, model: r.model, approval_policy: 'on-request' } }))
      lines.push(JSON.stringify({ timestamp: new Date(ts + 900).toISOString(), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { ...total }, last_token_usage: last, model_context_window: 400000 } } }))
    }
    const file = `${dir}/rollout-${new Date(start).toISOString().replace(/[:.]/g, '-')}-${id}.jsonl`
    writeText(file, lines.join('\n') + '\n')
    touch(file, ts)
  }
  log(`codex rollouts written: ${C.CODEX_HISTORY.length}`)
}

// ── insights ───────────────────────────────────────────────────────────────
function seedInsights() {
  const dir = `${RES}/insights`
  rmrf(dir)
  const a = acct(C.INSIGHTS.accountKey)
  const sam = acct('sam')
  const jordan = acct('jordan')
  const runs = [
    { id: '2026-07-21-064102-011900', timestamp: Date.parse('2026-07-21T06:41:02Z'), status: 'complete', accountEmail: a.email, profileId: a.id, kind: 'account' },
    { id: '2026-08-04-070812-013207', timestamp: Date.parse('2026-08-04T07:08:12Z'), status: 'complete', accountEmail: sam.email, profileId: sam.id, kind: 'account' },
    { id: '2026-08-11-071940-013802', timestamp: Date.parse('2026-08-11T07:19:40Z'), status: 'complete', accountEmail: jordan.email, profileId: jordan.id, kind: 'account' },
    { id: C.INSIGHTS.runId, timestamp: C.INSIGHTS.timestamp, status: 'complete', accountEmail: a.email, profileId: a.id, kind: 'account' },
  ]
  writeJson(`${dir}/catalogue.json`, { runs })
  // Older runs reuse the same report so a stray click never lands on an empty page.
  for (const r of runs) {
    writeText(`${dir}/${r.id}/report.html`, C.INSIGHTS.html)
    writeJson(`${dir}/${r.id}/kpis.json`, C.INSIGHTS.kpis)
  }
  log('insights written')
}

// ── canvas (signed record + versions + review) ────────────────────────────
function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  const entries = Object.entries(value).filter(([, v]) => v !== undefined && typeof v !== 'function').sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(',')}}`
}
function seedCanvas() {
  const secretFile = `${CONFIG}/conductor-secret.json`
  const secret = readJson(secretFile, null)?.secret
  if (!secret) { log('!! no conductor-secret.json — start the app once first; skipping canvas'); return }
  const key = crypto.createHmac('sha256', secret).update('ccc:canvas-record-v1', 'utf8').digest()
  const mac = (record) => crypto.createHmac('sha256', key).update(`canvas-record-v1\n${canonicalize(record)}`, 'utf8').digest('hex')

  const root = `${RES}/canvas`
  rmrf(root)
  const cv = C.CANVAS
  const s = C.SESSIONS[0]
  const c = cfg(s.configKey)
  const a = acct(s.accountKey)
  const dir = `${root}/${cv.canvasId}`
  const t0 = NOW - 52 * C.MIN
  const versions = [1, 2, 3].map((n) => ({ id: `v${n}`, mode: 'design', createdAt: new Date(t0 + (n - 1) * 17 * C.MIN).toISOString(), source: { mode: 'design', entry: 'index.html' } }))
  for (const v of versions) writeText(`${dir}/versions/${v.id}/index.html`, C.canvasHtml(Number(v.id.slice(1))))
  const record = {
    canvasId: cv.canvasId, sessionId: s.id, title: cv.title, activeVersionId: 'v3', versions,
    createdAt: new Date(t0).toISOString(), cwd: c.workingDirectory, conversationUuid: s.resumeUuid, profileId: a.id,
  }
  writeJson(`${dir}/canvas.json`, { ...record, mac: mac(record) })

  const reviewCreated = new Date(t0 + 20 * C.MIN).toISOString()
  const submitted = new Date(t0 + 27 * C.MIN).toISOString()
  const annotations = cv.reviews.notes.map((n) => {
    const base = { id: n.id, reviewId: 'R1', scope: n.scope, note: n.note, versionId: 'v2', state: n.state }
    if (n.scope === 'general') return base
    return { ...base, focus: { targets: [{ kind: 'ux-id', id: n.uxId }], bboxPage: n.bbox, label: n.label, versionId: 'v2' } }
  })
  writeJson(`${dir}/reviews.json`, {
    canvasId: cv.canvasId, sessionId: s.id, nextReview: 2, nextAnnotation: annotations.length + 1,
    reviews: [{ id: 'R1', canvas: { sessionId: s.id, canvasId: cv.canvasId }, versionId: 'v2', annotationIds: annotations.map((x) => x.id), status: 'submitted', createdAt: reviewCreated, submittedAt: submitted }],
    annotations,
  })
  log('canvas written (signed)')
}

// ── fake project directories ───────────────────────────────────────────────
function seedProjects() {
  const files = {
    'web/storefront': { 'package.json': '{ "name": "storefront", "private": true }\n', 'README.md': '# storefront\n' },
    'web/docs-site': { 'package.json': '{ "name": "docs-site", "private": true }\n' },
    'platform/api-gateway': { 'package.json': '{ "name": "api-gateway", "private": true }\n' },
    'platform/auth-service': { 'package.json': '{ "name": "auth-service", "private": true }\n' },
    'platform/infra': { 'main.tf': '# infra\n' },
    'data/pipeline': { 'pyproject.toml': '[project]\nname = "pipeline"\n' },
    'notes': { '2026-08-17.md': '# Monday\n' },
  }
  for (const [rel, fs_] of Object.entries(files)) for (const [name, body] of Object.entries(fs_)) writeText(`${DEV}/${rel}/${name}`, body)
  log('project dirs written')
}

// ── Logs DB via python ─────────────────────────────────────────────────────
function buildTranscriptsDb() {
  for (const f of ['transcripts.db', 'transcripts.db-wal', 'transcripts.db-shm', 'tokenomics.db', 'tokenomics.db-wal', 'tokenomics.db-shm']) rmrf(`${DATA}/${f}`)
  const py = path.join(__dirname, 'build-transcripts-db.py')
  const out = execFileSync('python', [py, `${RUNNER}/transcripts-seed.json`, `${DATA}/transcripts.db`], { encoding: 'utf8' })
  log(out.trim())
}

// ── main ───────────────────────────────────────────────────────────────────
if (RESTORE) {
  restore()
} else {
  backupOnce()
  seedProjects()
  seedConfig()
  seedAccounts()
  seedStatus()
  seedTranscripts()
  seedMemory()
  seedCodex()
  seedInsights()
  seedCanvas()
  buildTranscriptsDb()
  installFakeClis()
  log(`staged for app version ${APP_VERSION}`)
}
