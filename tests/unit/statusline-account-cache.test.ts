// tests/unit/statusline-account-cache.test.ts
// Asserts that the deployed statusline bridge script uses a per-account cache
// file (keyed by email) rather than a single shared cache file.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

// Mock getResourcesDirectory so configureClaudeSettings does not touch the real path
vi.mock('../../src/main/ipc/setup-handlers', () => ({
  getResourcesDirectory: vi.fn(() => _mockResources),
}))
let _mockResources = ''

import { deployClaudeStatuslineScript } from '../../src/main/providers/claude/statusline'

describe('statusline cache: per-account keying', () => {
  let resDir: string
  let sandboxHome: string
  let homeBackup: string | undefined
  let scriptContent: string

  beforeEach(async () => {
    resDir = mkdtempSync(join(tmpdir(), 'ccc-cache-test-'))
    _mockResources = resDir

    // Sandbox HOME/USERPROFILE so writes stay isolated from the real ~/.claude
    homeBackup = process.platform === 'win32'
      ? process.env.USERPROFILE
      : process.env.HOME
    sandboxHome = mkdtempSync(join(tmpdir(), 'ccc-cache-home-'))
    if (process.platform === 'win32') process.env.USERPROFILE = sandboxHome
    else process.env.HOME = sandboxHome

    await deployClaudeStatuslineScript(resDir)

    // Read the resources-dir copy (avoids relying on os.homedir() resolution in tests)
    const scriptPath = join(resDir, 'scripts', 'claude-multi-statusline.js')
    scriptContent = readFileSync(scriptPath, 'utf-8')
  })

  afterEach(() => {
    try { rmSync(resDir, { recursive: true, force: true }) } catch {}
    try { rmSync(sandboxHome, { recursive: true, force: true }) } catch {}
    if (process.platform === 'win32') {
      if (homeBackup !== undefined) process.env.USERPROFILE = homeBackup
      else delete process.env.USERPROFILE
    } else {
      if (homeBackup !== undefined) process.env.HOME = homeBackup
      else delete process.env.HOME
    }
    vi.clearAllMocks()
  })

  it('deployed script uses per-account cache file prefix', () => {
    expect(scriptContent).toContain('claude-command-center-usage-cache-')
  })

  it('deployed script does NOT use the old single shared cache filename', () => {
    // The legacy fixed name must not appear anywhere in the generated script
    expect(scriptContent).not.toContain("'claude-command-center-usage-cache.json'")
    expect(scriptContent).not.toContain('"claude-command-center-usage-cache.json"')
  })

  it('getCachedUsageLimits is called with accountEmail argument', () => {
    expect(scriptContent).toContain('getCachedUsageLimits(accountEmail)')
  })

  it('getCachedUsageLimits function accepts accountEmail parameter', () => {
    expect(scriptContent).toContain('async function getCachedUsageLimits(accountEmail)')
  })

  it('cache key sanitises email to alphanumeric+underscore', () => {
    // The sanitise expression must be present
    expect(scriptContent).toContain("replace(/[^a-z0-9]/g, '_')")
  })

  it('falls back to "default" key when accountEmail is falsy', () => {
    expect(scriptContent).toContain("accountEmail || 'default'")
  })
})
