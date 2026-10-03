// README staging: start or stop the INSTALLED app on a seeded staging root
// (WP2 PR 4, P4.11 review C-4). The only way the README pipeline starts the
// app: there is no start on the operator's real environment.
//
//   CCC_STAGE_ROOT=<root> node launch.js start [--port 9335] [--size 1600x1100]
//   CCC_STAGE_ROOT=<root> node launch.js stop
//
// The root must pass stage-root.js's rules and already carry its marker (the
// seed makes it). The app runs with the training tool's isolated launch
// environment (scripts/capture-env.ts, captureLaunchEnv on the staging data
// folder): CCC_E2E_DATA_DIR, USERPROFILE/HOME, LOCALAPPDATA/APPDATA and the
// temp folder inside the root; every PATH folder holding a real claude or
// codex removed and the staging fake CLIs first; CODEX_HOME and
// CLAUDE_CONFIG_DIR removed; Electron's --user-data-dir and the working folder
// inside the root; every child's proxy a dead loopback port (loopback stays
// direct). capture-env.ts is bundled with the checkout's own esbuild (pinned
// by the lockfile). It refuses while any app instance runs. The window is
// sized from the main process over the Node inspector (session 0 clamps a
// renderer resize to its small desktop). `stop` ends only the process tree it
// started (pid, path and start time checked).
'use strict'

const fs = require('fs')
const path = require('path')
const http = require('http')
const { spawn, execFileSync } = require('child_process')
const S = require('./stage-root')

const REPO = path.resolve(__dirname, '..', '..', '..')
const DEAD_PROXY = { HTTPS_PROXY: 'http://127.0.0.1:9', HTTP_PROXY: 'http://127.0.0.1:9', ALL_PROXY: 'http://127.0.0.1:9', NO_PROXY: '127.0.0.1,localhost' }

/** The installed app: CCC_STAGE_APP_EXE, else its default per-user install. */
function installedExe(env) {
  if (env.CCC_STAGE_APP_EXE) return path.resolve(env.CCC_STAGE_APP_EXE)
  const local = env.LOCALAPPDATA || path.join(require('os').homedir(), 'AppData', 'Local')
  return path.join(local, 'Programs', 'AI Code Conductor', 'AI Code Conductor.exe')
}

/**
 * The launch, without starting anything: the staging layout (checked), the
 * exe, its arguments, environment and working folder. `captureLaunchEnv` is
 * capture-env.ts's (passed in, so a test gives the module's own). Throws
 * StageRefusal.
 */
function planLaunch(env, captureLaunchEnv, opts = {}) {
  const stage = S.resolveStage(env)
  S.ensureMarker(stage.ROOT, { create: false })
  const port = opts.port || 9335
  const inspectPort = opts.inspectPort || 9229
  const launchEnv = captureLaunchEnv(stage.DATA, { ...env, ...DEAD_PROXY })
  for (const k of ['USERPROFILE', 'HOME', 'LOCALAPPDATA', 'APPDATA', 'TEMP', 'TMP', 'CCC_E2E_DATA_DIR']) {
    if (!launchEnv[k] || !S.sameOrInside(launchEnv[k], stage.ROOT)) throw new S.StageRefusal(`the launch environment's ${k} is not inside the staging root`)
  }
  const userData = path.join(stage.DATA, 'electron-userdata')
  return {
    stage,
    exe: installedExe(env),
    args: [`--remote-debugging-port=${port}`, `--inspect=${inspectPort}`, `--user-data-dir=${userData}`],
    env: launchEnv,
    cwd: stage.DATA,
    port,
    inspectPort,
  }
}

/** capture-env.ts, bundled with the checkout's esbuild into the runner folder. */
function loadCaptureEnv(stage) {
  let esbuild
  try { esbuild = require(path.join(REPO, 'node_modules', 'esbuild')) } catch { throw new S.StageRefusal(`no esbuild in ${REPO}\\node_modules (run npm ci in the checkout first)`) }
  fs.mkdirSync(stage.RUNNER, { recursive: true })
  const out = path.join(stage.RUNNER, 'capture-env.cjs')
  esbuild.buildSync({ entryPoints: [path.join(REPO, 'scripts', 'capture-env.ts')], bundle: true, platform: 'node', format: 'cjs', target: 'node20', outfile: out, logLevel: 'silent' })
  return require(out).captureLaunchEnv
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const getJson = (url) => new Promise((resolve, reject) => {
  http.get(url, (res) => { let b = ''; res.on('data', (c) => { b += c }); res.on('end', () => { try { resolve(JSON.parse(b)) } catch (e) { reject(e) } }) }).on('error', reject)
})

function appRunning() {
  if (process.platform !== 'win32') return false
  const out = execFileSync('tasklist', ['/fi', 'IMAGENAME eq AI Code Conductor.exe', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true })
  return /AI Code Conductor\.exe/i.test(out)
}

/** The main window resized from the main process (the inspector), as the VM run did. */
async function sizeWindow(inspectPort, w, h) {
  const list = await getJson(`http://127.0.0.1:${inspectPort}/json/list`)
  const ws = new WebSocket(list[0].webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
  const body = `const bw = require("electron").BrowserWindow.getAllWindows().filter(b => b.isVisible()).sort((a, b) => b.getBounds().width - a.getBounds().width)[0]; bw.unmaximize(); bw.setBounds({ x: 0, y: 0, width: ${Number(w)}, height: ${Number(h)} }); return JSON.stringify(bw.getContentBounds())`
  const expr = `(() => { const require = process.mainModule ? process.mainModule.require.bind(process.mainModule) : globalThis.require; ${body} })()`
  const r = await new Promise((resolve) => {
    ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id === 1) resolve(m) })
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, includeCommandLineAPI: true } }))
  })
  ws.close()
  return r.result && r.result.result && r.result.result.value
}

async function start(argv) {
  const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined }
  const stage = S.resolveStage(process.env)
  S.ensureMarker(stage.ROOT, { create: false })
  const plan = planLaunch(process.env, loadCaptureEnv(stage), { port: Number(opt('--port')) || 9335 })
  if (!fs.existsSync(plan.exe)) throw new S.StageRefusal(`no installed app at ${plan.exe}`)
  if (appRunning()) throw new S.StageRefusal('an app instance is already running: one app at a time')
  const startedAt = new Date(Date.now() - 1000).toISOString()
  const child = spawn(plan.exe, plan.args, { env: plan.env, cwd: plan.cwd, detached: true, stdio: 'ignore', windowsHide: false })
  child.unref()
  const rec = { pid: child.pid, port: plan.port, exe: plan.exe, dataDir: plan.stage.DATA, startedAt }
  fs.writeFileSync(S.launchRecordPath(plan.stage), JSON.stringify(rec, null, 2))
  let up = false
  for (let i = 0; i < 60 && !up; i++) { await sleep(1000); try { await getJson(`http://127.0.0.1:${plan.port}/json/version`); up = true } catch { /* not yet */ } }
  console.log(`started pid ${child.pid}; debug port ${plan.port} ${up ? 'up' : 'NOT UP'}; data ${plan.stage.DATA}`)
  const size = (opt('--size') || '1600x1100').split('x').map(Number)
  if (up) {
    await sleep(4000)
    try { console.log('window: ' + (await sizeWindow(plan.inspectPort, size[0], size[1]))) } catch (e) { console.log('window not sized: ' + e.message) }
  }
}

function stop() {
  const stage = S.resolveStage(process.env)
  S.ensureMarker(stage.ROOT, { create: false })
  const rec = S.readLaunchRecord(stage)
  if (process.platform !== 'win32') { try { process.kill(-rec.pid, 'SIGTERM') } catch { /* gone */ } console.log('stopped'); return }
  // The pid must still be the app this launcher started: same exe, started at or after the record.
  const ps = `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${rec.pid}"; if ($p) { $p.ExecutablePath + '|' + $p.CreationDate.ToUniversalTime().ToString('o') }`
  const row = execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8', windowsHide: true }).trim()
  if (!row) { console.log(`pid ${rec.pid} has ended`); return }
  const [exe, created] = row.split('|')
  if (!S.same(exe, rec.exe) || Date.parse(created) < Date.parse(rec.startedAt)) { console.log(`pid ${rec.pid} is another process now: not touched`); return }
  execFileSync('taskkill', ['/T', '/F', '/PID', String(rec.pid)], { stdio: 'ignore', windowsHide: true })
  console.log(`ended the app's tree (pid ${rec.pid})`)
}

module.exports = { planLaunch, installedExe, DEAD_PROXY }

if (require.main === module) {
  const [cmd, ...rest] = process.argv.slice(2)
  Promise.resolve()
    .then(() => (cmd === 'start' ? start(rest) : cmd === 'stop' ? stop() : (console.error('usage: node launch.js start|stop'), process.exit(64))))
    .catch((e) => {
      if (e instanceof S.StageRefusal) { console.error('refusing: ' + e.message); process.exit(2) }
      console.error(e && e.stack ? e.stack : e)
      process.exit(1)
    })
}
