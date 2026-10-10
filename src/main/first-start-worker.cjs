'use strict'
// The worker thread behind the first-start warm-up (ADR-025;
// src/main/first-start-warmup.ts reads this file's text and runs it as a
// worker thread, so nothing here is loaded from the app archive at run time).
//
// On Windows the first start of a newly written program can hold the start
// call (CreateProcess) for seconds while the OS checks the new program; later
// starts of the same file are fast. That wait holds THIS thread, never the
// main process's event loop.
//
// One request, from the main process only (first-start-warmup.ts builds it;
// nothing from a renderer reaches it): start `file` with `args` (main sends
// the fixed `--version`), with exactly the environment given and nothing
// inherited, in `cwd`, no shell, stdin ignored, stdout read up to `maxOutput`
// characters and the rest dropped, stderr ignored. At `timeoutMs` the process
// is ended, and the worker answers once it has exited or `killGraceMs` later.
// It answers exactly once: { exitCode, timedOut, spawnError?, startMs?,
// stdout }. A 'stop' message (the app is quitting) ends the process now.
//
// `state` (when the main process could share memory) tells the main process
// where the run is, so a quit can wait, bounded, for the process to be ended:
// 0 not started, 1 starting or running, 2 answered or ended, 3 stopped before
// it started (set by the main process; the program is then never started).
const { workerData, parentPort } = require('node:worker_threads')
const { spawn } = require('node:child_process')

;(function firstStart() {
  const req = workerData && typeof workerData === 'object' && workerData.request && typeof workerData.request === 'object' ? workerData.request : null
  const state = workerData && workerData.state instanceof Int32Array ? workerData.state : null
  let child = null
  let settled = false
  let timedOut = false
  let exited = false
  let timer = null
  let grace = null
  let closeWait = null
  let startMs
  let stdout = ''

  const mark = (v) => {
    if (!state) return
    try { Atomics.store(state, 0, v); Atomics.notify(state, 0) } catch { /* the main process does not wait then */ }
  }
  const running = () => !!child && child.exitCode === null && child.signalCode === null
  const end = () => {
    if (!running()) return
    try { child.kill() } catch { /* already gone */ }
  }
  const answer = (r) => {
    if (settled) return
    settled = true
    for (const t of [timer, grace, closeWait]) if (t) clearTimeout(t)
    try { if (child && child.stdout) child.stdout.destroy() } catch { /* already closed */ }
    mark(2)
    const out = { exitCode: null, timedOut: false, stdout }
    if (typeof startMs === 'number') out.startMs = startMs
    try { parentPort.postMessage(Object.assign(out, r)) } catch { /* the main process has gone */ }
    try { parentPort.close() } catch { /* already closed */ }
  }
  const code = (e) => (e && typeof e.code === 'string' && /^[A-Z0-9_]{1,40}$/.test(e.code) ? e.code : 'spawn-failed')

  parentPort.on('message', (m) => {
    if (m !== 'stop') return
    end()
    mark(2)
  })

  const strings = (a) => Array.isArray(a) && a.every((s) => typeof s === 'string')
  if (!req || typeof req.file !== 'string' || !req.file || !strings(req.args) || typeof req.cwd !== 'string' || !req.cwd
    || !req.env || typeof req.env !== 'object'
    || !Number.isFinite(req.timeoutMs) || req.timeoutMs < 1 || !Number.isFinite(req.killGraceMs) || req.killGraceMs < 0
    || !Number.isFinite(req.maxOutput) || req.maxOutput < 0) {
    answer({ spawnError: 'invalid-request' })
    return
  }
  // The main process may have stopped this run before it started.
  if (state && Atomics.compareExchange(state, 0, 0, 1) !== 0) {
    answer({ spawnError: 'stopped' })
    return
  }
  // A prototype-free copy of exactly the given variables: spawn walks
  // inherited keys, so nothing but these reaches the program.
  const env = Object.create(null)
  for (const k of Object.keys(req.env)) if (typeof req.env[k] === 'string') env[k] = req.env[k]
  const t0 = performance.now()
  try {
    child = spawn(req.file, req.args.slice(), {
      cwd: req.cwd,
      env,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      windowsVerbatimArguments: false,
      shell: false,
    })
  } catch (e) {
    startMs = performance.now() - t0
    answer({ spawnError: code(e) })
    return
  }
  startMs = performance.now() - t0
  if (child.stdout) {
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      const room = req.maxOutput - stdout.length
      if (room > 0) stdout += String(chunk).slice(0, room)
    })
    child.stdout.on('error', () => { /* the exit answers */ })
  }
  child.on('error', (e) => answer({ timedOut, spawnError: code(e) }))
  child.on('exit', (c) => {
    exited = true
    // The output is read until the pipe closes; something the program started
    // that holds it open does not hold the answer for long.
    closeWait = setTimeout(() => answer({ exitCode: timedOut ? null : (typeof c === 'number' ? c : null), timedOut }), 500)
    child.once('close', () => answer({ exitCode: timedOut ? null : (typeof c === 'number' ? c : null), timedOut }))
  })
  timer = setTimeout(() => {
    timer = null
    if (exited) return
    timedOut = true
    end()
    grace = setTimeout(() => answer({ timedOut: true }), req.killGraceMs)
  }, req.timeoutMs)
})()
