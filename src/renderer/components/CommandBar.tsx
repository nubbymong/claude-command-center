import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { useCommandStore, CustomCommand, CommandSection } from '../stores/commandStore'
import { bandMembers, type CommandBand } from '../lib/command-bands'
import { useSessionStore } from '../stores/sessionStore'
import { useAccountProfilesStore } from '../stores/accountProfilesStore'
import { useCommandBarStore, type CoreToolId, type CommandBarOverflow, type HiddenCoreTools } from '../stores/commandBarStore'
import { useExcalidrawStore } from '../stores/excalidrawStore'
import { useLogsStore } from '../stores/useLogsStore'
import { useSettingsStore } from '../stores/settingsStore'
import { openArtifactsPerSetting, resolveArtifactsOpenTarget } from '../lib/claude-web-targets'
import { useCanvasStore } from '../stores/canvasStore'
import { useCanvasReviewStore } from '../stores/canvasReviewStore'
import { useCanvasTotalsStore } from '../stores/canvasTotalsStore'
import { useCanvasQueue } from '../lib/canvasQueue'
import CommandDialog from './CommandDialog'
import ScreenshotButton from './ScreenshotButton'
import AgentCanvasButton from './AgentCanvasButton'
import LogsButton from './LogsButton'
import WebviewButton from './WebviewButton'
import PasteHint from './PasteHint'
import { useWebviewStore, pollUrlForContent, probeWebviewUrls } from '../stores/webviewStore'
import { generateId } from '../utils/id'
import { buildCommandLine, commandSecretRef, commandSecretKey } from '../../shared/command-secret'
import { isAllowedBrowserUrl } from '../../shared/browser-url'
import { trackUsage } from '../stores/tipsStore'
import { CODEX_MODELS } from '../codex-models'
import { useResolvedTheme } from '../hooks/useThemeController'
import { sessionCapabilities } from '../lib/session-capabilities'
import { planBar, inapplicability, effectiveKind, type BandPlan } from './command-bar/layout'
import GuiExeDialog from './GuiExeDialog'
import CapturedRunModal from './CapturedRunModal'
import { scheduleBleedRepaints } from './terminal/repaintRegistry'
import { getCachedProbe, setCachedProbe } from '../lib/gui-exe-probe-cache'
import type { ExeProbeResult } from '../../shared/gui-exe'
import { CommandChip, TargetMark, SectionLabel, ReservedLabel, CHIP_CLASS, CHIP_STYLE } from './command-bar/chips'
import BandOverflow from './command-bar/BandOverflow'
import ArgsPopover from './command-bar/ArgsPopover'
import SectionNameInput from './command-bar/SectionNameInput'
import { UserButtonMenu, CoreToolMenu, SectionMenu, BarMenu, BandMenu, AddMenu, ConfirmCard } from './command-bar/menus'
import { useBandFolding, type FoldBand } from './command-bar/useBandFolding'
import NotesTool, { type NotesToolHandle } from './command-bar/NotesTool'
import { CommandIcon } from './command-icons'
import { DEFAULT_COMMAND_COLOR } from '../lib/command-swatches'

// User-picked section colours are Mocha pastels tuned for dark surfaces;
// rendered as bare text on the light theme they wash out. Darken them toward
// the theme's text colour in light mode, keep verbatim in dark.
function legibleSectionColor(color: string | null | undefined, theme: 'dark' | 'light'): string | undefined {
  if (!color) return undefined
  return theme === 'light' ? `color-mix(in srgb, ${color} 55%, var(--text-primary))` : color
}

/** Ask the app to open Settings on a tab -- the same `app:openSettings` event the
 *  Codex form links use; App validates the tab and switches view (ADR-018 D11). */
export function openSettingsTab(tab: string): void {
  window.dispatchEvent(new CustomEvent('app:openSettings', { detail: { tab } }))
}

// -- Codex toolbar sub-components --

const CODEX_PRESETS = ['read-only', 'standard', 'auto', 'unrestricted'] as const
type CodexPreset = typeof CODEX_PRESETS[number]

function CodexModelDropdown({ value, onChange }: { value: string; onChange: (next: string) => void }) {
  const [dirty, setDirty] = React.useState(false)
  return (
    <div className="flex items-center gap-1">
      <select
        value={value}
        onChange={(e) => { setDirty(true); onChange(e.target.value) }}
        className="bg-base border border-surface1 rounded px-1.5 h-7 text-xs text-text"
      >
        {CODEX_MODELS.map((m) => (<option key={m} value={m}>{m}</option>))}
      </select>
      {dirty && <span className="text-[10px] text-overlay1">Restart session to apply</span>}
    </div>
  )
}

function PermissionsPresetDropdown({ value, onChange }: { value: CodexPreset; onChange: (next: CodexPreset) => void }) {
  const [dirty, setDirty] = React.useState(false)
  return (
    <div className="flex items-center gap-1">
      <select
        value={value}
        onChange={(e) => { setDirty(true); onChange(e.target.value as CodexPreset) }}
        className="bg-base border border-surface1 rounded px-1.5 h-7 text-xs text-text"
      >
        {CODEX_PRESETS.map((p) => (<option key={p} value={p}>{p}</option>))}
      </select>
      {dirty && <span className="text-[10px] text-overlay1">Restart session to apply</span>}
    </div>
  )
}

const TOOL_LABEL: Record<CoreToolId, string> = { snap: 'Snap', canvas: 'Canvas', logs: 'Logs', browser: 'Browser', artifacts: 'Artifacts', partner: 'Partner', notes: 'Notes' }
const NO_HIDDEN: HiddenCoreTools = { everywhere: [], bySession: {} }

interface Props {
  sessionId: string
  configId?: string
  sessionType?: 'local' | 'ssh'
  partnerEnabled?: boolean
  isPartnerActive?: boolean
  onTogglePartner?: () => void
  partnerSessionId?: string
  /**
   * The owning *session*'s id (not the PTY id). Used to key webview
   * store state so the Claude and Partner CommandBars within the same
   * session share one set of pulse/open state. Defaults to `sessionId`.
   */
  parentSessionId?: string
  /** True when the session's MAIN pane is a plain shell (terminal-only config).
   *  Kept as a fallback when the session record is not in the store; the bar's
   *  truth is `sessionCapabilities` (ADR-018 D2). */
  mainPaneIsShell?: boolean
  /** How many saved configs exist, so "Keep it only here" can say how many it leaves (D7). */
  configCount?: number
}

type MenuState =
  | { kind: 'command'; x: number; y: number; id: string; el?: HTMLElement | null }
  | { kind: 'core'; x: number; y: number; tool: CoreToolId; el?: HTMLElement | null }
  | { kind: 'section'; x: number; y: number; id: string; el?: HTMLElement | null }
  | { kind: 'bar'; x: number; y: number; el?: HTMLElement | null }
  | { kind: 'band'; x: number; y: number; band: CommandBand; el?: HTMLElement | null }
  | { kind: 'add'; x: number; y: number; el?: HTMLElement | null }

/** What opens a menu: everything but its position. (A plain Omit over the union would collapse it.) */
type MenuSeed =
  | { kind: 'command'; id: string }
  | { kind: 'core'; tool: CoreToolId }
  | { kind: 'section'; id: string }
  | { kind: 'bar' }
  | { kind: 'band'; band: CommandBand }
  | { kind: 'add' }

type ConfirmState =
  /** `sectionId`: the drop was onto a section of the other band -- membership is
   *  written only once the scope change is confirmed (D7: nothing changes on Cancel). */
  | { kind: 'scope'; commandId: string; band: CommandBand; beforeId: string | null; sectionId?: string }
  | { kind: 'delete'; commandId: string }
  | { kind: 'hide'; tool: CoreToolId }
  | { kind: 'section-band'; sectionId: string; band: CommandBand }
  /** The Canvas button's right-click: clear the whole review queue in one sweep. */
  | { kind: 'canvas-dismiss' }

export default function CommandBar({ sessionId, configId, sessionType = 'local', partnerEnabled, isPartnerActive, onTogglePartner, partnerSessionId, parentSessionId, mainPaneIsShell = false, configCount }: Props) {
  const webviewKey = parentSessionId ?? sessionId
  const resolvedTheme = useResolvedTheme()
  const store = useCommandStore()
  const { commands, sections, addCommand, updateCommand, removeCommand, updateSection, removeSection, reorderSections } = store
  const [showDialog, setShowDialog] = useState<null | { scope?: CommandBand; sectionId?: string }>(null)
  const [editingCommand, setEditingCommand] = useState<CustomCommand | null>(null)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [confirm, setConfirm] = useState<ConfirmState | null>(null)
  // The canvas review queue, for the Canvas tool's right-click dismiss-all —
  // the same number the button pill shows, so menu and button cannot disagree.
  const canvasQueue = useCanvasQueue(sessionId)
  const doCanvasDismissAll = useCallback(async () => {
    setConfirm(null)
    try {
      const openTileSessionIds = useSessionStore.getState().sessions.map((s) => s.id)
      await window.electronAPI.canvas.reviewDismissAll({ sessionId, openTileSessionIds })
    } catch {
      // Nothing destructive happened; the queue count simply stays.
    }
    // The change pushes refresh these anyway; doing it here makes the count
    // drop with the dialog instead of a beat later.
    void useCanvasTotalsStore.getState().refresh(sessionId)
    void useCanvasReviewStore.getState().refresh(sessionId)
    void useCanvasStore.getState().refresh(sessionId)
  }, [sessionId])
  const [overflowOpen, setOverflowOpen] = useState<{ band: CommandBand; anchor: DOMRect } | null>(null)
  const [argsPopover, setArgsPopover] = useState<{ cmd: CustomCommand; rect: DOMRect } | null>(null)
  const [sectionInput, setSectionInput] = useState<{ x: number; y: number; editSection?: CommandSection; band: CommandBand } | null>(null)
  // #379: a shell button whose program turned out to be a Windows GUI-subsystem
  // exe, waiting on the user's choice; and the log panel for a captured run.
  const [guiPrompt, setGuiPrompt] = useState<{ cmd: CustomCommand; fullCommand: string; exePath: string } | null>(null)
  const [capturedRun, setCapturedRun] = useState<{ runId: string | null; label: string; command: string; exePath: string | null; startError?: string } | null>(null)
  // Press ordering (#379 review MAJOR-6): once one press has to wait on a probe,
  // every later press queues behind it so the pty sees them in press order.
  const sendQueue = useRef<Promise<void>>(Promise.resolve())
  const pendingSends = useRef(0)
  // drag state
  const [dragId, setDragId] = useState<string | null>(null)
  const [dragOverId, setDragOverId] = useState<string | null>(null)
  const [dragOverSlot, setDragOverSlot] = useState<CommandBand | null>(null)
  const [dragOverSectionId, setDragOverSectionId] = useState<string | null>(null)
  const [dragSectionId, setDragSectionId] = useState<string | null>(null)
  const rowRef = useRef<HTMLDivElement>(null)
  const notesRef = useRef<NotesToolHandle>(null)

  // Bar-wide UI state (shared by the Claude and Partner bars; persisted).
  const barState = useCommandBarStore((s) => s.state)
  const toggleSectionCollapse = useCommandBarStore((s) => s.toggleSection)
  const setOverflow = useCommandBarStore((s) => s.setOverflow)
  const hideCoreTool = useCommandBarStore((s) => s.hideCoreTool)
  const showCoreTool = useCommandBarStore((s) => s.showCoreTool)
  const setBarCollapsed = useCommandBarStore((s) => s.setBarCollapsed)
  const collapsedSectionIds: string[] = Array.isArray(barState?.collapsedSectionIds) ? barState.collapsedSectionIds : []
  const barCollapsed = !!barState?.barCollapsed
  const overflowMode: CommandBarOverflow = barState?.overflow === 'wrap2' ? 'wrap2' : 'fold'
  const hidden = barState?.hiddenCoreTools ?? NO_HIDDEN
  const hiddenHere = useMemo(() => new Set<CoreToolId>([...(hidden.everywhere ?? []), ...((hidden.bySession ?? {})[webviewKey] ?? [])]), [hidden, webviewKey])

  // The session this bar belongs to. The PTY id may differ from the session id
  // (the partner pane is its own PTY), so resolve the session by its id first.
  const session = useSessionStore((s) => s.sessions.find((sess) => sess.id === webviewKey) ?? s.sessions.find((sess) => sess.id === sessionId))
  const updateSession = useSessionStore((s) => s.updateSession)
  const caps = useMemo(
    () => sessionCapabilities(session ?? ({ provider: 'claude', sessionType, shellOnly: mainPaneIsShell, configId } as never)),
    [session, sessionType, mainPaneIsShell, configId],
  )

  // #501: the Artifacts core tool opens this account's artifacts on claude.ai via
  // the existing accountWeb.openArtifacts IPC (the Sidebar's per-session action).
  // It applies only to a local, non-shell session that resolves to an account
  // profile (its own, else the primary) — the same guard the Sidebar uses.
  const primaryProfileId = useAccountProfilesStore((s) => s.profiles.find((p) => p.isPrimary)?.id)
  const artifactsProfileId = session?.profileId ?? primaryProfileId
  const artifactsApplicable =
    !!session && !session.shellOnly && session.sessionType === 'local' && !!artifactsProfileId
  const openArtifacts = useCallback(() => {
    if (!artifactsProfileId) return
    // Owner call 2026-08-26: routed through the global open-target setting
    // (default unchanged: the dedicated window). This session hosts the pane
    // when the setting says pane.
    openArtifactsPerSetting(artifactsProfileId, sessionId)
  }, [artifactsProfileId, sessionId])
  const artifactsTarget = useSettingsStore((s) => resolveArtifactsOpenTarget(s.settings))
  const setArtifactsTarget = useCallback((t: 'window' | 'pane') => {
    useSettingsStore.getState().updateSettings({ artifactsOpenTarget: t })
  }, [])

  const visibleCommands = useMemo(
    () => commands.filter((c) => c.scope === 'global' || (c.scope === 'config' && c.configId === configId)),
    [commands, configId],
  )
  const plans = useMemo(() => planBar(commands, sections, caps, configId), [commands, sections, caps, configId])
  const reviewCount = visibleCommands.filter((c) => c.needsReview?.length).length

  /** Build the full command string (prompt + default args) */
  const buildFullCommand = (cmd: CustomCommand, args?: string[]): string => {
    // ONE rule, shared with the dialog's preview (shared/command-secret). A
    // secret argument is typed as a reference to the env var main set when the
    // shell started -- never as the value, which would land in shell history.
    const isWin = (window as unknown as { electronPlatform?: string }).electronPlatform === 'win32'
    const ref = cmd.hasSecretArg ? commandSecretRef(cmd.id, isWin) : undefined
    return buildCommandLine(cmd.prompt, args || cmd.defaultArgs, ref)
  }

  const startActivation = useWebviewStore((s) => s.startActivation)
  const markAvailable = useWebviewStore((s) => s.markAvailable)
  const markFailed = useWebviewStore((s) => s.markFailed)

  const startWebviewPolling = (url: string) => {
    const token = startActivation(webviewKey, url)
    pollUrlForContent(url).then((reachable) => {
      if (reachable) markAvailable(webviewKey, url, token)
      else markFailed(webviewKey, token)
    })
  }

  const webviewUrls = visibleCommands.filter((c) => c.webView?.enabled && c.webView.url).map((c) => c.webView!.url)
  const webviewUrlsKey = webviewUrls.join('|')
  useEffect(() => {
    if (webviewUrls.length === 0) return
    void probeWebviewUrls(webviewKey, webviewUrls)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [webviewKey, webviewUrlsKey])

  /**
   * Type a command into the appropriate PTY. The original behaviour, unchanged.
   *
   * `expectBleed` is set when we know the line starts a Windows GUI-subsystem
   * program (#379): it will `AttachConsole` to this pty's console and write its
   * log straight into the screen buffer, over whatever TUI is drawing there.
   * Those bytes never reach xterm, so xterm's model and the screen silently
   * disagree — fix E arms a repaint sweep to put them back in step. It cannot
   * un-draw the log; only the TUI's next frame does that.
   */
  const typeIntoPty = (cmd: CustomCommand, fullCommand: string, expectBleed = false) => {
    const target = cmd.target || 'claude'
    const webViewUrl = cmd.webView?.enabled ? cmd.webView.url : null
    const writeTo = (ptyId: string) => {
      window.electronAPI.pty.write(ptyId, fullCommand + '\r')
      if (expectBleed) scheduleBleedRepaints(ptyId)
      if (webViewUrl) startWebviewPolling(webViewUrl)
      else if (webviewUrls.length > 0) void probeWebviewUrls(webviewKey, webviewUrls)
    }
    if (target === 'partner' && !isPartnerActive && onTogglePartner && partnerSessionId) {
      onTogglePartner()
      setTimeout(() => writeTo(partnerSessionId), 100)
      return
    }
    if (target === 'claude' && isPartnerActive && onTogglePartner) {
      onTogglePartner()
      setTimeout(() => writeTo(sessionId), 100)
      return
    }
    const targetId = target === 'partner' && partnerSessionId ? partnerSessionId : sessionId
    writeTo(targetId)
  }

  /** Run a command line from the console-less main process and show its log. */
  const runCaptured = (cmd: CustomCommand, fullCommand: string) => {
    void window.electronAPI.exe
      .runCaptured({ command: fullCommand, cwd: session?.workingDirectory })
      .then((res) => {
        if (!res.runId) {
          // Refused (the file changed between the probe and the spawn, or the
          // cap is full). The user explicitly asked NOT to have their pane
          // painted over, so falling back silently is the one thing we must not
          // do: type it, and open the panel to say what happened.
          typeIntoPty(cmd, fullCommand, true)
          setCapturedRun({ runId: null, label: cmd.label, command: fullCommand, exePath: res.exePath, startError: res.error })
          return
        }
        setCapturedRun({ runId: res.runId, label: cmd.label, command: fullCommand, exePath: res.exePath })
      })
      .catch((err: unknown) => {
        typeIntoPty(cmd, fullCommand, true)
        setCapturedRun({
          runId: null,
          label: cmd.label,
          command: fullCommand,
          exePath: null,
          startError: err instanceof Error ? err.message : 'The app could not start that program.',
        })
      })
  }

  /** Act on a probe result. Pure routing — no I/O of its own. */
  const actOnProbe = (cmd: CustomCommand, fullCommand: string, res: ExeProbeResult) => {
    // `gui` always carries a resolved path; anything else keeps the old route.
    if (res.status !== 'gui' || !res.exePath) { typeIntoPty(cmd, fullCommand); return }
    if (cmd.guiExePolicy === 'capture') { runCaptured(cmd, fullCommand); return }
    setGuiPrompt({ cmd, fullCommand, exePath: res.exePath })
  }

  /**
   * What `sendCommand` will do, when that can be decided without any I/O.
   * Returns null when a probe is genuinely needed.
   *
   * This exists for ORDERING (#379, review MAJOR-6). Making every shell press
   * asynchronous meant two rapid presses could reach the pty out of order, and
   * the write used to be strictly ordered. Deciding synchronously wherever
   * possible keeps the overwhelmingly common case on the old, ordered path; the
   * queue below covers the rest.
   */
  const syncDecision = (cmd: CustomCommand, fullCommand: string): (() => void) | null => {
    if (effectiveKind(cmd, caps) !== 'shell') return () => typeIntoPty(cmd, fullCommand)
    if (cmd.guiExePolicy === 'terminal') return () => typeIntoPty(cmd, fullCommand, true)
    // No probe available (an older preload, or a test harness that does not stub
    // it): type it, exactly as the button always did. The warning is an
    // improvement on the old behaviour, never a precondition for it.
    if (typeof window.electronAPI?.exe?.probe !== 'function') return () => typeIntoPty(cmd, fullCommand)
    const cached = getCachedProbe(fullCommand, session?.workingDirectory)
    if (cached) return () => actOnProbe(cmd, fullCommand, cached)
    return null
  }

  /**
   * Send a command, checking first whether its program is one that will paint
   * over the terminal instead of printing into it (#379).
   *
   * Only a SHELL line is probed. A prompt button's text goes to Claude's TUI as
   * text — no program is started by it, so there is nothing to sniff, and a
   * probe there would be both wrong and a wasted IPC round trip on every press.
   * Everything the probe cannot answer (not Windows, unresolved program, a
   * console-subsystem exe, a script) falls through to exactly the old path.
   *
   * Presses are kept in order: once anything is queued, everything queues behind
   * it, so a slow first probe cannot let a later press overtake it.
   */
  const sendCommand = (cmd: CustomCommand, fullCommand: string) => {
    const decided = syncDecision(cmd, fullCommand)
    if (decided && pendingSends.current === 0) { decided(); return }

    pendingSends.current += 1
    sendQueue.current = sendQueue.current
      .then(async () => {
        const again = syncDecision(cmd, fullCommand)
        if (again) { again(); return }
        const cwd = session?.workingDirectory
        try {
          const res = await window.electronAPI.exe.probe({ command: fullCommand, cwd })
          setCachedProbe(fullCommand, cwd, res)
          actOnProbe(cmd, fullCommand, res)
        } catch {
          // A probe that fails tells us nothing, and must never cost the user
          // their command. Old path.
          typeIntoPty(cmd, fullCommand)
        }
      })
      .finally(() => { pendingSends.current -= 1 })
  }

  const runCommand = (cmd: CustomCommand, withArgsAt?: DOMRect) => {
    if (cmd.kind === 'page') {
      if (!isAllowedBrowserUrl(cmd.pageUrl)) { console.warn('[CommandBar] page command has no usable URL:', cmd.label); return }
      trackUsage('webview.opened')
      useWebviewStore.getState().navigate(webviewKey, cmd.pageUrl)
      return
    }
    if (withArgsAt && (cmd.defaultArgs?.length || cmd.lastCustomArgs?.length)) {
      trackUsage('commands.ctrl-click-args')
      setArgsPopover({ cmd, rect: withArgsAt })
      return
    }
    sendCommand(cmd, buildFullCommand(cmd))
  }

  const handleClick = (cmd: CustomCommand, e: React.MouseEvent) => {
    const rect = (e.currentTarget as HTMLElement)?.getBoundingClientRect?.()
    runCommand(cmd, e.ctrlKey && rect ? rect : undefined)
  }

  // A keychain write that fails (no keyring on this Linux, a torn credentials
  // file) must not pass silently: the record already says "has a secret".
  const saveSecret = (key: string, value: string) => {
    void Promise.resolve(window.electronAPI.credentials.save(key, value))
      .then((ok) => { if (ok === false) console.warn('[CommandBar] the secret for', key, 'was NOT stored (keychain unavailable); the button will type an empty value') })
      .catch((err: unknown) => console.warn('[CommandBar] secret save failed:', err))
  }

  const handleAdd = (data: Omit<CustomCommand, 'id'>, argSecret?: string) => {
    const id = generateId()
    addCommand({ ...data, id })
    if (data.hasSecretArg && argSecret) saveSecret(commandSecretKey(id), argSecret)
    trackUsage('commands.create-command')
    setShowDialog(null)
  }

  const handleEdit = (data: Omit<CustomCommand, 'id'>, argSecret?: string) => {
    if (!editingCommand) return
    updateCommand(editingCommand.id, { ...data, needsReview: undefined })
    const key = commandSecretKey(editingCommand.id)
    if (data.hasSecretArg && argSecret) saveSecret(key, argSecret)
    else if (!data.hasSecretArg) void window.electronAPI.credentials.delete(key)
    setEditingCommand(null)
  }

  const deleteCommand = (id: string) => {
    void window.electronAPI.credentials.delete(commandSecretKey(id))
    removeCommand(id)
  }

  // ---- menus ----------------------------------------------------------------
  const openMenu = (e: React.MouseEvent, m: MenuSeed) => {
    e.preventDefault()
    e.stopPropagation()
    setMenu({ ...m, x: e.clientX, y: e.clientY, el: e.currentTarget as HTMLElement } as MenuState)
  }
  const openMenuAt = (el: HTMLElement, m: MenuSeed) => {
    const r = el.getBoundingClientRect()
    setMenu({ ...m, x: r.left, y: r.bottom + 2, el } as MenuState)
  }

  // ---- drag -----------------------------------------------------------------
  const bandOfCmd = (c: CustomCommand): CommandBand => (c.scope === 'global' ? 'global' : 'config')
  const dropCommand = (movedId: string, band: CommandBand, beforeId: string | null) => {
    const moved = commands.find((c) => c.id === movedId)
    if (!moved) return
    if (bandOfCmd(moved) !== band) { setConfirm({ kind: 'scope', commandId: movedId, band, beforeId }); return }
    store.moveCommand(movedId, beforeId, band, configId)
  }
  const endDrag = () => { setDragId(null); setDragOverId(null); setDragOverSlot(null); setDragOverSectionId(null); setDragSectionId(null) }

  const onChipDragStart = (e: React.DragEvent, cmd: CustomCommand) => {
    setDragId(cmd.id)
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', cmd.id)
    e.dataTransfer.setData('application/x-command', cmd.id)
  }
  const onChipDragOver = (e: React.DragEvent, cmd: CustomCommand) => {
    if (!dragId || dragId === cmd.id) return
    e.preventDefault(); e.stopPropagation()
    e.dataTransfer.dropEffect = 'move'
    setDragOverId(cmd.id); setDragOverSlot(null); setDragOverSectionId(null)
  }
  const onChipDrop = (e: React.DragEvent, target: CustomCommand, band: CommandBand) => {
    e.preventDefault(); e.stopPropagation()
    if (dragId && dragId !== target.id) dropCommand(dragId, band, target.id)
    endDrag()
  }
  const onSlotDragOver = (e: React.DragEvent, band: CommandBand) => {
    if (!dragId) return
    e.preventDefault(); e.stopPropagation()
    e.dataTransfer.dropEffect = 'move'
    setDragOverSlot(band); setDragOverId(null)
  }
  const onSlotDrop = (e: React.DragEvent, band: CommandBand) => {
    e.preventDefault(); e.stopPropagation()
    if (dragId) dropCommand(dragId, band, null)
    endDrag()
  }
  const onSectionDragOver = (e: React.DragEvent, section: CommandSection) => {
    if (dragId) { e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'move'; setDragOverSectionId(section.id); setDragOverId(null) }
    else if (dragSectionId && dragSectionId !== section.id) { e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'move'; setDragOverSectionId(section.id) }
  }
  const onSectionDrop = (e: React.DragEvent, section: CommandSection) => {
    e.preventDefault(); e.stopPropagation()
    const sectionBand: CommandBand = section.scope === 'global' ? 'global' : 'config'
    if (dragId) {
      // Membership: the ONLY drop that writes sectionId (D7). Across bands the
      // section's band wins: the scope change is confirmed FIRST and the
      // section is written with it -- Cancel leaves the chip exactly where it was.
      const moved = commands.find((c) => c.id === dragId)
      if (moved && bandOfCmd(moved) !== sectionBand) setConfirm({ kind: 'scope', commandId: dragId, band: sectionBand, beforeId: null, sectionId: section.id })
      else store.setCommandSection(dragId, section.id)
    } else if (dragSectionId && dragSectionId !== section.id) {
      const dragged = sections.find((s) => s.id === dragSectionId)
      const draggedBand: CommandBand = dragged?.scope === 'global' ? 'global' : 'config'
      if (dragged && draggedBand !== sectionBand) {
        // A section label dropped in the OTHER band is a scope change for the
        // section and every button in it -- confirmed, never silent.
        setConfirm({ kind: 'section-band', sectionId: dragged.id, band: sectionBand })
      } else {
        const next = [...sections]
        const from = next.findIndex((s) => s.id === dragSectionId)
        const to = next.findIndex((s) => s.id === section.id)
        if (from !== -1 && to !== -1) { const [m] = next.splice(from, 1); next.splice(to, 0, m); reorderSections(next) }
      }
    }
    endDrag()
  }

  // ---- keyboard (roving focus inside a band; Alt+arrows reorder) --------------
  const chipKeyDown = (e: React.KeyboardEvent, cmd: CustomCommand, plan: BandPlan) => {
    const el = e.currentTarget as HTMLElement
    const bandEl = el.closest('[data-band]')
    const chips = Array.from(bandEl?.querySelectorAll<HTMLElement>('[data-testid="command-chip"]') ?? [])
    const i = chips.indexOf(el)
    const ordered = plan.chips
    const idx = ordered.findIndex((c) => c.id === cmd.id)
    if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && e.altKey && e.shiftKey) {
      // Across bands: the same scope change as a cross-band drop, same confirm (D7).
      e.preventDefault()
      const other: CommandBand = plan.band === 'global' ? 'config' : 'global'
      if (other === 'config' && !configId) return
      setConfirm({ kind: 'scope', commandId: cmd.id, band: other, beforeId: null })
      return
    }
    if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && e.altKey) {
      e.preventDefault()
      const dir = e.key === 'ArrowLeft' ? -1 : 1
      const j = idx + dir
      if (j < 0 || j >= ordered.length) return
      const beforeId = dir === -1 ? ordered[j].id : (ordered[j + 1]?.id ?? null)
      store.moveCommand(cmd.id, beforeId, plan.band, configId)
      requestAnimationFrame(() => { const again = Array.from(bandEl?.querySelectorAll<HTMLElement>('[data-testid="command-chip"]') ?? []); again.find((b) => b.dataset.commandId === cmd.id)?.focus() })
      return
    }
    if (e.key === 'ArrowLeft') { e.preventDefault(); chips[Math.max(0, i - 1)]?.focus(); return }
    if (e.key === 'ArrowRight') { e.preventDefault(); chips[Math.min(chips.length - 1, i + 1)]?.focus(); return }
    if (e.key === 'Home') { e.preventDefault(); chips[0]?.focus(); return }
    if (e.key === 'End') { e.preventDefault(); chips[chips.length - 1]?.focus(); return }
    if (e.key === 'Enter' && e.altKey) { e.preventDefault(); runCommand(cmd, el.getBoundingClientRect()); return }
    if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) { e.preventDefault(); openMenuAt(el, { kind: 'command', id: cmd.id }); return }
  }

  // ---- hiding core tools ------------------------------------------------------
  const closePaneIfOpen = (tool: CoreToolId) => {
    if (tool === 'canvas') { const st = useExcalidrawStore.getState(); if (st.bySessionId[sessionId]?.isOpen) st.togglePane(sessionId) }
    if (tool === 'browser') { const st = useWebviewStore.getState(); if (st.bySessionId[webviewKey]?.isOpen) st.setOpen(webviewKey, false) }
    if (tool === 'logs') { const st = useLogsStore.getState(); if (st.bySessionId[sessionId]?.isOpen) st.togglePane(sessionId) }
    if (tool === 'partner' && isPartnerActive && onTogglePartner) onTogglePartner()
  }
  const doHide = (tool: CoreToolId, where: 'session' | 'everywhere') => {
    closePaneIfOpen(tool)
    hideCoreTool?.(tool, where, webviewKey)
    setConfirm(null)
  }
  const requestHide = (tool: CoreToolId, where: 'session' | 'everywhere') => {
    const paneOpen =
      (tool === 'canvas' && !!useExcalidrawStore.getState().bySessionId[sessionId]?.isOpen) ||
      (tool === 'browser' && !!useWebviewStore.getState().bySessionId[webviewKey]?.isOpen)
    if (tool === 'partner' || paneOpen) { setConfirm({ kind: 'hide', tool }); setMenu(null); return }
    doHide(tool, where)
    setMenu(null)
  }

  // ---- folding -----------------------------------------------------------------
  const foldBands: FoldBand[] = useMemo(() => plans.map((p) => ({
    key: p.band,
    ids: p.chips.filter((c) => !(c.sectionId && collapsedSectionIds.includes(c.sectionId))).map((c) => c.id),
    pinned: new Set(p.chips.filter((c) => c.pinned).map((c) => c.id)),
    // A band whose pill is already on the row (buttons that cannot run here)
    // needs no room reserved for it.
    hasPill: p.inapplicable.length > 0,
  })), [plans, collapsedSectionIds])
  const { folded } = useBandFolding(rowRef, foldBands, overflowMode, !!dragId)

  const configName = useMemo(() => session?.label, [session])

  // ---- render helpers -----------------------------------------------------------
  const renderBand = (plan: BandPlan) => {
    const band = plan.band
    const foldedIds = folded[band] ?? new Set<string>()
    const foldedChips = plan.chips.filter((c) => foldedIds.has(c.id))
    const moreCount = foldedChips.length + plan.inapplicable.length
    let chipIndex = 0
    const sectionName = (id?: string) => plan.sections.find((s) => s.id === id)?.name
    // An empty band shows nothing but its GLOBAL/SESSION label, which just adds
    // noise to the row (owner). Hide the label — and its leading divider — when
    // the band carries no commands at all, EXCEPT while a drag is in progress:
    // an empty band is still the drop target that makes a command global or
    // session-scoped, so the label must reappear then to give somewhere to drop.
    const bandEmpty = plan.chips.length === 0 && plan.inapplicable.length === 0
    const showBandLabel = !bandEmpty || !!dragId
    return (
      <React.Fragment key={band}>
        {showBandLabel && <div className="w-px h-4 mx-0.5 shrink-0" style={{ background: 'var(--border-subtle)' }} />}
        <div
          role="toolbar"
          aria-label={`${plan.label} commands`}
          className={`flex items-center gap-1 shrink-0 rounded ${overflowMode === 'wrap2' ? 'flex-wrap' : ''}`}
          data-band={band}
          data-testid={`command-band-${band}`}
          onContextMenu={(e) => openMenu(e, { kind: 'band', band })}
          onDragOver={(e) => onSlotDragOver(e, band)}
          onDrop={(e) => onSlotDrop(e, band)}
        >
          {showBandLabel && (
            <span
              className="shrink-0 text-[9.5px] font-semibold uppercase tracking-[.09em] px-1 select-none"
              style={{ color: 'var(--text-muted)' }}
              title={band === 'global' ? 'Global — these buttons show in every config' : `Session — this config only${configName ? ` (${configName})` : ''}`}
              data-testid={`command-band-label-${band}`}
            >
              {plan.label}
            </span>
          )}
          {plan.clusters.map((cluster) => (
            <React.Fragment key={cluster.kind}>
              {cluster.chips.some((c) => !foldedIds.has(c.id) && !(c.sectionId && collapsedSectionIds.includes(c.sectionId))) && <TargetMark kind={cluster.kind} caps={caps} />}
              {cluster.groups.map((group) => {
                const section = group.section
                const collapsed = !!section && collapsedSectionIds.includes(section.id)
                const visibleChips = group.chips.filter((c) => !foldedIds.has(c.id))
                if (!collapsed && visibleChips.length === 0) return null
                return (
                  <React.Fragment key={section?.id ?? '__loose'}>
                    {section && (
                      <SectionLabel
                        section={{ ...section, color: legibleSectionColor(section.color, resolvedTheme) }}
                        onContextMenu={(e) => openMenu(e, { kind: 'section', id: section.id })}
                        onClick={collapsed ? () => toggleSectionCollapse?.(section.id) : undefined}
                        draggable
                        onDragStart={(e) => { setDragSectionId(section.id); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('application/x-section', section.id) }}
                        onDragOver={(e) => onSectionDragOver(e, section)}
                        onDrop={(e) => onSectionDrop(e, section)}
                        onDragEnd={endDrag}
                        isDropTarget={dragOverSectionId === section.id}
                      />
                    )}
                    {collapsed ? (
                      <button
                        type="button"
                        className={CHIP_CLASS}
                        style={CHIP_STYLE}
                        onClick={() => toggleSectionCollapse?.(section!.id)}
                        onContextMenu={(e) => openMenu(e, { kind: 'section', id: section!.id })}
                        title={`${section!.name} — ${group.chips.length} button${group.chips.length === 1 ? '' : 's'}, collapsed. Click to expand.`}
                        data-testid="command-section-collapsed"
                      >
                        <span className="inline-block w-2 h-2 rounded-sm" style={{ background: section!.color || 'var(--text-muted)' }} aria-hidden />
                        {section!.name}
                        <span className="text-[9px]" style={{ color: 'var(--text-muted)' }}>{group.chips.length}</span>
                      </button>
                    ) : visibleChips.map((cmd) => {
                      const i = chipIndex++
                      return (
                        <CommandChipWithBand
                          key={cmd.id}
                          cmd={cmd}
                          caps={caps}
                          band={band}
                          sectionName={sectionName(cmd.sectionId)}
                          tabIndex={i === 0 ? 0 : -1}
                          onClick={(e) => handleClick(cmd, e)}
                          onContextMenu={(e) => openMenu(e, { kind: 'command', id: cmd.id })}
                          onKeyDown={(e) => chipKeyDown(e, cmd, plan)}
                          draggable
                          isDragging={dragId === cmd.id}
                          isDropTarget={dragOverId === cmd.id}
                          onDragStart={(e) => onChipDragStart(e, cmd)}
                          onDragOver={(e) => onChipDragOver(e, cmd)}
                          onDrop={(e) => onChipDrop(e, cmd, band)}
                          onDragEnd={endDrag}
                        />
                      )
                    })}
                  </React.Fragment>
                )
              })}
            </React.Fragment>
          ))}
          {dragId && (
            <span
              className="inline-block w-7 h-7 rounded-md border border-dashed shrink-0"
              style={{ borderColor: dragOverSlot === band ? 'var(--brand)' : 'var(--border-strong)', background: dragOverSlot === band ? 'color-mix(in srgb, var(--brand) 12%, transparent)' : 'transparent' }}
              onDragOver={(e) => onSlotDragOver(e, band)}
              onDrop={(e) => onSlotDrop(e, band)}
              title="Drop here to put it at the end"
              data-testid={`command-end-slot-${band}`}
            />
          )}
          {moreCount > 0 && (
            <button
              type="button"
              className={CHIP_CLASS}
              style={{ ...CHIP_STYLE, background: 'var(--surface-overlay)', color: 'var(--text-primary)', borderColor: 'var(--border-strong)' }}
              onClick={(e) => setOverflowOpen({ band, anchor: (e.currentTarget as HTMLElement).getBoundingClientRect() })}
              title={`${moreCount} more ${plan.label.toLowerCase()} command${moreCount === 1 ? '' : 's'}${plan.inapplicable.length ? ` (${plan.inapplicable.length} cannot run here)` : ''}`}
              aria-haspopup="dialog"
              data-testid={`command-more-${band}`}
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden><circle cx="5" cy="12" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="19" cy="12" r="2" /></svg>
              {moreCount} more
            </button>
          )}
        </div>
      </React.Fragment>
    )
  }

  const coreWrap = (tool: CoreToolId, node: React.ReactNode) => (
    <span key={tool} className="contents" onContextMenu={(e) => openMenu(e, { kind: 'core', tool })} data-testid={`core-tool-${tool}`}>
      {node}
    </span>
  )

  // ---- the bar --------------------------------------------------------------------
  if (barCollapsed) {
    // Hidden by "Hide the command bar"; Settings → Custom Commands shows it again.
    return <div className="shrink-0" data-testid="command-bar-hidden" />
  }

  const menuCmd = menu?.kind === 'command' ? commands.find((c) => c.id === menu.id) : undefined
  const menuSection = menu?.kind === 'section' ? sections.find((s) => s.id === menu.id) : undefined
  const confirmCmd = confirm && (confirm.kind === 'scope' || confirm.kind === 'delete') ? commands.find((c) => c.id === confirm.commandId) : undefined
  const overflowPlan = overflowOpen ? plans.find((p) => p.band === overflowOpen.band) : undefined

  return (
    <div className="flex flex-col shrink-0" onContextMenu={(e) => openMenu(e, { kind: 'bar' })} data-testid="command-bar">
      <PasteHint sessionId={sessionId} />
      <div
        ref={rowRef}
        className={`flex items-center gap-1.5 px-2.5 py-[9px] border-t ${overflowMode === 'wrap2' ? 'flex-wrap gap-y-1.5' : 'overflow-hidden'}`}
        style={{ background: 'var(--surface-chrome)', borderColor: 'var(--border-subtle)' }}
        data-testid="command-row"
        data-overflow={overflowMode}
      >
        {/* Add — far left, prominent (owner). Click adds a command; the caret
            offers the rest. Not on the Ask session (#465): its bar carries no
            command bands, so there is nothing an Add could add to. */}
        {!caps.isAsk && (
        <span className="inline-flex items-stretch rounded-md border shrink-0 overflow-hidden" style={{ borderColor: 'color-mix(in srgb, var(--brand) 55%, transparent)', background: 'color-mix(in srgb, var(--brand) 16%, transparent)' }} data-testid="command-add">
          <button
            type="button"
            onClick={() => setShowDialog({ scope: configId ? 'config' : 'global' })}
            className="flex items-center gap-1 px-2.5 h-7 text-xs font-semibold focus-ring"
            style={{ color: '#5cb0ff' }}
            title="Add a command button"
            aria-label="Add command"
            data-testid="command-add-button"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden><path d="M12 5v14M5 12h14" /></svg>
            Add
          </button>
          <button
            type="button"
            onClick={(e) => openMenuAt(e.currentTarget as HTMLElement, { kind: 'add' })}
            className="px-1 text-xs focus-ring"
            style={{ color: '#5cb0ff', borderLeft: '1px solid color-mix(in srgb, var(--brand) 45%, transparent)' }}
            title="Add command · Add section · Add note · Manage commands"
            aria-label="More ways to add"
            aria-haspopup="menu"
            data-testid="command-add-caret"
          >
            <svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden><path d="M2.5 4l2.5 2.5L7.5 4" /></svg>
          </button>
        </span>
        )}

        {/* Core — the fixed tools. Components, never data, never drop targets.
            The Ask session (#465) keeps only Snap and Canvas: it is a slim help
            surface, so the project-facing tools — Logs (its runs are not
            indexed), Browser, Artifacts (a claude.ai surface), Partner and the
            encrypted Notes — never render there. */}
        <div role="toolbar" aria-label="Session tools" className="flex items-center gap-1 shrink-0" data-testid="command-band-core" onDragOver={(e) => { if (dragId) { e.dataTransfer.dropEffect = 'none' } }}>
          {!hiddenHere.has('snap') && caps.canSendImageToAgent && coreWrap('snap', <ScreenshotButton sessionId={sessionId} sessionType={sessionType} />)}
          {!hiddenHere.has('canvas') && coreWrap('canvas', <AgentCanvasButton sessionId={sessionId} />)}
          {!caps.isAsk && !hiddenHere.has('logs') && coreWrap('logs', <LogsButton sessionId={sessionId} structuralReason={caps.logsEmptyReason} remoteHost={caps.remoteHost} />)}
          {!caps.isAsk && !hiddenHere.has('browser') && coreWrap('browser', <WebviewButton sessionId={webviewKey} />)}
          {!caps.isAsk && !hiddenHere.has('artifacts') && artifactsApplicable && coreWrap('artifacts', (
            <button
              type="button"
              onClick={openArtifacts}
              className="relative flex items-center gap-1.5 px-2 h-7 text-xs rounded border transition-colors whitespace-nowrap shrink-0 focus-ring bg-surface0/60 border-surface1/80 hover:bg-surface1 text-overlay1 hover:text-text"
              title="Open this account's artifacts on claude.ai"
              aria-label="Open artifacts"
              data-testid="artifacts-open"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" />
                <rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" />
              </svg>
              Artifacts
            </button>
          ))}
          {!caps.isAsk && partnerEnabled && onTogglePartner && !hiddenHere.has('partner') && coreWrap('partner', (
            <button
              onClick={onTogglePartner}
              className={`relative flex items-center gap-1.5 px-2 h-7 text-xs rounded border transition-colors whitespace-nowrap shrink-0 focus-ring ${
                isPartnerActive
                  ? 'bg-green/20 border-green/70 text-green hover:bg-green/30'
                  : 'bg-surface0/60 border-surface1/80 hover:bg-surface1 text-overlay1 hover:text-text'
              }`}
              title={isPartnerActive ? 'Back to the main terminal' : caps.panesOnDifferentMachines ? 'Switch to the partner shell — it runs on this PC, not the host' : 'Switch to the partner shell'}
              data-testid="partner-toggle"
            >
              {isPartnerActive ? (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M19 12H5M11 18l-6-6 6-6" /></svg>
              ) : (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="7 8 3 12 7 16" /><polyline points="17 8 21 12 17 16" /><line x1="14" y1="4" x2="10" y2="20" /></svg>
              )}
              <ReservedLabel current={isPartnerActive ? (caps.agentName || 'Terminal') : 'Partner'} states={[caps.agentName || 'Terminal', 'Partner']} />
              {caps.panesOnDifferentMachines && (
                <span className="rounded px-1 text-[7.5px] font-bold uppercase tracking-wide leading-[11px] border" style={{ background: 'var(--surface-overlay)', borderColor: 'var(--border-strong)', color: 'var(--text-secondary)' }} data-testid="command-machine-badge">this PC</span>
              )}
            </button>
          ))}
          {/* The encrypted notes, moved here from the session header (D10): one lock, a quiet count. */}
          {!caps.isAsk && !hiddenHere.has('notes') && coreWrap('notes', <NotesTool ref={notesRef} configId={configId} configName={configName} />)}
        </div>

        {/* Codex keeps its two session pills -- session controls, not commands. */}
        {(session?.provider ?? 'claude') === 'codex' && session?.codexOptions && (
          <>
            <div className="w-px h-4 mx-0.5 shrink-0" style={{ background: 'var(--border-subtle)' }} />
            <PermissionsPresetDropdown
              value={session.codexOptions.permissionsPreset ?? 'standard'}
              onChange={(next) => updateSession(session.id, { codexOptions: { ...session.codexOptions!, permissionsPreset: next } })}
            />
            <CodexModelDropdown
              value={session.codexOptions.model ?? 'gpt-5.5'}
              onChange={(next) => updateSession(session.id, { codexOptions: { ...session.codexOptions!, model: next } })}
            />
          </>
        )}

        {/* #465: no command bands on the Ask session — the user's Global and
            per-config buttons are workspace tooling, not help-session tooling. */}
        {!caps.isAsk && plans.map(renderBand)}
        <div className="flex-1 min-w-[4px]" />
      </div>

      {/* ---- dialogs, menus, popovers ---- */}
      {showDialog && (
        <CommandDialog
          onConfirm={handleAdd}
          onCancel={() => setShowDialog(null)}
          configId={configId}
          configName={configName}
          capabilities={caps}
          presetScope={showDialog.scope}
          presetSectionId={showDialog.sectionId}
        />
      )}
      {editingCommand && (
        <CommandDialog
          onConfirm={handleEdit}
          onCancel={() => setEditingCommand(null)}
          initial={editingCommand}
          configId={configId}
          configName={configName}
          capabilities={caps}
        />
      )}

      {menu?.kind === 'command' && menuCmd && (
        <UserButtonMenu
          x={menu.x} y={menu.y} cmd={menuCmd} caps={caps}
          sections={plans.find((p) => p.band === bandOfCmd(menuCmd))?.sections ?? []}
          // The band's OWN sections, as the chip's tooltip reads them (D4: the
          // header is the tooltip) -- an orphan sectionId names nothing in either.
          sectionName={plans.find((p) => p.band === bandOfCmd(menuCmd))?.sections.find((s) => s.id === menuCmd.sectionId)?.name}
          hasConfig={!!configId}
          cannotRunReason={inapplicability(menuCmd, caps)?.reason ?? null}
          returnFocusTo={menu.el}
          onClose={() => setMenu(null)}
          onRun={() => { setMenu(null); if (!inapplicability(menuCmd, caps)) runCommand(menuCmd) }}
          onRunWithArgs={() => { const el = menu.el; setMenu(null); runCommand(menuCmd, el?.getBoundingClientRect() ?? new DOMRect(menu.x, menu.y, 1, 1)) }}
          onEdit={() => { setMenu(null); setEditingCommand(menuCmd) }}
          onDuplicate={() => {
            setMenu(null)
            const { id: _id, order: _o, pinned: _p, needsReview: _r, hasSecretArg: _s, lastCustomArgs: _l, ...rest } = menuCmd
            addCommand({ ...rest, id: generateId(), label: `${menuCmd.label} copy` })
          }}
          onIcon={(key) => updateCommand(menuCmd.id, { icon: key })}
          onColor={(hex) => updateCommand(menuCmd.id, { color: hex })}
          onTogglePin={() => { setMenu(null); store.togglePinned(menuCmd.id) }}
          onShowIn={(band) => { setMenu(null); if (band !== bandOfCmd(menuCmd)) setConfirm({ kind: 'scope', commandId: menuCmd.id, band, beforeId: null }) }}
          onMoveToSection={(sectionId) => { setMenu(null); store.setCommandSection(menuCmd.id, sectionId) }}
          onMove={(dir) => {
            setMenu(null)
            const plan = plans.find((p) => p.band === bandOfCmd(menuCmd))
            if (!plan) return
            const ordered = bandMembers(commands, plan.band, configId).filter((c) => !c.pinned || menuCmd.pinned)
            const idx = ordered.findIndex((c) => c.id === menuCmd.id)
            // Already there: nothing to write (the keyboard path returns early too).
            if ((dir === 'left' || dir === 'start') && idx <= 0) return
            if ((dir === 'right' || dir === 'end') && idx === ordered.length - 1) return
            let beforeId: string | null = null
            if (dir === 'left') beforeId = ordered[idx - 1]?.id ?? ordered[0]?.id ?? null
            else if (dir === 'right') beforeId = ordered[idx + 2]?.id ?? null
            else if (dir === 'start') beforeId = ordered[0]?.id ?? null
            else beforeId = null
            if (beforeId === menuCmd.id) return
            store.moveCommand(menuCmd.id, beforeId, plan.band, configId)
          }}
          onDelete={() => { setMenu(null); setConfirm({ kind: 'delete', commandId: menuCmd.id }) }}
        />
      )}
      {menu?.kind === 'core' && (
        <CoreToolMenu
          x={menu.x} y={menu.y} tool={menu.tool}
          title={TOOL_LABEL[menu.tool]}
          sub={menu.tool === 'partner' ? (caps.panesOnDifferentMachines ? 'the partner shell · on this PC' : 'the partner shell')
            : menu.tool === 'logs' ? (caps.logsEmptyReason ? 'nothing to show in this kind of session' : 'this session\'s transcript')
            : menu.tool === 'canvas' ? 'Agent Canvas · reviews and mock-ups'
            : menu.tool === 'snap' ? `a screenshot, sent to ${caps.agentName || 'the agent'}`
            : menu.tool === 'notes' ? 'encrypted notes · Global and this config'
            : menu.tool === 'artifacts' ? 'this account\'s artifacts on claude.ai'
            : 'the browser pane'}
          ownActions={
            menu.tool === 'partner' && onTogglePartner ? [{ label: isPartnerActive ? 'Back to the main terminal' : 'Open partner shell', onClick: () => { setMenu(null); onTogglePartner() }, testId: 'menu-partner-toggle' }]
            : menu.tool === 'snap' ? [{ label: 'Screenshot settings…', onClick: () => { setMenu(null); openSettingsTab('commands') }, testId: 'menu-snap-settings' }]
            : menu.tool === 'notes' ? [
                { label: 'Add note…', onClick: () => { setMenu(null); notesRef.current?.addNote() }, testId: 'menu-notes-add' },
                { label: 'Open notes', onClick: () => { setMenu(null); notesRef.current?.openList() }, testId: 'menu-notes-open' },
              ]
            : menu.tool === 'canvas' && canvasQueue > 0 ? [
                { label: `Dismiss everything waiting on me (${canvasQueue})…`, onClick: () => { setMenu(null); setConfirm({ kind: 'canvas-dismiss' }) }, testId: 'menu-canvas-dismiss-all' },
                { label: `Show what's waiting (${canvasQueue})`, onClick: () => { setMenu(null); window.dispatchEvent(new CustomEvent('ccc:canvasShowQueue', { detail: { sessionId } })) }, testId: 'menu-canvas-show-queue' },
              ]
            : menu.tool === 'artifacts' ? [
                { label: 'Open artifacts', onClick: () => { setMenu(null); openArtifacts() }, testId: 'menu-artifacts-open' },
                // The GLOBAL open-target chooser (owner call 2026-08-26): the
                // check marks the current choice; picking writes the setting
                // for every entry point (this button and the session menu).
                { label: `${artifactsTarget === 'window' ? '✓ ' : ''}Open in a separate window`, onClick: () => { setMenu(null); setArtifactsTarget('window') }, testId: 'menu-artifacts-target-window' },
                { label: `${artifactsTarget === 'pane' ? '✓ ' : ''}Open in the session's browser pane`, onClick: () => { setMenu(null); setArtifactsTarget('pane') }, testId: 'menu-artifacts-target-pane' },
              ]
            : undefined}
          onHide={(where) => requestHide(menu.tool, where)}
          onClose={() => setMenu(null)}
          returnFocusTo={menu.el}
        />
      )}
      {menu?.kind === 'section' && menuSection && (
        <SectionMenu
          x={menu.x} y={menu.y} section={menuSection}
          count={commands.filter((c) => c.sectionId === menuSection.id).length}
          collapsed={collapsedSectionIds.includes(menuSection.id)}
          hasConfig={!!configId}
          onRename={() => { setSectionInput({ x: menu.x, y: menu.y, editSection: menuSection, band: menuSection.scope === 'global' ? 'global' : 'config' }); setMenu(null) }}
          onColor={(hex) => updateSection(menuSection.id, { color: hex })}
          onCollapse={() => { setMenu(null); toggleSectionCollapse?.(menuSection.id) }}
          onMoveBand={(band) => { setMenu(null); setConfirm({ kind: 'section-band', sectionId: menuSection.id, band }) }}
          onAddCommand={() => { setMenu(null); setShowDialog({ scope: menuSection.scope === 'global' ? 'global' : 'config', sectionId: menuSection.id }) }}
          onDelete={() => { setMenu(null); removeSection(menuSection.id) }}
          onClose={() => setMenu(null)}
          returnFocusTo={menu.el}
        />
      )}
      {menu?.kind === 'bar' && (
        <BarMenu
          x={menu.x} y={menu.y} overflow={overflowMode}
          hiddenTools={Array.from(hiddenHere).map((t) => ({ tool: t, label: TOOL_LABEL[t] }))}
          onAddCommand={caps.isAsk ? undefined : () => { setMenu(null); setShowDialog({ scope: configId ? 'config' : 'global' }) }}
          onAddSection={caps.isAsk ? undefined : () => { setSectionInput({ x: menu.x, y: menu.y, band: configId ? 'config' : 'global' }); setMenu(null) }}
          onOverflow={(v) => { setMenu(null); setOverflow?.(v) }}
          onShowTool={(tool) => { setMenu(null); showCoreTool?.(tool, hidden.everywhere?.includes(tool) ? 'everywhere' : 'session', webviewKey) }}
          onManage={() => { setMenu(null); openSettingsTab('commands') }}
          onHideBar={() => { setMenu(null); setBarCollapsed?.(true) }}
          onClose={() => setMenu(null)}
          returnFocusTo={menu.el}
        />
      )}
      {menu?.kind === 'band' && (
        <BandMenu
          x={menu.x} y={menu.y} band={menu.band} configName={configName}
          onAddCommand={() => { setMenu(null); setShowDialog({ scope: menu.band }) }}
          onAddSection={() => { setSectionInput({ x: menu.x, y: menu.y, band: menu.band }); setMenu(null) }}
          onManage={() => { setMenu(null); openSettingsTab('commands') }}
          onClose={() => setMenu(null)}
          returnFocusTo={menu.el}
        />
      )}
      {menu?.kind === 'add' && (
        <AddMenu
          x={menu.x} y={menu.y} reviewCount={reviewCount} notesEnabled={!hiddenHere.has('notes')}
          onAddNote={() => { setMenu(null); notesRef.current?.addNote() }}
          onAddCommand={() => { setMenu(null); setShowDialog({ scope: configId ? 'config' : 'global' }) }}
          onAddSection={() => { setSectionInput({ x: menu.x, y: menu.y, band: configId ? 'config' : 'global' }); setMenu(null) }}
          onReview={() => { setMenu(null); const first = visibleCommands.find((c) => c.needsReview?.length); if (first) setEditingCommand(first) }}
          onManage={() => { setMenu(null); openSettingsTab('commands') }}
          onClose={() => setMenu(null)}
          returnFocusTo={menu.el}
        />
      )}

      {sectionInput && (
        <SectionNameInput
          x={sectionInput.x}
          y={sectionInput.y}
          initialName={sectionInput.editSection?.name}
          initialColor={sectionInput.editSection?.color}
          onConfirm={(name, color) => {
            if (sectionInput.editSection) {
              updateSection(sectionInput.editSection.id, { name, color })
            } else {
              // A section belongs to the band it was created in (D9): Global
              // sections are possible for the first time.
              useCommandStore.getState().addSection({
                id: generateId(),
                name,
                color,
                scope: sectionInput.band === 'global' ? 'global' : 'config',
                configId: sectionInput.band === 'global' ? undefined : configId,
              })
              trackUsage('commands.command-sections')
            }
            setSectionInput(null)
          }}
          onCancel={() => setSectionInput(null)}
        />
      )}

      {argsPopover && (
        <ArgsPopover
          cmd={argsPopover.cmd}
          rect={argsPopover.rect}
          onRun={(args) => {
            const cmd = argsPopover.cmd
            updateCommand(cmd.id, { lastCustomArgs: args })
            sendCommand(cmd, buildFullCommand(cmd, args))
            setArgsPopover(null)
          }}
          onSetDefault={(args) => { updateCommand(argsPopover.cmd.id, { defaultArgs: args }); setArgsPopover(null) }}
          onClose={() => setArgsPopover(null)}
        />
      )}

      {/* #379: the program this button starts prints over the terminal. */}
      {guiPrompt && (
        <GuiExeDialog
          label={guiPrompt.cmd.label}
          command={guiPrompt.fullCommand}
          exePath={guiPrompt.exePath}
          onChoose={(choice, remember) => {
            const { cmd, fullCommand } = guiPrompt
            setGuiPrompt(null)
            if (remember) updateCommand(cmd.id, { guiExePolicy: choice })
            if (choice === 'capture') runCaptured(cmd, fullCommand)
            else typeIntoPty(cmd, fullCommand, true)
          }}
          onCancel={() => setGuiPrompt(null)}
        />
      )}

      {capturedRun && (
        <CapturedRunModal
          runId={capturedRun.runId}
          label={capturedRun.label}
          command={capturedRun.command}
          exePath={capturedRun.exePath}
          startError={capturedRun.startError}
          onClose={() => setCapturedRun(null)}
        />
      )}

      {overflowOpen && overflowPlan && (
        <BandOverflow
          plan={overflowPlan}
          folded={overflowPlan.chips.filter((c) => (folded[overflowPlan.band] ?? new Set()).has(c.id))}
          caps={caps}
          anchor={overflowOpen.anchor}
          onRun={(cmd, e) => runCommand(cmd, e.ctrlKey ? overflowOpen.anchor : undefined)}
          onContextMenu={(cmd, e) => { setOverflowOpen(null); setMenu({ kind: 'command', id: cmd.id, x: e.clientX, y: e.clientY }) }}
          onManage={() => openSettingsTab('commands')}
          onClose={() => setOverflowOpen(null)}
        />
      )}

      {confirm?.kind === 'scope' && confirmCmd && (
        <ConfirmCard
          testId="confirm-scope"
          title={confirm.band === 'global' ? `Show "${confirmCmd.label}" in every config?` : `Keep "${confirmCmd.label}" only in this config?`}
          body={confirm.band === 'global'
            ? <>It becomes <b>Global</b>: it appears in every config, and editing or deleting it reaches all of them.{confirmCmd.hasSecretArg ? <> Its secret then rides the environment of every shell you open on this PC, not only this config's.</> : null}</>
            : <>It becomes <b>Session</b>-only: it leaves your other {configCount && configCount > 1 ? `${configCount - 1} config${configCount - 1 === 1 ? '' : 's'}` : 'configs'} and shows only here{configName ? ` (${configName})` : ''}.</>}
          actions={[{ label: confirm.band === 'global' ? 'Make Global' : 'Keep it here only', primary: true, testId: 'confirm-scope-ok', onClick: () => {
            store.moveCommand(confirm.commandId, confirm.beforeId, confirm.band, configId)
            // A drop onto a section of the other band files it there only now (D7).
            if (confirm.sectionId) store.setCommandSection(confirm.commandId, confirm.sectionId)
            setConfirm(null)
          } }]}
          onCancel={() => setConfirm(null)}
        />
      )}
      {confirm?.kind === 'delete' && confirmCmd && (
        <ConfirmCard
          testId="confirm-delete"
          title={`Delete "${confirmCmd.label}"?`}
          body={confirmCmd.scope === 'global' ? <>This button is <b>Global</b> — it disappears from every config.{confirmCmd.hasSecretArg ? ' Its secret is removed from the keychain.' : ''}</> : <>It disappears from this config.{confirmCmd.hasSecretArg ? ' Its secret is removed from the keychain.' : ''}</>}
          actions={[{ label: 'Delete', danger: true, testId: 'confirm-delete-ok', onClick: () => { deleteCommand(confirm.commandId); setConfirm(null) } }]}
          onCancel={() => setConfirm(null)}
        />
      )}
      {confirm?.kind === 'hide' && (
        <ConfirmCard
          testId="confirm-hide"
          title={`Hide the ${TOOL_LABEL[confirm.tool]} tool?`}
          body={<>
            {confirm.tool === 'partner' && <p>Buttons that run in the partner shell still open it when you click them.</p>}
            {(confirm.tool === 'canvas' || confirm.tool === 'browser') && <p>Its pane closes first — the button is the way back to the terminal.</p>}
            <p className="mt-1"><b>In this session:</b> comes back when you close this tab.<br /><b>Everywhere:</b> comes back only from Settings → Custom Commands (or "Show hidden tools" in the bar's right-click).</p>
          </>}
          actions={[
            { label: 'Hide in this session', testId: 'confirm-hide-session', onClick: () => doHide(confirm.tool, 'session') },
            { label: 'Hide everywhere', primary: true, testId: 'confirm-hide-everywhere', onClick: () => doHide(confirm.tool, 'everywhere') },
          ]}
          onCancel={() => setConfirm(null)}
        />
      )}
      {confirm?.kind === 'section-band' && (() => {
        const sec = sections.find((s) => s.id === confirm.sectionId)
        if (!sec) return null
        const members = commands.filter((c) => c.sectionId === sec.id)
        return (
          <ConfirmCard
            testId="confirm-section-band"
            title={`Move "${sec.name}" and its ${members.length} button${members.length === 1 ? '' : 's'} to ${confirm.band === 'global' ? 'Global' : 'Session'}?`}
            body={confirm.band === 'global' ? <>They will show in every config.</> : <>They will show only in this config{configName ? ` (${configName})` : ''}.</>}
            actions={[{ label: 'Move', primary: true, testId: 'confirm-section-band-ok', onClick: () => {
              updateSection(sec.id, { scope: confirm.band === 'global' ? 'global' : 'config', configId: confirm.band === 'global' ? undefined : configId })
              for (const m of members) store.moveCommand(m.id, null, confirm.band, configId)
              setConfirm(null)
            } }]}
            onCancel={() => setConfirm(null)}
          />
        )
      })()}
      {confirm?.kind === 'canvas-dismiss' && (
        <ConfirmCard
          testId="confirm-canvas-dismiss"
          title="Dismiss everything waiting on you?"
          body={<>
            {canvasQueue} canvas{canvasQueue === 1 ? '' : 'es'} with rounds waiting on you. Notes the agent
            answered are closed — each keeps a <b>Reopen</b> — and a render still waiting for its first review
            stops asking. Nothing is deleted, and rounds still with the agent are left alone.
          </>}
          actions={[{ label: 'Dismiss all', danger: true, testId: 'confirm-canvas-dismiss-ok', onClick: () => { void doCanvasDismissAll() } }]}
          onCancel={() => setConfirm(null)}
        />
      )}
    </div>
  )
}

/** A CommandChip that also carries the band for the folding hook's measurement. */
function CommandChipWithBand(props: React.ComponentProps<typeof CommandChip> & { band: CommandBand }) {
  const { band, ...rest } = props
  return (
    <CommandChip
      {...rest}
      buttonRef={(el) => { if (el) el.setAttribute('data-fold-band', band) }}
    />
  )
}

// Re-export for places that want to draw a command the way the bar does.
export { CommandIcon, DEFAULT_COMMAND_COLOR }
