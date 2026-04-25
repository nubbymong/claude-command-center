// Minimal repro for Windows-only xterm.js cursor artifact.
// This is intentionally bare: Electron + node-pty + xterm.js, nothing
// else. Same PTY config as the main app (ConPTY, xterm-256color),
// same xterm.js + WebGL addon stack — but ZERO of our cursor-hide
// or stripping code. If the rogue square appears here, it's the raw
// Electron + xterm.js + Claude stack on Windows. If it doesn't, the
// issue is something we add on top in src/renderer.

const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('path')
const os = require('os')
const pty = require('node-pty')

let win
let ptyProcess

app.whenReady().then(() => {
  win = new BrowserWindow({
    width: 1200,
    height: 800,
    backgroundColor: '#1a1a1a',
    title: 'Minimal Terminal Repro',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  win.loadFile(path.join(__dirname, 'index.html'))

  // Spawn the user's default shell. They'll type `claude` themselves.
  const isWin = os.platform() === 'win32'
  const shell = isWin ? 'powershell.exe' : (process.env.SHELL || '/bin/bash')

  ptyProcess = pty.spawn(shell, [], {
    name: 'xterm-256color',
    cols: 120,
    rows: 30,
    cwd: process.env.USERPROFILE || process.env.HOME,
    env: process.env,
    useConpty: true,
  })

  ptyProcess.onData((data) => {
    if (!win.isDestroyed()) win.webContents.send('pty:data', data)
  })

  ipcMain.on('pty:write', (_, data) => {
    if (ptyProcess) ptyProcess.write(data)
  })

  ipcMain.on('pty:resize', (_, cols, rows) => {
    if (ptyProcess) ptyProcess.resize(cols, rows)
  })
})

app.on('window-all-closed', () => {
  if (ptyProcess) ptyProcess.kill()
  app.quit()
})
