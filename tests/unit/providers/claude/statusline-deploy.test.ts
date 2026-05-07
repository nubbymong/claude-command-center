import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

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
    // Per-test temp source root avoids races on the shared <repo>/src/main/scripts/
    // path that the deploy default resolves to under vitest. P4.11 added the
    // sourceRoot override exactly for this reason -- vitest runs files in parallel
    // and the Codex resume-picker test seeds the same default location.
    const tempSrcRoot = mkdtempSync(join(tmpdir(), 'ccc-claude-src-'))
    try {
      mkdirSync(join(tempSrcRoot, 'scripts'), { recursive: true })
      writeFileSync(join(tempSrcRoot, 'scripts', 'resume-picker.js'), '// test stub')
      await deployClaudeResumePickerScript(resDir, tempSrcRoot)
      expect(existsSync(join(resDir, 'scripts', 'resume-picker.js'))).toBe(true)
    } finally {
      try { rmSync(tempSrcRoot, { recursive: true, force: true }) } catch {}
    }
  })

  it('deployClaudeStatuslineScript no longer copies resume-picker.js', async () => {
    // After the split, statusline deploy is statusline-only.
    await deployClaudeStatuslineScript(resDir)
    expect(existsSync(join(resDir, 'scripts', 'resume-picker.js'))).toBe(false)
  })
})
