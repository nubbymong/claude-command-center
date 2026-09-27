import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

describe('readClaudeAccountEmail', () => {
  let sandbox: string
  let originalHome: string | undefined
  let originalUserProfile: string | undefined

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'acct-identity-'))
    originalHome = process.env.HOME
    originalUserProfile = process.env.USERPROFILE
    process.env.USERPROFILE = sandbox
    process.env.HOME = sandbox
    vi.resetModules()
  })

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME
    else process.env.HOME = originalHome
    if (originalUserProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = originalUserProfile
    rmSync(sandbox, { recursive: true, force: true })
  })

  async function loadFresh() {
    vi.resetModules()
    return await import('../../../src/main/account-identity')
  }

  it('returns null when ~/.claude.json is missing', async () => {
    const { readClaudeAccountEmail } = await loadFresh()
    expect(readClaudeAccountEmail()).toBeNull()
  })

  it('returns null when JSON is malformed', async () => {
    writeFileSync(join(sandbox, '.claude.json'), '{not valid json')
    const { readClaudeAccountEmail } = await loadFresh()
    expect(readClaudeAccountEmail()).toBeNull()
  })

  it('returns null when oauthAccount is missing', async () => {
    writeFileSync(join(sandbox, '.claude.json'), JSON.stringify({ userID: 'x', other: 'y' }))
    const { readClaudeAccountEmail } = await loadFresh()
    expect(readClaudeAccountEmail()).toBeNull()
  })

  it('returns null when file size exceeds 5MB defensive cap', async () => {
    const filler = '"x":"' + 'a'.repeat(5 * 1024 * 1024 + 100) + '"'
    writeFileSync(
      join(sandbox, '.claude.json'),
      `{"oauthAccount":{"emailAddress":"big@x.com"},${filler}}`,
    )
    const { readClaudeAccountEmail } = await loadFresh()
    expect(readClaudeAccountEmail()).toBeNull()
  })

  it('returns identity when oauthAccount is present', async () => {
    writeFileSync(
      join(sandbox, '.claude.json'),
      JSON.stringify({
        oauthAccount: {
          emailAddress: 'alice@example.com',
          accountUuid: 'uuid-123',
          displayName: 'Alice',
        },
      }),
    )
    const { readClaudeAccountEmail } = await loadFresh()
    const id = readClaudeAccountEmail()
    expect(id).toEqual({
      email: 'alice@example.com',
      name: 'Alice',
      accountUuid: 'uuid-123',
      provider: 'claude',
    })
  })
})
