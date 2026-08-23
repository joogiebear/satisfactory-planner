import { describe, expect, it } from 'vitest'
import { alternateRecipes, defaultSettings, generators } from './gameData'
import { bestFrom, supplyOf, type Available } from './fromResources'
import { generatorCost, generatorOptions } from './selfPowered'

const mk3 = () => ({
  ...defaultSettings(),
  unlockedAlternates: alternateRecipes.map((r) => r.key),
  extraction: { ...defaultSettings().extraction, minerKey: 'Build_MinerMk3_C' },
})

/** One Mk.3 miner each on a normal iron node and a normal coal node. */
const ironAndCoal: Available[] = [
  { item: 'Desc_OreIron_C', nodes: 1, purity: 'normal' },
  { item: 'Desc_Coal_C', nodes: 1, purity: 'normal' },
]

const coalGen = (s = mk3()) => {
  const gen = generators.find((g) => g.key === 'Build_GeneratorCoal_C')!
  const fuel = gen.fuels.find((f) => f.item === 'Desc_Coal_C')!
  return generatorCost(gen, fuel, s)!
}

describe('a build that powers itself', () => {
  it('costs a generator burning something you dig up at face value', () => {
    const cost = coalGen()
    // 15 coal and 45 water a minute, and no machines in between.
    expect(cost.draws.get('Desc_Coal_C')).toBeCloseTo(15, 4)
    expect(cost.draws.get('Desc_Water_C')).toBeCloseTo(45, 4)
    expect(cost.ownDrawMW).toBe(0)
    expect(cost.netMW).toBeCloseTo(75, 4)
  })

  /**
   * A fuel generator burns something a refinery makes, and that refinery draws
   * power the generator has to cover before it has covered anything else.
   */
  it('charges a generator for the factory feeding it', () => {
    const gen = generators.find((g) => g.key === 'Build_GeneratorFuel_C')!
    const fuel = gen.fuels.find((f) => f.item === 'Desc_LiquidFuel_C')!
    const cost = generatorCost(gen, fuel, mk3())!
    expect(cost.ownDrawMW).toBeGreaterThan(0)
    expect(cost.netMW).toBeLessThan(gen.powerMW)
    // Fuel comes from oil, so that is what a generator on it really spends.
    expect(cost.draws.has('Desc_LiquidOil_C')).toBe(true)
  })

  it('only offers generators that make more than they cost', () => {
    for (const g of generatorOptions(mk3())) expect(g.netMW).toBeGreaterThan(0)
  })

  /** The whole point: nothing plugged in from elsewhere, nothing overdrawn. */
  it('balances power and resources at once', () => {
    const settings = mk3()
    const supply = supplyOf(ironAndCoal, settings)
    const built = bestFrom(ironAndCoal, settings, coalGen(settings))
    expect(built.length).toBeGreaterThan(5)

    for (const c of built.slice(0, 10)) {
      const plant = c.plant!
      expect(plant).not.toBeNull()

      // The generators cover the whole load, themselves included.
      expect(plant.generators * 75).toBeGreaterThanOrEqual(plant.drawMW * (1 - 1e-6))

      // Fuel and coolant come out of the same pile as the factory's.
      for (const d of c.draws) {
        expect(d.ratePerMin).toBeLessThanOrEqual((supply.get(d.item.key) ?? 0) * (1 + 1e-6))
      }

      // And something is spent to the last item, or it isn't the biggest build.
      expect(Math.max(...c.draws.map((d) => d.fraction))).toBeCloseTo(1, 3)
    }
  })

  /** Generators burning your coal are coal the factory doesn't get. */
  it('makes less than the same nodes would on someone else\u2019s grid', () => {
    const settings = mk3()
    const grid = bestFrom(ironAndCoal, settings)
    const own = bestFrom(ironAndCoal, settings, coalGen(settings))
    const frame = (list: typeof grid) => list.find((c) => c.item.key === 'Desc_ModularFrame_C')

    expect(frame(own)!.ratePerMin).toBeLessThan(frame(grid)!.ratePerMin)
    expect(frame(own)!.plant!.generators).toBeGreaterThan(0)
    expect(frame(grid)!.plant).toBeNull()
  })

  /** A miner you placed costs its rating whether or not you use all of it. */
  it('charges for the miners you said you have', () => {
    const settings = mk3()
    const one = bestFrom(ironAndCoal, settings, coalGen(settings))
    const spare: Available[] = [...ironAndCoal, { item: 'Desc_OreIron_C', nodes: 1, purity: 'normal' }]
    const two = bestFrom(spare, settings, coalGen(settings))

    const rod = (list: typeof one) => list.find((c) => c.item.key === 'Desc_IronRod_C')!
    // Iron Rod is limited by coal, so a second iron miner adds nothing but its
    // own 45 MW — which the generators have to cover out of that same coal.
    expect(rod(two).ratePerMin).toBeLessThan(rod(one).ratePerMin)
  })
})
