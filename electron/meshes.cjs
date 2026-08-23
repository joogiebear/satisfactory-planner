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
  let buildings = 0
  try {
    buildings = Object.keys(JSON.parse(await fsp.readFile(path.join(dir, 'manifest.json'), 'utf8'))).length
  } catch {
    buildings = 0
  }
  return {
    count: buildings || count,
    meshFiles: count,
    dir,
    exporterAvailable: fs.existsSync(exporterPath()),
    detectedGame: findGame(),
  }
}

/**
 * Class name -> the parts that draw it, written by the extractor.
 *
 * A building is rarely one mesh: a window wall is a frame plus a pane, and a
 * foundation's mesh sits below its actor origin, so each part carries its own
 * offset, rotation and scale.
 */
async function manifest() {
  try {
    const raw = await fsp.readFile(path.join(meshDir(), 'manifest.json'), 'utf8')
    return JSON.parse(raw)
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

    onProgress({ phase: 'reading', done: 0, total: 0, message: 'Reading the icons…' })
    await runIcons(exporter, gameDir, raw, onProgress)

    onProgress({ phase: 'reading', done: 0, total: 0, message: 'Counting the map’s resource nodes…' })
    await runNodes(exporter, gameDir, raw, onProgress)

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

/**
 * Pull the game's own icons, using the class-to-texture map in the planner's
 * data. They used to come off the wiki and get baked into the installer, which
 * meant shipping Coffee Stain's artwork; this reads the copy already on the
 * machine, like the models.
 */
async function runIcons(exporter, gameDir, outDir, onProgress) {
  const { icons } = require('../src/data/game-data.json')
  if (!icons || Object.keys(icons).length === 0) return

  const list = path.join(outDir, 'icon-map.json')
  await fsp.writeFile(list, JSON.stringify(icons), 'utf8')
  try {
    await runExporter(exporter, gameDir, outDir, onProgress, ['--icons', list])
  } catch {
    // Icons are a nicety: without them chips fall back to lettered tiles, and
    // failing the whole extraction over that would cost the models too.
  } finally {
    await fsp.rm(list, { force: true }).catch(() => {})
  }
}

/**
 * Count what the map holds, so a survey can be checked against it.
 *
 * The nodes live in the level rather than in any data table, and the level is
 * a World Partition one — a few thousand cells, all of which have to be opened.
 * It runs last because it is the slowest part and the least missed: without it
 * you can still say you have three iron nodes, you just don't get told how many
 * there are to have.
 */
async function runNodes(exporter, gameDir, outDir, onProgress) {
  try {
    await runExporter(exporter, gameDir, outDir, onProgress, [
      '--nodes', path.join(outDir, 'nodes.json'),
    ])
  } catch {
    /* the tab falls back to unbounded counts */
  }
}

function runExporter(exporter, gameDir, outDir, onProgress, extra = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(exporter, ['--game', gameDir, '--out', outDir, ...extra], { windowsHide: true })
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
        // UVs must survive: without them the base-colour maps have nowhere to land.
        prune({ keepAttributes: true, keepLeaves: false }),
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

  // The manifest says which parts make up each building; without it the viewer
  // has meshes but no idea where they belong.
  try {
    await fsp.copyFile(path.join(rawDir, 'manifest.json'), path.join(outDir, 'manifest.json'))
  } catch {
    /* no manifest means no real geometry, and the boxes stand in */
  }
  await fsp.copyFile(path.join(rawDir, 'nodes.json'), path.join(outDir, 'nodes.json')).catch(() => {})

  // Base-colour maps and icons are already sized for display; copy as they are.
  for (const file of await fsp.readdir(rawDir)) {
    if (!file.endsWith('.albedo.jpg') && !file.endsWith('.png')) continue
    await fsp.copyFile(path.join(rawDir, file), path.join(outDir, file)).catch(() => {})
  }
  return written
}

/** How many nodes of each resource and purity the map holds. */
async function nodes() {
  try {
    return JSON.parse(await fsp.readFile(path.join(meshDir(), 'nodes.json'), 'utf8'))
  } catch {
    return null
  }
}

/** Class names that have an extracted icon, for the interface to look up. */
async function icons() {
  try {
    const files = await fsp.readdir(meshDir())
    return files.filter((f) => f.endsWith('.png')).map((f) => f.slice(0, -4))
  } catch {
    return []
  }
}

async function clear() {
  await fsp.rm(meshDir(), { recursive: true, force: true })
  return status()
}

module.exports = { meshDir, findGame, isGameDir, status, manifest, icons, nodes, extract, clear }
