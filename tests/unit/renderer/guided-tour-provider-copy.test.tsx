// @vitest-environment jsdom
/**
 * P3.4 (row 14): the guided tour's first card names the assistants in use.
 * It said "runs your Claude Code and Codex sessions side by side" whatever
 * was switched off. It reads the providers the way the title bar does
 * (usesClaude, usesCodex): with both on it is word for word as before; with
 * one of them it names that one only. A Codex not answered yet is not in use.
 */
import React from 'react'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const { default: GuidedTour } = await import('../../../src/renderer/components/GuidedTour')
const { useSettingsStore, DEFAULT_SETTINGS } = await import('../../../src/renderer/stores/settingsStore')

const REST = 'A quick look at where things live, then we' + String.fromCodePoint(0x2019) + 'll start your first session.'

describe('GuidedTour: the first card names the assistants in use', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => { root.unmount() })
    container.remove()
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS } })
  })

  const cardText = (on: { claudeEnabled?: boolean; codexEnabled?: boolean }): string => {
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, ...on }, isLoaded: true })
    act(() => { root.render(React.createElement(GuidedTour, { onCreateConfig: () => {}, onClose: () => {} })) })
    expect(container.textContent).toContain('This is your workbench')
    return container.textContent ?? ''
  }

  it('both on: word for word as before', () => {
    expect(cardText({ claudeEnabled: true, codexEnabled: true })).toContain(`AI Code Conductor runs your Claude Code and Codex sessions side by side. ${REST}`)
  })

  it('Claude Code only (Codex off or not answered yet): names Claude Code alone', () => {
    for (const codexEnabled of [false, undefined]) {
      const t = cardText({ claudeEnabled: true, codexEnabled })
      expect(t, String(codexEnabled)).toContain(`AI Code Conductor runs your Claude Code sessions side by side. ${REST}`)
      expect(t, String(codexEnabled)).not.toContain('Codex')
    }
  })

  it('Codex only (Claude Code off): names Codex alone', () => {
    const t = cardText({ claudeEnabled: false, codexEnabled: true })
    expect(t).toContain(`AI Code Conductor runs your Codex sessions side by side. ${REST}`)
    expect(t).not.toContain('Claude')
  })

  it('follows a switch while the card is open', () => {
    cardText({ claudeEnabled: true, codexEnabled: true })
    act(() => { useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, claudeEnabled: false, codexEnabled: true } }) })
    expect(container.textContent).toContain('AI Code Conductor runs your Codex sessions side by side.')
  })
})
