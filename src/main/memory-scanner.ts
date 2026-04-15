// memory-scanner.ts
// Scans Claude Code memory directories and returns structured data.

import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import * as crypto from 'crypto'
import { logInfo, logError } from './debug-logger'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MemoryFile {
  id: string // project + filename hash
  name: string // from frontmatter `name:` or filename without .md
  filename: string // e.g. "feedback_logging.md"
  project: string // e.g. "claude-multi-app" (cleaned from dir name)
  projectDir: string // raw directory name e.g. "F--CLAUDE-MULTI-APP"
  type: 'user' | 'feedback' | 'project' | 'reference' | 'snapshot' | 'uncategorized'
  description: string // from frontmatter or first content line
  size: number // bytes
  modified: number // epoch ms
  hasFrontmatter: boolean
  path: string // full file path
}

export interface MemoryProject {
  name: string // cleaned project name
  projectDir: string // raw dir name
  fileCount: number
  totalSize: number
  lastModified: number
  types: Record<string, number>
  memoryMdLines?: number // line count of MEMORY.md if it exists
}

export interface SchemaWarning {
  level: 'info' | 'warn' | 'error'
  message: string
  project?: string
  file?: string
}

export interface MemoryScanResult {
  projects: MemoryProject[]
  memories: MemoryFile[]
  warnings: SchemaWarning[]
  totalSize: number
  scannedAt: number
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_TYPES = new Set(['user', 'feedback', 'project', 'reference', 'snapshot'])
const KNOWN_FRONTMATTER_FIELDS = new Set(['name', 'description', 'type', 'originSessionId'])

/**
 * Clean a raw project directory name into a human-friendly project name.
 *
 * Examples:
 *   "F--CLAUDE-MULTI-APP" → "claude-multi-app"
 *   "C--Users-jane"       → "home"
 */
function cleanProjectName(dirName: string): string {
  // Replace -- with / to reconstruct path-like structure
  let cleaned = dirName.replace(/--/g, '/')

  // Remove leading drive letter prefix (e.g. "F/")
  cleaned = cleaned.replace(/^[A-Z]\//, '')

  // Take the last path segment
  const segments = cleaned.split('/').filter(Boolean)
  const last = segments[segments.length - 1] || dirName

  // If we end up with something very short or generic after stripping, use "home"
  if (!last || last.toLowerCase() === 'users' || last.length <= 2) {
    return 'home'
  }

  // Lowercase with hyphens (already hyphenated from dir name convention)
  return last.toLowerCase().replace(/[_\s]+/g, '-')
}

/**
 * Infer memory type from filename when no frontmatter type is present.
 */
function inferTypeFromFilename(
  filename: string
): 'feedback' | 'project' | 'snapshot' | 'reference' | 'uncategorized' {
  const lower = filename.toLowerCase()

  if (lower.startsWith('feedback_') || lower.startsWith('feedback-')) {
    return 'feedback'
  }
  if (lower.startsWith('project_') || lower.startsWith('project-')) {
    return 'project'
  }
  if (lower.startsWith('session-state-') || lower.startsWith('session_state_')) {
    return 'snapshot'
  }
  if (lower === 'memory.md') {
    return 'reference'
  }

  return 'uncategorized'
}

/**
 * Parse YAML frontmatter from file content.
 * Returns the parsed fields and the remaining content after frontmatter.
 */
function parseFrontmatter(content: string): {
  fields: Record<string, string>
  body: string
  hasFrontmatter: boolean
} {
  // Frontmatter must start at the very beginning of the file
  if (!content.startsWith('---')) {
    return { fields: {}, body: content, hasFrontmatter: false }
  }

  const endIndex = content.indexOf('\n---', 3)
  if (endIndex === -1) {
    return { fields: {}, body: content, hasFrontmatter: false }
  }

  const yamlBlock = content.substring(3, endIndex).trim()
  const body = content.substring(endIndex + 4).trim()

  const fields: Record<string, string> = {}
  for (const line of yamlBlock.split('\n')) {
    const colonIdx = line.indexOf(':')
    if (colonIdx === -1) continue
    const key = line.substring(0, colonIdx).trim()
    const value = line.substring(colonIdx + 1).trim()
    if (key) {
      // Strip surrounding quotes if present
      fields[key] = value.replace(/^["']|["']$/g, '')
    }
  }

  return { fields, body, hasFrontmatter: true }
}

/**
 * Extract description: first non-empty, non-header line of markdown content.
 */
function extractDescription(body: string): string {
  const lines = body.split('\n')
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    if (trimmed.startsWith('#')) continue
    // Return the first substantive line, truncated
    return trimmed.length > 200 ? trimmed.substring(0, 200) + '...' : trimmed
  }
  return ''
}

/**
 * Generate a stable ID from project dir + filename.
 */
function generateId(projectDir: string, filename: string): string {
  return crypto
    .createHash('sha256')
    .update(`${projectDir}/${filename}`)
    .digest('hex')
    .substring(0, 16)
}

// ---------------------------------------------------------------------------
// Core scan
// ---------------------------------------------------------------------------

// Scan all local Claude Code project memory directories.
export async function scanLocalMemory(): Promise<MemoryScanResult> {
  const projectsRoot = path.join(os.homedir(), '.claude', 'projects')
  const result: MemoryScanResult = {
    projects: [],
    memories: [],
    warnings: [],
    totalSize: 0,
    scannedAt: Date.now()
  }

  // Check if the projects root exists
  if (!fs.existsSync(projectsRoot)) {
    logInfo('[memory-scanner] No projects directory found at', projectsRoot)
    return result
  }

  let projectDirs: string[]
  try {
    projectDirs = fs
      .readdirSync(projectsRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
  } catch (err) {
    logError('[memory-scanner] Failed to read projects directory:', err)
    return result
  }

  for (const projectDir of projectDirs) {
    const memoryDir = path.join(projectsRoot, projectDir, 'memory')

    // Skip projects without a memory directory
    if (!fs.existsSync(memoryDir) || !fs.statSync(memoryDir).isDirectory()) {
      continue
    }

    let mdFiles: string[]
    try {
      mdFiles = fs.readdirSync(memoryDir).filter((f) => f.endsWith('.md'))
    } catch (err) {
      logError('[memory-scanner] Failed to read memory dir for', projectDir, err)
      result.warnings.push({
        level: 'error',
        message: `Failed to read memory directory: ${err}`,
        project: cleanProjectName(projectDir)
      })
      continue
    }

    if (mdFiles.length === 0) continue

    const projectName = cleanProjectName(projectDir)
    const projectData: MemoryProject = {
      name: projectName,
      projectDir,
      fileCount: 0,
      totalSize: 0,
      lastModified: 0,
      types: {}
    }

    let hasMemoryMd = false

    for (const filename of mdFiles) {
      const filePath = path.join(memoryDir, filename)

      let stat: fs.Stats
      try {
        stat = fs.statSync(filePath)
      } catch {
        continue
      }

      let content: string
      try {
        content = fs.readFileSync(filePath, 'utf-8')
      } catch (err) {
        logError('[memory-scanner] Failed to read file:', filePath, err)
        continue
      }

      const { fields, body, hasFrontmatter } = parseFrontmatter(content)

      // Determine type
      let memType: MemoryFile['type'] = 'uncategorized'
      if (hasFrontmatter && fields.type) {
        const fmType = fields.type.toLowerCase()
        if (VALID_TYPES.has(fmType)) {
          memType = fmType as MemoryFile['type']
        } else {
          result.warnings.push({
            level: 'warn',
            message: `Unknown frontmatter type: "${fields.type}"`,
            project: projectName,
            file: filename
          })
          memType = inferTypeFromFilename(filename)
        }
      } else {
        memType = inferTypeFromFilename(filename)
      }

      // Check for unknown frontmatter fields
      if (hasFrontmatter) {
        for (const key of Object.keys(fields)) {
          if (!KNOWN_FRONTMATTER_FIELDS.has(key)) {
            result.warnings.push({
              level: 'info',
              message: `Unknown frontmatter field: "${key}"`,
              project: projectName,
              file: filename
            })
          }
        }
      }

      // Name: from frontmatter or filename without .md
      const name = fields.name || filename.replace(/\.md$/, '')

      // Description: from frontmatter or first content line
      const description = fields.description || extractDescription(body)

      const memoryFile: MemoryFile = {
        id: generateId(projectDir, filename),
        name,
        filename,
        project: projectName,
        projectDir,
        type: memType,
        description,
        size: stat.size,
        modified: stat.mtimeMs,
        hasFrontmatter,
        path: filePath
      }

      result.memories.push(memoryFile)

      // Update project aggregates
      projectData.fileCount++
      projectData.totalSize += stat.size
      if (stat.mtimeMs > projectData.lastModified) {
        projectData.lastModified = stat.mtimeMs
      }
      projectData.types[memType] = (projectData.types[memType] || 0) + 1

      // Track MEMORY.md
      if (filename === 'MEMORY.md') {
        hasMemoryMd = true
        const lineCount = content.split('\n').length
        projectData.memoryMdLines = lineCount

        if (lineCount > 200) {
          result.warnings.push({
            level: 'warn',
            message: `MEMORY.md is ${lineCount} lines (Claude only loads first 200)`,
            project: projectName,
            file: 'MEMORY.md'
          })
        }
      }
    }

    // Warn if no MEMORY.md
    if (!hasMemoryMd && projectData.fileCount > 0) {
      result.warnings.push({
        level: 'info',
        message: 'No MEMORY.md found in project memory directory',
        project: projectName
      })
    }

    result.totalSize += projectData.totalSize
    result.projects.push(projectData)
  }

  logInfo(
    `[memory-scanner] Scanned ${result.projects.length} projects, ` +
      `${result.memories.length} files, ${result.warnings.length} warnings`
  )

  return result
}

// ---------------------------------------------------------------------------
// File operations
// ---------------------------------------------------------------------------

/**
 * Read the full content of a memory file.
 */
export async function readMemoryContent(filePath: string): Promise<string> {
  return fs.promises.readFile(filePath, 'utf-8')
}

/**
 * Delete a memory file.
 */
export async function deleteMemoryFile(filePath: string): Promise<void> {
  await fs.promises.unlink(filePath)
  logInfo('[memory-scanner] Deleted memory file:', filePath)
}

/**
 * Add or update YAML frontmatter on a memory file.
 * Merges provided fields with any existing frontmatter.
 */
export async function writeMemoryFrontmatter(
  filePath: string,
  frontmatter: { name?: string; description?: string; type?: string }
): Promise<void> {
  const content = await fs.promises.readFile(filePath, 'utf-8')
  const { fields: existing, body } = parseFrontmatter(content)

  // Merge: new values override existing
  const merged: Record<string, string> = { ...existing }
  if (frontmatter.name !== undefined) merged.name = frontmatter.name
  if (frontmatter.description !== undefined) merged.description = frontmatter.description
  if (frontmatter.type !== undefined) merged.type = frontmatter.type

  // Build YAML block
  const yamlLines: string[] = []
  for (const [key, value] of Object.entries(merged)) {
    if (value) {
      // Quote values that contain colons or special YAML characters
      const needsQuotes = /[:#\[\]{}&*!|>'"%@`]/.test(value) || value.includes('\n')
      yamlLines.push(needsQuotes ? `${key}: "${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : `${key}: ${value}`)
    }
  }

  const newContent =
    yamlLines.length > 0 ? `---\n${yamlLines.join('\n')}\n---\n\n${body}` : body

  await fs.promises.writeFile(filePath, newContent, 'utf-8')
  logInfo('[memory-scanner] Updated frontmatter for:', filePath)
}
