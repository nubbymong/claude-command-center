import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

/**
 * #379, item 3 — the spawn-site audit, made executable.
 *
 * The finding from the inventory was that main is ALREADY the console-less
 * parent the issue asks for: Electron's main process has no console, so every
 * `child_process.spawn` from it is fix A by construction, and every site that
 * wants output already pipes it. Nothing needed changing.
 *
 * What needed adding is something that NOTICES if that stops being true. The
 * dangerous combination the issue names is `detached: true` (DETACHED_PROCESS)
 * on a spawn whose output someone expects to capture: the child gets no console
 * of its own, goes looking for its parent's, and — measured, matrix row 2 —
 * still bleeds while the pipe collects 0 bytes. Every `detached: true` in main
 * today is paired with `stdio: 'ignore'`, i.e. "we deliberately want no output
 * from this one" (a browser, an installer), which is fine and stays fine.
 *
 * So: if you add `detached: true`, you must also say `stdio: 'ignore'`. If you
 * want the output, drop `detached` — main already has no console.
 */

const MAIN_DIR = path.resolve(__dirname, '../../src/main')

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(p, out)
    else if (entry.name.endsWith('.ts')) out.push(p)
  }
  return out
}

/** The `{ ... }` object literal that contains `index`, by brace matching. */
function enclosingObject(src: string, index: number): string {
  let start = index
  let depth = 0
  while (start > 0) {
    const ch = src[start]
    if (ch === '}') depth++
    else if (ch === '{') { if (depth === 0) break; depth-- }
    start--
  }
  let end = index
  depth = 0
  while (end < src.length) {
    const ch = src[end]
    if (ch === '{') depth++
    else if (ch === '}') { if (depth === 0) break; depth-- }
    end++
  }
  return src.slice(start, end + 1)
}

/** Sites in `src` that pair DETACHED_PROCESS with anything but a discarded stdio. */
function detachedWithoutIgnore(src: string, label: string): string[] {
  const offenders: string[] = []
  const re = /detached:\s*true/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src)) !== null) {
    // Skip prose: the runner's header explains why it never does this.
    const lineStart = src.lastIndexOf('\n', m.index) + 1
    const nl = src.indexOf('\n', m.index)
    const line = src.slice(lineStart, nl === -1 ? undefined : nl)
    if (/^\s*(\*|\/\/)/.test(line)) continue

    const obj = enclosingObject(src, m.index)
    if (!/stdio:\s*'ignore'/.test(obj)) offenders.push(`${label}: ${line.trim()}`)
  }
  return offenders
}

describe('main-process spawn options (#379 fix A audit)', () => {
  const files = walk(MAIN_DIR)

  it('finds the main sources to audit', () => {
    expect(files.length).toBeGreaterThan(20)
  })

  it('the audit can actually fail', () => {
    // Prove the check bites before trusting a green result from it.
    const bad = "const c = spawn(exe, [], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] })\n"
    expect(detachedWithoutIgnore(bad, 'synthetic')).toHaveLength(1)

    const good = "const c = spawn(exe, [], { detached: true, stdio: 'ignore' })\n"
    expect(detachedWithoutIgnore(good, 'synthetic')).toEqual([])

    // And that prose is not mistaken for code.
    expect(detachedWithoutIgnore(' * - `detached: true` is never a fix.\n', 'synthetic')).toEqual([])
  })

  it('every `detached: true` spawn in main discards its output', () => {
    const offenders = files.flatMap((file) =>
      detachedWithoutIgnore(fs.readFileSync(file, 'utf8'), path.relative(MAIN_DIR, file)),
    )
    // A failure here means someone paired DETACHED_PROCESS with a pipe. On
    // Windows that child will still write over whatever console its parent had,
    // and the pipe will collect nothing (#379, measured matrix row 2). Either
    // drop `detached` (main has no console — that is already the fix), or say
    // `stdio: 'ignore'` and mean it.
    expect(offenders).toEqual([])
  })

  it('the captured runner never acquires a shell or a detached child', () => {
    const src = fs.readFileSync(path.join(MAIN_DIR, 'gui-exe-runner.ts'), 'utf8')
    // The spawn options object, not the prose above it.
    const spawnCall = src.slice(src.indexOf('child = spawn('))
    expect(spawnCall).toContain('shell: false')
    expect(spawnCall).toContain('detached: false')
    expect(spawnCall).toContain("stdio: ['ignore', 'pipe', 'pipe']")
    expect(spawnCall).not.toContain('shell: true')
  })
})
