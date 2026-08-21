/**
 * browserStore -- what the browser pane remembers across restarts: saved
 * favourites (app-wide) and a home page per saved config. Every URL that
 * enters is re-checked against the shared http/https rule, so a hand-edited
 * browser.json cannot plant a file:// favourite that the pane would then load.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const saveConfigNow = vi.fn()
vi.mock('../../../src/renderer/utils/config-saver', () => ({
  saveConfigNow: (...a: unknown[]) => saveConfigNow(...a),
  saveConfigDebounced: vi.fn(),
}))

const { useBrowserStore } = await import('../../../src/renderer/stores/browserStore')

const fresh = () => useBrowserStore.setState({ favourites: [], homeByConfig: {}, isLoaded: false })
const lastSaved = () => saveConfigNow.mock.calls.at(-1)?.[1] as { favourites: unknown[]; homeByConfig: Record<string, string> }

beforeEach(() => {
  fresh()
  saveConfigNow.mockClear()
})

describe('hydrate defends the file', () => {
  it('accepts a good file', () => {
    useBrowserStore.getState().hydrate({
      favourites: [{ id: 'a', url: 'https://example.com/', title: 'Example', addedAt: 5 }],
      homeByConfig: { cfg1: 'http://localhost:5173/' },
    })
    const s = useBrowserStore.getState()
    expect(s.favourites).toEqual([{ id: 'a', url: 'https://example.com/', title: 'Example', addedAt: 5 }])
    expect(s.homeByConfig).toEqual({ cfg1: 'http://localhost:5173/' })
    expect(s.isLoaded).toBe(true)
  })
  it('drops favourites and homes that are not http/https -- a planted file:// never reaches the pane', () => {
    useBrowserStore.getState().hydrate({
      favourites: [
        { id: 'f', url: 'file:///C:/Windows/win.ini', title: 'x', addedAt: 1 },
        { id: 'j', url: 'javascript:alert(1)', title: 'x', addedAt: 1 },
        { id: 'ok', url: 'http://localhost:3000/', title: 'ok', addedAt: 1 },
        'garbage',
        null,
        { id: 'nourl', title: 'no url' },
      ],
      homeByConfig: { cfg1: 'file:///etc/passwd', cfg2: 'https://good.example/', '': 'https://x.y/', cfg3: 42 },
    })
    const s = useBrowserStore.getState()
    expect(s.favourites.map((f) => f.url)).toEqual(['http://localhost:3000/'])
    expect(s.homeByConfig).toEqual({ cfg2: 'https://good.example/' })
  })
  it('survives wrong shapes (string, array, null) with empty defaults', () => {
    for (const raw of [null, undefined, 'nope', 42, [], { favourites: 'x', homeByConfig: [] }, { favourites: {}, homeByConfig: 'y' }]) {
      fresh()
      useBrowserStore.getState().hydrate(raw)
      expect(useBrowserStore.getState().favourites).toEqual([])
      expect(useBrowserStore.getState().homeByConfig).toEqual({})
    }
  })
  it('de-duplicates by url, fills a missing id, clamps a long title, and caps the list', () => {
    const many = Array.from({ length: 250 }, (_, i) => ({ url: `https://h${i}.example/`, title: 't'.repeat(500) }))
    useBrowserStore.getState().hydrate({ favourites: [{ url: 'https://a.b/' }, { url: 'https://a.b/' }, ...many] })
    const s = useBrowserStore.getState()
    expect(s.favourites.length).toBe(200)
    expect(s.favourites[0].url).toBe('https://a.b/')
    expect(s.favourites[0].id).toBeTruthy()
    expect(s.favourites[1].title.length).toBe(200)
    expect(s.favourites.filter((f) => f.url === 'https://a.b/').length).toBe(1)
  })
  it('does not write anything back while hydrating', () => {
    useBrowserStore.getState().hydrate({ favourites: [{ url: 'https://a.b/' }] })
    expect(saveConfigNow).not.toHaveBeenCalled()
  })
})

describe('favourites', () => {
  it('add persists NOW under the browser key, and is idempotent by url', () => {
    const id = useBrowserStore.getState().addFavourite('https://example.com/', 'Example')
    expect(id).toBeTruthy()
    expect(saveConfigNow).toHaveBeenCalledTimes(1)
    expect(saveConfigNow.mock.calls[0][0]).toBe('browser')
    expect(lastSaved().favourites).toHaveLength(1)
    const again = useBrowserStore.getState().addFavourite('https://example.com/', 'Example again')
    expect(again).toBe(id)
    expect(useBrowserStore.getState().favourites).toHaveLength(1)
    expect(saveConfigNow).toHaveBeenCalledTimes(1)
  })
  it('refuses a non-http(s) url', () => {
    expect(useBrowserStore.getState().addFavourite('file:///x')).toBeNull()
    expect(useBrowserStore.getState().addFavourite('javascript:1')).toBeNull()
    expect(useBrowserStore.getState().favourites).toEqual([])
    expect(saveConfigNow).not.toHaveBeenCalled()
  })
  it('toggle adds then removes; isFavourite follows', () => {
    const st = useBrowserStore.getState()
    st.toggleFavourite('https://a.b/', 'A')
    expect(useBrowserStore.getState().isFavourite('https://a.b/')).toBe(true)
    useBrowserStore.getState().toggleFavourite('https://a.b/')
    expect(useBrowserStore.getState().isFavourite('https://a.b/')).toBe(false)
    expect(useBrowserStore.getState().favourites).toEqual([])
    expect(saveConfigNow).toHaveBeenCalledTimes(2)
  })
  it('remove of an unknown id does not write', () => {
    useBrowserStore.getState().removeFavourite('nope')
    expect(saveConfigNow).not.toHaveBeenCalled()
  })
  it('caps at 200', () => {
    for (let i = 0; i < 200; i++) useBrowserStore.getState().addFavourite(`https://h${i}.example/`)
    expect(useBrowserStore.getState().addFavourite('https://one-more.example/')).toBeNull()
    expect(useBrowserStore.getState().favourites).toHaveLength(200)
  })
})

describe('home per config', () => {
  it('set, read back, clear; each persists now', () => {
    const st = useBrowserStore.getState()
    st.setHome('cfg1', 'http://localhost:5173/')
    expect(useBrowserStore.getState().homeFor('cfg1')).toBe('http://localhost:5173/')
    expect(useBrowserStore.getState().homeFor('cfg2')).toBeNull()
    expect(useBrowserStore.getState().homeFor(undefined)).toBeNull()
    expect(lastSaved().homeByConfig).toEqual({ cfg1: 'http://localhost:5173/' })
    useBrowserStore.getState().setHome('cfg1', null)
    expect(useBrowserStore.getState().homeFor('cfg1')).toBeNull()
    expect(lastSaved().homeByConfig).toEqual({})
    expect(saveConfigNow).toHaveBeenCalledTimes(2)
  })
  it('refuses a non-http(s) home and an empty config id; no write', () => {
    useBrowserStore.getState().setHome('cfg1', 'file:///x')
    useBrowserStore.getState().setHome('', 'https://x.y/')
    expect(useBrowserStore.getState().homeByConfig).toEqual({})
    expect(saveConfigNow).not.toHaveBeenCalled()
  })
  it('setting the same home twice, or clearing an unset one, does not write', () => {
    useBrowserStore.getState().setHome('cfg1', 'https://x.y/')
    useBrowserStore.getState().setHome('cfg1', 'https://x.y/')
    useBrowserStore.getState().setHome('cfg9', null)
    expect(saveConfigNow).toHaveBeenCalledTimes(1)
  })
  it('persists favourites and homes TOGETHER -- one does not clobber the other', () => {
    useBrowserStore.getState().addFavourite('https://a.b/')
    useBrowserStore.getState().setHome('cfg1', 'https://c.d/')
    expect(lastSaved()).toEqual({
      favourites: [expect.objectContaining({ url: 'https://a.b/' })],
      homeByConfig: { cfg1: 'https://c.d/' },
    })
  })
})
