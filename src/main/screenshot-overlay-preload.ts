import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('screenshotAPI', {
  selectRegion: (region: { x: number; y: number; width: number; height: number }) => {
    ipcRenderer.invoke('screenshot:regionSelected', region)
  },
  cancel: () => {
    ipcRenderer.invoke('screenshot:cancelled')
  }
})
