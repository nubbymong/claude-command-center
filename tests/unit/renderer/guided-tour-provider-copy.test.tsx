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

// The follow-up sweep: every card, walked with each anchor mounted.
describe('GuidedTour: every card, per assistants in use', () => {
  const DASH = String.fromCodePoint(0x2014)
  const BOTH = { claudeEnabled: true, codexEnabled: true }
  const CLAUDE_ONLY = { claudeEnabled: true, codexEnabled: false }
  const CODEX_ONLY = { claudeEnabled: false, codexEnabled: true }
  const ANCHORS = ['nav-rail', 'new-config', 'canvas-button', 'nav-settings', 'help-button']
  let container: HTMLDivElement
  let root: Root
  let anchors: HTMLElement[]

  beforeEach(() => {
    anchors = ANCHORS.map((a) => { const el = document.createElement('div'); el.setAttribute('data-tour', a); document.body.appendChild(el); return el })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => { root.unmount() })
    container.remove()
    for (const el of anchors) el.remove()
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS } })
  })

  /** Each card's body text by its title, first to last, as the tour shows them. */
  function walk(on: { claudeEnabled?: boolean; codexEnabled?: boolean }): Map<string, string> {
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, ...on }, isLoaded: true })
    act(() => { root.render(React.createElement(GuidedTour, { onCreateConfig: () => {}, onClose: () => {} })) })
    const cards = new Map<string, string>()
    for (let n = 0; n < 7; n++) {
      const text = container.textContent ?? ''
      const title = ['This is your workbench', 'Everything has a home', 'Saved configs live here', 'Review what your agent builds', 'Change anything, anytime', 'Help lives here', 'Ready to go'].find((t) => text.includes(t))!
      // The body is the element right after the title.
      const titleEl = [...container.querySelectorAll('div')].find((d) => d.children.length === 0 && d.textContent === title)!
      cards.set(title, titleEl.nextElementSibling?.textContent ?? '')
      if (n < 6) act(() => { [...container.querySelectorAll('button')].find((b) => b.textContent?.startsWith('Next'))!.click() })
    }
    expect(cards.size).toBe(7)
    return cards
  }

  it('Codex only: no card mentions Claude; the saved-config card says Codex runs on this computer', () => {
    const cards = walk(CODEX_ONLY)
    for (const [title, text] of cards) expect(text, title).not.toContain('Claude')
    expect(cards.get('Saved configs live here')).toContain('whenever you want (Codex, on this computer).')
    expect(cards.get('Saved configs live here')).not.toContain('SSH')
    expect(cards.get('Review what your agent builds')).toContain('A Codex agent cannot put work there yet.')
    expect(cards.get('Review what your agent builds')).not.toContain('Your agent renders')
    expect(cards.get('Help lives here')).toContain('The Feature Guide explains every feature in depth whenever you want it.')
  })

  it('Claude Code only (Codex off or not answered yet): no card mentions Codex', () => {
    for (const on of [CLAUDE_ONLY, { claudeEnabled: true }]) {
      act(() => { root.unmount() })
      root = createRoot(container)
      const cards = walk(on)
      for (const [title, text] of cards) expect(text, `${title} ${JSON.stringify(on)}`).not.toContain('Codex')
      expect(cards.get('Saved configs live here')).toContain(`whenever you want (Claude, here or on another machine over SSH ${DASH} plain, or persistent so a dropped link does not kill it).`)
      expect(cards.get('Review what your agent builds')).toContain('anyone here can pick up.')
      expect(cards.get('Help lives here')).toContain('with Claude Code on, can hand your question to Ask Conductor, a Claude session that knows the app.')
    }
  })

  // The canvas card as it read before this sweep, less its last sentence
  // (the Codex note 21fff8bc added), which is also how it read before that.
  const CANVAS_BEFORE_NOTE = `Every session has a Canvas button beside Snap. Your agent renders a mockup, a plan, or the site it just built, and you review it by pointing: click an element to leave a note, draw over it, then decide ${DASH} approve that version, or send it back for another round. Testing mode goes further ${DASH} click through a running build and every note saves the screen, the page state and how you got there. A small dot on the button means there is unfinished canvas work anyone here can pick up.`

  it('Claude Code only: the canvas card reads as it did before the Codex note, whole', () => {
    expect(walk(CLAUDE_ONLY).get('Review what your agent builds')).toBe(CANVAS_BEFORE_NOTE)
  })

  it('both on: every card word for word as before', () => {
    const cards = walk(BOTH)
    expect(cards.get('Saved configs live here')).toBe(`The left panel has two modes ${DASH} Saved is your launcher, Running is your live sessions. A saved config is a reusable launcher: project folder, model, account. Open the Saved tab, press "+ New" and pick Config to create one, then start a session from it whenever you want (Claude or Codex here, or Claude on another machine over SSH ${DASH} plain, or persistent so a dropped link does not kill it).`)
    expect(cards.get('Review what your agent builds')).toBe(`${CANVAS_BEFORE_NOTE} Claude sessions draw on it; a Codex agent cannot put work there yet.`)
    expect(cards.get('Help lives here')).toBe('The Feature Guide explains every feature in depth whenever you want it and, with Claude Code on, can hand your question to Ask Conductor, a Claude session that knows the app.')
    expect(cards.get('Everything has a home')).toContain('Cloud Agents, Insights, Tokenomics, Memory, Logs and the built-in tools (Conductor MCP) all live on this rail')
    expect(cards.get('Change anything, anytime')).toContain('Everything you just set up lives in Settings: your assistants and their accounts under Accounts, GitHub, the status line and the built-in tools.')
  })
})
