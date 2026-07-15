import { describe, it, expect } from 'vitest'
import { scopesToCapabilities } from '../../src/main/github/auth/capability-mapper'

describe('plan capability (AI-credits coverage)', () => {
  it('classic "user" scope grants plan', () => {
    expect(scopesToCapabilities('classic', ['user'])).toContain('plan')
  })
  it('oauth token with "user" scope grants plan', () => {
    expect(scopesToCapabilities('oauth', ['user'])).toContain('plan')
  })
  it('fine-grained "plan" permission grants plan', () => {
    expect(scopesToCapabilities('fine-grained', ['plan'])).toContain('plan')
  })
  it('repo scope alone does not grant plan', () => {
    expect(scopesToCapabilities('classic', ['repo'])).not.toContain('plan')
  })
})
