import { execFile } from 'child_process'
import { logInfo, logError } from './debug-logger'
import type { DiffFile, DiffHunk, DiffLine } from '../shared/types'

/**
 * Parse a unified diff string (output of `git diff`) into structured DiffFile objects.
 */
export function parseUnifiedDiff(diffOutput: string): DiffFile[] {
  if (!diffOutput.trim()) return []

  const files: DiffFile[] = []
  const rawLines = diffOutput.split('\n')
  // Remove the trailing empty string produced by splitting a newline-terminated string
  const lines = rawLines[rawLines.length - 1] === '' ? rawLines.slice(0, -1) : rawLines
  let i = 0

  while (i < lines.length) {
    // Look for diff --git header
    if (!lines[i].startsWith('diff --git ')) {
      i++
      continue
    }

    // Parse the diff header to extract file paths
    const diffHeader = lines[i]
    const pathMatch = diffHeader.match(/^diff --git a\/(.+) b\/(.+)$/)
    if (!pathMatch) { i++; continue }

    const pathA = pathMatch[1]
    const pathB = pathMatch[2]
    i++

    // Parse metadata lines (index, mode, rename, etc.)
    let status: DiffFile['status'] = 'modified'
    let oldPath: string | undefined
    let isBinary = false

    while (i < lines.length && !lines[i].startsWith('diff --git ') && !lines[i].startsWith('@@') && !lines[i].startsWith('--- ') && !lines[i].startsWith('Binary ')) {
      const line = lines[i]
      if (line.startsWith('new file')) status = 'added'
      else if (line.startsWith('deleted file')) status = 'deleted'
      else if (line.startsWith('rename from ')) {
        status = 'renamed'
        oldPath = line.slice('rename from '.length)
      }
      i++
    }

    // Check for binary file
    if (i < lines.length && lines[i].startsWith('Binary files')) {
      isBinary = true
      i++
      files.push({
        path: pathB,
        status,
        oldPath,
        linesAdded: 0,
        linesRemoved: 0,
        isBinary: true,
        hunks: [],
      })
      continue
    }

    // Skip --- and +++ lines
    if (i < lines.length && lines[i].startsWith('--- ')) i++
    if (i < lines.length && lines[i].startsWith('+++ ')) i++

    // Parse hunks
    const hunks: DiffHunk[] = []
    let totalAdded = 0
    let totalRemoved = 0

    while (i < lines.length && !lines[i].startsWith('diff --git ')) {
      if (lines[i].startsWith('@@')) {
        const hunkHeader = lines[i]
        const hunkMatch = hunkHeader.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
        let oldLine = hunkMatch ? parseInt(hunkMatch[1]) : 1
        let newLine = hunkMatch ? parseInt(hunkMatch[2]) : 1
        i++

        const hunkLines: DiffLine[] = []

        while (i < lines.length && !lines[i].startsWith('@@') && !lines[i].startsWith('diff --git ')) {
          const rawLine = lines[i]
          if (rawLine.startsWith('+')) {
            hunkLines.push({
              type: 'addition',
              content: rawLine.slice(1),
              newLineNumber: newLine,
            })
            newLine++
            totalAdded++
          } else if (rawLine.startsWith('-')) {
            hunkLines.push({
              type: 'removal',
              content: rawLine.slice(1),
              oldLineNumber: oldLine,
            })
            oldLine++
            totalRemoved++
          } else if (rawLine.startsWith(' ') || rawLine === '') {
            // Context line (leading space) or empty line
            hunkLines.push({
              type: 'context',
              content: rawLine.startsWith(' ') ? rawLine.slice(1) : '',
              oldLineNumber: oldLine,
              newLineNumber: newLine,
            })
            oldLine++
            newLine++
          } else {
            // Unknown line type (e.g., "\ No newline at end of file")
            i++
            continue
          }
          i++
        }

        hunks.push({ header: hunkHeader, lines: hunkLines })
      } else {
        i++
      }
    }

    files.push({
      path: pathB,
      status,
      oldPath,
      linesAdded: totalAdded,
      linesRemoved: totalRemoved,
      isBinary,
      hunks,
    })
  }

  return files
}

/**
 * Run `git diff` in a directory and return structured diff data.
 */
export function getGitDiff(cwd: string): Promise<DiffFile[]> {
  return new Promise((resolve) => {
    // Get both staged and unstaged diffs
    execFile('git', ['diff', 'HEAD'], { cwd, maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
      if (err) {
        logError(`[diff-generator] git diff failed in ${cwd}: ${err.message}`)
        resolve([])
        return
      }
      try {
        resolve(parseUnifiedDiff(stdout))
      } catch (parseErr) {
        logError(`[diff-generator] Failed to parse diff: ${parseErr}`)
        resolve([])
      }
    })
  })
}

/**
 * Check if a directory is a git repository.
 */
export function isGitRepo(cwd: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('git', ['rev-parse', '--is-inside-work-tree'], { cwd }, (err) => {
      resolve(!err)
    })
  })
}

/**
 * Get diff stats (total lines added/removed) without full diff content.
 */
export function getGitDiffStats(cwd: string): Promise<{ added: number; removed: number }> {
  return new Promise((resolve) => {
    execFile('git', ['diff', 'HEAD', '--stat'], { cwd }, (err, stdout) => {
      if (err) {
        resolve({ added: 0, removed: 0 })
        return
      }
      // Parse last line: " 3 files changed, 12 insertions(+), 5 deletions(-)"
      const lastLine = stdout.trim().split('\n').pop() || ''
      const addMatch = lastLine.match(/(\d+) insertion/)
      const delMatch = lastLine.match(/(\d+) deletion/)
      resolve({
        added: addMatch ? parseInt(addMatch[1]) : 0,
        removed: delMatch ? parseInt(delMatch[1]) : 0,
      })
    })
  })
}
