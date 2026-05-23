import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
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

describe('readCodexAccountEmail', () => {
  let sandbox: string
  let originalHome: string | undefined
  let originalUserProfile: string | undefined

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'acct-identity-codex-'))
    originalHome = process.env.HOME
    originalUserProfile = process.env.USERPROFILE
    process.env.USERPROFILE = sandbox
    process.env.HOME = sandbox
    mkdirSync(join(sandbox, '.codex'), { recursive: true })
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

  function makeJwt(payload: object): string {
    const enc = (s: string) => Buffer.from(s).toString('base64url')
    return enc('{"alg":"RS256","typ":"JWT"}') + '.' + enc(JSON.stringify(payload)) + '.sig'
  }

  it('returns null when ~/.codex/auth.json is missing', async () => {
    const { readCodexAccountEmail } = await loadFresh()
    expect(readCodexAccountEmail()).toBeNull()
  })

  it('returns null when id_token segment count is wrong', async () => {
    writeFileSync(join(sandbox, '.codex', 'auth.json'), JSON.stringify({ tokens: { id_token: 'not.a.jwt.too.many' } }))
    const { readCodexAccountEmail } = await loadFresh()
    expect(readCodexAccountEmail()).toBeNull()
  })

  it('returns null when middle segment is unparseable base64', async () => {
    writeFileSync(join(sandbox, '.codex', 'auth.json'), JSON.stringify({ tokens: { id_token: 'h.@@@invalid@@@.sig' } }))
    const { readCodexAccountEmail } = await loadFresh()
    expect(readCodexAccountEmail()).toBeNull()
  })

  it('returns null when email claim is missing', async () => {
    const jwt = makeJwt({ sub: 'x', exp: Math.floor(Date.now() / 1000) + 3600 })
    writeFileSync(join(sandbox, '.codex', 'auth.json'), JSON.stringify({ tokens: { id_token: jwt } }))
    const { readCodexAccountEmail } = await loadFresh()
    expect(readCodexAccountEmail()).toBeNull()
  })

  it('returns null when exp claim is in the past', async () => {
    const jwt = makeJwt({ email: 'x@y.com', exp: Math.floor(Date.now() / 1000) - 100 })
    writeFileSync(join(sandbox, '.codex', 'auth.json'), JSON.stringify({ tokens: { id_token: jwt } }))
    const { readCodexAccountEmail } = await loadFresh()
    expect(readCodexAccountEmail()).toBeNull()
  })

  it('returns identity for valid JWT with email + name + account_id', async () => {
    const jwt = makeJwt({
      email: 'codex@example.com',
      name: 'Codex User',
      sub: 'oauth|abc',
      exp: Math.floor(Date.now() / 1000) + 3600,
    })
    writeFileSync(
      join(sandbox, '.codex', 'auth.json'),
      JSON.stringify({ tokens: { id_token: jwt, account_id: 'acct-xyz' } }),
    )
    const { readCodexAccountEmail } = await loadFresh()
    expect(readCodexAccountEmail()).toEqual({
      email: 'codex@example.com',
      name: 'Codex User',
      accountUuid: 'acct-xyz',
      provider: 'codex',
    })
  })
})
