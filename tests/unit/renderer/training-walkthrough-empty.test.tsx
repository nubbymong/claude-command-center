// @vitest-environment jsdom
/**
 * [host] PR 4 VM final (and review P411-4): the walkthrough draws the cards for
 * the assistants in use. When none is left to draw in its first-run mode, it
 * used to render nothing and never close, so its gate (training) stayed up and
 * nothing below it took a turn (#609: a gate the chain returns must render). It
 * now closes at once, stamping the tour version as a close does.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const { default: TrainingWalkthrough } = await import('../../../src/renderer/components/TrainingWalkthrough')
const { useAppMetaStore } = await import('../../../src/renderer/stores/appMetaStore')
const { useSettingsStore, DEFAULT_SETTINGS } = await import('../../../src/renderer/stores/settingsStore')
const { currentTrainingVersion } = await import('../../../src/renderer/training-steps')
const { choiceSettings } = await import('../../../src/renderer/onboarding/provider-choice')

let container: HTMLDivElement
let root: Root
const update = vi.fn()

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  update.mockReset()
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, ...choiceSettings('codex') }, isLoaded: true })
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function seen(version: string) {
  useAppMetaStore.setState({ meta: { lastTrainingVersion: version }, update } as never)
}

describe('the first-run walkthrough with no card to show', () => {
  it('closes at once and stamps the tour version, rather than drawing nothing and holding its gate', () => {
    seen(currentTrainingVersion())
    const onClose = vi.fn()
    act(() => root.render(<TrainingWalkthrough onClose={onClose} mode="first-run" />))
    expect(container.textContent).toBe('')
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(update).toHaveBeenCalledWith({ lastTrainingVersion: currentTrainingVersion() })
  })

  it('with a card to show it draws it and waits for the user', () => {
    seen('2.1.0')
    const onClose = vi.fn()
    act(() => root.render(<TrainingWalkthrough onClose={onClose} mode="first-run" />))
    expect(onClose).not.toHaveBeenCalled()
    expect(container.textContent).not.toBe('')
  })
})
