/**
 * "Do you use Codex?", asked once of everyone who updates (owner decisions,
 * 2026-09-26): the gate's decision (src/renderer/onboarding/codex-reconfirm-gate.ts),
 * its place in the boot chain (src/renderer/utils/bootGates.ts), and the
 * settings load that drops an earlier build's Codex setting
 * (migrateCodexAnswer in src/renderer/stores/settingsStore.ts). All pure.
 *
 *   - armed for any launch that is not a fresh install and has not answered;
 *     never for a fresh install (it answers on the assistants page), nor
 *     once answered; the marker is the answer (codexAnswered), never "shown";
 *   - due while armed and unanswered, read live; once on screen only its own
 *     answer closes it (the store says answered before the page is done);
 *   - after the release notes and the upgrade harness (the *Due waits), and
 *     before logging consent, resume, the Multi Spawn page and Hello Codex;
 *   - the settings load drops `codexEnabled` saved without `codexAnswered`,
 *     so nothing carries over; an answered one, or none, is left alone.
 */
import { describe, it, expect, vi } from 'vitest'

const saved = vi.hoisted(() => ({ calls: [] as Array<[string, Record<string, unknown>]> }))
vi.mock('../../../src/renderer/utils/config-saver', () => ({
  saveConfigNow: vi.fn(async (key: string, data: Record<string, unknown>) => { saved.calls.push([key, data]); return true }),
}))

import { decideCodexReconfirm, codexReconfirmDue, codexAnswered } from '../../../src/renderer/onboarding/codex-reconfirm-gate'
import { pickBootGate, type BootGateState } from '../../../src/renderer/utils/bootGates'
import { migrateCodexAnswer, useSettingsStore, DEFAULT_SETTINGS, type AppSettings } from '../../../src/renderer/stores/settingsStore'

const V = '2.1.1-beta.2'

describe('decideCodexReconfirm: armed at boot', () => {
  it('an upgrade that has not answered: armed', () => {
    expect(decideCodexReconfirm({ answered: false, lastSeenVersion: '2.1.0', lastRunVersion: '2.1.0', currentVersion: V })).toEqual({ show: true, reason: 'due' })
  })

  it('the same version again, still unanswered (the app closed before an answer): armed again', () => {
    expect(decideCodexReconfirm({ answered: false, lastSeenVersion: V, lastRunVersion: V, currentVersion: V })).toEqual({ show: true, reason: 'due' })
  })

  it('a fresh install is never asked: it answers on the assistants page of its setup', () => {
    expect(decideCodexReconfirm({ answered: false, currentVersion: V })).toEqual({ show: false, reason: 'fresh-install' })
    // A record of an earlier run without a seen stamp is still somebody's first (decideUpgradeFlow).
    expect(decideCodexReconfirm({ answered: false, lastRunVersion: '2.1.0', currentVersion: V }).reason).toBe('fresh-install')
  })

  it('answered: never again, whatever the versions say', () => {
    for (const lastSeenVersion of [undefined, '2.0.0', '2.1.0', V]) {
      expect(decideCodexReconfirm({ answered: true, lastSeenVersion, currentVersion: V }), String(lastSeenVersion)).toEqual({ show: false, reason: 'answered' })
    }
  })

  it('the answer is the saved codexAnswered, and only a plain true', () => {
    expect(codexAnswered({ codexAnswered: true })).toBe(true)
    expect(codexAnswered({})).toBe(false)
    expect(codexAnswered({ codexAnswered: false })).toBe(false)
    expect(codexAnswered({ codexAnswered: 'yes' as never })).toBe(false)
  })
})

describe('codexReconfirmDue: while armed and unanswered, and once shown until answered there', () => {
  it('armed and unanswered: due', () => {
    expect(codexReconfirmDue({ armed: true, shown: false, answered: false })).toBe(true)
  })
  it('answered before its turn (a setup screen\'s "Use Codex only"): never shows', () => {
    expect(codexReconfirmDue({ armed: true, shown: false, answered: true })).toBe(false)
  })
  it('on screen: the store saying answered does not take it down; only its own answer does (armed false)', () => {
    expect(codexReconfirmDue({ armed: true, shown: true, answered: true })).toBe(true)
    expect(codexReconfirmDue({ armed: false, shown: true, answered: true })).toBe(false)
  })
  it('not armed: never', () => {
    expect(codexReconfirmDue({ armed: false, shown: false, answered: false })).toBe(false)
  })
})

function state(over: Partial<BootGateState> = {}): BootGateState {
  return {
    configLoaded: true, logsWipeBytes: 0, onboardingDue: false, showTraining: false, showTrainingAll: false,
    tourActive: false, showGuidedConfig: false, showGitHubOnboarding: false, loggingConsentSeen: true,
    resumePending: false, whatsNewDue: false, trainingDue: false, githubOnboardingDue: false,
    ...over,
  }
}

describe('its turn in the boot chain', () => {
  it('takes its turn when nothing above it is up or due', () => {
    expect(pickBootGate(state({ codexReconfirmDue: true }))).toBe('codexReconfirm')
  })

  it('after the release notes and the upgrade harness: it waits while they are due, and they outrank it when up', () => {
    for (const over of [{ whatsNewDue: true }, { trainingDue: true }, { githubOnboardingDue: true }] as Partial<BootGateState>[]) {
      expect(pickBootGate(state({ codexReconfirmDue: true, ...over })), JSON.stringify(over)).toBeNull()
    }
    expect(pickBootGate(state({ codexReconfirmDue: true, onboardingDue: true }))).toBe('onboarding')
    expect(pickBootGate(state({ codexReconfirmDue: true, showTraining: true }))).toBe('training')
  })

  it('a Yes hands over to the Codex setup page: the harness again, which outranks it', () => {
    // App clears the arm and sets the hand-off in one step; were both up at once,
    // the setup page wins.
    expect(pickBootGate(state({ codexReconfirmDue: true, onboardingDue: true }))).toBe('onboarding')
  })

  it('before the app: logging consent, resume, the Multi Spawn page and Hello Codex all wait for it', () => {
    expect(pickBootGate(state({ codexReconfirmDue: true, loggingConsentSeen: false }))).toBe('codexReconfirm')
    expect(pickBootGate(state({ codexReconfirmDue: true, resumePending: true }))).toBe('codexReconfirm')
    expect(pickBootGate(state({ codexReconfirmDue: true, multiSpawnIntroDue: true }))).toBe('codexReconfirm')
    expect(pickBootGate(state({ codexReconfirmDue: true, helloCodexOpen: true }))).toBe('codexReconfirm')
  })

  it('absent === false, like the other optional gates', () => {
    expect(pickBootGate(state())).toBeNull()
  })
})

describe('migrateCodexAnswer: an earlier build\'s Codex setting does not carry over', () => {
  const base = { ...DEFAULT_SETTINGS } as AppSettings

  it('codexEnabled saved without the answer is dropped, on or off', () => {
    for (const codexEnabled of [true, false]) {
      const r = migrateCodexAnswer({ ...base, codexEnabled })
      expect(r.changed, String(codexEnabled)).toBe(true)
      expect(Object.hasOwn(r.settings, 'codexEnabled'), String(codexEnabled)).toBe(false)
    }
  })

  it('an answered setting is kept exactly, and nothing to drop changes nothing', () => {
    const answered = { ...base, codexEnabled: false, codexAnswered: true }
    expect(migrateCodexAnswer(answered)).toEqual({ settings: answered, changed: false })
    expect(migrateCodexAnswer(base)).toEqual({ settings: base, changed: false })
  })

  it('leaves every other setting as it was', () => {
    const r = migrateCodexAnswer({ ...base, codexEnabled: true, claudeEnabled: false })
    expect(r.settings.claudeEnabled).toBe(false)
    const { codexEnabled: _gone, ...rest } = { ...base, codexEnabled: true, claudeEnabled: false }
    expect(r.settings).toEqual(rest)
  })
})

describe('the settings load applies it, and saves it', () => {
  it('an upgrader\'s saved codexEnabled is gone from the store and from the save, so every reader sees "not answered yet"', () => {
    saved.calls.length = 0
    useSettingsStore.getState().hydrate({ ...DEFAULT_SETTINGS, codexEnabled: true, gpuDefaultOnMigrated: true, fontMigratedV2: true } as AppSettings)
    expect(Object.hasOwn(useSettingsStore.getState().settings, 'codexEnabled')).toBe(false)
    expect(saved.calls).toHaveLength(1)
    expect(saved.calls[0][0]).toBe('settings')
    expect(Object.hasOwn(saved.calls[0][1], 'codexEnabled')).toBe(false)
  })

  it('an answered one loads as saved, and nothing is written for it', () => {
    saved.calls.length = 0
    useSettingsStore.getState().hydrate({ ...DEFAULT_SETTINGS, codexEnabled: false, codexAnswered: true, gpuDefaultOnMigrated: true, fontMigratedV2: true } as AppSettings)
    expect(useSettingsStore.getState().settings.codexEnabled).toBe(false)
    expect(useSettingsStore.getState().settings.codexAnswered).toBe(true)
    expect(saved.calls).toHaveLength(0)
  })
})
