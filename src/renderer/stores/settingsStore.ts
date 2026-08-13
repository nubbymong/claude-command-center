import { create } from 'zustand'
import { saveConfigNow } from '../utils/config-saver'
import { DEFAULT_SHORTCUTS } from '../utils/shortcuts'
import { migrateTypography } from './migrateTypography'

export type StatusLineFont = 'sans' | 'mono'

export interface StatusLineSettings {
  showModel: boolean
  showEffort: boolean
  showAccount: boolean
  showTokens: boolean
  showContextBar: boolean
  showCost: boolean
  showLinesChanged: boolean
  showDuration: boolean
  showRateLimits: boolean
  showResetTime: boolean
  showCopilot: boolean
  font: StatusLineFont
  fontSize: number
}

export const DEFAULT_STATUS_LINE: StatusLineSettings = {
  showModel: true,
  showEffort: true,
  showAccount: true,
  showTokens: true,
  showContextBar: true,
  showCost: true,
  showLinesChanged: true,
  showDuration: true,
  showRateLimits: true,
  showResetTime: true,
  showCopilot: true,
  font: 'sans',
  fontSize: 12
}

// ── Session Watchdog (#235): auto-retry on rate-limit/overload/safeguard ──
export interface WatchdogSettings {
  /** Default OFF: watchdog auto-types into the session PTY, so it must be an
   *  explicit opt-in (mirrors sentinelEnabled's shape). Applies to newly
   *  spawned local Claude sessions only — see main/watchdog/watchdog-manager.ts. */
  enabled?: boolean
  /** Text auto-typed (+ Enter) to resume after a usage-limit reset clears. */
  retryMessage?: string
  /** Max usage-limit retry attempts before the watchdog gives up on this incident. */
  maxRetries?: number
}

export const DEFAULT_WATCHDOG_SETTINGS: WatchdogSettings = {
  enabled: false,
  retryMessage: 'continue',
  maxRetries: 5,
}

// ── UI typography (Font & Size settings page, spec 2026-07-04) ──
// Global scale drives the <html> root font-size (rem-based Tailwind utilities
// scale in lockstep; the canvas terminal is immune). Each region factor is a
// CSS zoom on that group's outer wrapper, compounding on global so it stays
// relative (e.g. Status bars set below 1.0 stay smaller than the rest as the
// whole UI scales up). Terminal font is NOT governed here (see TerminalSettings).
export type UiFontFamily = 'system' | 'inter' | 'serif' | 'mono'
export type TypographyRegionKey = 'status' | 'sidebar' | 'header' | 'panels'

export interface RegionTypography {
  /** 0.7..1.2 relative to global; undefined = follow global (1.0). */
  scale?: number
  /** undefined = follow the global family. */
  fontFamily?: UiFontFamily
}

export interface TypographySettings {
  globalScale: number             // 0.8..1.3, default 1.0
  globalFontFamily: UiFontFamily  // default 'inter'
  regions: Record<TypographyRegionKey, RegionTypography>
}

export const DEFAULT_TYPOGRAPHY: TypographySettings = {
  globalScale: 1,
  globalFontFamily: 'inter',
  regions: { status: {}, sidebar: {}, header: {}, panels: {} },
}

/** Conductor MCP built-in tool toggles (onboarding p6 / Settings). Each key
 *  filters a tool group on the conductor MCP server's tool list. */
export interface ConductorToolsSettings {
  vision: boolean
  codexReview: boolean
  hostTransfer: boolean
  canvas: boolean
}

export const DEFAULT_CONDUCTOR_TOOLS: ConductorToolsSettings = {
  vision: true,
  codexReview: true,
  hostTransfer: true,
  canvas: true,
}

export type UpdateChannel = 'stable' | 'beta'

// 'system' follows the OS prefers-color-scheme; explicit 'dark' / 'light'
// overrides regardless of OS. Default is 'dark' so existing users see no
// visual change unless they opt in.
export type ThemeMode = 'dark' | 'light' | 'system'

export type CursorStyle = 'bar' | 'block' | 'underline'

export interface TerminalSettings {
  fontFamily: string
  fontSize: number
  fontWeight: number
  lineHeight: number
  cursorStyle: CursorStyle
  cursorBlink: boolean
  background?: string   // optional user terminal-background override; undefined => --surface-stage token
  /**
   * GPU (WebGL) rendering for terminals. **Opt-IN** — absent or false means the
   * DOM renderer, which is what ships. Read it through `gpuRenderingEnabled`,
   * never by comparing directly.
   *
   * The fault: `@xterm/addon-webgl` keeps ONE glyph atlas per process (a
   * module-level `charAtlasCache`, keyed on font + colours, which every CCC
   * terminal matches). `clearTextureAtlas()` wipes that shared atlas for EVERY
   * terminal but rebuilds only the caller's render model, and `term.refresh()`
   * cannot undo it for the others because the renderer skips cells whose
   * contents have not changed. So one session repainting blanks the glyphs of
   * every other open session — backgrounds intact, text gone — until that
   * terminal is resized, scrolled, or activated. That is the real #273,
   * misdiagnosed for months as "the atlas goes stale on its own".
   *
   * #312 attempted a repair (a process-wide coordinator that refreshes the other
   * terminals) and it does NOT hold: refresh alone cannot rebuild a victim's
   * model, so the victim redraws blank. It was briefly default-on on the
   * strength of that repair, entirely within beta.16's unreleased development
   * window, and is opt-in again. See `gpuRenderingEnabled` for the disproof and
   * for the repair that does work. Applies to terminals opened after the change.
   */
  gpuRendering?: boolean
}

/**
 * Whether a terminal should render through WebGL.
 *
 * OPT-IN: only an explicit, literal `true` enables it. Absent, false, or any
 * non-boolean value a corrupt config might hold means the DOM renderer.
 *
 * It was briefly flipped to default-on during beta.16's development, on the
 * basis that #312 had repaired the shared-atlas fault. An adversarial pass
 * disproved that. The coordinator repairs a victim terminal with
 * `term.refresh()`, and refresh alone cannot undo a foreign atlas wipe:
 * `WebglRenderer._updateModel` skips every cell whose contents have not changed
 * (`// Nothing has changed, no updates needed`), so the victim redraws stale
 * vertices against an emptied texture and goes BLANK. Only the terminal that
 * called `clearTextureAtlas()` gets `_clearModel(true)`; the others get nothing
 * that would rebuild their model. Measured in a real WebGL renderer, the
 * victim's ink pixels drop to zero the moment the coordinator's refresh lands.
 *
 * So this stays opt-in until a repair is proven on a real GPU. Every reader goes
 * through this predicate rather than comparing the field itself: two call sites
 * each spelling their own check is how "unset" comes to mean one thing in the
 * terminal and the opposite in the settings checkbox.
 */
export function gpuRenderingEnabled(ts: Pick<TerminalSettings, 'gpuRendering'> | undefined): boolean {
  return ts?.gpuRendering === true
}

export const DEFAULT_TERMINAL_SETTINGS: TerminalSettings = {
  fontFamily: 'JetBrains Mono',
  fontSize: 13,
  fontWeight: 450,
  lineHeight: 1.2,
  cursorStyle: 'bar',
  cursorBlink: true,
  gpuRendering: false,
}

export interface AppSettings {
  defaultModel: string
  defaultWorkingDirectory: string
  terminalFontSize: number
  terminal: TerminalSettings
  debugMode: boolean
  keyboardShortcuts: Record<string, string>
  inputBarMaxHeight: number
  configPanelPinned: boolean
  statusLine: StatusLineSettings
  statusLineEnabled?: boolean
  /** v2.0.0-beta.2: UI Font & Size page. Global scale + family and per-region
   *  overrides. Migrated from legacy statusLine.font/fontSize (see migrateTypography). */
  typography: TypographySettings
  /** Master for the conductor MCP built-in tools (default on). Gates the MCP
   *  attach at spawn (local / SSH / Codex); the per-tool flags filter which
   *  tool groups the server registers. Absent = on (pre-upgrade configs). */
  conductorToolsEnabled?: boolean
  conductorTools?: ConductorToolsSettings
  /** "Do you use Codex?" (onboarding / Settings -> Codex). Absent = never
   *  answered (existing installs keep full behaviour); false disables Codex
   *  surfaces incl. the codex_review built-in tool. Codex support is Beta. */
  codexEnabled?: boolean
  localMachineName: string
  /** Usage buckets the user has HIDDEN from the status line, by label (e.g.
   *  "Fable"). Denylist model so the set stays dynamic: a new bucket shows by
   *  default (not listed), a removed one's entry goes inert, and a hidden one
   *  is remembered if it returns. Absent/empty = show every discovered bucket. */
  hiddenUsageBuckets?: string[]
  /** Like hiddenUsageBuckets but scoped to the multi-account BOTTOM footer
   *  (MultiAccountStatusline), so the footer's bars are curated INDEPENDENTLY of
   *  the per-session strip -- e.g. keep only Fable there to narrow the cluster.
   *  Same denylist model (by label); absent/empty = show every discovered bucket. */
  footerHiddenUsageBuckets?: string[]
  /** How the multi-account footer draws each account. 'meters' (absent/default)
   *  is the labelled progress bars; 'dots' is minimal mode -- the account's NAME
   *  plus one traffic-light dot for usage and one per model bucket, with the
   *  figures in the tooltip. Absent means meters, so no existing footer changes
   *  shape on upgrade. Minimal mode reads the SAME footerHiddenUsageBuckets
   *  denylist, so hiding Fable there drops its dot here. */
  footerAccountDisplay?: 'meters' | 'dots'
  updateChannel: UpdateChannel
  /** True once the user has explicitly picked an update channel (onboarding
   *  Transparency recap, or Settings -> General). Absent/false means
   *  `updateChannel` is still just the default, which lets onboarding
   *  pre-select the channel matching the running build WITHOUT ever
   *  overriding a real choice. */
  updateChannelChosen?: boolean
  showTips: boolean
  /** Ask Conductor's entry point in the sidebar dock. Hidden from the dock's own
   *  right-click menu, restored in Settings -> General. Absent (pre-upgrade
   *  config) means shown, so an existing install never loses the entry point on
   *  upgrade. Turning it off removes the way IN; it deliberately does not close
   *  an Ask session that is already open, because a display toggle must not
   *  destroy a running session. */
  showAskConductor: boolean
  // Agent Hub first-run "How it works" banner: true once the user dismisses it.
  // Optional/absent = not yet dismissed (banner shows).
  agentHubExplainerDismissed?: boolean
  hooksEnabled: boolean
  hooksPort: number
  theme: ThemeMode
  tokenomicsAccountFilter?: string  // 'all' | '__mixed__' | '__unknown__' | <email>
  fontMigratedV2?: boolean  // one-time guard: existing installs moved off the old Cascadia Code/14 default
  identityColorMigratedV2?: boolean      // one-time guard: saved-config colours migrated to identity keys
  colourMigrationNoticePending?: boolean // a colour migration changed records and the notice should show
  colourMigrationNoticeDismissed?: boolean
  // P2.4: a config section was corrupt and reset/dropped on hydrate; the notice
  // lists what was dropped so the user isn't silently missing data.
  configHydrationNoticePending?: boolean
  configHydrationNoticeDismissed?: boolean
  configHydrationDropped?: string[]
  /** User-defined per-account email -> identity colour key overrides. Keyed by
   *  canonicalised (lowercase+trim) email. Absent = use the deterministic colour.
   *  v1.5.9: no longer surfaced anywhere in the UI (AccountColoursSection removed).
   *  Retained so older saved settings still hydrate without errors. */
  accountColourOverrides?: Record<string, import('../../shared/identity-colors').IdentityColorKey>
  /** v1.5.19: friendly names for accounts WITHOUT a profile (the default/single
   *  account), keyed by canonical email. Profiles carry their own `name`. */
  accountAliases?: Record<string, string>
  /** The profile id of the account the user most recently launched a session
   *  under (global, across sessions). Surfaced as a "Last used" line in the
   *  account-launch gate so a new session can adopt it in one click. */
  lastUsedAccountId?: string
  /** v1.5.12: when true, CCC writes `disableWorkflows: true` into every
   *  per-session Claude settings file so Claude Code's dynamic-workflow
   *  feature is disabled at session boot. Affects newly spawned sessions
   *  only -- in-flight sessions keep whatever setting they started with.
   *  Off by default; CC's own /config toggle still wins per-session. */
  disableClaudeWorkflows?: boolean
  /** v1.5.31: record each session's terminal output locally for search and
   *  review. Logs never leave the machine. Default on; set false to disable
   *  capture. The main process capture gate reads this key from the shared
   *  settings config (readConfig('settings').loggingEnabled). */
  loggingEnabled?: boolean
  /** v1.5.31: one-time first-run consent notice has been shown. Falsy = show
   *  the notice on the next boot so the user can opt out before any data is
   *  written. Set true (with or without disabling logging) to suppress the
   *  prompt permanently. */
  loggingConsentSeen?: boolean
  /** True once the legacy file logs have been imported into SQLite (Phase 2b). */
  legacyLogsMigrated?: boolean
  /** True once the one-time "legacy logs detected" surfacing has been shown. */
  legacyLogsSurfacingSeen?: boolean
  /** v1.5.32: when true (or absent = default), CLAUDE_CODE_DISABLE_MOUSE=1 is set
   *  in the Claude spawn env so xterm owns the mouse and classic terminal selection
   *  + right-click copy/paste work. Right-click copies selected text or pastes when
   *  nothing is selected. Trade-off: CC's click-to-expand / click-to-position /
   *  scroll-inside-Claude are disabled; xterm scrollback + native selection take over.
   *  Set false to restore CC's mouse mode (copy-on-select active; right-click pastes).
   *  Changes apply to newly-launched sessions only. */
  classicTerminalCopyPaste?: boolean
  /** v2.0: Claude Code >= 2.1.195 renders its question options as CLICKABLE
   *  targets in the terminal. OFF by default in CCC (absent/false): the spawn
   *  env gets CLAUDE_CODE_DISABLE_MOUSE_CLICKS=1 so answers stay keyboard-only
   *  (wheel scroll unaffected) -- the clickable layer misfires inside xterm.
   *  Set true to restore CC's clickable prompts. New sessions only. */
  clickableQuestions?: boolean
  /** v2.0.0-beta.3: disable Claude Code's background tasks/agents so a stray
   *  Ctrl+B (or /bg) can't detach and strand a session. Default-on (absent/true
   *  = disabled); set false to allow background agents. New sessions only. */
  disableBackgroundTasks?: boolean
  /** Sentinel service (spec 2026-06-11): when not enabled, the service is not
   *  initialised at all — no startup check, no dot, zero overhead.
   *  OPT-IN (default-off): absent or false = disabled; only an explicit `true`
   *  enables it, because it spends Claude tokens on a Claude Code version change. */
  sentinelEnabled?: boolean
  /** When true (default), the Sentinel panel auto-opens once when a completed
   *  analysis finds open findings. Set false to suppress all automatic opens. */
  sentinelAutoOpen?: boolean
  /** v2: when true, the GitHub AI-credits (Copilot) usage meter polls the
   *  billed-usage endpoint every 60 min and surfaces the result. Default off —
   *  it requires extra token scope ('user' for classic PATs / 'Plan: read' for
   *  fine-grained PATs) and makes its own GitHub requests. */
  githubAiUsageEnabled?: boolean
  /** v2: the user's plan included AI-credit allowance (a CREDIT count, e.g.
   *  20,000 for Copilot Max — NOT dollars). GitHub does not expose this for
   *  personal accounts via API, so the user enters it from their plan page.
   *  null/absent = unknown (the meter shows usage without a cap bar). */
  copilotIncludedCredits?: number | null
  /** v2: the current plan-cycle start ('YYYY-MM-DD'), e.g. a mid-month Max
   *  upgrade date. When set, the included-credits meter counts AI-credit usage
   *  only from this date (matching GitHub's card, which resets per cycle) rather
   *  than the whole calendar month. null/absent = whole-month. */
  copilotCreditsCycleStart?: string | null
  /** v2: optional Copilot plan label for display ("Max" / "Pro" / "Plus"). Not
   *  exposed by any API, so it's a user-entered label shown next to the meter. */
  copilotPlanName?: string | null
  /** Account profile Sentinel's headless analysis runs under. null/absent =
   *  the captured primary (never the bare global login when profiles exist —
   *  the frozen global hangs at auth or carries stale usage limits). Switchable
   *  in Settings when the chosen account hits its usage limit. */
  sentinelAccountProfileId?: string | null
  /** Session Watchdog (#235). Opt-in, default off — see WatchdogSettings. */
  watchdog?: WatchdogSettings
}

interface SettingsState {
  settings: AppSettings
  isLoaded: boolean
  hydrate: (settings: AppSettings) => void
  updateSettings: (updates: Partial<AppSettings>) => Promise<unknown>
}

export const DEFAULT_SETTINGS: AppSettings = {
  defaultModel: 'sonnet',
  defaultWorkingDirectory: '',
  terminalFontSize: 13,
  terminal: { ...DEFAULT_TERMINAL_SETTINGS },
  debugMode: false,
  keyboardShortcuts: { ...DEFAULT_SHORTCUTS },
  inputBarMaxHeight: 400,
  configPanelPinned: false,
  statusLine: { ...DEFAULT_STATUS_LINE },
  statusLineEnabled: true,
  typography: {
    globalScale: 1,
    globalFontFamily: 'inter',
    regions: { status: {}, sidebar: {}, header: {}, panels: {} },
  },
  conductorToolsEnabled: true,
  conductorTools: { ...DEFAULT_CONDUCTOR_TOOLS },
  localMachineName: '',
  updateChannel: 'stable' as const,
  showTips: true,
  showAskConductor: true,
  hooksEnabled: true,
  hooksPort: 19334,
  theme: 'dark',
  loggingEnabled: true,
  classicTerminalCopyPaste: true,
  clickableQuestions: false,
  sentinelEnabled: false,
  sentinelAutoOpen: true,
  githubAiUsageEnabled: false,
  watchdog: { ...DEFAULT_WATCHDOG_SETTINGS },
}

// V2 changed the bundled terminal default from Cascadia Code @14 to JetBrains
// Mono @13. Move installs still sitting on the OLD default to the new one
// exactly ONCE, guarded by fontMigratedV2. A user who picked a different font is
// left alone; a user who re-picks Cascadia Code after the migration is respected
// (the guard has already fired). `changed` is true whenever the guard is newly
// set, so the caller persists it and the migration never runs again.
export function migrateV2Font(settings: AppSettings): { settings: AppSettings; changed: boolean } {
  if (settings.fontMigratedV2) return { settings, changed: false }
  const terminal = { ...settings.terminal }
  if (terminal.fontFamily === 'Cascadia Code') terminal.fontFamily = 'JetBrains Mono'
  if (terminal.fontSize === 14) terminal.fontSize = 13
  return {
    settings: {
      ...settings,
      terminal,
      terminalFontSize: settings.terminalFontSize === 14 ? 13 : settings.terminalFontSize,
      fontMigratedV2: true,
    },
    changed: true,
  }
}

export const useSettingsStore = create<SettingsState>((set) => ({
  settings: { ...DEFAULT_SETTINGS },
  isLoaded: false,

  hydrate: (settings) => {
    const merged: AppSettings = {
      ...DEFAULT_SETTINGS,
      ...settings,
      // Deep-merge nested objects so users with older saved configs still pick up
      // newly added fields (e.g. statusLine.font/fontSize) instead of getting undefined.
      statusLine: { ...DEFAULT_STATUS_LINE, ...(settings.statusLine || {}) },
      terminal: { ...DEFAULT_TERMINAL_SETTINGS, ...(settings.terminal || {}) },
      conductorTools: { ...DEFAULT_CONDUCTOR_TOOLS, ...(settings.conductorTools || {}) },
      watchdog: { ...DEFAULT_WATCHDOG_SETTINGS, ...(settings.watchdog || {}) },
      typography: migrateTypography(settings),
    }
    const { settings: migrated, changed } = migrateV2Font(merged)
    if (changed) {
      // Persist the one-time migration (including the guard flag) so it runs once.
      saveConfigNow('settings', migrated).catch(() => {})
    }
    set({ settings: migrated, isLoaded: true })
  },

  updateSettings: (updates) => {
    let savePromise: Promise<unknown> = Promise.resolve()
    set((state) => {
      const settings = { ...state.settings, ...updates }
      savePromise = saveConfigNow('settings', settings)
      return { settings }
    })
    return savePromise
  }
}))
