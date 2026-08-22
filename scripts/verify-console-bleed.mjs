#!/usr/bin/env node
/**
 * The 30-second verification from issue #379, made runnable.
 *
 * WHY THIS IS A SCRIPT AND NOT A TEST. It needs a real Windows GUI-subsystem
 * executable — one that does `AttachConsole(ATTACH_PARENT_PROCESS)` +
 * `freopen("CONOUT$")`. CI has no such binary, we are not going to ship one, and
 * the interesting half of the result ("did text land on the terminal frame?") is
 * only observable by a human looking at the terminal. So the automated tests
 * cover the parsing, the routing and the gate; this covers the mechanism, on the
 * one machine that has the tool.
 *
 * USAGE (from a real terminal, so there IS a console to bleed into):
 *
 *     node scripts/verify-console-bleed.mjs "C:\\path\\to\\bambu-studio.exe" --debug 2 --zzz-not-a-flag
 *
 * It runs the tool twice and prints both results:
 *
 *   1. DIRECT — spawned by this process, which has your terminal's console.
 *      EXPECT: 0 bytes captured, and the tool's banner smeared across your
 *      terminal. That is the bug.
 *
 *   2. CONSOLE-LESS — spawned by a helper process that has no console, which is
 *      the situation Electron's main process is always in.
 *      EXPECT: several KB captured (~5621 for the worked example) and a clean
 *      terminal. That is the fix.
 *
 * Exit code 0xFFFFFFFE (4294967294) from the tool is expected for the bad-flag
 * argument above, and is a useful non-zero-exit case — the point is the BYTES,
 * not the code.
 *
 * A NOTE ON `detached: true`, which #379 says is never a fix: that is right, and
 * it is not being used as one. Step 2 uses DETACHED_PROCESS on the HELPER to
 * manufacture a parent with no console — it is how the console-less parent is
 * created for the demonstration, not how the GUI tool is launched. The tool
 * itself is spawned by that helper with `detached: false` and pipes, exactly as
 * `src/main/gui-exe-runner.ts` does it.
 */
import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { readPeSubsystem } from './lib/pe-subsystem-lite.mjs'

const SELF = fileURLToPath(import.meta.url)

/** Spawn the tool with pipes and count what actually arrives. */
function captureRun(exe, args) {
  return new Promise((resolve) => {
    let bytes = 0
    let text = ''
    const child = spawn(exe, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: false,
      shell: false,
    })
    const take = (buf) => { bytes += buf.length; if (text.length < 400) text += buf.toString('utf8') }
    child.stdout?.on('data', take)
    child.stderr?.on('data', take)
    child.on('error', (err) => resolve({ bytes: 0, code: null, error: err.message, sample: '' }))
    child.on('close', (code) => resolve({ bytes, code, sample: text.slice(0, 400) }))
  })
}

// ---- inner mode: we are the console-less helper -----------------------------
const argv = process.argv.slice(2)
const innerAt = argv.indexOf('--inner')
if (innerAt !== -1) {
  const outFile = argv[innerAt + 1]
  const [exe, ...args] = argv.slice(innerAt + 2)
  const result = await captureRun(exe, args)
  fs.writeFileSync(outFile, JSON.stringify(result), 'utf8')
  process.exit(0)
}

// ---- outer mode -------------------------------------------------------------
const [exe, ...args] = argv
if (!exe) {
  console.error('usage: node scripts/verify-console-bleed.mjs <exe> [args...]')
  process.exit(2)
}
if (process.platform !== 'win32') {
  console.error('This verification only means anything on Windows.')
  process.exit(2)
}
if (!fs.existsSync(exe)) {
  console.error(`No such file: ${exe}`)
  process.exit(2)
}

// 0. The sniffer, against a real binary.
const head = Buffer.alloc(4096)
const fd = fs.openSync(exe, 'r')
const read = fs.readSync(fd, head, 0, head.length, 0)
fs.closeSync(fd)
const subsystem = readPeSubsystem(head.subarray(0, read))
const name = subsystem === 2 ? 'GUI (2)' : subsystem === 3 ? 'console (3)' : `${subsystem ?? 'not a PE'}`
console.log(`\nPE subsystem: ${name}`)
if (subsystem !== 2) {
  console.log('Not a GUI-subsystem image, so there is no bleed to demonstrate. Pick a Subsystem=2 exe.')
  process.exit(0)
}

// 1. Direct: this process has the terminal's console.
console.log('\n--- 1. DIRECT (parent HAS a console) ------------------------------')
const direct = await captureRun(exe, args)
console.log(`captured: ${direct.bytes} bytes   exit: ${direct.code}`)
console.log(direct.bytes === 0
  ? 'EXPECTED: 0 bytes, and the banner is now smeared over your terminal. This is the bug.'
  : `UNEXPECTED: this tool did not do the AttachConsole dance (${direct.bytes} bytes captured).`)

// 2. Console-less helper.
console.log('\n--- 2. CONSOLE-LESS (parent has NO console) -----------------------')
const outFile = path.join(os.tmpdir(), `ccc-379-${Date.now()}.json`)
await new Promise((resolve) => {
  const helper = spawn(process.execPath, [SELF, '--inner', outFile, exe, ...args], {
    // DETACHED_PROCESS: the helper gets NO console, which is the only thing
    // being manufactured here. See the header note.
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  helper.on('close', resolve)
  helper.on('error', resolve)
  helper.unref?.()
})

for (let i = 0; i < 300 && !fs.existsSync(outFile); i++) {
  await new Promise((r) => setTimeout(r, 100))
}
if (!fs.existsSync(outFile)) {
  console.log('helper produced no result (timed out).')
  process.exit(1)
}
const viaHelper = JSON.parse(fs.readFileSync(outFile, 'utf8'))
fs.unlinkSync(outFile)
console.log(`captured: ${viaHelper.bytes} bytes   exit: ${viaHelper.code}`)
console.log(viaHelper.bytes > 0
  ? 'EXPECTED: the log was captured, and nothing was painted over your terminal. This is the fix.'
  : 'UNEXPECTED: still 0 bytes from a console-less parent — investigate before trusting the fix.')

console.log('\nVERDICT:', direct.bytes === 0 && viaHelper.bytes > 0
  ? 'matches the measured matrix in #379.'
  : 'does NOT match #379 — read the numbers above.')
if (viaHelper.sample) console.log('\nfirst bytes of the captured log:\n' + viaHelper.sample)
