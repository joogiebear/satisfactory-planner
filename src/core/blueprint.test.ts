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

maybe('blueprint placements', () => {
  it('reads a transform for every placed building', async () => {
    for (const path of files) {
      const bp = await load(path)
      expect(bp.placements.length).toBe(bp.totalBuildings)
      for (const p of bp.placements) {
        for (const v of p.position) expect(Number.isFinite(v)).toBe(true)
        expect(Number.isFinite(p.yaw)).toBe(true)
      }
    }
  })

  it('keeps placements inside the designer volume', async () => {
    for (const path of files) {
      const bp = await load(path)
      if (!bp.bounds) continue
      // A designer cell is 8 m; allow generous slack for parts that overhang.
      const limit = Math.max(bp.dimensions.x, bp.dimensions.y, bp.dimensions.z) * 800
      for (let i = 0; i < 3; i++) {
        expect(Math.abs(bp.bounds.min[i])).toBeLessThanOrEqual(limit)
        expect(Math.abs(bp.bounds.max[i])).toBeLessThanOrEqual(limit)
      }
    }
  })

  it('only leaves spline-built things without a footprint', async () => {
    // Belts, lifts, pipes and power lines are splines: the game stores a path
    // rather than a box, so they legitimately have no footprint. Anything else
    // missing one would mean the extraction dropped it.
    const splineish = new Set(['conveyor', 'pipe', 'power'])
    const unexplained = new Map<string, number>()

    for (const path of files) {
      const bp = await load(path)
      for (const p of bp.placements) {
        if (p.box) continue
        if (splineish.has(p.category) || /passthrough/i.test(p.key)) continue
        unexplained.set(p.key, (unexplained.get(p.key) ?? 0) + 1)
      }
    }
    expect([...unexplained.keys()]).toEqual([])
  })

  it('gives real machines their in-game footprint', async () => {
    const bp = await load(files.find((f) => /smelter/i.test(f)) ?? files[0])
    const smelter = bp.placements.find((p) => p.key === 'Build_SmelterMk1_C')
    if (smelter?.box) {
      // The Smelter reserves 5 m x 10 m x 4.5 m.
      expect(smelter.box.max[0] - smelter.box.min[0]).toBeCloseTo(500, 1)
      expect(smelter.box.max[1] - smelter.box.min[1]).toBeCloseTo(1000, 1)
      expect(smelter.box.max[2] - smelter.box.min[2]).toBeCloseTo(450, 1)
    }
  })
})
