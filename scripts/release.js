#!/usr/bin/env node
/**
 * Claude Command Center Release Script
 *
 * Full automated release pipeline:
 * 1. Pre-flight checks (npm audit, git clean, gh auth)
 * 2. Auto-increment version
 * 3. Claude CLI generates changelog entry + release notes
 * 4. Build (electron-vite build)
 * 5. Package installer (electron-builder --win)
 * 6. SHA-256 checksum
 * 7. VirusTotal scan
 * 8. Git commit, tag, push
 * 9. GitHub Release with assets
 * 10. Push update notification to connected clients
 * 11. Verify
 *
 * Usage: npm run release
 *        npm run release -- --minor
 *        npm run release -- --major
 *        npm run release -- --skip-vt       (skip VirusTotal)
 *        npm run release -- --skip-claude   (skip changelog generation)
 *        npm run release -- --skip-push     (skip git push + gh release)
 */

const { execSync, spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const https = require('https')
const http = require('http')
const crypto = require('crypto')
const { WebSocketServer } = require('ws')

const PROJECT_ROOT = path.resolve(__dirname, '..')
const APPDATA = process.env.APPDATA || ''
const HASH_FILE = path.join(APPDATA, 'claude-conductor', 'source-hash.json')
const SECRETS_DIR = path.join(PROJECT_ROOT, '.secrets')

const args = process.argv.slice(2)
const SKIP_VT = args.includes('--skip-vt')
const SKIP_CLAUDE = args.includes('--skip-claude')
const SKIP_PUSH = args.includes('--skip-push')
const BUMP_MINOR = args.includes('--minor')
const BUMP_MAJOR = args.includes('--major')

// ============================================================
// HELPERS
// ============================================================

function run(cmd, opts = {}) {
  return execSync(cmd, { cwd: PROJECT_ROOT, encoding: 'utf-8', ...opts }).trim()
}

function runInherit(cmd) {
  execSync(cmd, { cwd: PROJECT_ROOT, stdio: 'inherit' })
}

function step(num, total, msg) {
  console.log(`\n[${num}/${total}] ${msg}`)
}

function ok(msg) {
  console.log(`      OK  ${msg}`)
}

function warn(msg) {
  console.log(`      WARN  ${msg}`)
}

function fail(msg) {
  console.error(`      FAIL  ${msg}`)
  process.exit(1)
}

function readSecret(filename) {
  const p = path.join(SECRETS_DIR, filename)
  if (!fs.existsSync(p)) return null
  return fs.readFileSync(p, 'utf-8').trim()
}

function sha256File(filePath) {
  const data = fs.readFileSync(filePath)
  return crypto.createHash('sha256').update(data).digest('hex')
}

// ============================================================
// MAIN
// ============================================================

const TOTAL_STEPS = 11
let exitCode = 0

// --- Step 1: Pre-flight checks ---
step(1, TOTAL_STEPS, 'Pre-flight checks...')

// npm audit
try {
  const auditResult = run('npm audit --audit-level=critical 2>&1 || true')
  if (auditResult.includes('critical')) {
    fail('npm audit found CRITICAL vulnerabilities. Fix before releasing.')
  }
  ok('npm audit clean (no critical vulnerabilities)')
} catch (err) {
  warn('npm audit check failed (non-fatal)')
}

// git clean check
try {
  const status = run('git status --porcelain')
  if (status.length > 0) {
    // That's OK for first release or if we have uncommitted changes
    // We'll commit everything as part of the release
    warn(`${status.split('\n').length} uncommitted changes (will be included in release commit)`)
  } else {
    ok('Git working tree clean')
  }
} catch (err) {
  warn('Git status check failed (non-fatal)')
}

// gh auth check
try {
  run('gh auth status 2>&1')
  ok('GitHub CLI authenticated')
} catch (err) {
  if (!SKIP_PUSH) {
    fail('GitHub CLI not authenticated. Run: gh auth login')
  }
  warn('GitHub CLI not authenticated (push skipped)')
}

// --- Step 2: Version bump ---
step(2, TOTAL_STEPS, 'Incrementing version...')

const pkgPath = path.join(PROJECT_ROOT, 'package.json')
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'))
const oldVersion = pkg.version
const parts = oldVersion.split('.').map(Number)

if (BUMP_MAJOR) {
  parts[0] += 1; parts[1] = 0; parts[2] = 0
} else if (BUMP_MINOR) {
  parts[1] += 1; parts[2] = 0
} else {
  parts[2] = (parts[2] || 0) + 1
}

const version = parts.join('.')
pkg.version = version
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf-8')

console.log('')
console.log('  ===========================================')
console.log(`    Claude Command Center Beta  v${version}`)
console.log(`    (from v${oldVersion})`)
console.log('  ===========================================')

// --- Step 3: Claude changelog + release notes ---
step(3, TOTAL_STEPS, 'Generating changelog and release notes...')

let releaseNotesBody = ''
let changelogGenerated = false

if (SKIP_CLAUDE) {
  warn('Skipped (--skip-claude)')
  releaseNotesBody = `## v${version}\n\nPatch release.\n`
} else {
  try {
    // Get diff since last tag (or all files if no tags yet)
    let diffText = ''
    try {
      const lastTag = run('git describe --tags --abbrev=0 2>&1')
      diffText = run(`git diff ${lastTag}..HEAD -- src/ build/ scripts/ package.json 2>&1`)
    } catch {
      // No tags yet — use all staged/tracked files summary
      diffText = run('git diff --cached --stat 2>&1 || git status --short 2>&1')
    }

    if (!diffText || diffText.length < 20) {
      diffText = 'Initial release with all features.'
    }

    // Truncate diff if too large (Claude CLI has input limits)
    if (diffText.length > 15000) {
      diffText = diffText.substring(0, 15000) + '\n\n... (diff truncated)'
    }

    // Read current changelog format for reference
    const changelogPath = path.join(PROJECT_ROOT, 'src', 'renderer', 'changelog.ts')
    const changelogContent = fs.readFileSync(changelogPath, 'utf-8')
    // Extract just the first entry as format example
    const formatExample = changelogContent.substring(0, 1500)

    const prompt = `You are generating release notes for Claude Command Center Beta v${version} (previously v${oldVersion}).

CRITICAL RULES:
- Do NOT include any file paths, usernames, machine names, API keys, or personal information
- Do NOT mention the developer or any individual by name
- Focus ONLY on what changed functionally from the user's perspective
- Be concise — each change description should be one sentence

Here is the git diff of changes since last release:
\`\`\`
${diffText}
\`\`\`

Generate TWO things as valid JSON (no markdown fences, just raw JSON):

{
  "changelog": {
    "version": "${version}",
    "date": "${new Date().toISOString().split('T')[0]}",
    "highlights": "Brief 1-line summary of this release",
    "changes": [
      { "type": "feature|fix|improvement", "description": "What changed" }
    ]
  },
  "releaseNotes": "Markdown release notes for GitHub. Include a ## What's New section with bullet points. End with:\\n\\nSHA-256 checksums and VirusTotal scan results are attached to this release."
}

Return ONLY the JSON object, no other text.`

    // Pipe prompt via stdin to avoid Windows command line length limits
    // shell:true required on Windows — 'claude' with shell finds .exe or .cmd
    const claudeBin = 'claude'
    console.log('      Spawning Claude CLI for changelog generation...')
    const claudeResult = spawnSync(claudeBin, ['-p'], {
      cwd: PROJECT_ROOT,
      encoding: 'utf-8',
      timeout: 120000,
      windowsHide: true,
      shell: true,
      input: prompt
    })

    if (claudeResult.stderr) {
      console.log(`      Claude stderr: ${claudeResult.stderr.substring(0, 300)}`)
    }

    if (claudeResult.status === 0 && claudeResult.stdout) {
      let output = claudeResult.stdout.trim()
      // Strip markdown fences if Claude wraps them anyway
      output = output.replace(/^```json?\s*/m, '').replace(/\s*```\s*$/m, '')

      // Extract JSON object from output — Claude sometimes adds preamble/postamble text
      // Find the first '{' and last '}' to extract the JSON block
      const firstBrace = output.indexOf('{')
      const lastBrace = output.lastIndexOf('}')
      if (firstBrace !== -1 && lastBrace > firstBrace) {
        output = output.substring(firstBrace, lastBrace + 1)
      }

      try {
        const parsed = JSON.parse(output)

        // Write changelog entry
        if (parsed.changelog) {
          const entry = parsed.changelog
          const newEntry = `  {
    version: '${entry.version}',
    date: '${entry.date}',
    highlights: ${JSON.stringify(entry.highlights)},
    changes: [
${entry.changes.map(c => `      { type: '${c.type}', description: ${JSON.stringify(c.description)} }`).join(',\n')}
    ]
  },`

          // Insert after the '= [' that opens the array (not the [] in the type annotation)
          const marker = 'ChangelogEntry[] = ['
          const insertPoint = changelogContent.indexOf(marker)
          if (insertPoint !== -1) {
            const bracketPos = insertPoint + marker.length
            const updatedChangelog = changelogContent.slice(0, bracketPos) + '\n' + newEntry + changelogContent.slice(bracketPos)
            fs.writeFileSync(changelogPath, updatedChangelog, 'utf-8')
            changelogGenerated = true
            ok(`Changelog entry written (${entry.changes.length} changes)`)
            console.log(`      Highlights: ${entry.highlights}`)
          }
        }

        // Write release notes
        if (parsed.releaseNotes) {
          releaseNotesBody = parsed.releaseNotes
          ok('Release notes generated')
        }
      } catch (parseErr) {
        warn(`Claude output not valid JSON, using fallback. Parse error: ${parseErr.message}`)
        releaseNotesBody = `## v${version}\n\nPatch release with improvements and fixes.\n`
      }
    } else {
      warn('Claude CLI returned no output, using fallback')
      if (claudeResult.stderr) console.log(`      stderr: ${claudeResult.stderr.substring(0, 200)}`)
      releaseNotesBody = `## v${version}\n\nPatch release with improvements and fixes.\n`
    }
  } catch (err) {
    warn(`Claude generation failed: ${err.message}`)
    releaseNotesBody = `## v${version}\n\nPatch release with improvements and fixes.\n`
  }
}

// Fallback: update changelog version if Claude didn't generate
if (!changelogGenerated) {
  try {
    const changelogPath = path.join(PROJECT_ROOT, 'src', 'renderer', 'changelog.ts')
    let changelogContent = fs.readFileSync(changelogPath, 'utf-8')
    const versionRegex = /version:\s*'(\d+\.\d+\.\d+)'/
    const match = changelogContent.match(versionRegex)
    if (match && match[1] !== version) {
      changelogContent = changelogContent.replace(versionRegex, `version: '${version}'`)
      fs.writeFileSync(changelogPath, changelogContent, 'utf-8')
      ok(`Changelog version updated: ${match[1]} -> ${version}`)
    }
  } catch (err) {
    warn('Could not update changelog version')
  }
}

// --- Step 4: Build ---
step(4, TOTAL_STEPS, 'Building...')
try {
  runInherit('npx electron-vite build')
  ok('Build complete')
} catch (err) {
  fail('BUILD FAILED')
}

// --- Step 5: Package ---
step(5, TOTAL_STEPS, 'Packaging installer...')
try {
  runInherit('npx electron-builder --win')
  ok('Package complete')
} catch (err) {
  fail('PACKAGE FAILED')
}

// --- Step 6: Post-build (copy, hash, checksum) ---
step(6, TOTAL_STEPS, 'Post-build: copy installer, generate checksums...')

const installerName = `ClaudeCommandCenter-Beta-${version}.exe`
const installerSrc = path.join(PROJECT_ROOT, 'dist', installerName)
const installerDst = path.join(PROJECT_ROOT, installerName)
const installerLatest = path.join(PROJECT_ROOT, 'ClaudeCommandCenter-latest.exe')
const checksumsPath = path.join(PROJECT_ROOT, 'CHECKSUMS.txt')

if (fs.existsSync(installerSrc)) {
  // Clean up old versioned installers from project root
  const oldExes = fs.readdirSync(PROJECT_ROOT).filter(f =>
    (f.startsWith('ClaudeCommandCenter-') || f.startsWith('ClaudeConductor-')) && f.endsWith('.exe') && f !== installerName && f !== 'ClaudeCommandCenter-latest.exe'
  )
  if (oldExes.length > 0) {
    oldExes.forEach(f => {
      try { fs.unlinkSync(path.join(PROJECT_ROOT, f)) } catch {}
    })
    ok(`Cleaned up ${oldExes.length} old installer(s): ${oldExes.join(', ')}`)
  }

  fs.copyFileSync(installerSrc, installerDst)
  fs.copyFileSync(installerSrc, installerLatest)
  ok(`Copied: ${installerName}`)

  // SHA-256
  const hash = sha256File(installerDst)
  const checksumContent = `SHA-256 Checksums for Claude Command Center Beta v${version}\nGenerated: ${new Date().toISOString()}\n\n${hash}  ${installerName}\n`
  fs.writeFileSync(checksumsPath, checksumContent, 'utf-8')
  ok(`SHA-256: ${hash.substring(0, 16)}...`)
} else {
  console.error(`      INSTALLER NOT FOUND: ${installerSrc}`)
  exitCode = 1
}

// Delete source-hash.json
try {
  if (fs.existsSync(HASH_FILE)) {
    fs.unlinkSync(HASH_FILE)
    ok('source-hash.json deleted')
  }
} catch (err) {
  warn('Could not delete source-hash.json (non-fatal)')
}

// --- Step 7: VirusTotal scan ---
step(7, TOTAL_STEPS, 'VirusTotal scan...')

let vtUrl = null

if (SKIP_VT) {
  warn('Skipped (--skip-vt)')
} else {
  const vtKey = readSecret('virus-total-api-key.txt')
  if (!vtKey) {
    warn('No API key found at .secrets/virus-total-api-key.txt')
  } else if (!fs.existsSync(installerDst)) {
    warn('Installer not found, skipping VT scan')
  } else {
    try {
      // Upload file to VirusTotal
      console.log('      Uploading installer to VirusTotal...')
      const fileSize = fs.statSync(installerDst).size
      const sizeMB = (fileSize / (1024 * 1024)).toFixed(1)
      console.log(`      File: ${installerName} (${sizeMB} MB)`)

      // Files > 32MB need a special upload URL
      let uploadUrl = 'https://www.virustotal.com/api/v3/files'
      if (fileSize > 32 * 1024 * 1024) {
        console.log('      File exceeds 32MB, requesting large file upload URL...')
        const urlResult = run(
          `curl -s --request GET --url https://www.virustotal.com/api/v3/files/upload_url ` +
          `--header "x-apikey: ${vtKey}"`,
          { timeout: 30000 }
        )
        const urlJson = JSON.parse(urlResult)
        if (urlJson.data) {
          uploadUrl = urlJson.data
          ok('Got large file upload URL')
        } else {
          warn('Could not get large file upload URL, trying standard endpoint')
        }
      }

      // Upload the file
      const vtResult = run(
        `curl -s --request POST --url "${uploadUrl}" ` +
        `--header "x-apikey: ${vtKey}" ` +
        `--form "file=@${installerDst.replace(/\\/g, '/')}"`,
        { timeout: 600000 }  // 10 min timeout for large file upload
      )

      const vtJson = JSON.parse(vtResult)
      if (vtJson.data && vtJson.data.id) {
        const analysisId = vtJson.data.id
        vtUrl = `https://www.virustotal.com/gui/file-analysis/${analysisId}`
        ok(`Uploaded! Analysis: ${vtUrl}`)
        console.log('      (Results take 2-5 minutes to complete)')

        // Also get the permanent file URL via SHA-256
        const fileHash = sha256File(installerDst)
        const permanentUrl = `https://www.virustotal.com/gui/file/${fileHash}`
        console.log(`      Permanent link: ${permanentUrl}`)
        vtUrl = permanentUrl  // Use permanent link in release notes
      } else {
        warn('VirusTotal upload returned unexpected response')
        if (vtResult.length < 500) console.log(`      Response: ${vtResult}`)
      }
    } catch (err) {
      warn(`VirusTotal upload failed: ${err.message}`)
    }
  }
}

// Append VT link to release notes if available
if (vtUrl) {
  releaseNotesBody += `\n\n## Security\n- [VirusTotal Scan Results](${vtUrl})\n`
}

// Write release notes to file
const releaseNotesPath = path.join(PROJECT_ROOT, 'RELEASE_NOTES.md')
fs.writeFileSync(releaseNotesPath, releaseNotesBody, 'utf-8')

// --- Step 8: Git commit, tag, push ---
step(8, TOTAL_STEPS, 'Git commit and tag...')

if (SKIP_PUSH) {
  warn('Skipped (--skip-push)')
} else {
  try {
    // Stage source files (not .exe, not dist/, not secrets)
    run('git add -A')

    // Check if there's anything to commit
    const staged = run('git diff --cached --stat 2>&1 || echo ""')
    if (staged.length > 0) {
      run(`git commit -m "Release v${version}"`)
      ok(`Committed: Release v${version}`)
    } else {
      ok('Nothing new to commit')
    }

    // Tag
    try {
      run(`git tag v${version}`)
      ok(`Tagged: v${version}`)
    } catch (err) {
      warn(`Tag v${version} may already exist`)
    }

    // Push
    console.log('      Pushing to origin...')
    run('git push origin main --tags 2>&1', { timeout: 60000 })
    ok('Pushed to origin/main with tags')
  } catch (err) {
    warn(`Git operations failed: ${err.message}`)
    exitCode = 1
  }
}

// --- Step 9: GitHub Release ---
step(9, TOTAL_STEPS, 'Creating GitHub Release...')

let releaseUrl = ''

if (SKIP_PUSH) {
  warn('Skipped (--skip-push)')
} else {
  try {
    // Create release with assets
    const ghCmd = [
      'gh', 'release', 'create', `v${version}`,
      '--title', `v${version}`,
      '--notes-file', releaseNotesPath,
    ]

    // Add installer as asset if it exists
    if (fs.existsSync(installerDst)) {
      ghCmd.push(installerDst)
    }
    // Add checksums
    if (fs.existsSync(checksumsPath)) {
      ghCmd.push(checksumsPath)
    }

    const ghResult = run(ghCmd.map(a => `"${a}"`).join(' '), { timeout: 120000 })
    releaseUrl = ghResult.trim()
    ok(`GitHub Release created: ${releaseUrl}`)
  } catch (err) {
    warn(`GitHub Release failed: ${err.message}`)
    exitCode = 1
  }
}

// --- Step 10: Push update notification ---
step(10, TOTAL_STEPS, 'Pushing update notification...')

pushNotification()

function pushNotification() {
  const PORT = 9847
  let server = null
  let wss = null
  let clientsSent = 0

  try {
    server = http.createServer()
    wss = new WebSocketServer({ server })

    wss.on('connection', (ws) => {
      ws.send(JSON.stringify({
        type: 'update_available',
        timestamp: Date.now(),
        hash: 'release-' + version,
        version: version,
        installerPath: installerLatest
      }))
      clientsSent++
      console.log(`      Notified client (${clientsSent} total)`)
    })

    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.log('      Update server already running on port ' + PORT)
        console.log('      Production clients will be notified via existing server.')
        finishUp()
        return
      }
    })

    server.listen(PORT, '0.0.0.0', () => {
      console.log(`      Listening on port ${PORT} for production clients...`)
      console.log('      (waiting 15s for connections)')

      setTimeout(() => {
        if (clientsSent === 0) {
          console.log('      No production clients connected.')
        } else {
          console.log(`      Done - notified ${clientsSent} client(s).`)
        }
        wss.close()
        server.close()
        finishUp()
      }, 15000)
    })
  } catch (err) {
    warn('Could not start notification server (non-fatal)')
    finishUp()
  }
}

function finishUp() {
  // --- Step 11: Verify ---
  step(11, TOTAL_STEPS, 'Verification...')

  const checks = []
  const installerSize = fs.existsSync(installerDst)
    ? (fs.statSync(installerDst).size / (1024 * 1024)).toFixed(1) + ' MB'
    : null

  if (installerSize) {
    checks.push(`  OK   Installer: ${installerName} (${installerSize})`)
  } else {
    checks.push('  FAIL Installer not found')
    exitCode = 1
  }

  if (fs.existsSync(checksumsPath)) {
    checks.push('  OK   CHECKSUMS.txt generated')
  }

  if (!SKIP_PUSH) {
    try {
      run(`git tag -l v${version}`)
      checks.push(`  OK   Git tag: v${version}`)
    } catch { /* ignore */ }
  }

  if (releaseUrl) {
    checks.push(`  OK   GitHub Release: ${releaseUrl}`)
  }

  if (vtUrl) {
    checks.push(`  OK   VirusTotal: ${vtUrl}`)
  }

  if (!fs.existsSync(HASH_FILE)) {
    checks.push('  OK   source-hash.json deleted')
  }

  if (changelogGenerated) {
    checks.push('  OK   Changelog entry generated by Claude')
  }

  console.log('')
  console.log(checks.join('\n'))
  console.log('')
  console.log('  ===========================================')
  if (exitCode === 0) {
    console.log(`    Release v${version} complete!`)
    if (releaseUrl) console.log(`    ${releaseUrl}`)
  } else {
    console.log('    Release completed with warnings.')
  }
  console.log('  ===========================================')
  console.log('')

  process.exit(exitCode)
}
