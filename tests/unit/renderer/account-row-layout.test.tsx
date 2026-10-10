// @vitest-environment jsdom
/**
 * Settings, Accounts: the account row's grid. Every provider's rows are this
 * one component, so this is the layout of both cards. jsdom lays nothing out,
 * so these pin the classes and the cells the layout is made of:
 *   - every cell lines up on the first line of text (baseline), never centred
 *     on its own height, which scattered a one-line name below a cell that
 *     runs to three lines;
 *   - the six tracks, with the badge track never narrower than 128px (px,
 *     like the pills it holds), so a pill never runs into the state column;
 *   - a row with nothing for the plan track renders no plan cell and gives
 *     that track to the name, which otherwise truncated beside an empty one;
 *   - a row with a plan keeps its cell, and the name stays in its own track;
 *   - a long name wraps to a second line and is never truncated, with a plan
 *     cell or without one, and keeps its full text as its title;
 *   - the state cell breaks a long unbroken line (an email) anywhere, rather
 *     than run it under the "..." menu;
 *   - the layout is set on the cells themselves, never by a child selector
 *     on the grid (the "..." menu's root is a div too).
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../../src/renderer/lib/goToSession', () => ({ goToSession: vi.fn() }))

const { AccountRow } = await import('../../../src/renderer/components/settings/accounts/AccountRow')

const TRACKS = 'grid-cols-[26px_minmax(0,1.6fr)_minmax(0,1fr)_minmax(128px,1.1fr)_minmax(0,1.5fr)_28px]'

let container: HTMLElement | null = null
let root: Root | null = null
afterEach(() => {
  if (root) act(() => { root!.unmount() })
  container?.remove()
  root = null
  container = null
})

function renderRow(planCell?: React.ReactNode) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root!.render(React.createElement(AccountRow, {
      testId: 'row',
      chip: React.createElement('span', { 'data-testid': 'chip' }, 'W'),
      name: 'A name long enough to want the plan track',
      nameTestId: 'name',
      secondary: React.createElement('span', null, 'work@example.com'),
      planCell,
      badges: React.createElement('span', { 'data-testid': 'badge' }, 'Confirm each launch'),
      stateCell: React.createElement('span', { 'data-testid': 'state' }, 'Signed in'),
      menu: React.createElement('div', { 'data-testid': 'menu', className: 'menu-root' }, '...'),
    }))
  })
  const row = container.querySelector('[data-testid="row"]') as HTMLElement
  const grid = row.firstElementChild as HTMLElement
  const nameCell = container.querySelector('[data-testid="name"]')!.parentElement as HTMLElement
  return { grid, nameCell, cells: [...grid.children] as HTMLElement[] }
}

describe('the account row grid', () => {
  it('lines every cell up on its first line of text, never centred on its own height', () => {
    const { grid } = renderRow(null)
    expect(grid.classList.contains('grid')).toBe(true)
    expect(grid.classList.contains('items-baseline')).toBe(true)
    expect(grid.classList.contains('items-center')).toBe(false)
    expect(grid.classList.contains('items-start')).toBe(false)
  })

  it('keeps six tracks, the badge track never narrower than 128px', () => {
    const { grid } = renderRow(null)
    const templates = [...grid.classList].filter((c) => c.startsWith('grid-cols-'))
    expect(templates).toEqual([TRACKS])
  })

  it('a row with no plan renders no plan cell and gives the plan track to the name', () => {
    for (const planCell of [null, undefined]) {
      const { cells, nameCell } = renderRow(planCell)
      // chip, name, badges, state, menu
      expect(cells).toHaveLength(5)
      expect(cells[1]).toBe(nameCell)
      expect(nameCell.classList.contains('col-span-2')).toBe(true)
      expect(cells[2].querySelector('[data-testid="badge"]')).not.toBeNull()
      expect(cells[3].querySelector('[data-testid="state"]')).not.toBeNull()
      expect(cells[4].getAttribute('data-testid')).toBe('menu')
      act(() => { root!.unmount() })
      container!.remove()
      root = null
      container = null
    }
  })

  it('a row with a plan keeps its plan cell, and the name stays in its own track', () => {
    const { cells, nameCell } = renderRow(React.createElement('span', { 'data-testid': 'plan' }, 'ChatGPT Plus'))
    expect(cells).toHaveLength(6)
    expect(cells[1]).toBe(nameCell)
    expect(nameCell.classList.contains('col-span-2')).toBe(false)
    expect(cells[2].querySelector('[data-testid="plan"]')?.textContent).toBe('ChatGPT Plus')
    expect(cells[3].querySelector('[data-testid="badge"]')).not.toBeNull()
  })

  it.each<[string, React.ReactNode]>([
    ['no plan', null],
    ['a plan', React.createElement('span', null, 'Plus')],
  ])('with %s, a long name wraps to two lines, is never truncated, and keeps its full text as its title', (_label, planCell) => {
    const { nameCell } = renderRow(planCell)
    const name = nameCell.querySelector('[data-testid="name"]') as HTMLElement
    expect(name.classList.contains('line-clamp-2')).toBe(true)
    expect(name.classList.contains('[overflow-wrap:anywhere]')).toBe(true)
    expect(name.classList.contains('truncate')).toBe(false)
    expect(name.classList.contains('whitespace-nowrap')).toBe(false)
    expect(name.getAttribute('title')).toBe('A name long enough to want the plan track')
  })

  it('breaks a long unbroken line in the state cell anywhere, rather than run it under the menu', () => {
    const { cells } = renderRow(null)
    // chip, name, badges, state, menu
    expect(cells[3].querySelector('[data-testid="state"]')).not.toBeNull()
    expect(cells[3].classList.contains('[overflow-wrap:anywhere]')).toBe(true)
  })

  it('sets the layout on the cells, never with a child selector on the grid', () => {
    const { grid } = renderRow(null)
    expect(grid.className).not.toContain('[&')
    const menu = grid.querySelector('[data-testid="menu"]') as HTMLElement
    expect(menu.parentElement).toBe(grid)
    expect(menu.className).toBe('menu-root')
  })
})
