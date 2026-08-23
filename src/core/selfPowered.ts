/**
 * Sizing a build that runs on its own resources, generators included.
 *
 * Everywhere else the planner treats power as somebody else's problem: it adds
 * up the draw and reports it. That is fine when you are extending a base that
 * already has a grid, and useless when the question is "one iron node, one coal
 * node, what can I actually run out here" — because the answer depends on how
 * much of the coal never reaches the factory at all. Generators eat the same
 * pile as the smelters, so a build that ignores them is not sized, it is
 * optimistic.
 *
 * The loop closes because everything in it is linear in the size of the build.
 * One solve at a rate of one a minute gives the resources and the machine draw
 * per unit; one solve of the fuel gives what a single generator costs to feed.
 * From there the balance is arithmetic rather than search, and the whole thing
 * costs two solves per candidate instead of the forty a bisection would take.
 */

import { generators, items } from './gameData'
import { solvePlan } from './solver'
import type { GameGenerator, GeneratorFuel, Plan, PlannerSettings } from './types'

/** What it takes to run one generator: resources per minute, and machine draw. */
export interface GeneratorCost {
  generator: GameGenerator
  fuel: GeneratorFuel
  /** Raw per minute, per generator, fuel and coolant together. */
  draws: Map<string, number>
  /**
   * What the machines making this generator's fuel draw, per generator.
   * Zero when the fuel comes straight out of the ground.
   */
  ownDrawMW: number
  /** Net output after feeding itself. Non-positive means it can never pay. */
  netMW: number
}

/** Machines you place because you decided to, not because a rate implied them. */
export interface FixedPlant {
  /** Extractors you declared: they draw their full rating whether or not you use it. */
  extractorMW: number
  /** Megawatts each water pump costs, for sizing the ones the generators need. */
  pumpMW: number
  pumpRatePerMin: number
}

export interface Balance {
  /** The largest build that closes on itself. */
  scale: number
  /** Fractional; ceil for what you build. */
  generators: number
  /** Water pumps the generators need on top of the ones feeding the factory. */
  pumps: number
  /** Everything drawing power: factory, declared extractors, fuel plant, pumps. */
  drawMW: number
  /** Total draw on each resource, generators included. */
  used: Map<string, number>
  /** What runs out. */
  limitedBy: string | null
}

const WATER = 'Desc_Water_C'

/**
 * What one generator costs to run, fuel chain and all.
 *
 * A coal generator burns something you dig up and the answer is one line. A
 * fuel generator burns something a refinery makes, and that refinery draws
 * power the generator has to cover before it has covered anything else — so
 * its real output is what is left after it has fed itself.
 */
export function generatorCost(
  generator: GameGenerator, fuel: GeneratorFuel, settings: PlannerSettings,
): GeneratorCost | null {
  const draws = new Map<string, number>()
  let ownDrawMW = 0

  for (const [key, rate] of [
    [fuel.item, fuel.ratePerMin] as const,
    [fuel.supplemental, fuel.supplementalPerMin] as const,
  ]) {
    if (!key || !(rate > 0)) continue
    const item = items[key]
    if (!item) return null

    if (item.isRaw) {
      draws.set(key, (draws.get(key) ?? 0) + rate)
      continue
    }
    const made = solvePlan([{ item: key, ratePerMin: rate }], settings)
    if (made.errors.length || !made.steps.length) return null
    for (const raw of made.raw) draws.set(raw.item.key, (draws.get(raw.item.key) ?? 0) + raw.ratePerMin)
    ownDrawMW += made.totals.machinePowerMW
  }

  return { generator, fuel, draws, ownDrawMW, netMW: generator.powerMW - ownDrawMW }
}

/** Every generator and fuel worth offering, best net output first. */
export function generatorOptions(settings: PlannerSettings): GeneratorCost[] {
  const out: GeneratorCost[] = []
  for (const generator of generators) {
    for (const fuel of generator.fuels) {
      const cost = generatorCost(generator, fuel, settings)
      if (cost && cost.netMW > 0) out.push(cost)
    }
  }
  out.sort((a, b) => b.netMW - a.netMW || a.generator.name.localeCompare(b.generator.name))
  return out
}

/**
 * The biggest self-powered build of one item, from a fixed pile of resources.
 *
 * `unit` is the plan for one a minute — its raw draw and machine power both
 * scale with the build, which is what lets this be solved rather than searched.
 *
 * Water is the awkward one. A generator wants coolant and a pump costs 20 MW to
 * supply it, so the pumps are part of the load they exist to serve. That is
 * settled by going round a few times: pumps are small next to everything else,
 * so the count stops moving almost immediately.
 */
export function balance(
  unit: Plan, supply: Map<string, number>, gen: GeneratorCost, fixed: FixedPlant,
): Balance | null {
  if (gen.netMW <= 0) return null

  const perUnit = new Map<string, number>()
  for (const raw of unit.raw) perUnit.set(raw.item.key, raw.ratePerMin)
  const machineMW = unit.totals.machinePowerMW

  // Anything the build or its generators need that isn't on the list.
  for (const key of [...perUnit.keys(), ...gen.draws.keys()]) {
    if (key !== WATER && !supply.has(key)) return null
  }

  let pumps = 0
  let scale = 0
  let generatorCount = 0
  let limitedBy: string | null = null

  for (let pass = 0; pass < 4; pass++) {
    const fixedMW = fixed.extractorMW + pumps * fixed.pumpMW

    // g = (machineMW * s + fixedMW) / netMW, so every resource gives a bound on
    // s once the generators' share of it is written in terms of s.
    let best = Infinity
    let binding: string | null = null
    for (const [key, have] of supply) {
      const perGen = gen.draws.get(key) ?? 0
      const direct = perUnit.get(key) ?? 0
      if (direct <= 0 && perGen <= 0) continue

      const slope = direct + (perGen * machineMW) / gen.netMW
      const offset = (perGen * fixedMW) / gen.netMW
      // Generators alone already outrun this resource.
      if (offset >= have) return null
      const bound = slope > 1e-12 ? (have - offset) / slope : Infinity
      if (bound < best) { best = bound; binding = key }
    }
    if (!isFinite(best) || best <= 0) return null

    scale = best
    limitedBy = binding
    generatorCount = (machineMW * scale + fixedMW) / gen.netMW

    const water = (perUnit.get(WATER) ?? 0) * scale + (gen.draws.get(WATER) ?? 0) * generatorCount
    const needed = Math.ceil(water / fixed.pumpRatePerMin - 1e-9)
    if (needed === pumps) break
    pumps = needed
  }

  const used = new Map<string, number>()
  for (const [key, rate] of perUnit) used.set(key, rate * scale)
  for (const [key, rate] of gen.draws) used.set(key, (used.get(key) ?? 0) + rate * generatorCount)

  return {
    scale,
    generators: generatorCount,
    pumps,
    drawMW: machineMW * scale + fixed.extractorMW + pumps * fixed.pumpMW
      + gen.ownDrawMW * generatorCount,
    used,
    limitedBy,
  }
}
