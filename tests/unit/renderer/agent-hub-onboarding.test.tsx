// @vitest-environment jsdom
/**
 * Agent Hub first-run onboarding (comprehension uplift).
 * Locks the click-to-prefill examples + dismissible explainer behaviour.
 */
import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { AgentHubExplainer, AgentHubExamples } from '../../../src/renderer/components/agent-hub/AgentHubOnboarding'
import { AGENT_EXAMPLES } from '../../../src/renderer/components/agent-hub/example-templates'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

describe('AgentHubOnboarding', () => {
  let container: HTMLDivElement
  let root: Root
  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('renders one card per example and prefills onPick with the chosen example', () => {
    const onPick = vi.fn()
    const onNew = vi.fn()
    act(() => root.render(React.createElement(AgentHubExamples, { onPick, onNew })))

    const first = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent?.includes(AGENT_EXAMPLES[0].name)
    ) as HTMLButtonElement
    expect(first).toBeTruthy()

    act(() => { first.click() })
    expect(onPick).toHaveBeenCalledWith(AGENT_EXAMPLES[0])
  })

  it('the New agent CTA calls onNew and never onPick (blank dialog)', () => {
    const onPick = vi.fn()
    const onNew = vi.fn()
    act(() => root.render(React.createElement(AgentHubExamples, { onPick, onNew })))

    const cta = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent?.includes('New agent')
    ) as HTMLButtonElement
    expect(cta).toBeTruthy()

    act(() => { cta.click() })
    expect(onNew).toHaveBeenCalledTimes(1)
    expect(onPick).not.toHaveBeenCalled()
  })

  it('the explainer dismiss button calls onDismiss', () => {
    const onDismiss = vi.fn()
    act(() => root.render(React.createElement(AgentHubExplainer, { onDismiss })))

    const dismiss = container.querySelector('button[aria-label="Dismiss"]') as HTMLButtonElement
    expect(dismiss).toBeTruthy()

    act(() => { dismiss.click() })
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })
})
