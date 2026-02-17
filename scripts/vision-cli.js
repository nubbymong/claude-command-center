#!/usr/bin/env node
// Claude Conductor — Vision CLI
// Standalone script (Node built-in http only) that proxies commands to VisionManager's HTTP server.
// Usage: node vision-cli.js <command> [args...]
// Env vars:
//   VISION_PORT — proxy port (required)
//   VISION_HOST — proxy host (default: 127.0.0.1, set to LAN IP for SSH sessions)

const http = require('http')

const PORT = parseInt(process.env.VISION_PORT, 10)
const HOST = process.env.VISION_HOST || '127.0.0.1'

if (!PORT || isNaN(PORT)) {
  console.log(JSON.stringify({ ok: false, error: 'VISION_PORT env var not set. Vision is not enabled for this session.' }))
  process.exit(1)
}

const args = process.argv.slice(2)
const command = args[0]

if (!command) {
  console.log(JSON.stringify({ ok: false, error: 'Usage: node vision-cli.js <command> [args...]' }))
  process.exit(1)
}

const payload = JSON.stringify({ command, args: args.slice(1) })

const req = http.request({
  hostname: HOST,
  port: PORT,
  path: '/command',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload)
  },
  timeout: 30000
}, (res) => {
  let body = ''
  res.on('data', (chunk) => { body += chunk })
  res.on('end', () => {
    try {
      JSON.parse(body)
      console.log(body)
    } catch {
      console.log(JSON.stringify({ ok: false, error: 'Invalid response from vision proxy' }))
    }
  })
})

req.on('error', (err) => {
  console.log(JSON.stringify({ ok: false, error: 'Cannot connect to vision proxy at ' + HOST + ':' + PORT + ' — ' + err.message }))
  process.exit(1)
})

req.on('timeout', () => {
  req.destroy()
  console.log(JSON.stringify({ ok: false, error: 'Vision proxy request timed out (30s)' }))
  process.exit(1)
})

req.write(payload)
req.end()
