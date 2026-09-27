/// <reference types="vite/client" />
// WP2 commit 6d: a settings save republishes the accounts snapshot, so a
// provider switched on over a saved "off" shows as on once the renderer's
// save lands (AccountsService.settingsChanged, tested in
// tests/wp1/consumer-leases.test.ts). This pins the wiring in main's start-up:
// the config handlers' onSettingsSaved hook must call it.
import { describe, it, expect } from 'vitest'
import indexSource from '../../../src/main/index.ts?raw'

describe('settings save -> accounts snapshot wiring', () => {
  it('onSettingsSaved tells the accounts service the settings changed', () => {
    const start = indexSource.indexOf('onSettingsSaved:')
    expect(start).toBeGreaterThan(-1)
    // The hook's body: up to the end of the registerConfigHandlers call.
    const body = indexSource.slice(start, indexSource.indexOf('})', start))
    expect(body).toMatch(/getAccountsService\(\)\?\.settingsChanged\(\)/)
    // The watchdog still gets its call too.
    expect(body).toMatch(/getWatchdogManager\(\)\?\.applySettings\(\)/)
  })

  it('each call has its own try, so a watchdog failure never skips the accounts service (WP2 final fixes)', () => {
    // main/index.ts runs only in the booted app, so the wiring is pinned by its text, as above.
    const start = indexSource.indexOf('onSettingsSaved:')
    const body = indexSource.slice(start, indexSource.indexOf('})', start))
    expect(body).toMatch(/try \{ getWatchdogManager\(\)\?\.applySettings\(\) \} catch \(err\) \{ logError\(/)
    expect(body).toMatch(/try \{ getAccountsService\(\)\?\.settingsChanged\(\) \} catch \(err\) \{ logError\(/)
  })
})
