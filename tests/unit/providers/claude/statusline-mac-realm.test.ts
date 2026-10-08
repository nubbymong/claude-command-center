// @vitest-environment node
//
// The LOCAL statusline bridge on the experimental macOS multi-account realm
// (statusline.ts, MAC_REALM_GATHER_JS). A realm session keeps HOME real, so
// the shared gather reads the real home's `.claude.json`; on macOS the bridge
// re-reads the identity from $CLAUDE_CONFIG_DIR and drops the gather's usage
// fetch (its token file would be the wrong account's). The snippet is in the
// deployed script on macOS only: win32/linux scripts are unchanged.
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MAC_REALM_GATHER_JS, deployClaudeStatuslineScript, setMacRealmStatuslineProbe, claudeStatuslineNeedsMacRealmRedeploy, _resetMacRealmStatuslineForTest } from '../../../../src/main/providers/claude/statusline'

function run(env: Record<string, string>, s: Record<string, unknown>) {
  const fn = new Function('fs', 'path', 'process', 's', `var fetchUsage=function(cb){cb('original');};${MAC_REALM_GATHER_JS};return fetchUsage;`)
  let got: unknown
  const fetchUsage = fn(fs, path, { env }, s) as (cb: (v: unknown) => void) => void
  fetchUsage((v) => { got = v })
  return got
}

const tmps: string[] = []
afterEach(() => { for (const t of tmps.splice(0)) try { fs.rmSync(t, { recursive: true, force: true }) } catch { /* ignore */ } })

describe('MAC_REALM_GATHER_JS', () => {
  it('with CLAUDE_CONFIG_DIR: the email comes from <dir>/.claude.json and the usage fetch is dropped', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-realm-'))
    tmps.push(dir)
    fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'realm@example.com' } }))
    const s: Record<string, unknown> = { accountEmail: 'real-home@example.com' }
    expect(run({ CLAUDE_CONFIG_DIR: dir }, s)).toBeNull()
    expect(s.accountEmail).toBe('realm@example.com')
  })
  it('with CLAUDE_CONFIG_DIR but no identity there yet: no email rather than the wrong one', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-realm-'))
    tmps.push(dir)
    const s: Record<string, unknown> = { accountEmail: 'real-home@example.com' }
    run({ CLAUDE_CONFIG_DIR: dir }, s)
    expect(s.accountEmail).toBeUndefined()
  })
  it('without CLAUDE_CONFIG_DIR (setting off, the primary): nothing changes', () => {
    const s: Record<string, unknown> = { accountEmail: 'real-home@example.com' }
    expect(run({}, s)).toBe('original')
    expect(s.accountEmail).toBe('real-home@example.com')
    expect(run({ CLAUDE_CONFIG_DIR: 'relative/dir' }, s)).toBe('original')
  })
  // Adversarial review pass 3, m6: a FIFO or a device at the identity path
  // would block the read (or never end it). Only a regular file is read.
  it('m6: an identity path that is not a regular file is never read', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-realm-'))
    tmps.push(dir)
    fs.mkdirSync(path.join(dir, '.claude.json'))
    let read = false
    const spyFs = { ...fs, statSync: fs.statSync, readFileSync: (...a: unknown[]) => { read = true; return (fs.readFileSync as (...x: unknown[]) => unknown)(...a) } }
    const s: Record<string, unknown> = { accountEmail: 'real-home@example.com' }
    const fn = new Function('fs', 'path', 'process', 's', `var fetchUsage=function(cb){cb('original');};${MAC_REALM_GATHER_JS};return fetchUsage;`)
    fn(spyFs, path, { env: { CLAUDE_CONFIG_DIR: dir } }, s)
    expect(read).toBe(false)
    expect(s.accountEmail).toBeUndefined()
  })
})

describe('deployed script', () => {
  const realPlatform = process.platform
  afterEach(() => { Object.defineProperty(process, 'platform', { value: realPlatform }); _resetMacRealmStatuslineForTest() })
  async function deployAs(p: NodeJS.Platform): Promise<string> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-deploy-'))
    tmps.push(dir)
    Object.defineProperty(process, 'platform', { value: p })
    await deployClaudeStatuslineScript(dir)
    return fs.readFileSync(path.join(dir, 'scripts', 'claude-multi-statusline.js'), 'utf8')
  }
  it('macOS with the setting ON carries the snippet; win32 and linux do not, and are identical to each other', async () => {
    setMacRealmStatuslineProbe(() => true)
    const mac = await deployAs('darwin')
    const win = await deployAs('win32')
    const lin = await deployAs('linux')
    expect(mac).toContain(MAC_REALM_GATHER_JS)
    expect(win).not.toContain('CLAUDE_CONFIG_DIR')
    expect(lin).toBe(win)
    expect(mac.replace(MAC_REALM_GATHER_JS, '')).toBe(win)
  })

  // m6: deployed only while the setting is on; turning it on mid-run asks for a
  // redeploy; once deployed it stays for the run (realm sessions still running).
  it('m6: macOS with the setting OFF deploys the same script as before the feature; ON mid-run needs a redeploy', async () => {
    let on = false
    setMacRealmStatuslineProbe(() => on)
    const off = await deployAs('darwin')
    expect(off).not.toContain(MAC_REALM_GATHER_JS)
    expect(off).not.toContain('CLAUDE_CONFIG_DIR')
    expect(claudeStatuslineNeedsMacRealmRedeploy()).toBe(false)
    on = true
    expect(claudeStatuslineNeedsMacRealmRedeploy()).toBe(true)
    expect(await deployAs('darwin')).toContain(MAC_REALM_GATHER_JS)
    expect(claudeStatuslineNeedsMacRealmRedeploy()).toBe(false)
    on = false
    expect(await deployAs('darwin')).toContain(MAC_REALM_GATHER_JS)
    _resetMacRealmStatuslineForTest()
    setMacRealmStatuslineProbe(() => { throw new Error('unreadable') })
    expect(await deployAs('darwin')).not.toContain(MAC_REALM_GATHER_JS)
    setMacRealmStatuslineProbe(() => true)
    expect(await deployAs('win32')).not.toContain('CLAUDE_CONFIG_DIR')
  })
})
