import * as path from 'path'
import * as fs from 'fs'
import { pathToFileURL } from 'url'
import { readConfig, saveConfig } from './config-manager'
import { logInfo } from './debug-logger'

const DEV_SERVER_PATTERNS = [
  /Local:\s+(https?:\/\/(?:localhost|127\.0\.0\.1):(\d+))/,
  /ready.*(https?:\/\/(?:localhost|127\.0\.0\.1):(\d+))/i,
  /listening.*(?:on|at)\s+(?:port\s+)?(\d+)/i,
  /Server running.*(https?:\/\/(?:localhost|127\.0\.0\.1):(\d+))/,
]

const PREVIEWABLE_EXTENSIONS = new Set([
  '.html', '.htm', '.pdf',
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp',
  '.md',
])

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.htm': 'text/html',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.md': 'text/markdown',
}

const suppressedProjects = new Set<string>()

function loadSuppressedProjects(): void {
  const data = readConfig<string[]>('previewSuppressed')
  if (Array.isArray(data)) {
    for (const p of data) suppressedProjects.add(p)
    logInfo(`[preview-manager] Loaded ${suppressedProjects.size} suppressed projects`)
  }
}

function saveSuppressedProjects(): void {
  saveConfig('previewSuppressed', Array.from(suppressedProjects))
}

function stripAnsi(str: string): string {
  return str
    .replace(/\x1b\[[\x20-\x3f]*[0-9;]*[\x20-\x7e]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b[()][A-Z0-9]/g, '')
    .replace(/\x1b[>=]/g, '')
}

export function detectDevServerUrl(data: string): string | null {
  const clean = stripAnsi(data)

  for (const pattern of DEV_SERVER_PATTERNS) {
    const match = clean.match(pattern)
    if (!match) continue

    // Pattern 3 (listening on port N) only captures a port number
    if (!match[1]?.startsWith('http')) {
      const port = match[1]
      if (port && /^\d+$/.test(port)) {
        return `http://localhost:${port}`
      }
      continue
    }

    return match[1]
  }

  return null
}

export function isPreviewableFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase()
  return PREVIEWABLE_EXTENSIONS.has(ext)
}

export function getFileContentType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase()
  return MIME_TYPES[ext] || 'application/octet-stream'
}

export async function resolveFileForPreview(
  filePath: string
): Promise<{ url: string; contentType: string } | null> {
  const absolute = path.resolve(filePath)
  try {
    await fs.promises.access(absolute, fs.constants.R_OK)
  } catch {
    return null
  }
  const contentType = getFileContentType(absolute)
  return { url: pathToFileURL(absolute).href, contentType }
}

export function addSuppressedProject(projectPath: string): void {
  suppressedProjects.add(projectPath)
  saveSuppressedProjects()
  logInfo(`[preview-manager] Suppressed dev server prompts for: ${projectPath}`)
}

export function isProjectSuppressed(projectPath: string): boolean {
  return suppressedProjects.has(projectPath)
}

// Track already-detected servers per session to avoid duplicate notifications
const detectedServers = new Map<string, Set<string>>()

export function checkForDevServer(sessionId: string, data: string, cwd: string): string | null {
  const url = detectDevServerUrl(data)
  if (!url) return null
  if (isProjectSuppressed(cwd)) return null

  const sessionUrls = detectedServers.get(sessionId) || new Set()
  if (sessionUrls.has(url)) return null

  sessionUrls.add(url)
  detectedServers.set(sessionId, sessionUrls)
  logInfo(`[preview-manager] Dev server detected for ${sessionId}: ${url}`)
  return url
}

export function clearDetectedServers(sessionId: string): void {
  detectedServers.delete(sessionId)
}

export function initPreviewManager(): void {
  loadSuppressedProjects()
}
