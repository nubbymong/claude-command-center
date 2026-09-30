#!/usr/bin/env node
// AI Code Conductor -- Codex hook forwarder (P3.10).
//
// Codex runs this as a command hook (the app gives every Codex launch the same
// hooks through `-c`; providers/codex/hooks.ts): the event's JSON arrives on
// stdin, and this posts it to the app's loopback Hooks gateway for the session
// that started Codex, the way a Claude Code http hook posts to it.
//
// It trusts nothing it is given:
//  - the session is named by the environment Codex passes down
//    (CLAUDE_MULTI_SESSION_ID) and the hook file the app wrote for that launch
//    (CCC_CODEX_HOOK_FILE), laid out as the app makes it:
//    `<app data folder>/codex-hooks/ccc-codex-hook-<random>/hook.json`. Its
//    real path must be that very path below the app data folder's real path
//    (no link or junction at any level the app made, P3.10 round 1), and it
//    must be a small plain file with one name, opened without following a
//    link and still the file looked at; its session id must be the same, its
//    port and token the right shape;
//  - the body is sent as read, at most 4 MiB (the gateway's own cap), and only
//    to 127.0.0.1, never through a proxy the environment names (round 1: Node
//    honours HTTP_PROXY when NODE_USE_ENV_PROXY is set, with no loopback
//    exception, so the request uses no shared agent);
//  - it writes nothing to stdout or stderr (Codex would read stdout as the
//    hook's answer), never waits more than a few seconds, and always exits 0.
// With no hook file (Codex run outside the app with this hook trusted) it does
// nothing.

'use strict'

const fs = require('fs')
const path = require('path')
const http = require('http')

const MAX_BODY_BYTES = 4 * 1024 * 1024
const MAX_FILE_BYTES = 4096
const POST_TIMEOUT_MS = 2000
const DEADLINE_MS = 4000
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/
const TOKEN_RE = /^[A-Za-z0-9-]{16,256}$/
const DIR_PREFIX = 'ccc-codex-hook-'
const FILE_NAME = 'hook.json'
/** The folder in the app's data folder that holds the hook folders
 *  (providers/codex/hooks.ts CODEX_HOOK_ROOT_NAME). */
const ROOT_NAME = 'codex-hooks'
const READ_NO_FOLLOW = fs.constants.O_RDONLY | (typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0)

/** Two paths as the platform's file system compares them. */
function samePath(a, b, platform) {
  const fold = platform === 'win32' || platform === 'darwin'
  return fold ? a.toLowerCase() === b.toLowerCase() : a === b
}

/** The file's real path is the path the app made: the app data folder's real
 *  path, then `codex-hooks`, the hook folder and `hook.json`, so nothing the
 *  app made on the way is a link or a junction, and the file is inside that
 *  folder. */
function laidOutAsMade(file, platform) {
  const dir = path.dirname(file)
  const root = path.dirname(dir)
  const appDir = path.dirname(root)
  if (!path.basename(dir).startsWith(DIR_PREFIX) || path.basename(root) !== ROOT_NAME) return false
  if (!appDir || appDir === root) return false
  let realFile
  let realApp
  try {
    realFile = fs.realpathSync.native(file)
    realApp = fs.realpathSync.native(appDir)
  } catch {
    return false
  }
  return samePath(realFile, path.join(realApp, ROOT_NAME, path.basename(dir), FILE_NAME), platform)
}

/** The session's hook file, checked, or null. */
function readHookFile(env, platform) {
  const plat = platform || process.platform
  const file = env.CCC_CODEX_HOOK_FILE
  const sid = env.CLAUDE_MULTI_SESSION_ID
  if (typeof file !== 'string' || typeof sid !== 'string' || !SESSION_ID_RE.test(sid)) return null
  if (!path.isAbsolute(file) || path.basename(file) !== FILE_NAME) return null
  if (!laidOutAsMade(file, plat)) return null
  let st
  try { st = fs.lstatSync(file) } catch { return null }
  if (!st.isFile() || st.nlink !== 1 || st.size > MAX_FILE_BYTES) return null
  let text
  let fd = null
  try {
    fd = fs.openSync(file, READ_NO_FOLLOW)
    const opened = fs.fstatSync(fd)
    // Still the file looked at (not one put in its place since).
    if (!opened.isFile() || opened.dev !== st.dev || opened.ino !== st.ino || opened.nlink !== 1 || opened.size > MAX_FILE_BYTES) return null
    const buf = Buffer.alloc(opened.size)
    const n = opened.size > 0 ? fs.readSync(fd, buf, 0, opened.size, 0) : 0
    text = buf.subarray(0, n).toString('utf8')
  } catch {
    return null
  } finally {
    if (fd !== null) { try { fs.closeSync(fd) } catch { /* closed */ } }
  }
  let j
  try { j = JSON.parse(text) } catch { return null }
  if (!j || typeof j !== 'object' || j.v !== 1) return null
  if (!Number.isInteger(j.port) || j.port < 1 || j.port > 65535) return null
  if (typeof j.sid !== 'string' || j.sid !== sid) return null
  if (typeof j.token !== 'string' || !TOKEN_RE.test(j.token)) return null
  return { port: j.port, sid: j.sid, token: j.token }
}

/** The request's options: 127.0.0.1 itself, and no agent (`agent: false`
 *  takes a fresh connection outside the shared agent, which is where Node's
 *  environment proxy support lives). */
function requestOptions(cfg, body) {
  return {
    host: '127.0.0.1',
    port: cfg.port,
    path: `/hook/${cfg.sid}`,
    method: 'POST',
    agent: false,
    headers: {
      'content-type': 'application/json',
      'content-length': body.length,
      'x-ccc-hook-token': cfg.token,
      'x-ccc-hook-client': 'codex',
      connection: 'close',
    },
    timeout: POST_TIMEOUT_MS,
  }
}

/** Post `body` to the gateway for `cfg`; `done` is called once, whatever happens. */
function forward(cfg, body, done, request) {
  let finished = false
  const end = () => { if (!finished) { finished = true; done() } }
  try {
    const req = (request || http.request)(requestOptions(cfg, body), (res) => {
      res.on('error', end)
      res.on('end', end)
      res.resume()
    })
    req.on('error', end)
    req.on('timeout', () => { try { req.destroy() } catch { /* gone */ } end() })
    req.end(body)
  } catch {
    end()
  }
}

/** Read stdin to its end, at most MAX_BODY_BYTES; `onBody` gets the bytes, or
 *  null when there were more. */
function readBody(stream, onBody) {
  const chunks = []
  let total = 0
  let over = false
  let settled = false
  const settle = (v) => { if (!settled) { settled = true; onBody(v) } }
  stream.on('data', (c) => {
    if (over) return
    total += c.length
    if (total > MAX_BODY_BYTES) { over = true; settle(null); return }
    chunks.push(c)
  })
  stream.on('end', () => settle(over ? null : Buffer.concat(chunks)))
  stream.on('error', () => settle(null))
}

function main() {
  const quit = () => process.exit(0)
  process.on('uncaughtException', quit)
  setTimeout(quit, DEADLINE_MS)
  const cfg = readHookFile(process.env)
  if (!cfg) return quit()
  readBody(process.stdin, (body) => {
    if (!body || body.length === 0) return quit()
    forward(cfg, body, quit)
  })
}

if (require.main === module) main()

module.exports = { readHookFile, forward, readBody, requestOptions, MAX_BODY_BYTES, MAX_FILE_BYTES, ROOT_NAME }
