import { describe, it, expect, vi, beforeEach } from 'vitest'
import { FakeTkWorkerTransport } from '../../../src/main/tokenomics/tk-worker-transport'

const forks: FakeTkWorkerTransport[] = []
vi.mock('../../../src/main/tokenomics/fork-tokenomics-worker', () => ({
  forkTokenomicsWorker: () => {
    const t = new FakeTkWorkerTransport()
    t.onWorker((m) => { if (m.type === 'open') t.emitToMain({ type: 'ready' }) })
    forks.push(t)
    return { transport: t, kill: () => t.kill(), onExit: () => {} }
  },
}))
vi.mock('../../../src/main/config-manager', () => ({ readConfig: vi.fn(() => [{ id: 'a', label: 'App', workingDirectory: 'F:\\proj' }]) }))
vi.mock('../../../src/main/data-paths', () => ({ getDataDirectory: () => 'F:\\data' }))
vi.mock('../../../src/main/tokenomics/tk-pricing', () => ({ getAllPricing: () => ({}), fetchModelPricing: vi.fn(() => Promise.resolve()) }))

import { initTokenomics, getTokenomicsSupervisor, shutdownTokenomics, refreshTokenomicsConfigs } from '../../../src/main/tokenomics/tokenomics-service'

describe('tokenomics-service', () => {
  beforeEach(() => { shutdownTokenomics(); forks.length = 0 })

  it('init forks once + posts open with dbPath + mapped configs; idempotent', () => {
    initTokenomics({ emit: () => {} })
    initTokenomics({ emit: () => {} })   // idempotent -> no second fork
    expect(forks).toHaveLength(1)
    const open = forks[0].workerMessages.find((m) => m.type === 'open') as any
    expect(open).toBeTruthy()
    expect(String(open.dbPath)).toContain('tokenomics.db')
    expect(open.configs).toEqual([{ configId: 'a', label: 'App', workingDirectory: 'F:\\proj' }])
    expect(getTokenomicsSupervisor()).not.toBeNull()
  })

  it('shutdown nulls the supervisor', () => {
    initTokenomics({ emit: () => {} })
    shutdownTokenomics()
    expect(getTokenomicsSupervisor()).toBeNull()
  })

  it('refreshTokenomicsConfigs pushes set-configs to the worker', () => {
    initTokenomics({ emit: () => {} })
    forks[0].workerMessages.length = 0
    refreshTokenomicsConfigs()
    expect(forks[0].workerMessages.some((m) => m.type === 'set-configs')).toBe(true)
  })
})
