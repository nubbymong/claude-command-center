// @vitest-environment jsdom
/**
 * Task 7 (V2 shell colour migration): ConfigRow's identity dot resolves its
 * colour through resolveIdentityColor(identityColorKey ?? bucketLegacyColorToKey(color), theme),
 * so a migrated record (has identityColorKey) and an un-migrated one (legacy
 * raw hex only) both render a concrete theme hex -- never a CSS var.
 *
 * Uses React.createElement (not JSX) so the file stays a *.test.ts under the
 * vitest include pattern -- matches sibling renderer tests. The settings-store
 * mock mirrors contextbar-account-slot.test.ts (selector + getState, theme:'dark').
 */
import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

// --- mock useSettingsStore before component import ---
// useResolvedTheme reads settings.theme via both a selector call and getState().
vi.mock('../../../src/renderer/stores/settingsStore', () => {
  const STATE = { settings: { theme: 'dark' as const } }
  const useSettingsStore: any = (selector: (s: typeof STATE) => unknown) => selector(STATE)
  useSettingsStore.getState = () => STATE
  return { useSettingsStore }
})

// Import after mock is registered
const { default: ConfigRow } = await import('../../../src/renderer/components/sidebar/ConfigRow')
const { resolveIdentityColor, bucketLegacyColorToKey } = await import('../../../src/shared/identity-colors')

const THEME = 'dark' as const

const baseConfig = {
  id: 'c1',
  provider: 'claude' as const,
  label: 'Test Config',
  workingDirectory: '.',
  sessionType: 'local' as const,
}

const rowProps = {
  onLaunch: () => {},
  onEdit: () => {},
  onDelete: () => {},
  onContextMenu: () => {},
}

function dot(container: HTMLElement): HTMLElement | null {
  // The identity dot is the aria-hidden span carrying the inline backgroundColor.
  return container.querySelector<HTMLElement>('span[aria-hidden]')
}

describe('ConfigRow identity colour', () => {
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
  })

  it('renders the dot using resolveIdentityColor for a config with identityColorKey', () => {
    act(() => {
      root.render(React.createElement(ConfigRow, {
        ...(rowProps as any),
        config: { ...baseConfig, identityColorKey: 'rose', color: '#ffffff' },
      }))
    })
    const el = dot(container)
    expect(el).toBeTruthy()
    expect(el!.style.backgroundColor).toBe(toRgb(resolveIdentityColor('rose', THEME)))
  })

  it('renders the same colour from a legacy raw hex (no key) as the bucketed key would', () => {
    act(() => {
      root.render(React.createElement(ConfigRow, {
        ...(rowProps as any),
        config: { ...baseConfig, color: '#00FFFF' },
      }))
    })
    const el = dot(container)
    const expectedKey = bucketLegacyColorToKey('#00FFFF')
    expect(el!.style.backgroundColor).toBe(toRgb(resolveIdentityColor(expectedKey, THEME)))
  })

  it('does not render the dot colour as a CSS var', () => {
    act(() => {
      root.render(React.createElement(ConfigRow, {
        ...(rowProps as any),
        config: { ...baseConfig, identityColorKey: 'mauve', color: '' },
      }))
    })
    const style = dot(container)?.getAttribute('style') || ''
    expect(style).not.toContain('var(')
  })
})

// jsdom normalises inline style colours to rgb(...) form; convert our hex
// expectation the same way so the assertions compare like-for-like.
function toRgb(hex: string): string {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex)
  if (!m) return hex
  const r = parseInt(m[1], 16)
  const g = parseInt(m[2], 16)
  const b = parseInt(m[3], 16)
  return `rgb(${r}, ${g}, ${b})`
}
