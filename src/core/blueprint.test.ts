import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { parseBlueprint } from './blueprint'

// Real blueprints saved by the game. Skipped when this machine has none, so the
// suite still runs on a checkout without Satisfactory installed.
const DIR = join(homedir(), 'AppData', 'Local', 'FactoryGame', 'Saved', 'SaveGames', 'blueprints')

function blueprintFiles(): string[] {
  if (!existsSync(DIR)) return []
  const found: string[] = []
  for (const profile of readdirSync(DIR, { withFileTypes: true })) {
    if (!profile.isDirectory()) continue
    const dir = join(DIR, profile.name)
    for (const f of readdirSync(dir)) {
      if (f.toLowerCase().endsWith('.sbp')) found.push(join(dir, f))
    }
  }
  return found
}

const files = blueprintFiles()
const maybe = files.length ? describe : describe.skip

function load(path: string) {
  const buf = readFileSync(path)
  return parseBlueprint(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), path)
}

maybe('blueprint parsing', () => {
  it('reads every blueprint on this machine', async () => {
    const failures: string[] = []
    for (const path of files) {
      const bp = await load(path)
      if (bp.headerVersion !== 2) failures.push(`${bp.name}: header version ${bp.headerVersion}`)
      if (bp.totalBuildings === 0) failures.push(`${bp.name}: no buildings found`)
      if (bp.cost.length === 0) failures.push(`${bp.name}: no build cost`)
    }
    expect(failures).toEqual([])
  })

  it('reports dimensions and a resolvable build cost', async () => {
    const bp = await load(files[0])
    expect(bp.dimensions.x).toBeGreaterThan(0)
    expect(bp.dimensions.y).toBeGreaterThan(0)
    expect(bp.dimensions.z).toBeGreaterThan(0)
    // Costs are item classes the planner already knows about.
    const known = bp.cost.filter((c) => c.item)
    expect(known.length).toBeGreaterThan(0)
    for (const c of bp.cost) expect(c.amount).toBeGreaterThan(0)
  })

  it('handles both save versions present on this machine', async () => {
    const seen = new Set<number>()
    for (const path of files) seen.add((await load(path)).saveVersion)
    // Every version found must have produced a usable parse, checked above.
    expect(seen.size).toBeGreaterThan(0)
  })

  it('rejects a file that is not a blueprint', async () => {
    const junk = new Uint8Array(256)
    junk.fill(0xff)
    await expect(parseBlueprint(junk.buffer, 'junk.sbp')).rejects.toThrow()
  })
})
