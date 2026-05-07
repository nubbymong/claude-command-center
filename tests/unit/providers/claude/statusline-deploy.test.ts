import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readdirSync } from 'fs'
import { join } from 'path'
import { tmpdir, homedir } from 'os'

// Mock getResourcesDirectory so configureClaudeSettings does not touch the real path
vi.mock('../../../../src/main/ipc/setup-handlers', () => ({
  getResourcesDirectory: vi.fn(() => _mockResources),
}))
let _mockResources = ''

import { deployClaudeStatuslineScript, deployClaudeResumePickerScript } from '../../../../src/main/providers/claude/statusline'

describe('Claude script deployment', () => {
  let resDir: string
  let sandboxHome: string
  let homeBackup: string | undefined

  beforeEach(() => {
    resDir = mkdtempSync(join(tmpdir(), 'ccc-claude-deploy-'))
    _mockResources = resDir
    // Sandbox HOME so settings.json writes do not touch the real ~/.claude
    homeBackup = process.env.USERPROFILE ?? process.env.HOME
    sandboxHome = mkdtempSync(join(tmpdir(), 'ccc-home-'))
    if (process.platform === 'win32') process.env.USERPROFILE = sandboxHome
    else process.env.HOME = sandboxHome
  })

  afterEach(() => {
    try { rmSync(resDir, { recursive: true, force: true }) } catch {}
    try { rmSync(sandboxHome, { recursive: true, force: true }) } catch {}
    if (process.platform === 'win32') {
      if (homeBackup) process.env.USERPROFILE = homeBackup
      else delete process.env.USERPROFILE
    } else {
      if (homeBackup) process.env.HOME = homeBackup
      else delete process.env.HOME
    }
    vi.clearAllMocks()
  })

  it('deployClaudeStatuslineScript writes the statusline bridge to resourcesDir/scripts', async () => {
    await deployClaudeStatuslineScript(resDir)
    expect(existsSync(join(resDir, 'scripts', 'claude-multi-statusline.js'))).toBe(true)
  })

  it('deployClaudeStatuslineScript writes the statusline bridge to the sandbox HOME, NOT the real ~/.claude', async () => {
    // Regression test: prior bug captured os.homedir() in a module-level constant
    // at import time, bypassing the sandbox HOME override. P4.10 made the path
    // lazy. This test asserts the home write lands in the sandbox.
    await deployClaudeStatuslineScript(resDir)
    expect(existsSync(join(sandboxHome, '.claude', 'claude-multi-statusline.js'))).toBe(true)
  })

  it('deployClaudeResumePickerScript copies the source resume-picker.js to resourcesDir/scripts', async () => {
    // The deploy module uses path.join(__dirname, '../../scripts/resume-picker.js') which,
    // under vitest, resolves to <repo>/src/main/scripts/resume-picker.js (because the
    // module's __dirname is src/main/providers/claude/). In production, electron-vite
    // bundles to out/main/index.js so the same join lands at <repo>/scripts/. We seed
    // the dev-time path for the test.
    //
    // SAFETY: Only delete files / dirs the test created. Track pre-existing state
    // so a real <repo>/src/main/scripts/ (currently does not exist, but might
    // someday) is never wiped by a test cleanup.
    const stubDir = join(__dirname, '..', '..', '..', '..', 'src', 'main', 'scripts')
    const stubPath = join(stubDir, 'resume-picker.js')
    const dirPreExisted = existsSync(stubDir)
    const filePreExisted = existsSync(stubPath)
    mkdirSync(stubDir, { recursive: true })
    writeFileSync(stubPath, '// test stub')
    try {
      await deployClaudeResumePickerScript(resDir)
      expect(existsSync(join(resDir, 'scripts', 'resume-picker.js'))).toBe(true)
    } finally {
      // Only remove the stub file if we created it.
      if (!filePreExisted) {
        try { rmSync(stubPath, { force: true }) } catch {}
      }
      // Only remove the stub dir if we created it AND it's empty.
      if (!dirPreExisted) {
        try {
          const entries = existsSync(stubDir) ? readdirSync(stubDir) : []
          if (entries.length === 0) rmSync(stubDir, { recursive: false, force: true })
        } catch {}
      }
    }
  })

  it('deployClaudeStatuslineScript no longer copies resume-picker.js', async () => {
    // After the split, statusline deploy is statusline-only.
    await deployClaudeStatuslineScript(resDir)
    expect(existsSync(join(resDir, 'scripts', 'resume-picker.js'))).toBe(false)
  })
})
