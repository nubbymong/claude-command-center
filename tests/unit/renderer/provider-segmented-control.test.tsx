// @vitest-environment jsdom
/**
 * [host] P4.11 (row 54): the Codex "Beta" labels come off in the release where
 * parity lands, the provider chip's pill included (inventory review F-9).
 */
import { describe, it, expect, afterEach } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { ProviderSegmentedControl } from '../../../src/renderer/components/SessionDialog/ProviderSegmentedControl'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null
let host: HTMLDivElement | null = null

function render(props: Partial<React.ComponentProps<typeof ProviderSegmentedControl>> = {}): HTMLDivElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => {
    root!.render(<ProviderSegmentedControl value="claude" onChange={() => {}} sessionType="local" {...props} />)
  })
  return host
}

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null
  host = null
})

describe('ProviderSegmentedControl', () => {
  it('[host] the Codex chip carries no Beta pill, picked or not, on or off', () => {
    for (const props of [{}, { value: 'codex' as const }, { codexMasterOff: true }, { sessionType: 'ssh' as const }]) {
      const el = render(props)
      const radios = [...el.querySelectorAll('[role="radio"]')]
      expect(radios.map((r) => r.textContent?.trim())).toEqual(['Claude', 'Codex'])
      expect(el.textContent).not.toMatch(/beta/i)
      act(() => root?.unmount())
      host?.remove()
      root = null
      host = null
    }
  })
})
