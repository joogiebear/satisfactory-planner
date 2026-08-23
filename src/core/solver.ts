import { solveLP } from './simplex'
import { belts, buildings, extractors, getItem, items, machineTiers, pipes, recipeTiers, recipes, unproducibleItems } from './gameData'
import type {
  GameExtractor, GameItem, GameRecipe, Plan, PlanNode, PlanTarget, PlannerSettings,
  ProductionStep, Purity, RawRequirement,
} from './types'
import { PURITY_MULTIPLIER } from './types'

const EPS = 1e-7

// ---------------------------------------------------------------------------
// Machine tuning
// ---------------------------------------------------------------------------

export interface Tuned {
  clock: number
  sloops: number
  /** Output multiplier: 1 with no Somersloops, 2 with every slot filled. */
  sloopMultiplier: number
}

function clampClock(clock: number, maxPotential = 1): number {
  // Power shards raise the ceiling to 250%; mMaxPotential in the docs is the
  // un-sharded limit, so allow up to 250% regardless of what it says.
  const max = Math.max(2.5, maxPotential)
  return Math.min(max, Math.max(0.01, clock || 1))
}

export function tuningFor(recipe: GameRecipe, settings: PlannerSettings): Tuned {
  const building = buildings[recipe.machine]
  const override = settings.tuning[recipe.key]
  const clock = clampClock(override?.clock ?? settings.defaultClock, building?.maxPotential)
  const slots = building?.sloopSlots ?? 0
  const sloops = Math.max(0, Math.min(slots, Math.round(override?.sloops ?? 0)))
  const sloopMultiplier = 1 + sloops * (building?.sloopBoostPerSlot ?? 0)
  return { clock, sloops, sloopMultiplier }
}

/** Recipe executions per minute for a single machine at the given tuning. */
export function runsPerMachine(recipe: GameRecipe, tuned: Tuned): number {
  const speed = buildings[recipe.machine]?.manufacturingSpeed ?? 1
  return (60 / recipe.timeSeconds) * tuned.clock * speed
}

/** Power draw of one machine, in MW, at the given tuning. */
export function powerPerMachine(recipe: GameRecipe, tuned: Tuned, clockOverride?: number): number {
  const building = buildings[recipe.machine]
  if (!building) return 0
  const base = recipe.variablePower ? recipe.variablePower.avgMW : building.powerMW
  const clock = clockOverride ?? tuned.clock
  return (
    base *
    Math.pow(clock, building.powerExponent) *
    Math.pow(tuned.sloopMultiplier, building.boostPowerExponent)
  )
}

/**
 * Power for a fractional machine count, assuming you build ceil(n) machines and
 * underclock the leftover one rather than running a fractional machine. That is
 * what actually happens in game, and it draws noticeably less than n * full.
 */
function powerForCount(recipe: GameRecipe, tuned: Tuned, count: number): number {
  const whole = Math.floor(count + 1e-9)
  const frac = count - whole
  let power = whole * powerPerMachine(recipe, tuned)
  if (frac > 1e-9) power += powerPerMachine(recipe, tuned, tuned.clock * frac)
  return power
}

// ---------------------------------------------------------------------------
// Sizing a build
// ---------------------------------------------------------------------------

/**
 * The rate at which one machine makes the thing you asked for.
 *
 * A rate is the wrong question to put to someone. Nobody wants 14.5734 Heavy
 * Modular Frames a minute -- they want to know what building this looks like,
 * and the rate is part of the answer. So a build is sized to one machine of the
 * final recipe and everything upstream follows: the smallest thing worth
 * laying out, with nothing built as though resources were free.
 *
 * Two rules were tried first and both fail. Making *every* machine count whole
 * is exact but explodes once alternates are unlocked -- their ratios put the
 * smallest such build at 210,600 Modular Frames a minute. Scaling until the
 * rarest machine reaches one inverts it: a chain that processes a trickle of
 * residue in a corner drags the whole build up to 1,800 iron plates a minute.
 * The recipe you actually chose is the stable anchor.
 *
 * Returns null when the item cannot be made at all with the current settings.
 */
export function oneMachineRate(item: string, settings: PlannerSettings): number | null {
  const unit = solvePlan([{ item, ratePerMin: 1 }], settings)
  if (unit.errors.length) return null

  const final = unit.steps.find((s) => s.primaryItem.key === item)
  if (!final || !(final.machines > 0)) return null

  const rate = 1 / final.machines
  if (!isFinite(rate) || rate <= 0) return null
  // Four decimals, as the game shows rates.
  return Math.round(rate * 10000) / 10000
}

// ---------------------------------------------------------------------------
// Recipe availability
// ---------------------------------------------------------------------------

export function availableRecipes(settings: PlannerSettings): GameRecipe[] {
  const unlocked = new Set(settings.unlockedAlternates)
  const banned = new Set(settings.bannedRecipes)

  return Object.values(recipes).filter((r) => {
    if (banned.has(r.key)) return false
    if (r.isAlternate && !unlocked.has(r.key)) return false
    // A tier limit is what keeps a milestone plan buildable: without it a plan
    // for Tier 3 will happily route through a Blender you don't see until 7.
    if (settings.maxTier !== null) {
      // The machine has to exist. This is the check that carries alternates and
      // MAM research, which aren't tier-gated themselves — a hard drive can
      // hand you a Blender recipe at any point, but not the Blender.
      const machineTier = machineTiers[r.machine]
      if (machineTier !== undefined && machineTier > settings.maxTier) return false

      // And the recipe itself, when the HUB is what grants it. No entry means
      // it comes from research rather than a milestone, so the tier says
      // nothing about it and the machine check above is the whole story.
      const tier = recipeTiers[r.key]
      if (tier !== undefined && tier > settings.maxTier) return false

      // Unless the plan is meant to be buildable today, in which case research
      // and hard drives are exactly what it must not quietly assume. Alternates
      // are named outright rather than inferred from a missing tier: a few are
      // filed under a schematic type that does carry one.
      if (!settings.allowResearch && (r.isAlternate || tier === undefined)) return false
    }
    // A pin makes that recipe the only permitted source of its item. Only the
    // recipe's primary output is constrained, so an unrelated pin can't block a
    // recipe that merely emits the item as a byproduct.
    const primary = r.products[0]?.item
    if (primary) {
      const pin = settings.pinnedRecipes[primary]
      if (pin && pin !== r.key) return false
    }
    return true
  })
}

// ---------------------------------------------------------------------------
// Solve
// ---------------------------------------------------------------------------

interface ObjectiveWeights { raw: number; building: number; power: number }

// Costs stay within a few orders of magnitude of each other so the pivot
// tolerance keeps its meaning. Every weight must be >= 0: that is what makes
// the all-slack basis dual-feasible and lets the solver skip a phase-1 pass.
const OBJECTIVES: Record<PlannerSettings['objective'], ObjectiveWeights> = {
  raw: { raw: 1, building: 0.01, power: 0 },
  buildings: { raw: 0.01, building: 1, power: 0 },
  // Megawatts are three orders of magnitude larger than the other costs, so the
  // weight brings them into the same range: without that the pivot tolerance
  // stops meaning anything and the solver chases rounding noise.
  power: { raw: 0.0002, building: 0.0005, power: 0.01 },
}

function emptyPlan(targets: PlanTarget[], errors: string[], warnings: string[]): Plan {
  return {
    targets, steps: [], raw: [], byproducts: [], tree: [],
    totals: {
      machines: 0, machinePowerMW: 0, extractorPowerMW: 0, totalPowerMW: 0,
      buildingCounts: [], sinkPointsPerMin: 0,
    },
    errors, warnings,
  }
}

export function solvePlan(targets: PlanTarget[], settings: PlannerSettings): Plan {
  const errors: string[] = []
  const warnings: string[] = []
  const requested = targets.filter((t) => t.item && t.ratePerMin > 0)

  // Guard against item keys that aren't in the database at all; without this an
  // unknown key survives all the way to tree building and throws there.
  const active = requested.filter((t) => Boolean(items[t.item]))
  for (const t of requested) {
    if (!items[t.item]) errors.push(`Unknown item "${t.item}".`)
  }
  if (!active.length) return emptyPlan(active, errors, warnings)

  const pool = availableRecipes(settings)

  // Anything the planner cannot manufacture has to come from outside.
  const importable = new Set<string>(settings.importedItems)
  for (const i of unproducibleItems) importable.add(i.key)
  const isSource = (key: string) => Boolean(items[key]?.isRaw) || importable.has(key)

  // --- prune to the recipes that can actually feed the targets ---
  const byProduct = new Map<string, GameRecipe[]>()
  for (const r of pool) {
    for (const p of r.products) {
      const list = byProduct.get(p.item) ?? []
      list.push(r)
      byProduct.set(p.item, list)
    }
  }

  // `explored` tracks items whose producers we have already enumerated, kept
  // separate from the set of items that get an LP row. Collapsing the two would
  // let a byproduct mark its item as seen before the search reaches it, and its
  // own recipes would then never be added — Sulfuric Acid is a byproduct of
  // Encased Uranium Cell, so that chain would look circular and unsolvable.
  const neededItems = new Set<string>()
  const explored = new Set<string>()
  /** Items nothing available can make; warned about only if the plan buys one. */
  const noProducer = new Set<string>()
  const usedRecipes = new Map<string, GameRecipe>()
  const queue = active.map((t) => t.item)
  while (queue.length) {
    const key = queue.pop()!
    if (explored.has(key)) continue
    explored.add(key)
    neededItems.add(key)
    if (isSource(key)) continue
    const makers = byProduct.get(key) ?? []
    if (!makers.length) {
      importable.add(key)
      // Not warned about here. The search reaches plenty of items the finished
      // plan never buys, and a tier limit makes that the common case rather
      // than the exception — warning on exploration buries the real notices
      // under a dozen about ingredients nothing ended up needing.
      noProducer.add(key)
      continue
    }
    for (const r of makers) {
      if (usedRecipes.has(r.key)) continue
      usedRecipes.set(r.key, r)
      for (const ing of r.ingredients) queue.push(ing.item)
      // Byproducts only need a row so the balance can account for them. They
      // are deliberately not queued for exploration: doing so drags in most of
      // the recipe graph. If a byproduct is also consumed somewhere it reaches
      // the queue through that recipe's ingredients instead.
      for (const p of r.products) neededItems.add(p.item)
    }
  }

  const itemList = [...neededItems]
  const rowOf = new Map<string, number>()
  itemList.forEach((k, i) => rowOf.set(k, i))

  const recipeList = [...usedRecipes.values()]
  const tunings = new Map<string, Tuned>()
  for (const r of recipeList) tunings.set(r.key, tuningFor(r, settings))

  // Variable layout: [recipe runs/min ...][source extraction ...]
  // Constraints are `net production >= demand`, so surplus needs no variable of
  // its own; the slack the solver reports on each row is the leftover.
  const sourceItems = itemList.filter(isSource)
  const nR = recipeList.length
  const nS = sourceItems.length
  const nVars = nR + nS

  const A: number[][] = itemList.map(() => new Array(nVars).fill(0))
  const b = new Array(itemList.length).fill(0)

  recipeList.forEach((r, j) => {
    const tuned = tunings.get(r.key)!
    for (const ing of r.ingredients) {
      const row = rowOf.get(ing.item)
      if (row !== undefined) A[row][j] -= ing.amount
    }
    for (const p of r.products) {
      const row = rowOf.get(p.item)
      // Somersloops amplify output only; input consumption is unchanged.
      if (row !== undefined) A[row][j] += p.amount * tuned.sloopMultiplier
    }
  })

  sourceItems.forEach((key, s) => { A[rowOf.get(key)!][nR + s] = 1 })
  for (const t of active) {
    const row = rowOf.get(t.item)
    if (row !== undefined) b[row] += t.ratePerMin
  }

  // --- objective ---
  // A settings file from an older build may still say 'balanced'.
  const w = OBJECTIVES[settings.objective] ?? OBJECTIVES.raw
  const c = new Array(nVars).fill(0)
  recipeList.forEach((r, j) => {
    // Proportional to machine count, since machines = runs * time / 60 / clock.
    const tuned = tunings.get(r.key)!
    const machines = r.timeSeconds / 60 / tuned.clock
    c[j] = w.building * machines + w.power * machines * powerPerMachine(r, tuned)
  })
  sourceItems.forEach((key, s) => {
    const weight = settings.resourceWeights[key] ?? (items[key]?.isRaw ? 1 : 5)
    c[nR + s] = Math.max(0, w.raw * weight)
  })

  const result = solveLP(A, b, c)
  if (result.status !== 'optimal') {
    errors.push(
      result.status === 'infeasible'
        ? 'No combination of the enabled recipes can produce this target. Try unlocking more alternate recipes, or marking an intermediate item as imported.'
        : `Solver stopped: ${result.status}.`
    )
    return emptyPlan(active, errors, warnings)
  }

  // --- read the solution back ---
  const steps: ProductionStep[] = []
  recipeList.forEach((r, j) => {
    const runs = result.x[j]
    if (runs <= EPS) return
    const tuned = tunings.get(r.key)!
    const machines = runs / runsPerMachine(r, tuned)
    const primary = r.products[0]
    steps.push({
      recipe: r,
      building: buildings[r.machine],
      runsPerMin: runs,
      machines,
      clock: tuned.clock,
      sloops: tuned.sloops,
      sloopMultiplier: tuned.sloopMultiplier,
      powerMW: powerForCount(r, tuned, machines),
      inputs: r.ingredients.map((e) => ({ item: items[e.item], ratePerMin: e.amount * runs })),
      outputs: r.products.map((e) => ({
        item: items[e.item], ratePerMin: e.amount * runs * tuned.sloopMultiplier,
      })),
      primaryItem: items[primary.item],
      primaryRatePerMin: primary.amount * runs * tuned.sloopMultiplier,
    })
  })
  steps.sort((a, b2) => b2.machines - a.machines)

  // --- raw / imported inputs ---
  const rawReqs: RawRequirement[] = []
  sourceItems.forEach((key, s) => {
    const rate = result.x[nR + s]
    if (rate > EPS) rawReqs.push(buildRawRequirement(items[key], rate, settings))
  })
  rawReqs.sort((a, b2) => b2.ratePerMin - a.ratePerMin)

  // --- leftover byproducts ---
  const targetKeys = new Set(active.map((t) => t.item))
  const byproducts: { item: GameItem; ratePerMin: number }[] = []
  itemList.forEach((key, i) => {
    const leftover = result.surplus[i] ?? 0
    if (leftover > 1e-4 && !targetKeys.has(key)) {
      byproducts.push({ item: items[key], ratePerMin: leftover })
    }
  })
  byproducts.sort((a, b2) => b2.ratePerMin - a.ratePerMin)

  // --- totals ---
  const machinePower = steps.reduce((sum, s) => sum + s.powerMW, 0)
  const extractorPower = rawReqs.reduce((sum, r) => sum + r.powerMW, 0)
  const counts = new Map<string, number>()
  for (const s of steps) {
    counts.set(s.recipe.machine, (counts.get(s.recipe.machine) ?? 0) + Math.ceil(s.machines - 1e-9))
  }
  const sinkPoints = active.reduce(
    (sum, t) => sum + (items[t.item]?.sinkPoints ?? 0) * t.ratePerMin, 0
  )

  const plan: Plan = {
    targets: active,
    steps,
    raw: rawReqs,
    byproducts,
    tree: [],
    totals: {
      machines: steps.reduce((n, s) => n + Math.ceil(s.machines - 1e-9), 0),
      machinePowerMW: machinePower,
      extractorPowerMW: extractorPower,
      totalPowerMW: machinePower + extractorPower,
      buildingCounts: [...counts.entries()]
        .map(([key, count]) => ({ building: buildings[key], count }))
        .sort((a, b2) => b2.count - a.count),
      sinkPointsPerMin: sinkPoints,
    },
    errors,
    warnings,
  }

  plan.tree = buildTree(plan, active, importable)
  addImportWarnings(plan, noProducer, warnings)
  addLogisticsWarnings(plan, settings, warnings)
  addResearchWarnings(plan, settings, warnings)
  return plan
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

export function extractorFor(item: GameItem, settings: PlannerSettings): GameExtractor | null {
  if (!item?.isRaw) return null
  if (item.key === 'Desc_Water_C') return extractors.find((e) => e.key === 'Build_WaterPump_C') ?? null
  if (item.key === 'Desc_LiquidOil_C') return extractors.find((e) => e.key === 'Build_OilPump_C') ?? null
  if (item.key === 'Desc_NitrogenGas_C') return extractors.find((e) => e.kind === 'fracking') ?? null
  // Set on the miner itself where one has been, falling back to the default.
  const chosen = settings.extraction.minerByResource?.[item.key]
    ?? settings.extraction.minerKey
  return (
    extractors.find((e) => e.key === chosen)
    ?? extractors.find((e) => e.kind === 'solid')
    ?? null
  )
}

function clockForExtractor(ex: GameExtractor, settings: PlannerSettings, item: GameItem): number {
  const own = settings.extraction.clockByResource?.[item.key]
  if (own !== undefined) return own
  if (ex.key === 'Build_WaterPump_C') return settings.extraction.waterExtractorClock
  if (ex.key === 'Build_OilPump_C' || ex.kind === 'fracking') return settings.extraction.oilExtractorClock
  return settings.extraction.minerClock
}

export function buildRawRequirement(
  item: GameItem, rate: number, settings: PlannerSettings
): RawRequirement {
  const ex = extractorFor(item, settings)
  if (!ex) {
    return {
      item, ratePerMin: rate, extractor: null, purity: null,
      ratePerExtractor: 0, extractorCount: 0, powerMW: 0,
    }
  }
  const purity: Purity | null = ex.affectedByPurity
    ? settings.extraction.purity[item.key] ?? settings.extraction.defaultPurity
    : null
  const clock = clampClock(clockForExtractor(ex, settings, item))
  const perExtractor = ex.baseRatePerMin * (purity ? PURITY_MULTIPLIER[purity] : 1) * clock

  const count = perExtractor > 0 ? rate / perExtractor : 0
  const whole = Math.floor(count + 1e-9)
  const frac = count - whole
  let power = whole * ex.powerMW * Math.pow(clock, ex.powerExponent)
  if (frac > 1e-9) power += ex.powerMW * Math.pow(clock * frac, ex.powerExponent)

  return {
    item, ratePerMin: rate, extractor: ex, purity,
    ratePerExtractor: perExtractor, extractorCount: count, powerMW: power,
  }
}

// ---------------------------------------------------------------------------
// Progression sanity checks
// ---------------------------------------------------------------------------

/**
 * Say which items the plan actually has to buy in.
 *
 * Only the ones it ends up drawing on: an item the search passed through and
 * discarded is not something the player has to do anything about.
 */
function addImportWarnings(plan: Plan, noProducer: Set<string>, warnings: string[]): void {
  const bought = plan.raw
    .filter((r) => noProducer.has(r.item.key) && r.ratePerMin > 1e-6)
    .map((r) => r.item.name)
  if (bought.length === 0) return

  warnings.push(
    `Nothing available makes ${bought.sort().join(', ')}; ` +
    `${bought.length === 1 ? 'it is' : 'they are'} counted as imported into the plan.`
  )
}

/**
 * Say so when a tier-limited plan leans on something the HUB never gave you.
 *
 * The tier limit guarantees the machines exist, but MAM research and hard-drive
 * alternates arrive on their own schedule. A plan that quietly assumes you have
 * researched Silica is still a good plan — it just isn't one you can read as
 * "build this now" without checking, so it says which.
 */
function addResearchWarnings(plan: Plan, settings: PlannerSettings, warnings: string[]): void {
  if (settings.maxTier === null || !settings.allowResearch) return

  const research = new Set<string>()
  for (const step of plan.steps) {
    if (step.recipe.isAlternate) research.add(`${step.recipe.name} (hard drive)`)
    else if (recipeTiers[step.recipe.key] === undefined) research.add(`${step.recipe.name} (MAM)`)
  }
  if (research.size === 0) return

  warnings.push(
    `This plan uses ${research.size} recipe${research.size === 1 ? '' : 's'} the HUB doesn't ` +
    `hand you: ${[...research].sort().join(', ')}. Research them first, or ban them under ` +
    `Recipe choice.`
  )
}

// ---------------------------------------------------------------------------
// Logistics sanity checks
// ---------------------------------------------------------------------------

function addLogisticsWarnings(plan: Plan, settings: PlannerSettings, warnings: string[]): void {
  const belt = belts.find((b) => b.key === settings.beltKey)
  const pipe = pipes.find((p) => p.key === settings.pipeKey)

  for (const r of plan.raw) {
    if (!r.extractor || !r.ratePerExtractor) continue
    if (r.item.isFluid) {
      if (pipe && r.ratePerExtractor > pipe.cubicMetersPerMin) {
        warnings.push(
          `${r.extractor.name} on ${r.item.name} outputs ${r.ratePerExtractor.toFixed(0)} m³/min, above ${pipe.name} (${pipe.cubicMetersPerMin} m³/min). You'll need a second pipe or a lower clock.`
        )
      }
    } else if (belt && r.ratePerExtractor > belt.itemsPerMin) {
      warnings.push(
        `${r.extractor.name} on a ${r.purity} node outputs ${Math.round(r.ratePerExtractor)}/min, above ${belt.name} (${belt.itemsPerMin}/min). Output will be belt-limited.`
      )
    }
  }
}

// ---------------------------------------------------------------------------
// Tree
// ---------------------------------------------------------------------------

function buildTree(plan: Plan, targets: PlanTarget[], importable: Set<string>): PlanNode[] {
  // Total production of each item across every step, so demand can be split
  // when more than one recipe makes the same thing.
  const production = new Map<string, number>()
  const producers = new Map<string, ProductionStep[]>()
  for (const s of plan.steps) {
    for (const out of s.outputs) {
      production.set(out.item.key, (production.get(out.item.key) ?? 0) + out.ratePerMin)
      const list = producers.get(out.item.key) ?? []
      if (!list.includes(s)) list.push(s)
      producers.set(out.item.key, list)
    }
  }

  let counter = 0
  const visit = (itemKey: string, rate: number, path: Set<string>, depth: number): PlanNode => {
    const item = getItem(itemKey)!
    const id = `n${counter++}`
    const madeBy = producers.get(itemKey) ?? []

    if (!madeBy.length) {
      return {
        id, item, ratePerMin: rate, step: null, machines: 0, powerMW: 0,
        kind: item.isRaw ? 'raw' : importable.has(itemKey) ? 'imported' : 'raw',
        children: [], isRepeat: false, depth,
      }
    }

    const total = production.get(itemKey) ?? 0
    // This branch consumes `rate` of the item's `total` output, so it owns that
    // fraction of the machines and power that produce it.
    const shareOfStep = total > EPS ? rate / total : 0
    const machines = madeBy.reduce((n, s2) => n + s2.machines * shareOfStep, 0)
    const powerMW = madeBy.reduce((n, s2) => n + s2.powerMW * shareOfStep, 0)

    if (path.has(itemKey)) {
      // Recycling loop: stop here so the tree stays finite, and flag it.
      return {
        id, item, ratePerMin: rate, step: madeBy[0], machines, powerMW,
        kind: 'byproduct-loop', children: [], isRepeat: true, depth,
      }
    }

    const nextPath = new Set(path).add(itemKey)
    const children: PlanNode[] = []

    for (const step of madeBy) {
      for (const input of step.inputs) {
        const childRate = input.ratePerMin * shareOfStep
        if (childRate > EPS) children.push(visit(input.item.key, childRate, nextPath, depth + 1))
      }
    }

    return {
      id, item, ratePerMin: rate, step: madeBy[0], machines, powerMW,
      kind: 'produced', children, isRepeat: false, depth,
    }
  }

  return targets.map((t) => visit(t.item, t.ratePerMin, new Set(), 0))
}
