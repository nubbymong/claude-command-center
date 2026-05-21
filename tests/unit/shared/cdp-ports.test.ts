import { describe, it, expect } from 'vitest'
import {
  CDP_PORT_PROD,
  CDP_PORT_DEV,
  resolveCdpPort,
} from '../../../src/shared/cdp-ports'

describe('cdp-ports (P7.7)', () => {
  it('exposes the canonical prod CDP port', () => {
    expect(CDP_PORT_PROD).toBe(9222)
  })

  it('exposes the dev CDP port', () => {
    expect(CDP_PORT_DEV).toBe(9322)
  })

  it('resolves to prod port when isPackaged=true', () => {
    expect(resolveCdpPort(true)).toBe(9222)
  })

  it('resolves to dev port when isPackaged=false', () => {
    expect(resolveCdpPort(false)).toBe(9322)
  })
})
