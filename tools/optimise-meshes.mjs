/**
 * Shrink the meshes exported from the game into something a browser can draw.
 *
 * Satisfactory's building meshes are Nanite-era: a Smelter is ~1.4 MB and the
 * full set is 227 MB, which is far too much to load in WebGL. The planner only
 * needs recognisable silhouettes, so each mesh is simplified hard and quantised,
 * which takes the set to roughly 15 MB with no runtime decoder required
 * (KHR_mesh_quantization is supported by three.js out of the box).
 *
 *   node tools/optimise-meshes.mjs <rawDir> [outDir]
 */

import { NodeIO } from '@gltf-transform/core'
import { KHRONOS_EXTENSIONS } from '@gltf-transform/extensions'
import { dedup, prune, quantize, simplify, weld } from '@gltf-transform/functions'
import { MeshoptSimplifier } from 'meshoptimizer'
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { basename, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const rawDir = process.argv[2]
const outDir = process.argv[3] ?? join(here, '..', 'src', 'data', 'meshes')

if (!rawDir || !existsSync(rawDir)) {
  console.error('usage: node tools/optimise-meshes.mjs <rawExportDir> [outDir]')
  process.exit(2)
}

const io = new NodeIO().registerExtensions(KHRONOS_EXTENSIONS)
await MeshoptSimplifier.ready

mkdirSync(outDir, { recursive: true })

const files = readdirSync(rawDir).filter((f) => f.toLowerCase().endsWith('.glb'))
console.log(`Optimising ${files.length} meshes from ${rawDir}`)

let before = 0
let after = 0
let failed = 0

for (const [i, file] of files.entries()) {
  const src = join(rawDir, file)
  const dest = join(outDir, file)
  try {
    before += statSync(src).size
    const document = await io.read(src)

    await document.transform(
      // Welding first lets the simplifier actually collapse shared edges.
      weld(),
      simplify({ simplifier: MeshoptSimplifier, ratio: 0.12, error: 0.008 }),
      // Drop anything the planner never draws: materials, textures, animation.
      // UVs must survive: without them the base-colour maps have nowhere to land.
        prune({ keepAttributes: true, keepLeaves: false }),
      dedup(),
      quantize({ quantizePosition: 14, quantizeNormal: 8 })
    )

    writeFileSync(dest, await io.writeBinary(document))
    after += statSync(dest).size
  } catch (error) {
    failed++
    if (failed <= 5) console.warn(`  ${basename(file)}: ${error.message}`)
  }
  if ((i + 1) % 25 === 0) console.log(`  ${i + 1}/${files.length}…`)
}

// The exporter's manifest maps building classes to files; carry it across,
// along with the base-colour maps, which are already sized for display.
const manifest = join(rawDir, 'manifest.json')
if (existsSync(manifest)) writeFileSync(join(outDir, 'manifest.json'), readFileSync(manifest))

let textures = 0
for (const file of readdirSync(rawDir)) {
  if (!file.endsWith('.albedo.jpg')) continue
  writeFileSync(join(outDir, file), readFileSync(join(rawDir, file)))
  textures++
}
console.log(`Copied ${textures} textures`)

const mb = (n) => (n / 1048576).toFixed(1)
console.log(`Done: ${mb(before)} MB -> ${mb(after)} MB (${failed} failed)`)
