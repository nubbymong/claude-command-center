import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, existsSync, rmSync, mkdirSync, writeFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { CodexProvider } from '../../../../src/main/providers/codex'

// Under vitest, the deploy module's __dirname resolves to src/main/providers/codex/,
// so its path.join(__dirname, '../../scripts/codex-resume-picker.js') lands at
// <repo>/src/main/scripts/codex-resume-picker.js. In production, electron-vite
// bundles to out/main/index.js so the same join lands at <repo>/scripts/. We seed
// the dev-time path so the deploy can copy from it.
const stubScriptsDir = join(__dirname, '..', '..', '..', '..', 'src', 'main', 'scripts')
const stubLibDir = join(stubScriptsDir, 'lib')
const stubPickerPath = join(stubScriptsDir, 'codex-resume-picker.js')
const stubLibPath = join(stubLibDir, 'codex-resume-picker-lib.js')

describe('Codex resume picker deploy', () => {
  let resDir: string
  // SAFETY: track pre-existing state so a real <repo>/src/main/scripts/ (currently
  // does not exist, but might someday) is never wiped by a test cleanup.
  let scriptsDirPreExisted: boolean
  let libDirPreExisted: boolean
  let pickerFilePreExisted: boolean
  let libFilePreExisted: boolean

  beforeEach(() => {
    resDir = mkdtempSync(join(tmpdir(), 'ccc-codex-deploy-'))
    scriptsDirPreExisted = existsSync(stubScriptsDir)
    libDirPreExisted = existsSync(stubLibDir)
    pickerFilePreExisted = existsSync(stubPickerPath)
    libFilePreExisted = existsSync(stubLibPath)
    mkdirSync(stubLibDir, { recursive: true })
    writeFileSync(stubPickerPath, '// test stub picker')
    writeFileSync(stubLibPath, '// test stub lib')
  })

  afterEach(() => {
    try { rmSync(resDir, { recursive: true, force: true }) } catch {}
    // Only remove files we created.
    if (!pickerFilePreExisted) {
      try { rmSync(stubPickerPath, { force: true }) } catch {}
    }
    if (!libFilePreExisted) {
      try { rmSync(stubLibPath, { force: true }) } catch {}
    }
    // Only remove dirs we created AND only if empty.
    if (!libDirPreExisted) {
      try {
        const entries = existsSync(stubLibDir) ? readdirSync(stubLibDir) : []
        if (entries.length === 0) rmSync(stubLibDir, { recursive: false, force: true })
      } catch {}
    }
    if (!scriptsDirPreExisted) {
      try {
        const entries = existsSync(stubScriptsDir) ? readdirSync(stubScriptsDir) : []
        if (entries.length === 0) rmSync(stubScriptsDir, { recursive: false, force: true })
      } catch {}
    }
  })

  it('CodexProvider has a deployResumePickerScript method', () => {
    const p = new CodexProvider()
    expect(typeof p.deployResumePickerScript).toBe('function')
  })

  it('copies scripts/codex-resume-picker.js into resourcesDir/scripts/', async () => {
    const p = new CodexProvider()
    await p.deployResumePickerScript!(resDir)
    expect(existsSync(join(resDir, 'scripts', 'codex-resume-picker.js'))).toBe(true)
  })

  it('also copies the helper lib so the picker can require it', async () => {
    const p = new CodexProvider()
    await p.deployResumePickerScript!(resDir)
    expect(existsSync(join(resDir, 'scripts', 'lib', 'codex-resume-picker-lib.js'))).toBe(true)
  })

  it('creates the scripts dir if missing', async () => {
    const p = new CodexProvider()
    expect(existsSync(join(resDir, 'scripts'))).toBe(false)
    await p.deployResumePickerScript!(resDir)
    expect(existsSync(join(resDir, 'scripts'))).toBe(true)
  })

  it('does not throw when called twice', async () => {
    const p = new CodexProvider()
    await p.deployResumePickerScript!(resDir)
    await expect(p.deployResumePickerScript!(resDir)).resolves.not.toThrow()
  })
})
