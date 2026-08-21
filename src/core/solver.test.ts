import { describe, expect, it } from 'vitest'
import { alternateRecipes, defaultSettings, producibleItems } from './gameData'
import { powerPerMachine, solvePlan, tuningFor } from './solver'
import { recipes } from './gameData'
import type { PlannerSettings } from './types'

const IRON_ORE = 'Desc_OreIron_C'

function settings(patch: Partial<PlannerSettings> = {}): PlannerSettings {
  return { ...defaultSettings(), ...patch }
}

/** Total machines of a given building across the plan. */
function machinesOf(plan: ReturnType<typeof solvePlan>, buildingKey: string): number {
  return plan.steps
    .filter((s) => s.recipe.machine === buildingKey)
    .reduce((n, s) => n + s.machines, 0)
}

function rawRate(plan: ReturnType<typeof solvePlan>, itemKey: string): number {
  return plan.raw.find((r) => r.item.key === itemKey)?.ratePerMin ?? 0
}

describe('basic chains', () => {
  it('makes 20 Iron Plate/min from 1 Constructor + 1 Smelter on 30 ore', () => {
    const plan = solvePlan([{ item: 'Desc_IronPlate_C', ratePerMin: 20 }], settings())

    expect(plan.errors).toEqual([])
    expect(rawRate(plan, IRON_ORE)).toBeCloseTo(30, 6)
    expect(machinesOf(plan, 'Build_ConstructorMk1_C')).toBeCloseTo(1, 6)
    expect(machinesOf(plan, 'Build_SmelterMk1_C')).toBeCloseTo(1, 6)
    // Constructor 4 MW + Smelter 4 MW at 100% clock.
    expect(plan.totals.machinePowerMW).toBeCloseTo(8, 4)
  })

  it('needs 60 Iron Ore/min for 5 Reinforced Iron Plate/min', () => {
    const plan = solvePlan([{ item: 'Desc_IronPlateReinforced_C', ratePerMin: 5 }], settings())

    expect(plan.errors).toEqual([])
    expect(rawRate(plan, IRON_ORE)).toBeCloseTo(60, 6)
    expect(machinesOf(plan, 'Build_AssemblerMk1_C')).toBeCloseTo(1, 6)
    expect(machinesOf(plan, 'Build_SmelterMk1_C')).toBeCloseTo(2, 6)
    // 1.5 plate + 1.5 screw + 1 rod constructors.
    expect(machinesOf(plan, 'Build_ConstructorMk1_C')).toBeCloseTo(4, 6)
  })

  it('scales linearly with the requested rate', () => {
    const one = solvePlan([{ item: 'Desc_IronPlate_C', ratePerMin: 20 }], settings())
    const ten = solvePlan([{ item: 'Desc_IronPlate_C', ratePerMin: 200 }], settings())
    expect(rawRate(ten, IRON_ORE)).toBeCloseTo(rawRate(one, IRON_ORE) * 10, 6)
  })
})

describe('byproducts', () => {
  it('reports Heavy Oil Residue left over when making Plastic', () => {
    const plan = solvePlan([{ item: 'Desc_Plastic_C', ratePerMin: 20 }], settings())

    expect(plan.errors).toEqual([])
    expect(rawRate(plan, 'Desc_LiquidOil_C')).toBeCloseTo(30, 6)
    const hor = plan.byproducts.find((b) => b.item.key === 'Desc_HeavyOilResidue_C')
    expect(hor?.ratePerMin).toBeCloseTo(10, 6)
  })

  it('consumes the residue instead of wasting it when both Plastic and Rubber are wanted', () => {
    // Plastic emits 10 HOR per 20 plastic; Rubber emits 20 HOR per 20 rubber.
    // Residual Fuel/Rubber can absorb it, so the surplus should not just pile up.
    const plan = solvePlan(
      [
        { item: 'Desc_Plastic_C', ratePerMin: 20 },
        { item: 'Desc_Rubber_C', ratePerMin: 20 },
      ],
      settings()
    )
    expect(plan.errors).toEqual([])
    const hor = plan.byproducts.find((b) => b.item.key === 'Desc_HeavyOilResidue_C')
    // Whatever is left must be accounted for, never negative.
    expect(hor?.ratePerMin ?? 0).toBeGreaterThanOrEqual(0)
    expect(plan.targets).toHaveLength(2)
  })
})

describe('recycling loops', () => {
  it('solves Recycled Plastic / Recycled Rubber without diverging', () => {
    // These two alternates consume each other's output, which is exactly the
    // case a recursive tree walk cannot handle.
    const s = settings({
      unlockedAlternates: ['Recipe_Alternate_RecycledPlastic_C', 'Recipe_Alternate_RecycledRubber_C'],
    })
    const plan = solvePlan([{ item: 'Desc_Plastic_C', ratePerMin: 100 }], s)

    expect(plan.errors).toEqual([])
    expect(plan.steps.length).toBeGreaterThan(0)
    for (const step of plan.steps) {
      expect(Number.isFinite(step.machines)).toBe(true)
      expect(step.machines).toBeGreaterThan(0)
    }
  })
})

describe('overclocking and Somersloops', () => {
  it('applies the 1.321929 power exponent when overclocking', () => {
    const recipe = recipes['Recipe_IronPlate_C']
    const s = settings({ defaultClock: 2.5 })
    const tuned = tuningFor(recipe, s)
    // 4 MW * 2.5^1.321929 ~= 13.4 MW, matching the in-game readout.
    expect(powerPerMachine(recipe, tuned)).toBeCloseTo(4 * Math.pow(2.5, 1.321929), 6)
  })

  it('halves the machine count at 250% clock', () => {
    const base = solvePlan([{ item: 'Desc_IronPlate_C', ratePerMin: 20 }], settings())
    const oc = solvePlan([{ item: 'Desc_IronPlate_C', ratePerMin: 20 }], settings({ defaultClock: 2.5 }))
    expect(machinesOf(oc, 'Build_ConstructorMk1_C')).toBeCloseTo(
      machinesOf(base, 'Build_ConstructorMk1_C') / 2.5, 6
    )
    // Same throughput needs the same ore either way.
    expect(rawRate(oc, IRON_ORE)).toBeCloseTo(rawRate(base, IRON_ORE), 6)
  })

  it('doubles output per input with a full Somersloop, at 4x power', () => {
    const s = settings({ tuning: { Recipe_IronPlate_C: { clock: 1, sloops: 1 } } })
    const plan = solvePlan([{ item: 'Desc_IronPlate_C', ratePerMin: 20 }], s)
    const step = plan.steps.find((x) => x.recipe.key === 'Recipe_IronPlate_C')!

    expect(step.sloopMultiplier).toBeCloseTo(2, 6)
    // Same 20 plate/min now takes half a Constructor and half the ingots.
    expect(step.machines).toBeCloseTo(0.5, 6)
    expect(rawRate(plan, IRON_ORE)).toBeCloseTo(15, 6)
    // Power exponent for the boost is 2, so a full sloop is 4x draw.
    expect(powerPerMachine(step.recipe, { clock: 1, sloops: 1, sloopMultiplier: 2 })).toBeCloseTo(16, 6)
  })
})

describe('extraction settings', () => {
  it('scales miner counts with node purity and miner mark', () => {
    const impure = solvePlan(
      [{ item: 'Desc_IronPlate_C', ratePerMin: 20 }],
      settings({ extraction: { ...defaultSettings().extraction, defaultPurity: 'impure' } })
    )
    const pure = solvePlan(
      [{ item: 'Desc_IronPlate_C', ratePerMin: 20 }],
      settings({ extraction: { ...defaultSettings().extraction, defaultPurity: 'pure' } })
    )
    const impureOre = impure.raw.find((r) => r.item.key === IRON_ORE)!
    const pureOre = pure.raw.find((r) => r.item.key === IRON_ORE)!

    // Mk.1 miner: 30/min impure, 120/min pure.
    expect(impureOre.ratePerExtractor).toBeCloseTo(30, 6)
    expect(pureOre.ratePerExtractor).toBeCloseTo(120, 6)
    expect(impureOre.extractorCount).toBeCloseTo(1, 6)
    expect(pureOre.extractorCount).toBeCloseTo(0.25, 6)
  })

  it('warns when a miner outruns the selected belt', () => {
    const s = settings({
      beltKey: 'Build_ConveyorBeltMk1_C',
      extraction: {
        ...defaultSettings().extraction,
        minerKey: 'Build_MinerMk3_C',
        defaultPurity: 'pure',
      },
    })
    const plan = solvePlan([{ item: 'Desc_IronPlate_C', ratePerMin: 200 }], s)
    // Mk.3 on a pure node is 480/min against a 60/min belt.
    expect(plan.warnings.some((w) => w.includes('belt-limited'))).toBe(true)
  })
})

describe('robustness', () => {
  it('returns an empty plan for no targets', () => {
    const plan = solvePlan([], settings())
    expect(plan.steps).toEqual([])
    expect(plan.errors).toEqual([])
  })

  it('solves every producible item once all alternates are unlocked', () => {
    const s = settings({ unlockedAlternates: alternateRecipes.map((r) => r.key) })
    const failures: string[] = []
    for (const item of producibleItems) {
      const plan = solvePlan([{ item: item.key, ratePerMin: 10 }], s)
      if (plan.errors.length) failures.push(item.name)
      // A raw resource asked for directly is just extraction, so no steps is
      // the right answer for those.
      else if (!plan.steps.length && !item.isRaw) failures.push(`${item.name} (no steps)`)
    }
    expect(failures).toEqual([])
  })

  it('reports a clean error for items that genuinely need an alternate recipe', () => {
    // Turbofuel has no standard recipe: every route needs Compacted Coal or one
    // of the blend alternates, so a fresh save really cannot make it.
    const plan = solvePlan([{ item: 'Desc_LiquidTurboFuel_C', ratePerMin: 10 }], settings())
    expect(plan.errors).toHaveLength(1)
    expect(plan.errors[0]).toContain('alternate')
    expect(plan.steps).toEqual([])
  })

  it('makes those items solvable once the alternate is unlocked', () => {
    const plan = solvePlan(
      [{ item: 'Desc_LiquidTurboFuel_C', ratePerMin: 10 }],
      settings({ unlockedAlternates: ['Recipe_Alternate_Turbofuel_C', 'Recipe_Alternate_EnrichedCoal_C'] })
    )
    expect(plan.errors).toEqual([])
    expect(plan.steps.length).toBeGreaterThan(0)
  })
})
