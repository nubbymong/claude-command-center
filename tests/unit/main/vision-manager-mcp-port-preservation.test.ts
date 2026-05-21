/**
 * P7.6 regression: startGlobalVision MUST NOT change the Conductor MCP
 * port that was set at CCC boot. The MCP port is owned by the boot path
 * (index.ts -> resolveConductorMcpPort -> startConductorMcpServer); the
 * vision/browser sub-tool's lifecycle is independent.
 *
 * Pre-fix bug: vision-manager.startGlobalVision reconciled
 * getConductorMcpPort() against config.mcpPort (deprecated as of P7.2),
 * which in dev mode tore down the 19433 server and rebound on 19333,
 * defeating the dev/prod split.
 *
 * This is a static-source assertion test because VisionManager is not
 * exported as a class and mocking the internal browser launch path is
 * awkward. The static assertion pins the contract: startGlobalVision
 * must not contain the reconcile pattern. Any future regression that
 * re-adds it will fail this test.
 */
import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

describe('vision-manager startGlobalVision MCP port preservation (P7.6)', () => {
  it('startGlobalVision does NOT contain the MCP port reconcile pattern', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../../src/main/vision-manager.ts'),
      'utf-8',
    )

    // Locate the startGlobalVision function body.
    const fnStart = src.indexOf('export async function startGlobalVision')
    expect(fnStart, 'startGlobalVision function must exist').toBeGreaterThan(-1)

    const fnEnd = src.indexOf('export async function stopGlobalVision')
    expect(fnEnd, 'stopGlobalVision function must follow').toBeGreaterThan(fnStart)

    const fnBody = src.slice(fnStart, fnEnd)

    // The reconcile pattern that defeats P7.2: stopMcpServer() +
    // resetConductorMcpPort() + startConductorMcpServer(config.mcpPort)
    // inside startGlobalVision. After the fix, these calls must not
    // exist inside the function body.
    expect(fnBody).not.toMatch(/stopMcpServer\(\)/)
    expect(fnBody).not.toMatch(/resetConductorMcpPort\(\)/)
    expect(fnBody).not.toMatch(/startConductorMcpServer\s*\(/)
    // Specifically the deprecated config.mcpPort reference is forbidden
    // inside this function (P7.2 deprecation).
    expect(fnBody).not.toMatch(/config\.mcpPort/)
  })
})
