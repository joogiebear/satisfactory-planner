import { describe, expect, it } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { parseBlueprint } from './blueprint'

const SHACK = 'C:/Users/e85sr/AppData/Local/FactoryGame/Saved/SaveGames/blueprints/YaBoi/The Smelting Shack.sbp'

describe('conveyor lift height', () => {
  it.skipIf(!existsSync(SHACK))('reads a real height for every lift', async () => {
    const bytes = readFileSync(SHACK)
    const bp = await parseBlueprint(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      'The Smelting Shack')
    const lifts = bp.placements.filter((p) => p.key.includes('ConveyorLift'))
    expect(lifts.length).toBeGreaterThan(100)

    // Every one decodes, and none of them is the one-storey default that the
    // viewer used to draw for all of them.
    const missing = lifts.filter((l) => l.liftHeight === undefined)
    expect(missing).toEqual([])

    const heights = new Set(lifts.map((l) => Math.round(l.liftHeight!)))
    expect(heights.size).toBeGreaterThan(1)
    // Lifts run in whole half-metres, up or down, and none is absurd.
    for (const h of heights) {
      expect(Math.abs(h)).toBeGreaterThan(0)
      expect(Math.abs(h)).toBeLessThan(10000)
    }
  })
})
