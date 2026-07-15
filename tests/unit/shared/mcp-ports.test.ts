import { describe, it, expect } from 'vitest'
import {
  CONDUCTOR_MCP_PORT_PROD,
  CONDUCTOR_MCP_PORT_DEV,
  resolveConductorMcpPort,
} from '../../../src/shared/mcp-ports'

describe('mcp-ports (P7.2)', () => {
  it('exposes the canonical prod port', () => {
    expect(CONDUCTOR_MCP_PORT_PROD).toBe(19333)
  })

  it('exposes the canonical dev port', () => {
    expect(CONDUCTOR_MCP_PORT_DEV).toBe(19433)
  })

  it('resolves to prod port when isPackaged=true', () => {
    expect(resolveConductorMcpPort(true)).toBe(19333)
  })

  it('resolves to dev port when isPackaged=false', () => {
    expect(resolveConductorMcpPort(false)).toBe(19433)
  })
})
