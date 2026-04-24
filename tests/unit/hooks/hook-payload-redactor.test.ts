import { describe, it, expect } from 'vitest'
import { redactHookPayload } from '../../../src/main/hooks/hook-payload-redactor'

describe('redactHookPayload', () => {
  it('redacts Anthropic-style sk- tokens', () => {
    const out = redactHookPayload({ msg: 'key=sk-abc1234567890abcdef1234567890abcdef12345' })
    expect(out.msg).toContain('[REDACTED]')
    expect(out.msg).not.toContain('sk-abc1234567890')
  })

  it('redacts Slack xoxb tokens', () => {
    const out = redactHookPayload({ env: 'SLACK=xoxb-1234-5678-abcdef' })
    expect(out.env).toContain('[REDACTED]')
  })

  it('redacts AWS access keys', () => {
    const out = redactHookPayload({ s: 'AKIAIOSFODNN7EXAMPLE' })
    expect(out.s).toBe('[REDACTED]')
  })

  it('redacts PEM private key blocks', () => {
    const key =
      '-----BEGIN OPENSSH PRIVATE KEY-----\nmumblemumble\n-----END OPENSSH PRIVATE KEY-----'
    const out = redactHookPayload({ k: key })
    expect(out.k).toContain('[REDACTED]')
    expect(out.k).not.toContain('mumblemumble')
  })

  it('redacts password/token/api_key assignments', () => {
    const out = redactHookPayload({ line: 'API_KEY=hunter2-real-value-here' })
    expect(out.line).toContain('[REDACTED]')
    expect(out.line).toContain('API_KEY=')
  })

  it('walks nested objects and arrays', () => {
    const out = redactHookPayload({
      tools: [
        { args: { apiKey: 'sk-ant-abcdefghij0123456789abcdefghij0123456789' } },
      ],
    })
    const leaf = (out as { tools: Array<{ args: { apiKey: string } }> }).tools[0].args.apiKey
    expect(leaf).toContain('[REDACTED]')
  })

  it('does not throw on circular references', () => {
    interface Circ { name: string; self?: Circ }
    const a: Circ = { name: 'root' }
    a.self = a
    expect(() => redactHookPayload(a)).not.toThrow()
  })

  it('preserves non-string leaves', () => {
    const out = redactHookPayload({ n: 42, b: true, nil: null, arr: [1, 2] })
    expect(out).toEqual({ n: 42, b: true, nil: null, arr: [1, 2] })
  })

  it('redacts GitHub PAT-style tokens', () => {
    const out = redactHookPayload({ auth: 'ghp_aaaabbbbccccddddeeeeffffgggghhhh1234' })
    expect(out.auth).toContain('[REDACTED]')
  })
})
