import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { extractEmailsFromAccountsJson } from '../../src/main/account-attribution'

describe('accounts.json migration', () => {
  let sandbox: string
  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'acct-mig-'))
  })
  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true })
  })

  it('reads accounts.json once; file is NOT deleted after read', () => {
    const accountsPath = join(sandbox, 'accounts.json')
    // Real legacy account-manager schema: each account's credentials carries
    // the full ~/.claude.json snapshot, including oauthAccount.
    writeFileSync(accountsPath, JSON.stringify({
      accounts: [
        {
          profile: { id: 'primary', label: 'Primary', savedAt: 0 },
          credentials: {
            oauthAccount: { emailAddress: 'alice@example.com', accountUuid: 'u1' },
            claudeAiOauth: { accessToken: 'enc:xxx', refreshToken: 'enc:yyy' },
          },
        },
      ],
    }))

    const emails = extractEmailsFromAccountsJson(accountsPath)
    expect(emails).toEqual(['alice@example.com'])
    expect(existsSync(accountsPath)).toBe(true)
  })
})
