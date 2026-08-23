import { describe, expect, it } from 'vitest'
import { defaultSettings } from './gameData'
import { oneMachineRate, solvePlan } from './solver'

/**
 * The rate is the product of the build and its tuning, so tuning has to move
 * it. These pin the arithmetic the app relies on to keep them in step.
 */
describe('output follows the build', () => {
  it('overclocking the machines raises what one of them makes', () => {
    const item = 'Desc_IronPlate_C'
    const base = { ...defaultSettings(), unlockedAlternates: [] }
    const fast = { ...base, defaultClock: 2.5 }

    const slow = oneMachineRate(item, base)!
    const quick = oneMachineRate(item, fast)!
    expect(quick).toBeCloseTo(slow * 2.5, 4)

    // And the build stays one machine at either speed.
    for (const [rate, s] of [[slow, base], [quick, fast]] as const) {
      const plan = solvePlan([{ item, ratePerMin: rate }], s)
      const final = plan.steps.find((x) => x.primaryItem.key === item)!
      expect(final.machines).toBeCloseTo(1, 6)
    }
  })

  it('mining settings change the miners, not the output', () => {
    const item = 'Desc_IronPlate_C'
    const poor = { ...defaultSettings(), unlockedAlternates: [] }
    const rich = {
      ...poor,
      extraction: { ...poor.extraction, minerKey: 'Build_MinerMk3_C', defaultPurity: 'pure' as const },
    }
    // The factory makes the same amount; it just takes less of a node to feed.
    expect(oneMachineRate(item, rich)).toBeCloseTo(oneMachineRate(item, poor)!, 6)

    const a = solvePlan([{ item, ratePerMin: oneMachineRate(item, poor)! }], poor)
    const b = solvePlan([{ item, ratePerMin: oneMachineRate(item, rich)! }], rich)
    const ore = (p: typeof a) => p.raw.find((r) => r.item.key === 'Desc_OreIron_C')!
    expect(ore(b).extractorCount).toBeLessThan(ore(a).extractorCount)
    expect(ore(b).ratePerMin).toBeCloseTo(ore(a).ratePerMin, 4)
  })

  it('a different recipe changes what the same one machine makes', () => {
    const item = 'Desc_IronPlate_C'
    const vanilla = { ...defaultSettings(), unlockedAlternates: [] }

    // Pinned rather than merely unlocked: with resources as the objective the
    // solver declines Coated Iron Plate on its own, since the plastic in it
    // costs crude oil. Unlocking a recipe is an offer, not an instruction.
    const alt = 'Recipe_Alternate_CoatedIronPlate_C'
    const coated = {
      ...vanilla,
      unlockedAlternates: [alt],
      pinnedRecipes: { [item]: alt },
    }

    const a = oneMachineRate(item, vanilla)!
    const b = oneMachineRate(item, coated)!
    expect(a).toBeGreaterThan(0)
    expect(b).toBeGreaterThan(0)
    expect(b).not.toBeCloseTo(a, 4)
  })
})
