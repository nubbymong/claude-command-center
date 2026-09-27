// Usage track MP6: the multi-account footer shows each provider's meters in
// their own group, so its hidden labels are kept per provider
// (`<provider>:<label>`). A bare label written before that was Claude Code's
// (the only provider the footer showed) and becomes `claude:<label>` at load,
// once: the migration is idempotent, keeps entries already scoped to a
// provider, drops duplicates and leaves a list with nothing to change alone.
// The per-session strip's own hidden list stays one list, untouched.
//
// PURE: the real settings store with its disk writer stubbed.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const saveConfigNow = vi.fn(async (_name: string, _value: unknown) => true)
vi.mock('../../../src/renderer/utils/config-saver', () => ({ saveConfigNow: (n: string, v: unknown) => saveConfigNow(n, v) }))

const { migrateFooterHiddenBuckets, useSettingsStore, DEFAULT_SETTINGS } = await import('../../../src/renderer/stores/settingsStore')
type AppSettings = Parameters<typeof migrateFooterHiddenBuckets>[0]

const withHidden = (list: unknown): AppSettings => ({ ...DEFAULT_SETTINGS, footerHiddenUsageBuckets: list as string[] })

beforeEach(() => { saveConfigNow.mockClear() })

describe('migrateFooterHiddenBuckets (usage track MP6)', () => {
  it('moves a bare label to Claude Code\'s', () => {
    const r = migrateFooterHiddenBuckets(withHidden(['Fable', 'Weekly']))
    expect(r.changed).toBe(true)
    expect(r.settings.footerHiddenUsageBuckets).toEqual(['claude:Fable', 'claude:Weekly'])
  })

  it('keeps entries already scoped to a provider, and drops duplicates', () => {
    const r = migrateFooterHiddenBuckets(withHidden(['codex:Weekly', 'Fable', 'claude:Fable', 'claude:5h']))
    expect(r.settings.footerHiddenUsageBuckets).toEqual(['codex:Weekly', 'claude:Fable', 'claude:5h'])
  })

  it('treats a colon that names no provider as part of a bare label', () => {
    const r = migrateFooterHiddenBuckets(withHidden(['Opus: extended']))
    expect(r.settings.footerHiddenUsageBuckets).toEqual(['claude:Opus: extended'])
  })

  it('is idempotent: a second run changes nothing and returns the same settings', () => {
    const once = migrateFooterHiddenBuckets(withHidden(['Fable', 'codex:5h']))
    const twice = migrateFooterHiddenBuckets(once.settings)
    expect(twice.changed).toBe(false)
    expect(twice.settings).toBe(once.settings)
  })

  it('leaves an absent, empty or already-scoped list alone', () => {
    for (const list of [undefined, [], ['claude:Fable', 'codex:Weekly']]) {
      const s = withHidden(list)
      const r = migrateFooterHiddenBuckets(s)
      expect(r.changed).toBe(false)
      expect(r.settings).toBe(s)
    }
  })

  it('drops a value that is not a label', () => {
    const r = migrateFooterHiddenBuckets(withHidden(['Fable', 42, '', null]))
    expect(r.settings.footerHiddenUsageBuckets).toEqual(['claude:Fable'])
  })

  it('runs at load and saves once; the per-session list is not touched', () => {
    useSettingsStore.getState().hydrate({ ...DEFAULT_SETTINGS, footerHiddenUsageBuckets: ['Fable'], hiddenUsageBuckets: ['Fable'] })
    expect(useSettingsStore.getState().settings.footerHiddenUsageBuckets).toEqual(['claude:Fable'])
    expect(useSettingsStore.getState().settings.hiddenUsageBuckets).toEqual(['Fable'])
    expect(saveConfigNow).toHaveBeenCalledTimes(1)
    saveConfigNow.mockClear()
    useSettingsStore.getState().hydrate(useSettingsStore.getState().settings)
    expect(saveConfigNow).not.toHaveBeenCalled()
  })
})
