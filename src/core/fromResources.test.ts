import { describe, expect, it } from 'vitest'
import { alternateRecipes, defaultSettings } from './gameData'
import { bestFrom, supplyOf, type Available } from './fromResources'

const mk3 = () => ({
  ...defaultSettings(),
  unlockedAlternates: alternateRecipes.map((r) => r.key),
  extraction: { ...defaultSettings().extraction, minerKey: 'Build_MinerMk3_C' },
})

const three: Available[] = [
  { item: 'Desc_OreIron_C', nodes: 1, purity: 'pure' },
  { item: 'Desc_Coal_C', nodes: 1, purity: 'pure' },
  { item: 'Desc_LiquidOil_C', nodes: 1, purity: 'pure' },
]

describe('what these nodes could make', () => {
  it('works out what each node supplies', () => {
    const supply = supplyOf(three, mk3())
    // Mk.3 is 240/min, a pure node doubles it.
    expect(supply.get('Desc_OreIron_C')).toBeCloseTo(480, 4)
    expect(supply.get('Desc_Coal_C')).toBeCloseTo(480, 4)
    // Oil has its own extractor and isn't a miner.
    expect(supply.get('Desc_LiquidOil_C')).toBeGreaterThan(0)
  })

  it('never proposes something needing a resource you did not list', () => {
    const iron: Available[] = [{ item: 'Desc_OreIron_C', nodes: 1, purity: 'pure' }]
    for (const c of bestFrom(iron, mk3())) {
      for (const d of c.draws) expect(d.item.key).toBe('Desc_OreIron_C')
    }
  })

  /** Every candidate is sized so exactly one resource is spent to the last item. */
  it('scales each candidate until something runs out', () => {
    const supply = supplyOf(three, mk3())
    for (const c of bestFrom(three, mk3()).slice(0, 12)) {
      expect(c.limitedBy).not.toBeNull()
      const binding = c.draws.find((d) => d.item.key === c.limitedBy!.key)!
      expect(binding.fraction).toBeCloseTo(1, 4)
      // And nothing exceeds what you have.
      for (const d of c.draws) {
        expect(d.ratePerMin).toBeLessThanOrEqual((supply.get(d.item.key) ?? 0) * (1 + 1e-6))
      }
    }
  })

  it('ranks by value, best first', () => {
    const ranked = bestFrom(three, mk3())
    expect(ranked.length).toBeGreaterThan(10)
    for (let i = 1; i < ranked.length; i++) {
      expect(ranked[i - 1].sinkPointsPerMin).toBeGreaterThanOrEqual(ranked[i].sinkPointsPerMin)
    }
  })

  it('gives nothing back when you have nothing', () => {
    expect(bestFrom([], mk3())).toEqual([])
    expect(bestFrom([{ item: 'Desc_OreIron_C', nodes: 0, purity: 'pure' }], mk3())).toEqual([])
  })

  it('offers more once the resources are richer', () => {
    const one = bestFrom([{ item: 'Desc_OreIron_C', nodes: 1, purity: 'pure' }], mk3())
    const all = bestFrom(three, mk3())
    expect(all.length).toBeGreaterThan(one.length)
  })

  /**
   * Machines are whole buildings, so a plan's totals cannot be scaled by
   * multiplication — a chain solved at one a minute reports one machine per
   * step no matter how big the real build is.
   */
  it('counts the machines the real build needs, not the sample one', () => {
    const settings = { ...defaultSettings(), unlockedAlternates: [] }
    const ranked = bestFrom([{ item: 'Desc_OreIron_C', nodes: 1, purity: 'normal' }], settings)
    const ingot = ranked.find((c) => c.item.key === 'Desc_IronIngot_C')!
    // A Mk.1 miner on a normal node is 60 ore/min; a smelter eats 30.
    expect(ingot.ratePerMin).toBeCloseTo(60, 4)
    expect(ingot.machines).toBe(2)
  })
})
