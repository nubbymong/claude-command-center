import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, existsSync, rmSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { CodexProvider } from '../../../../src/main/providers/codex'
import { deployCodexResumePickerScript } from '../../../../src/main/providers/codex/resume-picker'

describe('Codex resume picker deploy', () => {
  let resDir: string
  let tempSrcRoot: string

  beforeEach(() => {
    resDir = mkdtempSync(join(tmpdir(), 'ccc-codex-deploy-'))
    // Per-test temp source root replaces the shared <repo>/src/main/scripts/
    // stub. P4.11 added the sourceRoot override on deployCodexResumePickerScript
    // to avoid races on that shared on-disk path under vitest's parallel runner.
    tempSrcRoot = mkdtempSync(join(tmpdir(), 'ccc-codex-src-'))
    mkdirSync(join(tempSrcRoot, 'scripts', 'lib'), { recursive: true })
    writeFileSync(join(tempSrcRoot, 'scripts', 'codex-resume-picker.js'), '// test stub picker')
    writeFileSync(join(tempSrcRoot, 'scripts', 'lib', 'codex-resume-picker-lib.js'), '// test stub lib')
  })

  afterEach(() => {
    try { rmSync(resDir, { recursive: true, force: true }) } catch {}
    try { rmSync(tempSrcRoot, { recursive: true, force: true }) } catch {}
  })

  it('CodexProvider has a deployResumePickerScript method', () => {
    const p = new CodexProvider()
    expect(typeof p.deployResumePickerScript).toBe('function')
  })

  it('copies scripts/codex-resume-picker.js into resourcesDir/scripts/', async () => {
    await deployCodexResumePickerScript(resDir, tempSrcRoot)
    expect(existsSync(join(resDir, 'scripts', 'codex-resume-picker.js'))).toBe(true)
  })

  it('also copies the helper lib so the picker can require it', async () => {
    await deployCodexResumePickerScript(resDir, tempSrcRoot)
    expect(existsSync(join(resDir, 'scripts', 'lib', 'codex-resume-picker-lib.js'))).toBe(true)
  })

  it('creates the scripts dir if missing', async () => {
    expect(existsSync(join(resDir, 'scripts'))).toBe(false)
    await deployCodexResumePickerScript(resDir, tempSrcRoot)
    expect(existsSync(join(resDir, 'scripts'))).toBe(true)
  })

  it('does not throw when called twice', async () => {
    await deployCodexResumePickerScript(resDir, tempSrcRoot)
    await expect(deployCodexResumePickerScript(resDir, tempSrcRoot)).resolves.not.toThrow()
  })
})
