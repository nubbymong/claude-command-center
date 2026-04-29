import { describe, it, expectTypeOf } from 'vitest'
import type {
  SessionProvider,
  SshCapableProvider,
  SpawnOptions,
  TelemetrySource,
  HistorySession,
} from '../../../src/main/providers/types'

describe('provider types', () => {
  it('SessionProvider has required methods', () => {
    expectTypeOf<SessionProvider>().toHaveProperty('id')
    expectTypeOf<SessionProvider>().toHaveProperty('displayName')
    expectTypeOf<SessionProvider>().toHaveProperty('resolveBinary')
    expectTypeOf<SessionProvider>().toHaveProperty('buildSpawnCommand')
    expectTypeOf<SessionProvider>().toHaveProperty('detectUiRunning')
    expectTypeOf<SessionProvider>().toHaveProperty('ingestSessionTelemetry')
    expectTypeOf<SessionProvider>().toHaveProperty('listHistorySessions')
    expectTypeOf<SessionProvider>().toHaveProperty('resumeCommand')
    expectTypeOf<SessionProvider>().toHaveProperty('configureMcpServer')
  })

  it('SshCapableProvider extends SessionProvider with SSH methods', () => {
    expectTypeOf<SshCapableProvider>().toMatchTypeOf<SessionProvider>()
    expectTypeOf<SshCapableProvider>().toHaveProperty('getSshSettingsPath')
    expectTypeOf<SshCapableProvider>().toHaveProperty('configureRemoteSettings')
  })
})
