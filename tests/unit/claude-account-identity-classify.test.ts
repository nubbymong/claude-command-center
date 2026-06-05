import { describe, it, expect } from 'vitest'
import { classifyIdentityChange } from '../../src/main/claude-account-identity'

describe('classifyIdentityChange', () => {
  it('same email => refresh', () => {
    expect(classifyIdentityChange('s', 'a@x.com', 'a@x.com', ['a@x.com']).kind).toBe('refresh')
  })
  it('different known email => adopt', () => {
    expect(classifyIdentityChange('s', 'b@x.com', 'a@x.com', ['a@x.com', 'b@x.com']).kind).toBe('adopt')
  })
  it('different unknown email => capture', () => {
    expect(classifyIdentityChange('s', 'c@x.com', 'a@x.com', ['a@x.com']).kind).toBe('capture')
  })
  it('email match is case-insensitive (refresh)', () => {
    expect(classifyIdentityChange('s', 'A@X.com', 'a@x.com', ['a@x.com']).kind).toBe('refresh')
  })
  it('no current email, email is known => adopt', () => {
    expect(classifyIdentityChange('s', 'a@x.com', null, ['a@x.com']).kind).toBe('adopt')
  })
  it('no current email, email is unknown => capture', () => {
    expect(classifyIdentityChange('s', 'new@x.com', null, ['a@x.com']).kind).toBe('capture')
  })
})
