/**
 * One command to put real building geometry in the planner:
 * build the extractor, read the installed game, then shrink the result.
 *
 *   npm run fetch-meshes -- --game "D:/SteamLibrary/steamapps/common/Satisfactory"
 *
 * With no --game it looks the install up through Steam's library registry.
 * Requires the .NET SDK for the extractor build; see docs/MESHES.md.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const exporter = join(here, 'mesh-exporter')

function findGame() {
  const flag = process.argv.indexOf('--game')
  if (flag >= 0 && process.argv[flag + 1]) return process.argv[flag + 1]

  for (const steam of ['C:/Program Files (x86)/Steam', 'C:/Program Files/Steam']) {
    const vdf = join(steam, 'steamapps', 'libraryfolders.vdf')
    if (!existsSync(vdf)) continue
    const text = readFileSync(vdf, 'utf8')
    for (const match of text.matchAll(/"path"\s+"([^"]+)"/g)) {
      const dir = join(match[1].replace(/\\/g, '/'), 'steamapps', 'common', 'Satisfactory')
      if (existsSync(join(dir, 'FactoryGame', 'Content', 'Paks'))) return dir
    }
  }
  return null
}

const game = findGame()
if (!game) {
  console.error('Could not find Satisfactory. Pass --game "<install folder>".')
  process.exit(2)
}
console.log(`Game: ${game}`)

const run = (cmd, args, cwd) => {
  const res = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: true })
  if (res.status !== 0) {
    console.error(`\n${cmd} failed. Is the .NET SDK installed? See docs/MESHES.md`)
    process.exit(res.status ?? 1)
  }
}

console.log('\n[1/3] Building the extractor…')
run('dotnet', ['build', '-c', 'Release', '--nologo'], exporter)

const raw = mkdtempSync(join(tmpdir(), 'satisfactory-meshes-'))
try {
  console.log('\n[2/3] Reading meshes from the game…')
  run('dotnet', ['run', '-c', 'Release', '--no-build', '--', '--game', `"${game}"`, '--out', `"${raw}"`], exporter)

  console.log('\n[3/3] Simplifying for the browser…')
  run('node', [join(here, 'optimise-meshes.mjs'), `"${raw}"`], root)
} finally {
  rmSync(raw, { recursive: true, force: true })
}

console.log('\nDone. Reload the app to see real geometry in the blueprint viewer.')
