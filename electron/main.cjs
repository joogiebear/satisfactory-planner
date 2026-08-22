// Electron entry point. Plain CommonJS so it runs without a build step.
const { app, BrowserWindow, dialog, ipcMain, Menu, net, protocol, shell } = require('electron')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const meshes = require('./meshes.cjs')

const isDev = process.env.NODE_ENV === 'development'

// Meshes are extracted per-user into the app's data folder, so they can't be
// bundled by the renderer. A privileged scheme lets the page fetch them without
// relaxing file:// security.
protocol.registerSchemesAsPrivileged([
  { scheme: 'mesh', privileges: { standard: true, secure: true, supportFetchAPI: true, bypassCSP: true } },
])

function createWindow() {
  const win = new BrowserWindow({
    width: 1500,
    height: 950,
    minWidth: 1024,
    minHeight: 700,
    backgroundColor: '#0d1117',
    show: false,
    autoHideMenuBar: true,
    title: 'Satisfactory Planner',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  win.once('ready-to-show', () => win.show())

  // Open external links in the user's real browser, never in-app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url)
    return { action: 'deny' }
  })

  if (isDev) {
    win.loadURL('http://localhost:5173')
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
  }
  return win
}

// A minimal menu keeps the standard shortcuts (reload, devtools, zoom, quit)
// without the default Electron "Help/Learn More" clutter.
function buildMenu() {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: 'File',
        submenu: [{ role: 'quit' }],
      },
      {
        label: 'View',
        submenu: [
          { role: 'reload' },
          { role: 'forceReload' },
          { role: 'toggleDevTools' },
          { type: 'separator' },
          { role: 'resetZoom' },
          { role: 'zoomIn' },
          { role: 'zoomOut' },
          { type: 'separator' },
          { role: 'togglefullscreen' },
        ],
      },
    ])
  )
}

function registerMeshProtocol() {
  protocol.handle('mesh', (request) => {
    // mesh://model/<file> -> <userData>/meshes/<file>
    // Geometry and its base-colour maps both come through here.
    const name = path.basename(decodeURIComponent(new URL(request.url).pathname))
    if (!/\.(glb|jpg|png)$/i.test(name)) return new Response('Not found', { status: 404 })
    return net.fetch(pathToFileURL(path.join(meshes.meshDir(), name)).toString())
  })
}

function registerIpc() {
  ipcMain.handle('meshes:status', () => meshes.status())
  ipcMain.handle('meshes:manifest', () => meshes.manifest())
  ipcMain.handle('meshes:clear', () => meshes.clear())

  ipcMain.handle('meshes:browse', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const result = await dialog.showOpenDialog(win, {
      title: 'Select your Satisfactory folder',
      properties: ['openDirectory'],
      message: 'Pick the folder containing FactoryGameSteam.exe',
    })
    if (result.canceled || !result.filePaths.length) return null
    const dir = result.filePaths[0]
    return { dir, valid: meshes.isGameDir(dir) }
  })

  ipcMain.handle('meshes:extract', async (event, gameDir) => {
    const sender = event.sender
    const send = (progress) => {
      if (!sender.isDestroyed()) sender.send('meshes:progress', progress)
    }
    try {
      return { ok: true, ...(await meshes.extract(gameDir, send)) }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
}

app.whenReady().then(() => {
  buildMenu()
  registerMeshProtocol()
  registerIpc()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
