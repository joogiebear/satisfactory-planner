import { describe, expect, it } from 'vitest'
import { defaultSettings } from './gameData'
import { planPower, SETTLED_MW } from './power'

const settings = () => ({ ...defaultSettings(), unlockedAlternates: [] })

describe('planPower', () => {
  /**
   * A coal generator burns 15 coal a minute for 75 MW, and coal comes out of
   * the ground — so the only overhead is the miners, and the arithmetic is
   * checkable by hand.
   */
  it('sizes a coal plant the way the game does', () => {
    const coal = planPower(750, settings()).find((o) => o.key === 'Build_GeneratorCoal_C:Desc_Coal_C')!
    expect(coal).toBeDefined()

    // 750 MW needs 10 generators before overhead, each wanting 15 coal and
    // 45 m³ of water a minute.
    expect(coal.units).toBeGreaterThanOrEqual(10)
    expect(coal.fuelPerMin / coal.units).toBeCloseTo(15, 6)
    expect(coal.supplementalPerMin / coal.units).toBeCloseTo(45, 6)
    expect(coal.supplementalItem?.name).toBe('Water')
    expect(coal.outputMW).toBeGreaterThanOrEqual(750 + coal.overheadMW - SETTLED_MW)
    expect(coal.blocker).toBe(null)
  })

  it('covers the fuel supply out of its own output, not just the factory', () => {
    for (const o of planPower(1000, settings())) {
      if (o.blocker) continue
      // Every option's generators produce the factory's demand *and* whatever
      // the fuel supply draws. Getting this wrong is the whole trap: divide
      // 1000 by the generator rating and the plant browns out under its own
      // mining and refining load.
      expect(o.outputMW).toBeGreaterThanOrEqual(1000 + o.overheadMW - SETTLED_MW)
      expect(o.overheadMW).toBeGreaterThan(0)
    }
  })

  it('reports the nuclear byproduct rather than quietly dropping it', () => {
    const rods = planPower(5000, settings())
      .find((o) => o.key === 'Build_GeneratorNuclear_C:Desc_NuclearFuelRod_C')
    expect(rods?.byproductItem?.name).toBe('Uranium Waste')
    expect(rods!.byproductPerMin).toBeGreaterThan(0)
  })

  it('finds a workable option for a real factory load', () => {
    const options = planPower(989.5, settings())
    expect(options.length).toBeGreaterThan(0)
    expect(options.some((o) => o.blocker === null)).toBe(true)
    // Best-first: the head of the list is never a runaway when one works.
    expect(options[0].blocker).toBe(null)
  })

  it('returns nothing for a factory that draws nothing', () => {
    expect(planPower(0, settings())).toEqual([])
  })

  /**
   * The failure this exists to prevent. A plan that can't be solved returns no
   * steps, so it also returns no power draw — and an unmakeable fuel then reads
   * as the cheapest option on the board, four generators and nothing to build.
   */
  it('does not let an unmakeable fuel pass as a free one', () => {
    // Turbofuel is an alternate, so with none unlocked nothing produces it.
    const turbo = planPower(1000, settings())
      .find((o) => o.fuelItem.name === 'Turbofuel')!
    expect(turbo.blocker).toBe('locked')
    expect(turbo.overheadMW).toBe(0)

    // And it never outranks something you could actually build.
    const options = planPower(1000, settings())
    const firstBlocked = options.findIndex((o) => o.blocker !== null)
    const lastClear = options.map((o) => o.blocker).lastIndexOf(null)
    expect(lastClear).toBeLessThan(firstBlocked)
  })

  it('separates fuel you gather by hand from fuel you cannot make', () => {
    const options = planPower(1000, settings())
    const leaves = options.find((o) => o.fuelItem.name === 'Leaves')!
    expect(leaves.blocker).toBe('gathered')
    expect(leaves.imported.map((i) => i.name)).toContain('Leaves')
  })
})
