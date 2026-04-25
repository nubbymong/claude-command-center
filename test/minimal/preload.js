const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('pty', {
  onData: (cb) => ipcRenderer.on('pty:data', (_, data) => cb(data)),
  write: (data) => ipcRenderer.send('pty:write', data),
  resize: (cols, rows) => ipcRenderer.send('pty:resize', cols, rows),
})
