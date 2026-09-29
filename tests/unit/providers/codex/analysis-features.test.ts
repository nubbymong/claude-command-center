// P3.9 round 3 (L5): every feature Sentinel's analysis run disables is one
// both supported CLIs know (their `codex features list`, captured as
// fixtures), since an unknown name fails the run; the two it leaves out are
// listed as removed (off) in both.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { codexCommandLine } from '../../../../src/main/providers/codex'

const features = (version: string) => {
  const text = readFileSync(join(__dirname, `../../../fixtures/codex/cli/${version}/help/features-list.txt`), 'utf8')
  const out = new Map<string, { stage: string; on: boolean }>()
  for (const line of text.split(/\r?\n/)) {
    const m = /^([a-z0-9_]+)\s+(.+?)\s+(true|false)\s*$/.exec(line)
    if (m) out.set(m[1], { stage: m[2], on: m[3] === 'true' })
  }
  return out
}

describe("the analysis run's disabled features (P3.9 round 3)", () => {
  const cmd = codexCommandLine('/usr/bin/codex', 'analysis', 'linux', {})
  const args = 'refused' in cmd ? [] : cmd.args
  const disabled = args.flatMap((a, i) => (args[i - 1] === '--disable' ? [a] : []))

  for (const version of ['0.153.4', '0.155.1']) {
    it(`every name is one Codex ${version} lists; code_mode_host (on by default) is among them`, () => {
      const list = features(version)
      expect(list.size).toBeGreaterThan(20)
      for (const name of disabled) expect(list.has(name), name).toBe(true)
      expect(disabled).toEqual(expect.arrayContaining(['code_mode', 'code_mode_host']))
      expect(list.get('code_mode_host')).toEqual({ stage: 'stable', on: true })
      // Left out: removed, and off, in this version.
      for (const name of ['js_repl', 'apply_patch_freeform']) {
        expect(disabled).not.toContain(name)
        expect(list.get(name)).toEqual({ stage: 'removed', on: false })
      }
    })
  }
})
