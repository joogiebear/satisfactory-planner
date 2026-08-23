import raw from '../data/game-data.json'
import type {
  GameBelt, GameBuilding, GameData, GameExtractor, GameGenerator, GameItem, GamePipe, GameRecipe,
  PlannerSettings, Purity,
} from './types'

export const gameData = raw as unknown as GameData

export const items = gameData.items
export const recipes = gameData.recipes
export const buildings = gameData.buildings

export const allItems: GameItem[] = Object.values(items).sort((a, b) => a.name.localeCompare(b.name))
export const allRecipes: GameRecipe[] = Object.values(recipes)

/** Every recipe that outputs a given item. */
export const recipesByProduct: Record<string, GameRecipe[]> = {}
/** Every recipe that consumes a given item. */
export const recipesByIngredient: Record<string, GameRecipe[]> = {}

for (const r of allRecipes) {
  for (const p of r.products) (recipesByProduct[p.item] ??= []).push(r)
  for (const i of r.ingredients) (recipesByIngredient[i.item] ??= []).push(r)
}

/** Raw resources that come out of the ground. */
export const rawResources: GameItem[] = allItems.filter((i) => i.isRaw)

/**
 * Items that no recipe produces (e.g. alien remains handed out by the world).
 * The planner has to treat these as imports rather than something to build.
 */
export const unproducibleItems: GameItem[] = allItems.filter(
  (i) => !i.isRaw && !recipesByProduct[i.key]?.length
)

/** Items worth offering as a plan target: anything a machine can make. */
export const producibleItems: GameItem[] = allItems
  .filter((i) => recipesByProduct[i.key]?.length)
  .sort((a, b) => a.name.localeCompare(b.name))

/**
 * What one machine makes of an item per minute, running the standard recipe at
 * 100%.
 *
 * This is the number the game itself shows you on a machine, so it is the
 * sensible thing for a new output to start at: one line, actually built. A flat
 * default is either far too small to be a factory or far too big to be a first
 * one, and either way it is a number nobody chose.
 */
export function baseRatePerMin(itemKey: string): number {
  const made = recipesByProduct[itemKey] ?? []
  // Prefer the standard recipe: an alternate is a choice the player makes later.
  const recipe = made.find((r) => !r.isAlternate) ?? made[0]
  if (!recipe) return 1

  const amount = recipe.products.find((p) => p.item === itemKey)?.amount ?? 0
  if (!amount || !recipe.timeSeconds) return 1

  const speed = buildings[recipe.machine]?.manufacturingSpeed ?? 1
  const rate = (60 / recipe.timeSeconds) * speed * amount
  // Four decimals is what the game shows; anything longer is noise in an input.
  return Math.round(rate * 10000) / 10000
}

export function getItem(key: string): GameItem | undefined { return items[key] }
export function getRecipe(key: string): GameRecipe | undefined { return recipes[key] }
export function getBuilding(key: string): GameBuilding | undefined { return buildings[key] }

/** The four ways the game opens up, and the tier each recipe arrives at. */
export const milestones = gameData.milestones
export const spaceElevatorPhases = gameData.spaceElevator
export const mamResearch = gameData.mamResearch
export const hardDrives = gameData.hardDrives
export const recipeTiers = gameData.recipeTiers
export const machineTiers = gameData.machineTiers

/** The highest tier the game has, so the UI never hard-codes it. */
export const maxGameTier = milestones.reduce((n, m) => Math.max(n, m.tier), 0)

export const belts: GameBelt[] = gameData.belts
export const pipes: GamePipe[] = gameData.pipes
export const extractors: GameExtractor[] = gameData.extractors
/** Power generators and what they burn, for planning the supply side. */
export const generators: GameGenerator[] = gameData.generators

export const miners = extractors.filter((e) => e.kind === 'solid')
export const oilExtractor = extractors.find((e) => e.key === 'Build_OilPump_C') ?? null
export const waterExtractor = extractors.find((e) => e.key === 'Build_WaterPump_C') ?? null
export const frackingExtractor = extractors.find((e) => e.kind === 'fracking') ?? null

/**
 * Approximate total extractable rate per resource across the whole map, used to
 * price raw inputs so the solver prefers abundant ores over scarce ones. These
 * are the community's map-survey figures (items/min with fully overclocked
 * Mk.3 miners) and are exposed in the UI as editable defaults rather than
 * treated as gospel.
 */
export const RESOURCE_AVAILABILITY: Record<string, number> = {
  Desc_OreIron_C: 92100,
  Desc_Stone_C: 69900,
  Desc_Coal_C: 42300,
  Desc_OreCopper_C: 36900,
  Desc_OreGold_C: 15000,
  Desc_RawQuartz_C: 13500,
  Desc_LiquidOil_C: 12600,
  Desc_OreBauxite_C: 12300,
  Desc_NitrogenGas_C: 12000,
  Desc_Sulfur_C: 10800,
  Desc_SAM_C: 10200,
  Desc_OreUranium_C: 2100,
}

/** Water is effectively unlimited, so it should barely influence recipe choice. */
export const WATER_WEIGHT = 0.001

export function defaultResourceWeights(): Record<string, number> {
  const weights: Record<string, number> = {}
  for (const res of rawResources) {
    if (res.key === 'Desc_Water_C') { weights[res.key] = WATER_WEIGHT; continue }
    const avail = RESOURCE_AVAILABILITY[res.key]
    // Scarce resources cost more per unit; scale so iron ore sits near 1.
    weights[res.key] = avail ? 92100 / avail : 10
  }
  return weights
}

export const standardRecipes = allRecipes.filter((r) => !r.isAlternate)
export const alternateRecipes = allRecipes
  .filter((r) => r.isAlternate)
  .sort((a, b) => a.name.localeCompare(b.name))

export function defaultSettings(): PlannerSettings {
  return {
    unlockedAlternates: [],
    pinnedRecipes: {},
    bannedRecipes: [],
    importedItems: [],
    resourceWeights: defaultResourceWeights(),
    extraction: {
      minerKey: miners[0]?.key ?? 'Build_MinerMk1_C',
      minerClock: 1,
      defaultPurity: 'normal' as Purity,
      purity: {},
      oilExtractorClock: 1,
      waterExtractorClock: 1,
    },
    // Start on the kit a new save has and let upgrades improve the plan,
    // rather than assuming everything is already unlocked.
    beltKey: belts[0]?.key ?? 'Build_ConveyorBeltMk1_C',
    pipeKey: pipes[0]?.key ?? 'Build_Pipeline_C',
    defaultClock: 1,
    tuning: {},
    objective: 'raw',
    maxTier: null,
    allowResearch: true,
  }
}

/** Formats a rate the way the game does: trimmed to at most 4 decimals. */
export function fmtRate(value: number): string {
  if (!isFinite(value)) return '—'
  if (Math.abs(value) < 1e-6) return '0'
  const rounded = Math.round(value * 10000) / 10000
  return rounded.toLocaleString(undefined, { maximumFractionDigits: 4 })
}

export function unitFor(item: GameItem): string {
  return item.isFluid ? 'm³/min' : '/min'
}
