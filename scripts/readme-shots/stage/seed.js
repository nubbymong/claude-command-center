// README staging: seed a throwaway staging root with the fictional workspace
// in content.js, for the installed app to run on (launch.js) and shoot.js to
// capture. Runs ON the screenshot VM, from a checkout with node_modules.
//
//   CCC_STAGE_ROOT=<root> node seed.js --app-version 2.1.1-beta.2   stage everything (app closed)
//   CCC_STAGE_ROOT=<root> node seed.js --restore                    undo it (and the C:\dev projects)
//
// Everything is written inside CCC_STAGE_ROOT, one throwaway folder that
// carries this tool's marker (stage-root.js: made only in an absent or empty
// folder, checked before anything is written, renamed or deleted; the root may
// never be or hold the real home, sit in the real ~/.claude or ~/.codex, the
// app's or npm's app data folders, or the installed app's data folder). Every
// other CCC_STAGE_* folder must be inside the root; by default the layout is
// the one launch.js starts the app with (capture-env.ts). There is no mode
// that writes over a real install: the VM user's own app data, ~/.claude,
// ~/.codex and npm folder are never touched.
//
// The one place outside the root: the project folders the fictional configs
// name, C:\dev\{web,platform,data,notes} (or CCC_STAGE_DEV inside the root).
// The seed makes only folders that do not exist yet, marks and records each,
// never overwrites a file, and stops before writing anything if one of them
// exists without its mark. --restore removes only recorded entries that are
// still exactly one of those marked folders.
//
// The Codex accounts are written through the app's own registry code
// (codex-registry.ts), bundled with the checkout's own esbuild (pinned by the
// lockfile; no download at run time).

'use strict'

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { execFileSync } = require('child_process')
const C = require('./content')
const S = require('./stage-root')

const argv = process.argv.slice(2)
const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined }
const RESTORE = argv.includes('--restore')
const APP_VERSION = flag('--app-version') || '2.1.0-beta.15'

// The guard, before anything else touches the file system (exit 2, fail closed).
let STAGE
try {
  STAGE = S.resolveStage(process.env)
  if (!RESTORE) S.checkDevTargets(STAGE.DEV)
  S.ensureMarker(STAGE.ROOT, { create: !RESTORE })
} catch (e) {
  if (e instanceof S.StageRefusal) { console.error('refusing: ' + e.message); process.exit(2) }
  throw e
}

const HOME = STAGE.HOME
const DATA = STAGE.DATA
const RES = STAGE.RES
const CONFIG = `${RES}/CONFIG`
const NPM_BIN = STAGE.NPM_BIN
const RUNNER = STAGE.RUNNER
const BACKUP = `${RUNNER}/backup`
const PROJECTS = `${HOME}/.claude/projects`
const CODEX_SESSIONS = `${HOME}/.codex/sessions`
const DEV = STAGE.DEV
const DEV_RECORD = `${RUNNER}/dev-created.json`
// The checkout this script is in (scripts/readme-shots/stage).
const REPO = path.resolve(__dirname, '..', '..', '..')
const NOW = Date.now()

const log = (m) => console.log(m)
const codexAcct = (key) => C.CODEX_ACCOUNTS.find((a) => a.key === key)

// ── small fs helpers ───────────────────────────────────────────────────────
// Every write and delete below is held inside the staging root; the project
// folders under DEV go through writeProjectFile and restore's own checks.
function inRoot(p) {
  if (!S.inside(p, STAGE.ROOT)) throw new Error(`[seed] ${p} is outside the staging root ${STAGE.ROOT}`)
  return p
}
function mkdirp(p) { fs.mkdirSync(inRoot(p), { recursive: true }) }
function writeJson(p, v) { mkdirp(path.dirname(p)); fs.writeFileSync(inRoot(p), JSON.stringify(v, null, 2) + '\n', 'utf8') }
function writeText(p, s) { mkdirp(path.dirname(p)); fs.writeFileSync(inRoot(p), s, 'utf8') }
function readJson(p, fallback) { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return fallback } }
function touch(p, ms) { const d = new Date(ms); fs.utimesSync(inRoot(p), d, d) }
function rmrf(p) { S.removeNoFollow(inRoot(p)) }
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
  // A backup from an earlier run is NOT this state's backup: seeding over it
  // would delete the current state with nothing to restore it from.
  if (fs.existsSync(`${BACKUP}/.done`) && !argv.includes('--reuse-backup')) {
    console.error(`refusing: ${BACKUP}/.done is from an earlier run; restore or move it first (or pass --reuse-backup)`)
    process.exit(2)
  }
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
  // Only the project folders this seed made (seedProjects), each still exactly
  // DEV\<one of its names> and marked; any other entry is reported, not removed.
  const record = readJson(DEV_RECORD, [])
  for (const d of Array.isArray(record) ? record : []) {
    if (S.validDevEntry(d, DEV)) { S.removeNoFollow(path.resolve(d)); log('removed project folder ' + d) }
    else log('!! not removing recorded entry ' + JSON.stringify(d) + ': not one of this tool\'s marked project folders under ' + DEV)
  }
  fs.renameSync(`${BACKUP}/.done`, `${BACKUP}/.restored-${Date.now()}`)
  log('restored')
}

// ── fake CLIs on PATH ──────────────────────────────────────────────────────
// `where claude.cmd` is how the app finds Claude on Windows; the fake takes the
// real file's place and the real one is parked beside it as claude.real.cmd.
function installFakeClis() {
  const here = __dirname
  // A staging fake-CLI folder does not exist yet (the npm bin always did).
  mkdirp(NPM_BIN)
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
  // Where the fake Claude keeps each session's status file (this staging's
  // resources; it has no default of its own) and the home its transcripts
  // are under.
  writeJson(`${NPM_BIN}/fake-stage.json`, { statusDir: `${RES}/status`, home: HOME })
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
  rmrf(`${NPM_BIN}/fake-stage.json`)
  log('fake CLIs removed')
}

// ── CONFIG/*.json ──────────────────────────────────────────────────────────
function seedConfig() {
  const configs = C.CONFIGS.map((c) => {
    const { profileKey, codexAccountKey, ...rest } = c
    const out = { ...rest }
    if (profileKey) out.profileId = acct(profileKey).id
    // 2.1.1: a Codex config names its account in the registry (absent = the default).
    if (codexAccountKey) out.providerAccountId = codexAcct(codexAccountKey).accountId
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
    if (s.provider === 'codex') return { ...base, providerAccountId: codexAcct(s.codexAccountKey).accountId, codexOptions: c.codexOptions }
    base.profileId = acct(s.accountKey).id
    return {
      ...base,
      resumeUuid: s.resumeUuid, resumeCwd: c.workingDirectory,
      claudeOptions: { ...c.claudeOptions, model: s.model, effortLevel: s.effort },
    }
  })
  writeJson(`${CONFIG}/session-state.json`, { sessions, activeSessionId: C.ACTIVE_SESSION_ID, savedAt: NOW - 30 * C.MIN })

  // The onboarding steps as src/renderer/onboarding/steps.ts lists them (2.1.1;
  // ONBOARDING_VERSION '3'): all done, so the flow never covers the window.
  const steps = ['whatsNewV2', 'welcome', 'assistants', 'commandBar', 'findClaude', 'compatibility', 'accounts', 'codexSetup', 'helloCodex', 'github', 'statusline', 'builtinTools', 'transparency', 'finish']
  const completedSteps = {}
  for (const s of steps) completedSteps[s] = APP_VERSION
  writeJson(`${CONFIG}/app-meta.json`, {
    // lastTrainingVersion above every card: the app stamps the newest card's
    // version, and its compare reads a prerelease like 2.1.1-beta.2 as 2.1.0,
    // so the 2.1.1 cards would count as new and the boot chain would wait on
    // a tour nothing opens (no resume prompt; VM run at f73f1785).
    setupVersion: APP_VERSION, lastSeenVersion: APP_VERSION, lastRunVersion: APP_VERSION, lastTrainingVersion: '99.99.99',
    // 2.1.1's one-time pages: Hello Codex and the multi-spawn intro, seen.
    helloCodexSeenVersion: APP_VERSION, multiSpawnIntroVersion: APP_VERSION,
    onboardingCompletedVersion: '3', onboardingAppVersion: APP_VERSION, completedSteps,
    commandsSeeded: true, colorMigrated: true, hasCreatedFirstConfig: true, firstRunCardDismissed: true,
    accountWizardDismissed: true, accountGateDecided: true, lastSeenGlobalAccount: acct('alex').email,
  })

  const settings = readJson(`${CONFIG}/settings.json`, {})
  Object.assign(settings, {
    loggingConsentSeen: true, loggingConsentVersion: 2, loggingEnabled: true, legacyLogsSurfacingSeen: true, showTips: false,
    // 2.1.1: both assistants on; Codex's on/off counts only with the answer.
    claudeEnabled: true, codexAnswered: true,
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
function realmSessionsDir(accountKey) {
  const a = codexAcct(accountKey)
  if (!a) throw new Error('[seed] no Codex account ' + accountKey)
  return `${RES}/codex-realms/${a.realmId}/sessions`
}
function rolloutDir(base, start) {
  const d = new Date(start)
  return `${base}/${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}`
}
function seedCodex() {
  rmrf(CODEX_SESSIONS)
  for (const a of C.CODEX_ACCOUNTS) rmrf(realmSessionsDir(a.key))
  for (const r of C.CODEX_HISTORY) {
    const start = NOW - r.daysAgo * C.DAY
    const dir = rolloutDir(r.account ? realmSessionsDir(r.account) : CODEX_SESSIONS, start)
    const id = uuid()
    const lines = [JSON.stringify({ timestamp: new Date(start).toISOString(), type: 'session_meta', payload: { id, timestamp: new Date(start).toISOString(), cwd: r.cwd, originator: 'codex_cli_rs', cli_version: '0.155.1', model: r.model } })]
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
  seedCodexLogs()
}

// Codex conversations for the Logs page: provider 'codex' runs on the docs-site config (Website account), each
// with its rollout in that account's realm, appended to the runs the Logs DB is built from.
function seedCodexLogs() {
  const seedFile = `${RUNNER}/transcripts-seed.json`
  const seedDoc = readJson(seedFile, { runs: [] })
  const c = cfg('cfg-docs')
  const a = codexAcct('website')
  let added = 0
  for (const r of C.CODEX_LOG_RUNS) {
    const startMs = NOW - r.daysAgo * C.DAY - 2 * C.HOUR
    const id = uuid()
    const rows = []
    const lines = [JSON.stringify({ timestamp: new Date(startMs).toISOString(), type: 'session_meta', payload: { id, timestamp: new Date(startMs).toISOString(), cwd: c.workingDirectory, originator: 'codex_cli_rs', cli_version: '0.155.1', model: r.model } })]
    let ts = startMs
    for (const t of r.turns) {
      ts += (t.user ? rint(20, 90) : rint(3, 14)) * 1000
      if (t.user) {
        rows.push({ ts, role: 'user', kind: 'message', content: t.user })
        lines.push(JSON.stringify({ timestamp: new Date(ts).toISOString(), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: t.user }] } }))
      } else if (t.text) {
        rows.push({ ts, role: 'assistant', kind: 'message', content: t.text })
        lines.push(JSON.stringify({ timestamp: new Date(ts).toISOString(), type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: t.text }] } }))
      } else if (t.tool) {
        const meta = {}
        for (const k of ['file_path', 'command']) if (t.input[k] !== undefined) meta[k] = String(t.input[k]).slice(0, 200)
        rows.push({ ts, role: 'assistant', kind: 'tool_call', content: '', toolName: t.tool, toolMeta: JSON.stringify(meta) })
        lines.push(JSON.stringify({ timestamp: new Date(ts).toISOString(), type: 'response_item', payload: { type: 'function_call', name: t.tool, arguments: JSON.stringify(t.input), call_id: 'call_' + hex(24) } }))
      }
    }
    const file = `${rolloutDir(realmSessionsDir('website'), startMs)}/rollout-${new Date(startMs).toISOString().replace(/[:.]/g, '-')}-${id}.jsonl`
    writeText(file, lines.join('\n') + '\n')
    touch(file, ts)
    seedDoc.runs.push({ sessionId: hex(24), configId: c.id, configLabel: c.label, projectCwd: c.workingDirectory, accountEmail: a.label, profileId: a.accountId, provider: 'codex', startedAt: startMs, endedAt: ts + 4000, path: file.replace(/\//g, '\\'), sourceFormat: 'codex-rollout', sourceVersion: '0.155.1', rows })
    added++
  }
  writeJson(seedFile, seedDoc)
  log(`codex log runs written: ${added}`)
}

// ── insights ───────────────────────────────────────────────────────────────
function seedInsights() {
  const dir = `${RES}/insights`
  rmrf(dir)
  const a = acct(C.INSIGHTS.accountKey)
  const sam = acct('sam')
  const jordan = acct('jordan')
  const runs = [
    { id: '2026-09-14-064102-011900', timestamp: Date.parse('2026-09-14T06:41:02Z'), status: 'complete', accountEmail: a.email, profileId: a.id, kind: 'account' },
    { id: '2026-09-21-070812-013207', timestamp: Date.parse('2026-09-21T07:08:12Z'), status: 'complete', accountEmail: sam.email, profileId: sam.id, kind: 'account' },
    { id: '2026-09-28-071940-013802', timestamp: Date.parse('2026-09-28T07:19:40Z'), status: 'complete', accountEmail: jordan.email, profileId: jordan.id, kind: 'account' },
    { id: C.INSIGHTS.runId, timestamp: C.INSIGHTS.timestamp, status: 'complete', accountEmail: a.email, profileId: a.id, kind: 'account' },
  ]
  // 2.1.1 (P4.7): a Codex account's report, provider 'codex', its account id as profileId.
  const cx = codexAcct(C.CODEX_INSIGHTS.accountKey)
  if (!cx) throw new Error('[seed] no account ' + C.CODEX_INSIGHTS.accountKey + ' for the Insights run')
  const codexRun = { id: C.CODEX_INSIGHTS.runId, timestamp: C.CODEX_INSIGHTS.timestamp, status: 'complete', provider: 'codex', profileId: cx.accountId }
  // The page opens on the catalogue's last run: keep the primary account's newest Claude report last.
  writeJson(`${dir}/catalogue.json`, { runs: [...runs.slice(0, -1), codexRun, runs[runs.length - 1]] })
  // Older runs reuse the same report so a stray click never lands on an empty page.
  for (const r of runs) {
    writeText(`${dir}/${r.id}/report.html`, C.INSIGHTS.html)
    writeJson(`${dir}/${r.id}/kpis.json`, C.INSIGHTS.kpis)
  }
  writeJson(`${dir}/${codexRun.id}/report.json`, C.CODEX_INSIGHTS.report)
  writeJson(`${dir}/${codexRun.id}/kpis.json`, C.CODEX_INSIGHTS.kpis)
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
  let secret = readJson(secretFile, null)?.secret
  if (!secret) {
    // 2.1.1 makes its install secret lazily (the first session token), so a
    // first start alone leaves none. Mint it as the app does
    // (src/main/install-secret.ts: 32 random bytes as hex, CONDUCTOR_SECRET_VERSION
    // 3), owner-only; the app then loads this one.
    secret = crypto.randomBytes(32).toString('hex')
    mkdirp(CONFIG)
    fs.writeFileSync(secretFile, JSON.stringify({ secret, v: 3 }), { encoding: 'utf8', mode: 0o600 })
    log('conductor-secret.json minted for the staging')
  }
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
  // Each top-level folder is made here (and marked, and recorded so --restore
  // removes it) or was made and marked by an earlier run: checkDevTargets
  // stopped the run before any write when one exists without its mark.
  const made = readJson(DEV_RECORD, [])
  for (const t of S.DEV_TOPS) {
    const top = path.join(DEV, t)
    if (!fs.existsSync(top)) {
      fs.mkdirSync(top, { recursive: true })
      fs.writeFileSync(path.join(top, S.DEV_MARKER), 'made by scripts/readme-shots/stage/seed.js for README screenshots\n', { flag: 'wx' })
      if (!made.includes(top)) made.push(top)
    } else if (!fs.existsSync(path.join(top, S.DEV_MARKER))) {
      throw new Error(`[seed] ${top} lost its mark during the run`)
    }
  }
  writeJson(DEV_RECORD, made)
  // Never overwrite: a file already there (from an earlier run) is kept.
  let written = 0
  for (const [rel, fs_] of Object.entries(files)) {
    for (const [name, body] of Object.entries(fs_)) {
      const file = path.join(DEV, ...rel.split('/'), name)
      if (!S.DEV_TOPS.some((t) => S.inside(file, path.join(DEV, t)))) throw new Error(`[seed] ${file} is not in a project folder of this tool`)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      try { fs.writeFileSync(file, body, { encoding: 'utf8', flag: 'wx' }); written++ } catch (e) { if (e.code !== 'EEXIST') throw e }
    }
  }
  log(`project dirs written: ${written} files (folders made by this tool: ${made.join(', ') || 'none'})`)
}

// -- Codex accounts (2.1.1: the app's account registry) --
// Written by codex-registry.ts through the app's own registry code, bundled
// with this checkout's own esbuild (a devDependency pinned by the lockfile; no
// download at run time) into the runner folder and run with this node.
function seedCodexAccounts() {
  let esbuild
  try { esbuild = require(path.join(REPO, 'node_modules', 'esbuild')) } catch {
    console.error(`refusing: no esbuild in ${REPO}\node_modules (run npm ci in the checkout first)`)
    process.exit(2)
  }
  const out = path.join(RUNNER, 'codex-registry.cjs')
  esbuild.buildSync({ entryPoints: [path.join(__dirname, 'codex-registry.ts')], bundle: true, platform: 'node', format: 'cjs', target: 'node20', outfile: inRoot(out), logLevel: 'silent' })
  const text = execFileSync(process.execPath, [out, RES, path.join(__dirname, 'content.js')], { encoding: 'utf8' })
  log(text.trim())
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
  seedCodexAccounts()
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
