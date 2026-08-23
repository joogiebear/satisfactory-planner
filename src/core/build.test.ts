import { describe, expect, it } from 'vitest'
import { alternateRecipes, defaultSettings, recipes } from './gameData'
import { oneMachineRate, solvePlan } from './solver'

describe('one machine of what you asked for', () => {
  it('sizes a build to exactly one machine of the final recipe', () => {
    const s = { ...defaultSettings(), unlockedAlternates: [] }
    for (const item of ['Desc_IronPlate_C', 'Desc_ModularFrame_C', 'Desc_ModularFrameHeavy_C']) {
      const rate = oneMachineRate(item, s)!
      expect(rate).toBeGreaterThan(0)
      const plan = solvePlan([{ item, ratePerMin: rate }], s)
      const final = plan.steps.find((x) => x.primaryItem.key === item)!
      expect(final.machines).toBeCloseTo(1, 6)
    }
  })

  /**
   * The point of the rule. Making every machine count whole is exact but puts
   * the smallest Modular Frame build at 210,600/min once alternates are in;
   * scaling until the rarest machine hits one drags iron plate to 1,800/min on
   * the back of a residue chain. Anchoring on the chosen recipe stays small
   * either way.
   */
  it('stays a sane size with alternates unlocked', () => {
    const s = { ...defaultSettings(), unlockedAlternates: alternateRecipes.map((r) => r.key) }
    for (const item of ['Desc_IronPlate_C', 'Desc_ModularFrameHeavy_C', 'Desc_Computer_C']) {
      const rate = oneMachineRate(item, s)!
      const plan = solvePlan([{ item, ratePerMin: rate }], s)
      expect(plan.totals.machines).toBeLessThan(200)
      expect(rate).toBeLessThan(500)
    }
  })

  it('improves the build as things get unlocked, for the same request', () => {
    const item = 'Desc_ModularFrameHeavy_C'
    const vanilla = { ...defaultSettings(), unlockedAlternates: [] }
    const unlocked = { ...defaultSettings(), unlockedAlternates: alternateRecipes.map((r) => r.key) }

    const a = solvePlan([{ item, ratePerMin: oneMachineRate(item, vanilla)! }], vanilla)
    const b = solvePlan([{ item, ratePerMin: oneMachineRate(item, unlocked)! }], unlocked)

    // Same one Manufacturer, fewer machines feeding it.
    expect(b.totals.machines).toBeLessThan(a.totals.machines)
  })

  it('gives nothing back for something no recipe makes', () => {
    const s = defaultSettings()
    expect(oneMachineRate('Desc_OreIron_C', s)).toBeNull()
    expect(oneMachineRate('not-an-item', s)).toBeNull()
  })

  it('covers every producible item without blowing up', () => {
    const s = { ...defaultSettings(), unlockedAlternates: alternateRecipes.map((r) => r.key) }
    const made = new Set(Object.values(recipes).flatMap((r) => r.products.map((p) => p.item)))
    const silly: string[] = []
    for (const item of made) {
      const rate = oneMachineRate(item, s)
      if (rate !== null && (rate > 5000 || !isFinite(rate))) silly.push(`${item} ${rate}`)
    }
    expect(silly).toEqual([])
  })
})
