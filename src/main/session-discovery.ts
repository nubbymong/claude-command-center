import { readFileSync, readdirSync, existsSync, statSync } from 'fs'
import { join, basename } from 'path'
import { homedir } from 'os'

export interface DiscoveredProject {
  path: string
  name: string
  sessionCount: number
  lastActive: number
}

export interface DiscoveredSession {
  id: string
  filePath: string
  firstMessage: string
  timestamp: number
  lastActive: number
  messageCount: number
  model?: string
}

function getClaudeProjectsDir(): string {
  return join(homedir(), '.claude', 'projects')
}

function sanitizeProjectPath(encoded: string): string {
  // Claude encodes paths like C--Users-foo-project
  return encoded.replace(/-/g, '/').replace(/^([A-Z])\/\//, '$1:/')
}

export function discoverProjects(): DiscoveredProject[] {
  const projectsDir = getClaudeProjectsDir()
  if (!existsSync(projectsDir)) return []

  const projects: DiscoveredProject[] = []

  try {
    const dirs = readdirSync(projectsDir)
    for (const dir of dirs) {
      const fullPath = join(projectsDir, dir)
      try {
        const stat = statSync(fullPath)
        if (!stat.isDirectory()) continue

        const jsonlFiles = readdirSync(fullPath).filter(f => f.endsWith('.jsonl'))
        if (jsonlFiles.length === 0) continue

        let lastActive = 0
        for (const f of jsonlFiles) {
          const fstat = statSync(join(fullPath, f))
          if (fstat.mtimeMs > lastActive) lastActive = fstat.mtimeMs
        }

        projects.push({
          path: sanitizeProjectPath(dir),
          name: basename(sanitizeProjectPath(dir)),
          sessionCount: jsonlFiles.length,
          lastActive
        })
      } catch { /* skip */ }
    }
  } catch { /* skip */ }

  return projects.sort((a, b) => b.lastActive - a.lastActive)
}

export function discoverSessions(projectPath: string): DiscoveredSession[] {
  const projectsDir = getClaudeProjectsDir()
  if (!existsSync(projectsDir)) return []

  // Find matching project directory
  const dirs = readdirSync(projectsDir)
  const sessions: DiscoveredSession[] = []

  for (const dir of dirs) {
    const decoded = sanitizeProjectPath(dir)
    if (decoded !== projectPath && !decoded.includes(projectPath)) continue

    const fullDir = join(projectsDir, dir)
    try {
      const files = readdirSync(fullDir).filter(f => f.endsWith('.jsonl'))
      for (const file of files) {
        const filePath = join(fullDir, file)
        const session = parseSessionFile(filePath)
        if (session) sessions.push(session)
      }
    } catch { /* skip */ }
  }

  return sessions.sort((a, b) => b.lastActive - a.lastActive)
}

function parseSessionFile(filePath: string): DiscoveredSession | null {
  try {
    const content = readFileSync(filePath, 'utf-8')
    const lines = content.split('\n').filter(l => l.trim())
    if (lines.length === 0) return null

    let firstMessage = ''
    let model: string | undefined
    let timestamp = 0
    let lastActive = 0
    let messageCount = 0
    let sessionId = basename(filePath, '.jsonl')

    for (const line of lines) {
      try {
        const obj = JSON.parse(line)
        messageCount++

        if (!timestamp && obj.timestamp) {
          timestamp = new Date(obj.timestamp).getTime()
        }
        if (obj.timestamp) {
          const t = new Date(obj.timestamp).getTime()
          if (t > lastActive) lastActive = t
        }

        if (!firstMessage && obj.type === 'human' && obj.message?.content) {
          const content = obj.message.content
          firstMessage = typeof content === 'string'
            ? content.slice(0, 120)
            : Array.isArray(content)
              ? content.find((c: any) => c.type === 'text')?.text?.slice(0, 120) || ''
              : ''
        }

        if (!model && obj.model) {
          model = obj.model
        }

        if (obj.sessionId || obj.session_id) {
          sessionId = obj.sessionId || obj.session_id
        }
      } catch { /* skip invalid line */ }
    }

    if (!lastActive) {
      lastActive = statSync(filePath).mtimeMs
    }

    return {
      id: sessionId,
      filePath,
      firstMessage: firstMessage || '(empty session)',
      timestamp: timestamp || lastActive,
      lastActive,
      messageCount,
      model
    }
  } catch {
    return null
  }
}
