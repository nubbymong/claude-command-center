/**
 * R-DEC-3: the global ~/.claude.json MCP registration write embeds the
 * per-launch secret in the URL so Claude sessions authenticate against the
 * now-gated MCP server with zero user-visible change.
 *
 * Exercises injectMcpSettings directly against a tmp HOME (same idiom as the
 * per-session writer test) and asserts the conductor entry's URL carries
 * ?token=<secret>. The defensive merge / atomic-write safety of this path is
 * pre-existing and covered elsewhere; here we only pin the token.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { injectMcpSettings, getConductorMcpSecret } from '../../../src/main/conductor-mcp-server'

// os.homedir() resolves USERPROFILE (Windows) / HOME (POSIX) at call time, so
// redirecting both env vars points the production write at our tmp dir without
// depending on which `os` namespace wrapper the module captured under Vitest.
describe('injectMcpSettings registration token (R-DEC-3)', () => {
  let tmpHome: string
  let realHome: string | undefined
  let realUserProfile: string | undefined

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'rdec3-reg-'))
    realHome = process.env.HOME
    realUserProfile = process.env.USERPROFILE
    process.env.HOME = tmpHome
    process.env.USERPROFILE = tmpHome
  })

  afterEach(() => {
    if (realHome === undefined) delete process.env.HOME
    else process.env.HOME = realHome
    if (realUserProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = realUserProfile
    fs.rmSync(tmpHome, { recursive: true, force: true })
  })

  it('writes the conductor entry with ?token=<secret> in the URL (fresh ~/.claude.json)', () => {
    injectMcpSettings(19444)
    const cj = JSON.parse(fs.readFileSync(path.join(tmpHome, '.claude.json'), 'utf-8'))
    const entry = cj.mcpServers.conductor
    expect(entry.type).toBe('sse')
    expect(entry.url).toBe(`http://localhost:19444/sse?token=${getConductorMcpSecret()}`)
  })

  it('preserves other top-level keys and other mcpServers entries', () => {
    fs.writeFileSync(
      path.join(tmpHome, '.claude.json'),
      JSON.stringify({
        oauthAccount: { email: 'x@y.z' },
        mcpServers: { 'other-server': { type: 'sse', url: 'http://example.com/sse' } },
      }),
    )
    injectMcpSettings(19444)
    const cj = JSON.parse(fs.readFileSync(path.join(tmpHome, '.claude.json'), 'utf-8'))
    // Untouched neighbours
    expect(cj.oauthAccount).toEqual({ email: 'x@y.z' })
    expect(cj.mcpServers['other-server']).toEqual({ type: 'sse', url: 'http://example.com/sse' })
    // Our entry carries the token
    expect(cj.mcpServers.conductor.url).toContain(`token=${getConductorMcpSecret()}`)
  })
})
