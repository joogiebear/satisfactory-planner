// The renderer is a self-contained calculator; it needs no privileged APIs.
// We expose only inert version strings so the UI can show what it's running on.
const { contextBridge } = require('electron')

contextBridge.exposeInMainWorld('appInfo', {
  isElectron: true,
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  node: process.versions.node,
})
