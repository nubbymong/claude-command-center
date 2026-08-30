// tests/unit/statusline-account-cache.test.ts
// The deployed LOCAL statusline bridge script embeds the SHARED gather snippet
// (statusline-gather.ts — same source as both SSH remote shims) and delivers
// POST-first to the conductor /status endpoint with the watched status file as
// fallback (harmonise-remote local-unification slice). These tests pin that
// unification: per-account usage cache keying, the shared gather wiring, and
// the POST-first/file-fallback delivery order.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

// Mock getResourcesDirectory so configureClaudeSettings does not touch the real path
vi.mock('../../src/main/ipc/setup-handlers', () => ({
  getResourcesDirectory: vi.fn(() => _mockResources),
}))
let _mockResources = ''

import { deployClaudeStatuslineScript } from '../../src/main/providers/claude/statusline'
import { SHIM_GATHER_JS } from '../../src/main/providers/claude/statusline-gather'

describe('local statusline bridge: shared gather + POST-first delivery', () => {
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

  it('embeds the SHARED gather snippet verbatim (one source with the SSH shims)', () => {
    expect(scriptContent).toContain(SHIM_GATHER_JS)
  })

  it('uses the per-account usage cache file prefix from the shared gather', () => {
    expect(scriptContent).toContain("'ccc-usage-cache-'+cacheKey+'.json'")
  })

  it('does NOT carry the retired local-only gather (old cache prefix, promise helpers)', () => {
    expect(scriptContent).not.toContain('claude-command-center-usage-cache')
    expect(scriptContent).not.toContain('getCachedUsageLimits')
    expect(scriptContent).not.toContain('fetchUsageLimits')
  })

  it('cache key sanitises email to alphanumeric+underscore with a default fallback', () => {
    expect(scriptContent).toContain("String(s.accountEmail||'default').toLowerCase().replace(/[^a-z0-9]/g,'_')")
  })

  it('reads the signed-in account from ~/.claude.json via the shared gather', () => {
    expect(scriptContent).toContain('oauthAccount')
  })

  it('delivers POST-first (argv[3] / CCC_STATUS_URL) with the status file as fallback', () => {
    expect(scriptContent).toContain("process.argv[3] || process.env.CCC_STATUS_URL || ''")
    expect(scriptContent).toContain('deliverLegacy')
    // Fallback still writes <statusDir>/<sid>.json for the directory watcher.
    expect(scriptContent).toContain("path.join(statusDir, sid + '.json')")
    // POST failure routes to the file fallback, not silence: fin(false) paths exist.
    expect(scriptContent).toContain('fin(false)')
  })

  it('resolves identity by the same argv[2]/env ladder as the remote shims', () => {
    expect(scriptContent).toContain('process.argv[2] || process.env.CLAUDE_MULTI_SESSION_ID')
  })

  it('stdin rate_limits win; gather only fills gaps', () => {
    // stdin 5h/weekly are applied unconditionally before the gather runs...
    expect(scriptContent).toContain('rl.five_hour')
    expect(scriptContent).toContain('rl.seven_day')
    // ...and the shared applyUsage guards on undefined (stdin-wins semantics).
    expect(scriptContent).toContain('s.rateLimitCurrent===undefined')
  })
})
