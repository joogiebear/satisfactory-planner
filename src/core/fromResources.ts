/**
 * The planner run backwards: you say what you have, it says what to make.
 *
 * The normal direction is "I want Heavy Modular Frames, what does that need".
 * Standing over a fresh patch of map the question is the other way round — here
 * is a pure iron node, a coal node and some oil, what is worth building? That
 * is the same solver used differently: cost each candidate at one a minute, see
 * which of your resources runs out first, and scale until it does.
 *
 * The recipe mix a plan settles on doesn't change with the size of the plan, so
 * one cheap solve at a rate of one a minute is enough to find how much of each
 * resource a candidate draws, and from that how far it can be scaled. The
 * totals, though, are not linear — machines are whole buildings and their power
 * follows the clock of the last, part-loaded one — so the candidate is solved
 * again at its real size before anything is reported. Multiplying the small
 * plan's totals instead reads back one machine per step however big it gets.
 *
 * Scarcity here is not the map-wide kind the rest of the planner uses. Iron is
 * the commonest ore on the map, but if the only iron you have is one node
 * beside four coal ones then iron is the expensive thing, and the solver has to
 * be told so or it will spend the resource that runs out to save one you have
 * plenty of.
 */

import { extractors, items, rawResources, recipesByProduct } from './gameData'
import { balance, type Balance, type FixedPlant, type GeneratorCost } from './selfPowered'
import { buildRawRequirement, solvePlan } from './solver'
import type { GameItem, Plan, PlannerSettings, Purity } from './types'

/** A resource you have, and how much of it. */
export interface Available {
  item: string
  nodes: number
  purity: Purity
}

/** What one resource contributes, and how hard this candidate leans on it. */
export interface Draw {
  item: GameItem
  ratePerMin: number
  /** 0–1 of what you have. The one at 1 is what runs out. */
  fraction: number
}

/** The generators a self-powered build needs, and what they cost it. */
export interface Plant {
  generators: number
  pumps: number
  drawMW: number
}

export interface Candidate {
  item: GameItem
  ratePerMin: number
  sinkPointsPerMin: number
  machines: number
  powerMW: number
  /** The resource that runs out first — the reason it stops here. */
  limitedBy: GameItem | null
  draws: Draw[]
  /**
   * Set when the build powers itself: the generators it runs on, the pumps
   * cooling them, and the load they between them carry. Null when power is
   * somebody else's problem.
   */
  plant: Plant | null
  /**
   * True when the objective you picked found a route holding the same output,
   * so the machine and power figures are its doing rather than the fallback's.
   */
  tuned: boolean
}

/**
 * Water is placed on a shoreline rather than mined, so it never limits
 * anything. It still shows in a plan's inputs; it just isn't a constraint.
 */
const UNLIMITED = new Set(['Desc_Water_C'])

/**
 * How much dearer the scarcest thing you have may be priced than the most
 * plentiful. Uncapped, a resource you have a trickle of would dominate every
 * cost and the solver would chase rounding noise instead of routes.
 */
const MAX_SCARCITY = 20

/** What a resource you haven't got costs: far above anything you have. */
const OUT_OF_REACH = 500

/** Items per minute each entry supplies, at the current miner and clock. */
export function supplyOf(available: Available[], settings: PlannerSettings): Map<string, number> {
  const supply = new Map<string, number>()
  for (const entry of available) {
    const item = items[entry.item]
    if (!item || !(entry.nodes > 0)) continue

    // Ask the solver what one extractor delivers, so the miner mark, the clock
    // and the purity rules stay in one place.
    const probe = buildRawRequirement(item, 0, {
      ...settings,
      extraction: { ...settings.extraction, purity: { ...settings.extraction.purity, [entry.item]: entry.purity } },
    })
    if (!probe.extractor) continue
    supply.set(entry.item, (supply.get(entry.item) ?? 0) + probe.ratePerExtractor * entry.nodes)
  }
  return supply
}

/**
 * The draw of the machines you said you have.
 *
 * A miner you placed costs its full rating whether or not the factory takes
 * everything it lifts, which is the difference between planning a build and
 * planning a rate: elsewhere the extractor count falls out of the demand, and
 * here you declared it. Getting this wrong understates the load by more than a
 * Mk.3 miner's 45 MW is comfortable.
 */
export function fixedPlantOf(available: Available[], settings: PlannerSettings): FixedPlant {
  const pump = extractors.find((e) => e.key === 'Build_WaterPump_C')
  let extractorMW = 0
  for (const entry of available) {
    const item = items[entry.item]
    if (!item || !(entry.nodes > 0)) continue
    const probe = buildRawRequirement(item, 0, settings)
    if (!probe.extractor) continue
    const clock = probe.extractor.key === 'Build_WaterPump_C'
      ? settings.extraction.waterExtractorClock
      : settings.extraction.clockByResource?.[entry.item] ?? settings.extraction.minerClock
    extractorMW += entry.nodes * probe.extractor.powerMW * Math.pow(clock, probe.extractor.powerExponent)
  }
  return {
    extractorMW,
    pumpMW: pump?.powerMW ?? 20,
    pumpRatePerMin: pump?.baseRatePerMin ?? 120,
  }
}

/**
 * The planner, re-costed around what you actually have.
 *
 * Each resource is priced against the most plentiful thing on your list, so a
 * route spending four of something you have a trickle of to save one of
 * something you have lots of reads as the bad trade it is. Anything not on the
 * list is priced out of reach rather than removed: a candidate with no way
 * round it still solves, and is dropped afterwards on what it ended up drawing,
 * so "you can't make this here" comes from the routes rather than a guess.
 */
export function scarcitySettings(
  supply: Map<string, number>, settings: PlannerSettings,
): PlannerSettings {
  const most = Math.max(...supply.values(), 0)
  const weights: Record<string, number> = {}
  for (const res of rawResources) {
    if (UNLIMITED.has(res.key)) { weights[res.key] = 0; continue }
    const have = supply.get(res.key) ?? 0
    weights[res.key] = have > 0 ? Math.min(MAX_SCARCITY, most / have) : OUT_OF_REACH
  }
  return { ...settings, resourceWeights: weights }
}

/** Whether a plan lives within the nodes you have. */
function fits(plan: Plan, supply: Map<string, number>): boolean {
  return plan.raw.every((r) =>
    UNLIMITED.has(r.item.key) || r.ratePerMin <= (supply.get(r.item.key) ?? 0) * (1 + 1e-6))
}

/**
 * Re-price on what a route actually spent rather than on what you have.
 *
 * Pricing by supply alone assumes a build will draw on everything in
 * proportion, and most don't: a route can run the coal dry while barely
 * touching the copper, and stop there. Charging for the coal at what it turned
 * out to be worth — and letting the untouched copper go cheap — pushes the next
 * solve towards the route that spreads the load, which is the one that makes
 * the most.
 */
function repriceOn(used: Map<string, number>, supply: Map<string, number>): Record<string, number> {
  const touched = [...used.values()].filter((v) => v > 1e-9)
  const least = Math.min(...touched, 1)
  const weights: Record<string, number> = {}
  for (const res of rawResources) {
    if (UNLIMITED.has(res.key)) { weights[res.key] = 0; continue }
    if (!supply.has(res.key)) { weights[res.key] = OUT_OF_REACH; continue }
    // Floored rather than free: a resource this route ignores should be
    // tempting, but costing nothing at all makes the solve degenerate.
    weights[res.key] = Math.min(MAX_SCARCITY, Math.max(0.05, (used.get(res.key) ?? 0) / least))
  }
  return weights
}

/**
 * Repricing converges in two or three rounds; the fourth is there to catch the
 * ones that take a step sideways before they improve.
 */
const REPRICE_PASSES = 4

interface Sized {
  scale: number
  limitedBy: string | null
  /** Fraction of each resource spent, which is what the next pricing round reads. */
  used: Map<string, number>
  plant: Plant | null
}

interface Biggest extends Sized {
  /** The prices that found this route, so the full-size solve repeats it. */
  weights: Record<string, number>
}

/** How far a unit plan stretches on resources alone. */
function stretch(unit: Plan, supply: Map<string, number>): Sized | null {
  let scale = Infinity
  let limitedBy: string | null = null
  for (const raw of unit.raw) {
    if (UNLIMITED.has(raw.item.key) || !(raw.ratePerMin > 0)) continue
    const room = (supply.get(raw.item.key) ?? 0) / raw.ratePerMin
    if (room < scale) { scale = room; limitedBy = raw.item.key }
  }
  if (!isFinite(scale) || scale <= 0) return null
  const used = new Map<string, number>()
  for (const raw of unit.raw) {
    if (!UNLIMITED.has(raw.item.key)) used.set(raw.item.key, raw.ratePerMin * scale)
  }
  return { scale, limitedBy, used, plant: null }
}

/** The same, with the generators drawing on the pile too. */
function stretchPowered(
  unit: Plan, supply: Map<string, number>, gen: GeneratorCost, fixed: FixedPlant,
): Sized | null {
  const b: Balance | null = balance(unit, supply, gen, fixed)
  if (!b) return null
  return {
    scale: b.scale,
    limitedBy: b.limitedBy,
    used: b.used,
    plant: { generators: b.generators, pumps: b.pumps, drawMW: b.drawMW },
  }
}

/**
 * The most of one item those nodes can make.
 *
 * Sizing on the cheap unit solve and then repricing on the result is a good
 * deal better than pricing by supply alone — on a lopsided survey it finds
 * getting on for twice the steel pipe, because the first pricing had no way to
 * know the route would run the coal dry and leave the copper alone.
 */
function maximise(
  itemKey: string,
  supply: Map<string, number>,
  base: PlannerSettings,
  size: (unit: Plan) => Sized | null,
): Biggest | null {
  let weights = base.resourceWeights
  let best: Biggest | null = null

  for (let pass = 0; pass < REPRICE_PASSES; pass++) {
    const unit = solvePlan([{ item: itemKey, ratePerMin: 1 }], { ...base, resourceWeights: weights })
    if (unit.errors.length || !unit.steps.length) break

    // Anything still reaching for a resource you haven't got, after being
    // charged the earth for it, has no route that avoids it.
    if (unit.raw.some((r) => !supply.has(r.item.key) && !UNLIMITED.has(r.item.key))) break

    const sized = size(unit)
    if (!sized) break

    if (!best || sized.scale > best.scale) best = { ...sized, weights }

    // Repricing reads the whole draw, generators included — which is the point
    // when they are burning the same coal the factory wants.
    const fractions = new Map<string, number>()
    for (const [key, rate] of sized.used) fractions.set(key, rate / (supply.get(key) || 1))
    const next = repriceOn(fractions, supply)
    if (rawResources.every((r) => Math.abs(next[r.key] - weights[r.key]) < 1e-9)) break
    weights = next
  }

  return best
}

/**
 * Everything those resources could make, best first.
 *
 * Output comes first and the objective breaks ties. Asked for the fewest
 * buildings, the planner will happily take a route making a fifth as much from
 * the same nodes — the right answer to "build this rate cheaply" and the wrong
 * one to "what do these nodes make". So the size of each build is settled on
 * resources alone, and the objective is then given its chance to find a leaner
 * or cooler-running way to reach that same size. If it can't, the
 * resource-first route stands.
 */
export function bestFrom(
  available: Available[], settings: PlannerSettings, generator: GeneratorCost | null = null,
): Candidate[] {
  const supply = supplyOf(available, settings)
  if (supply.size === 0) return []

  // With generators in the build the pile has a second claimant, and the size
  // of the factory is what is left once they have taken their cut.
  const fixed = generator ? fixedPlantOf(available, settings) : null
  const size = generator && fixed
    ? (unit: Plan) => stretchPowered(unit, supply, generator, fixed)
    : (unit: Plan) => stretch(unit, supply)

  // Sizing runs on resources alone: whatever you are optimising for, wasting a
  // node is never the most of something you can make.
  const sizing = { ...scarcitySettings(supply, settings), objective: 'raw' as const }
  const tuning = settings.objective === 'raw' ? null : scarcitySettings(supply, settings)

  const out: Candidate[] = []
  for (const item of Object.values(items)) {
    if (item.isRaw || !(recipesByProduct[item.key] ?? []).length) continue

    const biggest = maximise(item.key, supply, sizing, size)
    if (!biggest) continue
    const { scale } = biggest

    const target = [{ item: item.key, ratePerMin: scale }]
    const sized = solvePlan(target, { ...sizing, resourceWeights: biggest.weights })
    if (sized.errors.length || !sized.steps.length) continue

    // Your objective gets the build only if it can hold the output, and only
    // when it has something to show for it: the same route arrived at twice is
    // not the objective doing anything.
    const alt = tuning ? solvePlan(target, { ...tuning, resourceWeights: biggest.weights }) : null
    const useAlt = Boolean(
      alt && !alt.errors.length && alt.steps.length && fits(alt, supply)
      && (settings.objective === 'buildings'
        ? alt.totals.machines < sized.totals.machines
        : alt.totals.totalPowerMW < sized.totals.totalPowerMW - 1e-6),
    )
    const full = useAlt ? alt! : sized

    out.push({
      item,
      ratePerMin: scale,
      sinkPointsPerMin: full.totals.sinkPointsPerMin,
      machines: full.totals.machines,
      // Self-powered, the load is the whole plant: the factory, the extractors
      // you declared, the pumps and the fuel chain. Otherwise it is what the
      // factory alone draws off a grid you already have.
      powerMW: biggest.plant ? biggest.plant.drawMW : full.totals.totalPowerMW,
      limitedBy: biggest.limitedBy ? items[biggest.limitedBy] ?? null : null,
      tuned: useAlt,
      plant: biggest.plant,
      draws: [...biggest.used]
        .filter(([key, rate]) => rate > 0 && !UNLIMITED.has(key) && items[key])
        .map(([key, rate]) => ({
          item: items[key],
          ratePerMin: rate,
          fraction: rate / (supply.get(key) || 1),
        }))
        .sort((a, b) => b.fraction - a.fraction),
    })
  }

  out.sort((a, b) => b.sinkPointsPerMin - a.sinkPointsPerMin)
  return out
}
