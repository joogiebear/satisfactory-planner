/**
 * Working out how to power a factory.
 *
 * The planner knows a build draws 989 MW and stops there, which is half an
 * answer: the generators burn fuel, and unless the fuel is coal straight out of
 * the ground, making it takes its own factory — which draws power of its own.
 *
 * So this is a fixed point, not a division. Fourteen Fuel generators want 280
 * Fuel a minute; the refineries and extractors making that draw perhaps 150 MW;
 * covering *that* wants another generator, which wants more fuel. It converges
 * quickly when a fuel yields far more energy than it costs to make, which every
 * real fuel in the game does — and when one doesn't, that is the answer and it
 * gets reported rather than iterated forever.
 */

import { generators, items, recipesByProduct } from './gameData'
import { solvePlan } from './solver'
import type {
  GameGenerator, GameItem, GeneratorFuel, Plan, PlanTarget, PlannerSettings,
} from './types'

/** One way to make the power: a generator burning one of its fuels. */
export interface PowerOption {
  key: string
  generator: GameGenerator
  fuel: GeneratorFuel
  fuelItem: GameItem
  /** Fractional; ceil() for what you actually build. */
  units: number
  outputMW: number
  fuelPerMin: number
  supplementalItem: GameItem | null
  supplementalPerMin: number
  byproductItem: GameItem | null
  byproductPerMin: number
  /** What the fuel supply costs to run, and the plan that produces it. */
  overheadMW: number
  fuelPlan: Plan | null
  /**
   * Fuel-chain inputs nothing available can make, so the plan buys them in.
   *
   * Without this an unmakeable fuel looks like the best option on the board:
   * no recipe means no machines, no machines means no overhead, and Turbofuel
   * reads as four generators and nothing else to build. These are the reason
   * that number is a fiction.
   */
  imported: GameItem[]
  /**
   * Why this isn't something you could go and build, if it isn't.
   *
   * `gathered` — the chain bottoms out in something the game gives no recipe
   * for, like leaves or hog remains. The rate is real; nobody is automating it.
   * `locked` — it bottoms out in something that *does* have recipes, none of
   * them available under the current settings: a tier limit, a ban, an
   * alternate you haven't ticked. Worth separating, because a plan blocked by
   * your own settings is one you can unblock, and calling a refinery product
   * "gathered by hand" sends you looking in the wrong place entirely.
   * `runaway` — the fuel costs more power to make than it yields, so no number
   * of generators ever covers the demand. Nothing in the base game does this,
   * but a banned recipe or a tier limit can force a route that does.
   *
   * Any of them has to be said out loud, because a plan that fails produces no
   * machines, no machines means no overhead, and the option then reads as the
   * cheapest on the board when it is not an option at all.
   */
  blocker: 'gathered' | 'locked' | 'runaway' | null
}

/** Worst first, so a sort can rank on it. */
const BLOCKER_RANK: Record<string, number> = { runaway: 3, locked: 2, gathered: 1 }

/** Iterations before a fixed point is called a runaway. Real fuels take 3–4. */
const MAX_PASSES = 24

/** Within 0.01 MW the answer has stopped moving in any way a player would see. */
export const SETTLED_MW = 0.01

/**
 * Every way to cover a power demand, best first.
 *
 * `demandMW` is what the factory draws. The fuel supply's own draw is added on
 * top, so a returned option's generators cover both.
 */
export function planPower(demandMW: number, settings: PlannerSettings): PowerOption[] {
  if (!(demandMW > 0)) return []

  const options: PowerOption[] = []
  for (const generator of generators) {
    for (const fuel of generator.fuels) {
      const option = solveOne(generator, fuel, demandMW, settings)
      if (option) options.push(option)
    }
  }

  // Smallest plant that does the job, then fewest buildings, then least
  // overhead.
  //
  // This used to lead on the building count alone, which reads well in a list
  // and badly as an answer: a 135 MW factory came back as one Nuclear Power
  // Plant, because a single 2.5 GW reactor is fewer buildings than two coal
  // generators and the 95% of it left idle cost nothing to say. Ranking on what
  // you have to install instead puts the two coal generators first, and still
  // prefers the reactor once there is a factory big enough to load it.
  options.sort((a, b) => {
    // Anything blocked sorts below anything buildable, however small it
    // would have been.
    const blocked = (BLOCKER_RANK[a.blocker ?? ''] ?? 0) - (BLOCKER_RANK[b.blocker ?? ''] ?? 0)
    if (blocked !== 0) return blocked
    const installed = installedMW(a) - installedMW(b)
    if (Math.abs(installed) > 1e-6) return installed
    const units = Math.ceil(a.units - 1e-9) - Math.ceil(b.units - 1e-9)
    return units !== 0 ? units : a.overheadMW - b.overheadMW
  })
  return options
}

/** What you actually have to build: whole generators at their full rating. */
function installedMW(option: PowerOption): number {
  return Math.ceil(option.units - 1e-9) * option.generator.powerMW
}

function solveOne(
  generator: GameGenerator,
  fuel: GeneratorFuel,
  demandMW: number,
  settings: PlannerSettings
): PowerOption | null {
  const fuelItem = items[fuel.item]
  if (!fuelItem || !(generator.powerMW > 0) || !(fuel.ratePerMin > 0)) return null

  // The supplemental is a target in its own right — water is not free, and a
  // nuclear plant's 240 m³/min is two extractors and 40 MW that have to come
  // from somewhere.
  const supply = (count: number): PlanTarget[] => {
    const targets: PlanTarget[] = [{ item: fuel.item, ratePerMin: count * fuel.ratePerMin }]
    if (fuel.supplemental && fuel.supplementalPerMin > 0) {
      targets.push({ item: fuel.supplemental, ratePerMin: count * fuel.supplementalPerMin })
    }
    return targets
  }

  let overheadMW = 0
  let units = 0
  let fuelPlan: Plan | null = null
  let runaway = true

  for (let pass = 0; pass < MAX_PASSES; pass++) {
    units = (demandMW + overheadMW) / generator.powerMW
    fuelPlan = solvePlan(supply(units), settings)
    const next = fuelPlan.totals.totalPowerMW

    if (Math.abs(next - overheadMW) < SETTLED_MW) {
      overheadMW = next
      runaway = false
      break
    }
    overheadMW = next
  }

  // Size the plant against the overhead actually being reported, and build the
  // fuel supply for that size. Without this last pass the count still reflects
  // the pass before it settled, and the plant is a hair short of its own load.
  units = (demandMW + overheadMW) / generator.powerMW
  if (!runaway) fuelPlan = solvePlan(supply(units), settings)

  // A raw requirement with no extractor behind it is something the plan had to
  // assume rather than produce — the ores and fluids that come out of the
  // ground all carry one. A plan that failed outright names nothing at all, so
  // the fuel itself is what is missing.
  const imported = (fuelPlan?.raw ?? [])
    .filter((r) => !r.extractor && r.ratePerMin > 1e-6)
    .map((r) => r.item)
  if ((fuelPlan?.errors.length ?? 0) > 0 && !imported.some((i) => i.key === fuelItem.key)) {
    imported.push(fuelItem)
  }

  // Something with no recipe anywhere is gathered; something with recipes that
  // are merely unavailable is locked behind a setting you can change.
  const locked = imported.some((i) => (recipesByProduct[i.key]?.length ?? 0) > 0)

  return {
    key: `${generator.key}:${fuel.item}`,
    generator,
    fuel,
    fuelItem,
    units,
    outputMW: units * generator.powerMW,
    fuelPerMin: units * fuel.ratePerMin,
    supplementalItem: fuel.supplemental ? items[fuel.supplemental] ?? null : null,
    supplementalPerMin: units * fuel.supplementalPerMin,
    byproductItem: fuel.byproduct ? items[fuel.byproduct] ?? null : null,
    byproductPerMin: units * fuel.byproductPerMin,
    overheadMW,
    fuelPlan,
    imported,
    blocker: runaway ? 'runaway' : locked ? 'locked' : imported.length ? 'gathered' : null,
  }
}

/** The targets that build one option's fuel supply, for handing to the planner. */
export function fuelTargets(option: PowerOption): PlanTarget[] {
  const targets: PlanTarget[] = [
    { item: option.fuel.item, ratePerMin: round(option.fuelPerMin) },
  ]
  if (option.supplementalItem && option.supplementalPerMin > 0) {
    targets.push({ item: option.supplementalItem.key, ratePerMin: round(option.supplementalPerMin) })
  }
  return targets
}

/** Four decimals, as the game shows rates. */
function round(value: number): number {
  return Math.round(value * 10000) / 10000
}
