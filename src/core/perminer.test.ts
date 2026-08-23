import { describe, expect, it } from 'vitest'
import { defaultSettings } from './gameData'
import { solvePlan } from './solver'

/**
 * A survey turns up a pure iron node and an impure copper one. They are
 * separate machines and have to be settable separately, which is why these
 * settings moved onto the miner in the factory view.
 */
describe('per-resource extraction', () => {
  const twoOres = [
    { item: 'Desc_IronPlate_C', ratePerMin: 20 },
    { item: 'Desc_Wire_C', ratePerMin: 30 },
  ]

  it('lets each resource carry its own miner, purity and clock', () => {
    const s = {
      ...defaultSettings(),
      unlockedAlternates: [],
      extraction: {
        ...defaultSettings().extraction,
        minerByResource: { Desc_OreIron_C: 'Build_MinerMk3_C' },
        purity: { Desc_OreIron_C: 'pure' as const, Desc_OreCopper_C: 'impure' as const },
        clockByResource: { Desc_OreIron_C: 2.5 },
      },
    }
    const plan = solvePlan(twoOres, s)
    const iron = plan.raw.find((r) => r.item.key === 'Desc_OreIron_C')!
    const copper = plan.raw.find((r) => r.item.key === 'Desc_OreCopper_C')!

    // Iron: Mk.3 (240) on a pure node (x2) at 250% = 1,200/min.
    expect(iron.extractor!.key).toBe('Build_MinerMk3_C')
    expect(iron.purity).toBe('pure')
    expect(iron.ratePerExtractor).toBeCloseTo(1200, 4)

    // Copper keeps the default miner, and its own impure node halves it.
    expect(copper.extractor!.key).toBe(defaultSettings().extraction.minerKey)
    expect(copper.purity).toBe('impure')
    expect(copper.ratePerExtractor).toBeCloseTo(copper.extractor!.baseRatePerMin * 0.5, 4)
  })

  it('falls back to the defaults for anything not set on its own miner', () => {
    const s = { ...defaultSettings(), unlockedAlternates: [] }
    const plan = solvePlan(twoOres, s)
    for (const raw of plan.raw) {
      if (!raw.extractor || raw.extractor.kind !== 'solid') continue
      expect(raw.purity).toBe(s.extraction.defaultPurity)
      expect(raw.extractor.key).toBe(s.extraction.minerKey)
    }
  })

  it('reads settings files written before the miner owned them', () => {
    const old = defaultSettings()
    // A file from an earlier build has neither of the new records at all.
    delete (old.extraction as Partial<typeof old.extraction>).minerByResource
    delete (old.extraction as Partial<typeof old.extraction>).clockByResource
    const plan = solvePlan(twoOres, { ...old, unlockedAlternates: [] })
    expect(plan.errors).toEqual([])
    expect(plan.raw.length).toBeGreaterThan(0)
  })
})
