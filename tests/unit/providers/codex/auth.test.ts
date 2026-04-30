import { describe, it, expect, afterEach } from 'vitest'
import { parseChatgptPlanFromJwt, getCodexHome, readCodexAuthStatus } from '../../../../src/main/providers/codex/auth'

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url')
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const sig = 'fakesig'
  return `${header}.${body}.${sig}`
}

describe('parseChatgptPlanFromJwt', () => {
  it('returns planType and accountId from a valid JWT', () => {
    const token = makeJwt({ chatgpt_plan_type: 'plus', account_id: 'acct-x' })
    expect(parseChatgptPlanFromJwt(token)).toEqual({ planType: 'plus', accountId: 'acct-x' })
  })

  it('returns empty object for malformed input', () => {
    expect(parseChatgptPlanFromJwt('not-a-jwt')).toEqual({})
  })
})

describe('getCodexHome', () => {
  afterEach(() => {
    delete process.env.CODEX_HOME
  })

  it('respects CODEX_HOME env var', () => {
    process.env.CODEX_HOME = '/tmp/codex-test'
    expect(getCodexHome()).toBe('/tmp/codex-test')
  })
})

describe('readCodexAuthStatus', () => {
  it('returns authMode=none for non-existent codex home', async () => {
    const status = await readCodexAuthStatus(`/nonexistent/codex-test-${Date.now()}`)
    expect(status.authMode).toBe('none')
    expect(typeof status.hasOpenAiApiKeyEnv).toBe('boolean')
    // installed/version depend on whether codex is on the test machine's PATH
    if (status.installed) {
      expect(status.version).toMatch(/^\d+\.\d+\.\d+$/)
    } else {
      expect(status.version).toBeNull()
    }
  })
})
