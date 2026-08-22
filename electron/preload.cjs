// The renderer is a self-contained calculator, so the only privileged thing it
// needs is the mesh extraction that reads the installed game.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('appInfo', {
  isElectron: true,
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  node: process.versions.node,
})

contextBridge.exposeInMainWorld('meshApi', {
  status: () => ipcRenderer.invoke('meshes:status'),
  manifest: () => ipcRenderer.invoke('meshes:manifest'),
  icons: () => ipcRenderer.invoke('meshes:icons'),
  browse: () => ipcRenderer.invoke('meshes:browse'),
  extract: (gameDir) => ipcRenderer.invoke('meshes:extract', gameDir),
  clear: () => ipcRenderer.invoke('meshes:clear'),
  onProgress: (callback) => {
    const handler = (_event, progress) => callback(progress)
    ipcRenderer.on('meshes:progress', handler)
    return () => ipcRenderer.removeListener('meshes:progress', handler)
  },
})
