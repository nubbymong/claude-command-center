import { create } from 'zustand'
import { saveConfigNow } from '../utils/config-saver'
import { generateId } from '../utils/id'
import { isAllowedBrowserUrl, cleanDisplayText } from '../../shared/browser-url'

/**
 * What the browser pane REMEMBERS across restarts: saved favourites (one list,
 * app-wide -- the owner's call for item 26 was "per session, with saved
 * favourites") and a home page per saved config, so a session launched from
 * that config opens on it.
 *
 * Persisted under config key `browser` as
 *   { favourites: [{ id, url, title, addedAt }], homeByConfig: { [configId]: url } }
 *
 * What the pane is showing right now (the URL, history, whether it is open)
 * is per SESSION and volatile -- that stays in webviewStore.
 *
 * Every URL that enters this store is re-checked against the one shared rule
 * (http/https, no credentials, bounded); a hand-edited browser.json cannot
 * plant a file:// favourite. Every record field is bounded on the way in --
 * ids, titles, config ids -- and titles are cleaned of control/bidi
 * characters, because the favourites bar RENDERS them.
 */
export interface BrowserFavourite {
  id: string
  url: string
  title: string
  addedAt: number
}

export interface BrowserPersistedState {
  favourites: BrowserFavourite[]
  homeByConfig: Record<string, string>
}

interface State extends BrowserPersistedState {
  isLoaded: boolean
}

interface Actions {
  hydrate: (raw: unknown) => void
  /** Add `url` to the favourites (no-op when already there). Returns the id. */
  addFavourite: (url: string, title?: string) => string | null
  removeFavourite: (id: string) => void
  /** Star toggle on the current page. */
  toggleFavourite: (url: string, title?: string) => void
  isFavourite: (url: string) => boolean
  /** Set (or with null, clear) the home page for a saved config. */
  setHome: (configId: string, url: string | null) => void
  homeFor: (configId: string | undefined) => string | null
}

const MAX_FAVOURITES = 200
const MAX_TITLE = 200
const MAX_ID = 64
const MAX_CONFIG_ID = 200

/** A favourite id as stored: the app's own ids are 24 hex, but a hand-edited
 *  file could hold anything, and an id is a React key and a delete handle --
 *  it must be bounded, plain, and unique within the list. */
function cleanId(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw || raw.length > MAX_ID) return null
  return /^[A-Za-z0-9_-]+$/.test(raw) ? raw : null
}

function sanitiseFavourites(raw: unknown): BrowserFavourite[] {
  if (!Array.isArray(raw)) return []
  const out: BrowserFavourite[] = []
  const seenUrl = new Set<string>()
  const seenId = new Set<string>()
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const f = item as Partial<BrowserFavourite>
    if (!isAllowedBrowserUrl(f.url)) continue
    const url = f.url
    if (seenUrl.has(url)) continue
    seenUrl.add(url)
    let id = cleanId(f.id) ?? generateId()
    // Two records with one id would both vanish on a single remove and
    // collide as React keys; the second gets a fresh id.
    while (seenId.has(id)) id = generateId()
    seenId.add(id)
    out.push({
      id,
      url,
      title: cleanDisplayText(f.title, MAX_TITLE),
      addedAt: typeof f.addedAt === 'number' && Number.isFinite(f.addedAt) ? f.addedAt : 0,
    })
    if (out.length >= MAX_FAVOURITES) break
  }
  return out
}

/** Keys a hand-edited browser.json must not be allowed to plant on a plain
 *  object: assigning them does something other than store a value. */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

/** The one rule for a config id as a home-page key: the app's own ids, bounded,
 *  never a prototype key. Applied on hydrate AND on setHome so a key that
 *  would be dropped at the next start is never accepted now. */
function isUsableConfigId(configId: unknown): configId is string {
  return typeof configId === 'string' && configId.length > 0 && configId.length <= MAX_CONFIG_ID && !FORBIDDEN_KEYS.has(configId)
}

function sanitiseHomes(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Record<string, string> = {}
  for (const [configId, url] of Object.entries(raw as Record<string, unknown>)) {
    if (!isUsableConfigId(configId)) continue
    if (!isAllowedBrowserUrl(url)) continue
    out[configId] = url
  }
  return out
}

const persist = (state: BrowserPersistedState) => {
  const data: BrowserPersistedState = { favourites: state.favourites, homeByConfig: state.homeByConfig }
  // Favourites and home are explicit user actions (a star, a "set as home"),
  // never a storm -- save now, so a crash a second later does not lose them.
  saveConfigNow('browser', data)
}

export const useBrowserStore = create<State & Actions>((set, get) => ({
  favourites: [],
  homeByConfig: {},
  isLoaded: false,

  hydrate: (raw) => {
    const obj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
    set({
      favourites: sanitiseFavourites(obj.favourites),
      homeByConfig: sanitiseHomes(obj.homeByConfig),
      isLoaded: true,
    })
  },

  addFavourite: (url, title) => {
    if (!isAllowedBrowserUrl(url)) return null
    const existing = get().favourites.find((f) => f.url === url)
    if (existing) return existing.id
    if (get().favourites.length >= MAX_FAVOURITES) return null
    const fav: BrowserFavourite = {
      id: generateId(),
      url,
      title: cleanDisplayText(title ?? '', MAX_TITLE),
      addedAt: Date.now(),
    }
    const favourites = [...get().favourites, fav]
    set({ favourites })
    persist({ favourites, homeByConfig: get().homeByConfig })
    return fav.id
  },

  removeFavourite: (id) => {
    const favourites = get().favourites.filter((f) => f.id !== id)
    if (favourites.length === get().favourites.length) return
    set({ favourites })
    persist({ favourites, homeByConfig: get().homeByConfig })
  },

  toggleFavourite: (url, title) => {
    const existing = get().favourites.find((f) => f.url === url)
    if (existing) get().removeFavourite(existing.id)
    else get().addFavourite(url, title)
  },

  isFavourite: (url) => get().favourites.some((f) => f.url === url),

  setHome: (configId, url) => {
    if (!isUsableConfigId(configId)) return
    const homeByConfig = { ...get().homeByConfig }
    if (url === null) {
      if (!Object.hasOwn(homeByConfig, configId)) return
      delete homeByConfig[configId]
    } else {
      if (!isAllowedBrowserUrl(url)) return
      if (homeByConfig[configId] === url) return
      homeByConfig[configId] = url
    }
    set({ homeByConfig })
    persist({ favourites: get().favourites, homeByConfig })
  },

  // Own-property read: `homeByConfig['constructor']` on a plain object is a
  // function, not a URL.
  homeFor: (configId) => {
    if (!configId) return null
    const homes = get().homeByConfig
    return Object.hasOwn(homes, configId) ? homes[configId] : null
  },
}))
