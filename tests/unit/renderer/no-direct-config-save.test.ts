/**
 * Only two files may call `window.electronAPI.config.save` directly:
 * config-saver.ts (where the write latch, the retry and the health marking
 * live) and configHydration.ts (whose own calls check the latch first). Every
 * other write goes through config-saver -- a store that bypassed it was how the
 * latch's promise ("nothing has been written over your saved config") became
 * false the first time the user touched the Agent Library. This is the guard
 * that stops a third bypass landing silently.
 */
import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

const ROOT = path.resolve(__dirname, '../../../src/renderer')
const ALLOWED = new Set([
  path.join(ROOT, 'utils', 'config-saver.ts'),
  path.join(ROOT, 'utils', 'configHydration.ts'),
])

function walk(dir: string, out: string[] = []): string[] {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name)
    if (ent.isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(ent.name) && !/\.d\.ts$/.test(ent.name)) out.push(p)
  }
  return out
}

describe('config.save is called directly only where the write latch lives', () => {
  it('no renderer file outside config-saver / configHydration calls electronAPI.config.save', () => {
    const offenders: string[] = []
    for (const file of walk(ROOT)) {
      if (ALLOWED.has(file)) continue
      const src = fs.readFileSync(file, 'utf-8')
      if (/electronAPI\s*\.\s*config\s*\.\s*save\s*\(/.test(src)) offenders.push(path.relative(ROOT, file))
    }
    expect(offenders).toEqual([])
  })
  it('the allowlist itself still calls it (so this test cannot pass vacuously)', () => {
    for (const file of ALLOWED) {
      expect(/electronAPI\s*\.\s*config\s*\.\s*save\s*\(/.test(fs.readFileSync(file, 'utf-8'))).toBe(true)
    }
  })
})
