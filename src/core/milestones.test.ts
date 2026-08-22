import { describe, expect, it } from 'vitest'
import { defaultSettings, machineTiers, milestones, recipeTiers, recipes } from './gameData'
import { solvePlan } from './solver'

/** A milestone's cost is a total; the planner works in rates. One hour is arbitrary. */
const targetsFor = (cost: { item: string; amount: number }[]) =>
  cost.map((c) => ({ item: c.item, ratePerMin: c.amount / 60 }))

describe('milestones', () => {
  it('covers every tier of the game', () => {
    const tiers = new Set(milestones.map((m) => m.tier))
    expect([...tiers].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
  })

  /**
   * Only milestones carry a meaningful tier. Every schematic has an `mTechTier`
   * field, but MAM research reports 3 for all hundred of its nodes and the
   * AWESOME shop reports 1 — trusting those put a Blender recipe in Tier 0 and
   * made the limit meaningless, so this pins the machines to the tiers the game
   * actually gates them behind.
   */
  it('places each machine at the tier the game unlocks it', () => {
    expect(machineTiers['Build_SmelterMk1_C']).toBe(0)
    expect(machineTiers['Build_ConstructorMk1_C']).toBe(0)
    // HUB Upgrade 3 hands you Reinforced Iron Plate, so the Assembler is Tier 0.
    expect(machineTiers['Build_AssemblerMk1_C']).toBe(0)
    expect(machineTiers['Build_FoundryMk1_C']).toBe(3)
    expect(machineTiers['Build_OilRefinery_C']).toBe(5)
    expect(machineTiers['Build_ManufacturerMk1_C']).toBe(6)
    expect(machineTiers['Build_Blender_C']).toBe(7)
    expect(machineTiers['Build_HadronCollider_C']).toBe(8)
    expect(machineTiers['Build_QuantumEncoder_C']).toBe(9)
  })

  /**
   * The point of the tier limit. Without it a plan for an early milestone will
   * route through a machine you don't have yet, which is worse than no plan:
   * you would build it and only then find out.
   */
  it('plans every milestone using only machines that exist by then', () => {
    const failures: string[] = []

    for (const m of milestones) {
      if (!m.cost.length) continue
      const plan = solvePlan(targetsFor(m.cost), { ...defaultSettings(), maxTier: m.tier })

      if (plan.errors.length) {
        failures.push(`T${m.tier} ${m.name}: ${plan.errors[0]}`)
        continue
      }
      for (const step of plan.steps) {
        const machine = machineTiers[step.recipe.machine]
        if (machine !== undefined && machine > m.tier) {
          failures.push(`T${m.tier} ${m.name}: ${step.recipe.name} needs a tier-${machine} machine`)
        }
        // A recipe the HUB grants must not arrive later than the milestone.
        // One with no entry comes from research instead, which the plan warns
        // about rather than forbids.
        const tier = recipeTiers[step.recipe.key]
        if (tier !== undefined && tier > m.tier) {
          failures.push(`T${m.tier} ${m.name}: ${step.recipe.name} is a tier-${tier} unlock`)
        }
      }
    }

    expect(failures).toEqual([])
  })

  it('warns when a limited plan depends on research rather than the HUB', () => {
    const steel = milestones.find((m) => m.name === 'Basic Steel Production')!
    const plan = solvePlan(targetsFor(steel.cost), { ...defaultSettings(), maxTier: steel.tier })

    const usesResearch = plan.steps.some(
      (s) => s.recipe.isAlternate || recipeTiers[s.recipe.key] === undefined
    )
    const warned = plan.warnings.some((w) => w.includes("the HUB doesn't hand you"))
    expect(warned).toBe(usesResearch)
  })

  it('leaves the plan unrestricted when no tier is set', () => {
    const late = Object.values(recipes).find((r) => machineTiers[r.machine] === 9)!
    const open = { ...defaultSettings(), maxTier: null }
    const early = { ...defaultSettings(), maxTier: 2 }

    const product = late.products[0].item
    const target = [{ item: product, ratePerMin: 1 }]

    // Unreachable output isn't an error — the solver falls back to importing it
    // — so the difference shows in whether the machine is ever used.
    const usesLateMachine = (s: ReturnType<typeof solvePlan>) =>
      s.steps.some((step) => machineTiers[step.recipe.machine] === 9)

    expect(usesLateMachine(solvePlan(target, open))).toBe(true)
    expect(usesLateMachine(solvePlan(target, early))).toBe(false)
  })
})
