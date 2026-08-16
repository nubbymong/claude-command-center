// src/main/effort-tracker.ts
// Live reasoning-effort tracker. Claude reports the active effort on every hook
// event as `payload.effort.level`; CCC's status strip otherwise only knows the
// effort the user picked THROUGH CCC, so a globally-set effort never shows. This
// reads the live value, dedupes per session, and pushes it to the renderer.
// Mirrors channel-permissions.ts (subscribe once at boot; push via webContents).
import { BrowserWindow } from 'electron'
import { getGateway } from './hooks/index'
import { IPC } from '../shared/ipc-channels'
import type { HookEvent } from '../shared/hook-types'
import { getRegistry } from './model-registry-service'
import { sentinelObserve } from './sentinel/index'
import {
  noteSessionStart,
  noteSubagentStart,
  noteSubagentStop,
  noteBackgroundToolStart,
  noteBackgroundToolStop,
  noteTurnEnd,
  isBackgroundContext,
} from './background-context'

// Tool calls that launch a BACKGROUND agent whose model/effort must not repaint
// the main strip. The tool's Pre/PostToolUse bracket the background window
// RACE-FREE (they fire on the main transcript, in order, around the whole
// agent), which is what the fire-and-forget SubagentStart signal cannot do.
// Names span CC versions/features: Task + Agent launch subagents; Workflow
// launches a dynamic workflow.
const BACKGROUND_SPAWN_TOOLS: ReadonlySet<string> = new Set(['Task', 'Agent', 'Workflow'])

// DELIBERATE behaviour change (spec 2026-06-11 §3/§4): unknown effort levels
// now display verbatim instead of being silently dropped. A hardcoded VALID set
// would re-create the documented restore crash (see pty-handlers.ts effortLevel
// comment). Unknown levels are also reported to the Sentinel observer seam so
// Phase 2 can detect new CC-shipped effort values automatically.

const lastBySession = new Map<string, string>()
let started = false

let effortObserver: ((value: string) => void) | null = null
/** Sentinel Trigger A hook (wired in Phase 2); test seam until then. */
export function setEffortObserver(fn: ((value: string) => void) | null): void { effortObserver = fn }
export const _setEffortObserverForTest = setEffortObserver

export function effortFromEvent(e: HookEvent): string | undefined {
  const eff = (e.payload as { effort?: unknown }).effort
  if (!eff || typeof eff !== 'object') return undefined
  const level = (eff as { level?: unknown }).level
  if (typeof level !== 'string' || !level) return undefined
  const known = getRegistry().effortLevels.some((l) => l.value === level)
  if (!known) { try { effortObserver?.(level) } catch { /* observer must not break tracking */ } }
  return level                                // permissive: unknown levels still display (spec §3/§4)
}

function pushEffort(sessionId: string, effortLevel: string): void {
  for (const w of BrowserWindow.getAllWindows()) {
    try { w.webContents.send(IPC.HOOKS_EFFORT_UPDATE, { sessionId, effortLevel }) } catch { /* window destroyed */ }
  }
}

function transcriptOf(e: HookEvent): string | undefined {
  const tp = (e.payload as { transcript_path?: unknown }).transcript_path
  return typeof tp === 'string' ? tp : undefined
}

function track(e: HookEvent): void {
  // Background-context lifecycle (see background-context.ts): anchor the main
  // transcript at SessionStart, bracket subagent/workflow-agent execution with
  // SubagentStart/Stop. These carry no effort we want to push.
  if (e.event === 'SessionStart') { noteSessionStart(e.sessionId, transcriptOf(e)); return }
  if (e.event === 'SubagentStart') { noteSubagentStart(e.sessionId); return }
  if (e.event === 'SubagentStop') { noteSubagentStop(e.sessionId); return }
  // Turn ended -> drop the session's last-effort so the map can't grow
  // unbounded, and clear any dangling subagent depth. Mirrors
  // channel-permissions.ts clearing per-session state on Stop.
  if (e.event === 'Stop') { lastBySession.delete(e.sessionId); noteTurnEnd(e.sessionId); return }

  // A background-spawning tool call (Task/Agent/Workflow) brackets the whole
  // background agent race-free. Its PostToolUse ENDS the window: exit background
  // BEFORE this event's own effort, which is the main window's again. Its
  // PreToolUse BEGINS the window: enter AFTER this event's own effort, which is
  // still the main window's. This is the primary fix for the pills flickering to
  // a subagent's / dynamic-workflow agent's effort.
  const spawnTool = !!e.toolName && BACKGROUND_SPAWN_TOOLS.has(e.toolName)
  if (spawnTool && e.event === 'PostToolUse') noteBackgroundToolStop(e.sessionId)

  const level = effortFromEvent(e)
  // A subagent / workflow agent's effort must not repaint the main strip: its
  // PreToolUse/PostToolUse events reach the main session's hook endpoint, but
  // the effort is the agent's, not the main window's.
  if (level && e.sessionId
      && !isBackgroundContext(e.sessionId, transcriptOf(e))
      && lastBySession.get(e.sessionId) !== level) {
    lastBySession.set(e.sessionId, level)
    pushEffort(e.sessionId, level)
  }

  if (spawnTool && e.event === 'PreToolUse') noteBackgroundToolStart(e.sessionId)
}

/** Test seam. */
export function _emitForTest(e: HookEvent): void { track(e) }
/** Test seam. */
export function _resetEffort(): void { lastBySession.clear() }

export function startEffortTracker(): void {
  if (started) return
  started = true
  // Wire Sentinel Trigger A: unknown effort levels are reported for registry
  // proposals. sentinelObserve is a no-op before initSentinel (fail-open).
  setEffortObserver((v) => { try { sentinelObserve({ kind: 'effort', value: v, source: 'hooks' }) } catch { /* must not break tracking */ } })
  const gw = getGateway()
  if (gw) gw.subscribe(track)
}
