/**
 * One derived description of what a session CAN do, computed from the three
 * facts every session already carries (provider, sessionType, shellOnly) plus
 * whether it has a saved config. The command bar, the command dialog, the Logs
 * button and the Settings page all read THIS and nothing else.
 *
 * Why one function: until 2.1.0-beta.16 the bar's only type-awareness was a
 * single boolean, `mainPaneIsShell`. Provider and transport never reached the
 * labels, so a Codex session was told "Claude", and on every SSH session the
 * partner shell -- which is a LOCAL PTY (App.tsx spawns it with no ssh prop) --
 * was described only as "the partner shell", with nothing on screen saying it
 * runs on this PC and not on the host. Three axes standing behind one flag
 * is exactly how those lies happened; deriving everything here is how they
 * stop. A future session type is added in this file alone.
 */
import type { Session } from '../stores/sessionStore'

export type CommandTarget = 'claude' | 'partner'
export type AgentId = 'claude' | 'codex'
export type LogsEmptyReason = 'shell-only' | 'ssh' | 'codex'

export type CapabilitySource = Pick<Session, 'provider' | 'sessionType' | 'shellOnly' | 'configId' | 'sshConfig' | 'kind'>

export interface SessionCapabilities {
  /** The agent in the MAIN pane, or null for a plain shell. */
  agent: AgentId | null
  /** "Claude" / "Codex" -- the one string every label derives from. '' for a shell. */
  agentName: string
  /** What the main pane accepts when a button types into it. */
  mainAccepts: 'prompt' | 'shell'
  /** Where the main pane's process runs. */
  mainRunsOn: 'local' | 'remote'
  /** The partner pane is ALWAYS a local shell, SSH or not (App.tsx). */
  partnerRunsOn: 'local'
  /** Host name for wording when the main pane is remote. */
  remoteHost?: string
  /** True on every SSH session: the two panes are on different computers. */
  panesOnDifferentMachines: boolean
  /** Mirrors LogsPane's structural predicate: a shell has no transcript; an SSH
   *  transcript lives on the host; Codex transcripts are not indexed. */
  logsEmptyReason: LogsEmptyReason | null
  canIndexLogs: boolean
  /** Snap types an English prompt into the main pane -- nonsense on a shell. */
  canSendImageToAgent: boolean
  /** A session with no saved config has no "this config" to scope to. */
  hasConfig: boolean
  /** True when this is the Ask Conductor help session. */
  isAsk: boolean
  /** Where a button with this target runs. A page button has no target. */
  runsOn: (target: CommandTarget) => 'local' | 'remote'
  /** A secret argument is injected only into LOCAL shell spawns (main sets the
   *  env var when the shell starts; the SSH branch never does), and a reference
   *  typed into an agent's TUI is just text. So: a local shell target only. */
  canDeliverSecret: (target: CommandTarget) => boolean
  /** Whether the main pane IS a shell (the old `mainPaneIsShell`). */
  mainPaneIsShell: boolean
}

const AGENT_NAMES: Record<AgentId, string> = { claude: 'Claude', codex: 'Codex' }

export function sessionCapabilities(session: CapabilitySource | null | undefined): SessionCapabilities {
  const provider: AgentId = session?.provider === 'codex' ? 'codex' : 'claude'
  const shellOnly = !!session?.shellOnly
  const ssh = session?.sessionType === 'ssh'
  const agent: AgentId | null = shellOnly ? null : provider
  const logsEmptyReason: LogsEmptyReason | null = shellOnly ? 'shell-only' : ssh ? 'ssh' : provider === 'codex' ? 'codex' : null
  const mainRunsOn: 'local' | 'remote' = ssh ? 'remote' : 'local'
  const runsOn = (target: CommandTarget): 'local' | 'remote' => (target === 'partner' ? 'local' : mainRunsOn)
  return {
    agent,
    agentName: agent ? AGENT_NAMES[agent] : '',
    mainAccepts: shellOnly ? 'shell' : 'prompt',
    mainRunsOn,
    partnerRunsOn: 'local',
    remoteHost: ssh ? session?.sshConfig?.host : undefined,
    panesOnDifferentMachines: ssh,
    logsEmptyReason,
    canIndexLogs: logsEmptyReason === null,
    canSendImageToAgent: !shellOnly,
    hasConfig: !!session?.configId,
    isAsk: session?.kind === 'ask',
    runsOn,
    // A 'claude' target on a shell-only session IS the main shell (that is what
    // "the row the main pane is" meant); on an agent session it is the agent.
    canDeliverSecret: (target) => runsOn(target) === 'local' && (target === 'partner' || shellOnly),
    mainPaneIsShell: shellOnly,
  }
}

/** Plain words for where a target runs, for tooltips, menus and the dialog. */
export function describeTarget(caps: SessionCapabilities, target: CommandTarget): string {
  if (target === 'partner') return caps.panesOnDifferentMachines ? 'the partner shell (this PC)' : 'the partner shell'
  if (caps.mainPaneIsShell) return caps.mainRunsOn === 'remote' ? `this shell on ${caps.remoteHost ?? 'the host'}` : 'this shell'
  return caps.mainRunsOn === 'remote' ? `${caps.agentName} on ${caps.remoteHost ?? 'the host'}` : `the ${caps.agentName} terminal`
}
