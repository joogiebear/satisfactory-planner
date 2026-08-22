/**
 * Extracting the game's building meshes on first run.
 *
 * Nothing of the game's ships with the planner. The bundled extractor reads the
 * copy of Satisfactory already on this machine and writes the result into the
 * app's own data folder, so the geometry never enters the installer or the repo.
 */

const { app } = require('electron')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')

const isDev = process.env.NODE_ENV === 'development'

/** Where extracted meshes live: per-user, outside the installed app. */
function meshDir() {
  return path.join(app.getPath('userData'), 'meshes')
}

function exporterPath() {
  const exe = 'satisfactory-mesh-exporter.exe'
  return isDev
    ? path.join(__dirname, '..', 'tools', 'mesh-exporter', 'publish', exe)
    : path.join(process.resourcesPath, 'mesh-exporter', exe)
}

/**
 * Find Satisfactory through Steam's library registry, which is where it lives
 * for nearly everyone. Anything else is picked by hand.
 */
function findGame() {
  const roots = [
    'C:/Program Files (x86)/Steam',
    'C:/Program Files/Steam',
    path.join(os.homedir(), 'scoop', 'apps', 'steam', 'current'),
  ]
  const libraries = []

  for (const root of roots) {
    const vdf = path.join(root, 'steamapps', 'libraryfolders.vdf')
    if (!fs.existsSync(vdf)) continue
    let text
    try { text = fs.readFileSync(vdf, 'utf8') } catch { continue }
    for (const match of text.matchAll(/"path"\s+"([^"]+)"/g)) {
      libraries.push(match[1].replace(/\\\\/g, '/'))
    }
  }
  libraries.push(...roots)

  for (const lib of libraries) {
    const dir = path.join(lib, 'steamapps', 'common', 'Satisfactory')
    if (isGameDir(dir)) return dir
  }
  return null
}

function isGameDir(dir) {
  return Boolean(dir) && fs.existsSync(path.join(dir, 'FactoryGame', 'Content', 'Paks'))
}

async function status() {
  const dir = meshDir()
  let count = 0
  try {
    const files = await fsp.readdir(dir)
    count = files.filter((f) => f.toLowerCase().endsWith('.glb')).length
  } catch {
    count = 0
  }
  return {
    count,
    dir,
    exporterAvailable: fs.existsSync(exporterPath()),
    detectedGame: findGame(),
  }
}

/** Class name -> file name, read back from what is actually on disk. */
async function manifest() {
  const dir = meshDir()
  try {
    const files = await fsp.readdir(dir)
    const map = {}
    for (const file of files) {
      if (file.toLowerCase().endsWith('.glb')) map[file.replace(/\.glb$/i, '')] = file
    }
    return map
  } catch {
    return {}
  }
}

/**
 * Run the extractor, then simplify what it produced.
 *
 * Source meshes are Nanite-era and far too heavy for WebGL, so the second pass
 * is not optional: it takes roughly 226 MB down to 20 MB.
 */
async function extract(gameDir, onProgress) {
  const exporter = exporterPath()
  if (!fs.existsSync(exporter)) {
    throw new Error('The mesh extractor is missing from this build.')
  }
  if (!isGameDir(gameDir)) {
    throw new Error('That folder does not look like a Satisfactory install (no FactoryGame/Content/Paks).')
  }

  const raw = await fsp.mkdtemp(path.join(os.tmpdir(), 'satisfactory-meshes-'))
  try {
    onProgress({ phase: 'reading', done: 0, total: 0, message: 'Opening the game files…' })
    await runExporter(exporter, gameDir, raw, onProgress)

    onProgress({ phase: 'optimising', done: 0, total: 0, message: 'Simplifying for display…' })
    const out = meshDir()
    await fsp.rm(out, { recursive: true, force: true })
    await fsp.mkdir(out, { recursive: true })
    const written = await optimise(raw, out, onProgress)

    onProgress({ phase: 'done', done: written, total: written, message: 'Ready.' })
    return { count: written, dir: out }
  } finally {
    await fsp.rm(raw, { recursive: true, force: true }).catch(() => {})
  }
}

function runExporter(exporter, gameDir, outDir, onProgress) {
  return new Promise((resolve, reject) => {
    const child = spawn(exporter, ['--game', gameDir, '--out', outDir], { windowsHide: true })
    let tail = ''
    let stderr = ''

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      tail += chunk
      const lines = tail.split(/\r?\n/)
      tail = lines.pop() ?? ''
      for (const line of lines) {
        const match = /^PROGRESS (\d+) (\d+) (.*)$/.exec(line)
        if (match) {
          onProgress({
            phase: 'reading',
            done: Number(match[1]),
            total: Number(match[2]),
            message: friendly(match[3]),
          })
        }
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => { stderr += chunk })

    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(stderr.trim().split('\n').pop() || `Extractor exited with code ${code}.`))
    })
  })
}

function friendly(className) {
  return String(className).replace(/^Build_/, '').replace(/_C$/, '').replace(/_/g, ' ')
}

/** Weld, simplify, strip and quantise every mesh the extractor produced. */
async function optimise(rawDir, outDir, onProgress) {
  const { NodeIO } = require('@gltf-transform/core')
  const { KHRONOS_EXTENSIONS } = require('@gltf-transform/extensions')
  const { dedup, prune, quantize, simplify, weld } = require('@gltf-transform/functions')
  const { MeshoptSimplifier } = require('meshoptimizer')

  await MeshoptSimplifier.ready
  const io = new NodeIO().registerExtensions(KHRONOS_EXTENSIONS)

  const files = (await fsp.readdir(rawDir)).filter((f) => f.toLowerCase().endsWith('.glb'))
  let written = 0

  for (const [index, file] of files.entries()) {
    try {
      const document = await io.read(path.join(rawDir, file))
      await document.transform(
        weld(),
        simplify({ simplifier: MeshoptSimplifier, ratio: 0.12, error: 0.008 }),
        prune({ keepAttributes: false, keepLeaves: false }),
        dedup(),
        quantize({ quantizePosition: 14, quantizeNormal: 8 })
      )
      await fsp.writeFile(path.join(outDir, file), await io.writeBinary(document))
      written++
    } catch {
      // A mesh that won't simplify simply isn't drawn; the box stands in.
    }
    onProgress({
      phase: 'optimising',
      done: index + 1,
      total: files.length,
      message: friendly(file.replace(/\.glb$/i, '')),
    })
  }
  return written
}

async function clear() {
  await fsp.rm(meshDir(), { recursive: true, force: true })
  return status()
}

module.exports = { meshDir, findGame, isGameDir, status, manifest, extract, clear }
