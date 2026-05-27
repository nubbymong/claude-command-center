// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../../src/renderer/hooks/useThemeController', () => ({
  useResolvedTheme: () => 'dark',
}))

const { default: RepoBreadcrumb } = await import('../../../src/renderer/components/RepoBreadcrumb')
const { useSettingsStore, DEFAULT_SETTINGS } = await import('../../../src/renderer/stores/settingsStore')

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS }, isLoaded: true } as any)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

function render(session: any) {
  act(() => { root.render(createElement(RepoBreadcrumb, { session })) })
}

describe('RepoBreadcrumb account chip', () => {
  it('shows the account email alongside the path', () => {
    render({ id: 's1', workingDirectory: '/home/me/proj', accountEmail: 'me@example.com', accountColour: 'violet' })
    expect(container.textContent).toContain('me@example.com')
    expect(container.textContent).toContain('/home/me/proj')
  })

  it('omits the chip when there is no account email', () => {
    render({ id: 's1', workingDirectory: '/home/me/proj' })
    expect(container.querySelector('[data-testid="account-chip"]')).toBeNull()
    // breadcrumb itself still renders because cwd is present
    expect(container.textContent).toContain('/home/me/proj')
  })
})
