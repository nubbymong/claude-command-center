// README staging: the ONE throwaway staging root every staging script works in
// (WP2 PR 4, P4.11 review C-1, C-2, C-6). Plain CommonJS with no dependencies:
// seed.js, launch.js and shoot.js require it, and the unit suite reads it
// directly (tests/unit/scripts/readme-stage.test.ts).
//
// The rules, all checked before anything is written, renamed or deleted, and
// failing closed (a StageRefusal; the scripts exit 2):
//  - CCC_STAGE_ROOT names the root. It is a real folder (no link anywhere on
//    its path), and it carries this tool's marker file: the seed makes the
//    marker only in a folder that is absent or empty, so a folder with other
//    content is never taken as a root.
//  - The root is never the real home, nor a folder holding it, nor inside the
//    real ~/.claude or ~/.codex, the app data folders under %LOCALAPPDATA% and
//    %APPDATA% (the app's, the npm prefix, Anthropic's), the installed app's
//    data or resources folder (as the installer recorded them in the
//    registry), or C:\dev.
//  - Every other CCC_STAGE_* folder is inside the root (default: the layout
//    the training tool's launch environment uses, capture-env.ts), with no
//    link between the root and it.
//  - The project folders the fictional configs name live under C:\dev (or
//    CCC_STAGE_DEV, inside the root). The seed makes only folders that do not
//    exist yet, marks each one, records it, and never overwrites a file; a
//    folder that exists without its mark stops the run. --restore removes only
//    recorded entries that are still exactly one of those marked folders.
'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')

const MARKER = '.ccc-readme-stage'
const MARKER_TEXT = 'ccc-readme-stage v1: a throwaway staging root made by scripts/readme-shots/stage. Safe to delete.\n'
const DEV_MARKER = '.ccc-readme-stage-project'
/** The top-level project folders the fictional configs name (content.js). */
const DEV_TOPS = Object.freeze(['web', 'platform', 'data', 'notes'])
const REAL_DEV = 'C:\\dev'

class StageRefusal extends Error {}
const refuse = (msg) => { throw new StageRefusal(msg) }

const isWin = (platform) => platform === 'win32'
function pathApi(platform) { return isWin(platform) ? path.win32 : path.posix }
/** A comparable spelling: resolved, no trailing separator, case-folded on
 *  Windows (an overlap check that errs refuses, never allows). */
function cmp(p, platform) {
  const P = pathApi(platform)
  let s = P.resolve(p)
  while (s.length > P.parse(s).root.length && /[\\/]$/.test(s)) s = s.slice(0, -1)
  return isWin(platform) ? s.toLowerCase() : s
}
function inside(child, parent, platform = process.platform) {
  const P = pathApi(platform)
  const rel = P.relative(cmp(parent, platform), cmp(child, platform))
  return rel !== '' && !rel.startsWith('..') && !P.isAbsolute(rel)
}
const same = (a, b, platform = process.platform) => cmp(a, platform) === cmp(b, platform)
const sameOrInside = (a, b, platform = process.platform) => same(a, b, platform) || inside(a, b, platform)

/** A link (symbolic link or junction) at `p`, if `p` exists. */
function isLink(p) {
  let st
  try { st = fs.lstatSync(p) } catch { return false }
  if (st.isSymbolicLink()) return true
  if (st.isDirectory()) { try { fs.readlinkSync(p); return true } catch { return false } }
  return false
}

/** No link on the path from the drive root down to `p` (the parts that exist). */
function noLinkOnPath(p, platform = process.platform) {
  const P = pathApi(platform)
  const abs = P.resolve(p)
  const root = P.parse(abs).root
  let cur = root
  for (const part of abs.slice(root.length).split(/[\\/]/).filter(Boolean)) {
    cur = P.join(cur, part)
    if (!fs.existsSync(cur)) return true
    if (isLink(cur)) return false
  }
  return true
}

/** The installed app's data and resources folders as its installer recorded
 *  them (HKCU), on Windows; empty elsewhere or when unrecorded. */
function registryFolders(platform = process.platform) {
  if (!isWin(platform)) return []
  const out = []
  for (const key of ['HKCU\\Software\\AI Code Conductor', 'HKCU\\Software\\Claude Command Center', 'HKCU\\Software\\Claude Conductor']) {
    for (const name of ['DataDirectory', 'ResourcesDirectory']) {
      try {
        const text = execFileSync('reg', ['query', key, '/v', name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: 5000 })
        const m = text.match(new RegExp(`${name}\\s+REG_(?:EXPAND_)?SZ\\s+(.+)`))
        if (m && m[1].trim()) out.push(m[1].trim())
      } catch { /* not recorded */ }
    }
  }
  return out
}

/** The real folders a staging root must keep clear of. `env` is the
 *  operator's environment; the real home also comes from the account itself
 *  (os.userInfo), which no variable can redirect. */
function protectedFolders(env = process.env, platform = process.platform, deps = {}) {
  const P = pathApi(platform)
  const homes = new Set()
  const add = (s, v) => { if (typeof v === 'string' && v && P.isAbsolute(v)) s.add(P.resolve(v)) }
  add(homes, (deps.userHome || (() => { try { return os.userInfo().homedir } catch { return '' } }))())
  add(homes, (deps.osHome || os.homedir)())
  for (const k of ['USERPROFILE', 'HOME']) add(homes, env[k])
  const appRoots = new Set()
  for (const h of homes) { add(appRoots, P.join(h, 'AppData', 'Local')); add(appRoots, P.join(h, 'AppData', 'Roaming')) }
  for (const k of ['LOCALAPPDATA', 'APPDATA']) add(appRoots, env[k])
  const within = new Set() // the root may not be in any of these
  for (const h of homes) for (const d of ['.claude', '.codex', '.config/ai-code-conductor', '.ai-code-conductor', '.claude-conductor', 'Library/Application Support/AI Code Conductor', 'Library/Application Support/Claude Conductor']) add(within, P.join(h, d))
  for (const a of appRoots) {
    for (const d of ['AI Code Conductor', 'Claude Command Center', 'Claude Conductor', 'ai-code-conductor', 'claude-conductor', 'npm', 'Anthropic', P.join('Programs', 'AI Code Conductor')]) add(within, P.join(a, d))
  }
  for (const f of (deps.registryFolders || registryFolders)(platform)) add(within, f)
  if (isWin(platform)) add(within, REAL_DEV)
  return { homes: [...homes], appRoots: [...appRoots], within: [...within] }
}

/** A UNC (`\\server\share`) or device (`\\?\`, `\\.\`) spelling, on Windows. */
const uncOrDevice = (p, platform) => isWin(platform) && /^[\\/]{2}/.test(String(p))

/** `p` as the file system names it (P4.11 review V-1): the real path of its
 *  deepest existing ancestor (fs.realpathSync.native resolves 8.3 short
 *  names, subst drives and drives mapped to a share), with the parts that do
 *  not exist yet joined on. A spelling the overlap checks would otherwise
 *  miss (C:\Users\NICHOL~1\.codex, S:\.codex for a subst onto the home)
 *  becomes the folder it is. */
function canonicalPath(p, platform = process.platform, deps = {}) {
  const P = pathApi(platform)
  const exists = deps.exists || fs.existsSync
  const real = deps.realpath || ((x) => fs.realpathSync.native(x))
  let cur = P.resolve(p)
  const rest = []
  for (;;) {
    if (exists(cur)) {
      let r = cur
      try { r = real(cur) } catch { /* unreadable: keep the spelling */ }
      return rest.length ? P.join(r, ...rest.reverse()) : r
    }
    const parent = P.dirname(cur)
    if (parent === cur) return P.resolve(p)
    rest.push(P.basename(cur))
    cur = parent
  }
}

/** Resolve the staging layout from `env` and check every rule except the
 *  marker. Throws StageRefusal. Pure apart from reading the file system. */
function resolveStage(env = process.env, platform = process.platform, deps = {}) {
  const P = pathApi(platform)
  const raw = env.CCC_STAGE_ROOT
  if (typeof raw !== 'string' || !raw || !P.isAbsolute(raw)) refuse('CCC_STAGE_ROOT must name the staging root (an absolute path)')
  if (uncOrDevice(raw, platform)) refuse(`the staging root ${raw} is a UNC or device path: give a local folder`)
  const ROOT = P.resolve(raw)
  if (same(ROOT, P.parse(ROOT).root, platform)) refuse(`the staging root ${ROOT} is a drive root`)
  if (!(deps.noLinkOnPath || noLinkOnPath)(ROOT, platform)) refuse(`the staging root ${ROOT} has a link on its path`)
  // V-1: every check on both spellings, the given one and the real path, of
  // the root and of each protected folder.
  const canon = (p) => canonicalPath(p, platform, deps)
  const REAL_ROOT = canon(ROOT)
  if (uncOrDevice(REAL_ROOT, platform)) refuse(`the staging root ${ROOT} is on a UNC or device path (${REAL_ROOT}): give a local folder`)
  if (same(REAL_ROOT, P.parse(REAL_ROOT).root, platform)) refuse(`the staging root ${ROOT} is a drive root (${REAL_ROOT})`)
  const roots = [ROOT, REAL_ROOT]
  const both = (list) => list.flatMap((x) => [x, canon(x)])
  const prot = protectedFolders(env, platform, deps)
  for (const h of both(prot.homes)) for (const r of roots) if (sameOrInside(h, r, platform)) refuse(`the staging root ${ROOT} is or holds the home folder ${h}`)
  for (const a of both(prot.appRoots)) for (const r of roots) if (sameOrInside(a, r, platform)) refuse(`the staging root ${ROOT} is or holds the app data folder ${a}`)
  for (const w of both(prot.within)) for (const r of roots) if (sameOrInside(r, w, platform) || inside(w, r, platform)) refuse(`the staging root ${ROOT} overlaps ${w}`)

  const sub = (name, fallback) => {
    const v = env[name]
    const p = v ? P.resolve(v) : fallback
    if (v && !P.isAbsolute(v)) refuse(`${name} must be an absolute path`)
    if (v && uncOrDevice(v, platform)) refuse(`${name} (${v}) is a UNC or device path`)
    if (!inside(p, ROOT, platform)) refuse(`${name} (${p}) is not inside the staging root ${ROOT}`)
    if (!inside(canon(p), REAL_ROOT, platform)) refuse(`${name} (${p}) is not inside the staging root ${ROOT} by its real path`)
    if (!(deps.noLinkOnPath || noLinkOnPath)(p, platform)) refuse(`${name} (${p}) has a link on its path`)
    return p
  }
  const DATA = sub('CCC_STAGE_DATA', P.join(ROOT, 'data'))
  const stage = {
    ROOT,
    DATA,
    RES: sub('CCC_STAGE_RES', P.join(DATA, 'resources')),
    // The training tool's launch layout (capture-env.ts): home and fake CLIs in the data root.
    HOME: sub('CCC_STAGE_HOME', P.join(DATA, 'home')),
    NPM_BIN: sub('CCC_STAGE_NPM_BIN', P.join(DATA, 'fake-bin')),
    RUNNER: sub('CCC_STAGE_RUNNER', P.join(ROOT, 'runner')),
    DEV: env.CCC_STAGE_DEV ? sub('CCC_STAGE_DEV', '') : (isWin(platform) ? REAL_DEV : P.join(ROOT, 'dev')),
  }
  return stage
}

/** The marker: made only in a root that is absent or empty (`create`), else
 *  it must already be there with this tool's text. */
function ensureMarker(ROOT, { create }) {
  const m = path.join(ROOT, MARKER)
  let st = null
  try { st = fs.lstatSync(ROOT) } catch { /* absent */ }
  if (st && (!st.isDirectory() || isLink(ROOT))) refuse(`the staging root ${ROOT} is not a plain folder`)
  if (st) {
    let text = null
    try { text = fs.readFileSync(m, 'utf8') } catch { /* none */ }
    if (text !== null) {
      if (!text.startsWith('ccc-readme-stage v1')) refuse(`${m} is not this tool's marker`)
      return 'present'
    }
    if (!create) refuse(`the staging root ${ROOT} has no staging marker (run the seed first)`)
    if (fs.readdirSync(ROOT).length) refuse(`${ROOT} is not empty and has no staging marker: not a staging root of this tool`)
  } else if (!create) {
    refuse(`the staging root ${ROOT} does not exist`)
  }
  fs.mkdirSync(ROOT, { recursive: true })
  fs.writeFileSync(m, MARKER_TEXT, { flag: 'wx' })
  return 'made'
}

/** Before the seed writes anything: each project folder it would make under
 *  DEV is either absent or one this tool made (marked). */
function checkDevTargets(DEV) {
  if (isLink(DEV) || !noLinkOnPath(DEV)) refuse(`the projects folder ${DEV} has a link on its path`)
  for (const t of DEV_TOPS) {
    const p = path.join(DEV, t)
    if (!fs.existsSync(p)) continue
    if (isLink(p) || !fs.lstatSync(p).isDirectory() || !fs.existsSync(path.join(p, DEV_MARKER))) {
      refuse(`${p} already exists and was not made by this tool: refusing to write into it`)
    }
  }
}

/** A recorded project folder still safe to remove: an absolute path that is
 *  exactly DEV\<one of DEV_TOPS>, a plain folder, and marked by this tool. */
function validDevEntry(entry, DEV, platform = process.platform) {
  const P = pathApi(platform)
  if (typeof entry !== 'string' || !entry || !P.isAbsolute(entry)) return false
  const abs = P.resolve(entry)
  if (same(abs, P.parse(abs).root, platform)) return false
  if (!same(P.dirname(abs), DEV, platform)) return false
  if (!DEV_TOPS.includes(P.basename(abs).toLowerCase())) return false
  if (isLink(abs)) return false
  try { if (!fs.lstatSync(abs).isDirectory()) return false } catch { return false }
  return fs.existsSync(P.join(abs, DEV_MARKER))
}

/** Remove `p` without ever entering a link (a link is removed as a link). */
function removeNoFollow(p) {
  let st
  try { st = fs.lstatSync(p) } catch { return }
  if (isLink(p)) { try { fs.unlinkSync(p) } catch { fs.rmdirSync(p) } return }
  if (st.isDirectory()) {
    for (const n of fs.readdirSync(p)) removeNoFollow(path.join(p, n))
    fs.rmdirSync(p)
    return
  }
  try { fs.unlinkSync(p) } catch { fs.chmodSync(p, 0o666); fs.unlinkSync(p) }
}

/** The launch record launch.js writes and shoot.js attaches by. */
function launchRecordPath(stage) { return path.join(stage.RUNNER, 'launch.json') }
function readLaunchRecord(stage) {
  let rec
  try { rec = JSON.parse(fs.readFileSync(launchRecordPath(stage), 'utf8')) } catch { refuse('no launch record: start the app with launch.js first') }
  if (!rec || !Number.isInteger(rec.port) || rec.port <= 0 || !Number.isInteger(rec.pid)) refuse('the launch record is not readable')
  if (typeof rec.dataDir !== 'string' || !same(rec.dataDir, stage.DATA)) refuse('the launch record names another data folder')
  return rec
}

/** Where shoot.js writes its images and log: <root>/out and <root>/shoot.log,
 *  or CCC_SHOOT_OUT / CCC_SHOOT_LOG, which must be inside the root too. */
function shootPaths(stage, env = process.env) {
  const pick = (name, fallback) => {
    const v = env[name]
    if (!v) return fallback
    if (!path.isAbsolute(v)) refuse(`${name} must be an absolute path`)
    const p = path.resolve(v)
    if (!inside(p, stage.ROOT) || !inside(canonicalPath(p), canonicalPath(stage.ROOT))) refuse(`${name} (${p}) is not inside the staging root ${stage.ROOT}`)
    if (!noLinkOnPath(p)) refuse(`${name} (${p}) has a link on its path`)
    return p
  }
  return { OUT: pick('CCC_SHOOT_OUT', path.join(stage.ROOT, 'out')), LOG: pick('CCC_SHOOT_LOG', path.join(stage.ROOT, 'shoot.log')) }
}

const runCmd = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: 20000 })

/** What process `pid` is now: its executable (Windows) or command line
 *  (ps on macOS and Linux) and its start time; null when it is gone. */
function processIdentity(pid, platform = process.platform, exec = runCmd) {
  const n = Number(pid)
  if (!Number.isInteger(n) || n <= 0) return null
  try {
    if (isWin(platform)) {
      const row = String(exec('powershell.exe', ['-NoProfile', '-Command', `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${n}"; if ($p) { $p.ExecutablePath + '|' + $p.CreationDate.ToUniversalTime().ToString('o') }`])).trim()
      const i = row.lastIndexOf('|')
      if (i <= 0) return null
      const startedAt = Date.parse(row.slice(i + 1))
      return Number.isFinite(startedAt) ? { command: row.slice(0, i), startedAt } : null
    }
    // ps -o lstart: "Sat Oct  3 11:00:03 2026" (local time, whole seconds), then the command line.
    const row = String(exec('ps', ['-p', String(n), '-o', 'lstart=', '-o', 'command='])).trim()
    const m = row.match(/^(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/)
    if (!m) return null
    const startedAt = Date.parse(m[1].replace(/\s+/g, ' '))
    return Number.isFinite(startedAt) ? { command: m[2], startedAt } : null
  } catch {
    return null
  }
}

/** The process is the one launch.js recorded: the recorded executable (the
 *  command's start on macOS and Linux), started no earlier than the record
 *  (ps rounds to whole seconds). */
function isRecordedProcess(rec, ident, platform = process.platform) {
  if (!rec || !ident || !Number.isFinite(ident.startedAt) || typeof rec.exe !== 'string') return false
  const since = Date.parse(rec.startedAt)
  if (!Number.isFinite(since) || ident.startedAt < since - 2000) return false
  return isWin(platform) ? same(ident.command, rec.exe, platform) : ident.command === rec.exe || ident.command.startsWith(rec.exe + ' ')
}

/** The pid listening on `port` on the loopback, or null. */
function portOwnerPid(port, platform = process.platform, exec = runCmd) {
  const n = Number(port)
  try {
    const out = isWin(platform)
      ? String(exec('powershell.exe', ['-NoProfile', '-Command', `(Get-NetTCPConnection -State Listen -LocalPort ${n} -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess`]))
      : String(exec('lsof', ['-nP', `-iTCP:${n}`, '-sTCP:LISTEN', '-t']))
    const pid = Number(out.trim().split(/\s+/)[0])
    return Number.isInteger(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

/** Before shoot.js attaches: the recorded app is still the process launch.js
 *  started, and it is what holds the recorded debug port. */
function checkLaunchedApp(rec, deps = {}) {
  const platform = deps.platform || process.platform
  const exec = deps.exec || runCmd
  if (!isRecordedProcess(rec, processIdentity(rec.pid, platform, exec), platform)) refuse(`the recorded app (pid ${rec.pid}) is not running any more: start it with launch.js`)
  const owner = portOwnerPid(rec.port, platform, exec)
  if (owner !== rec.pid) refuse(`port ${rec.port} is not held by the recorded app (pid ${rec.pid}; held by ${owner === null ? 'nothing' : 'pid ' + owner})`)
}

module.exports = {
  canonicalPath, shootPaths, processIdentity, isRecordedProcess, portOwnerPid, checkLaunchedApp,
  MARKER, MARKER_TEXT, DEV_MARKER, DEV_TOPS, REAL_DEV, StageRefusal,
  inside, same, sameOrInside, isLink, noLinkOnPath, protectedFolders, registryFolders,
  resolveStage, ensureMarker, checkDevTargets, validDevEntry, removeNoFollow, launchRecordPath, readLaunchRecord,
}
