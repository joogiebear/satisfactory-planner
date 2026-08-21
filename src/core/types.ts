/** Shapes of the database produced by tools/extract_game_data.py. */

export type ResourceForm = 'RF_SOLID' | 'RF_LIQUID' | 'RF_GAS'

export interface GameItem {
  key: string
  name: string
  form: ResourceForm
  isFluid: boolean
  isRaw: boolean
  stackSize: string
  /** Fuel value: MJ per item for solids, MJ per m3 for fluids. */
  energyMJ: number
  sinkPoints: number
  category: string
}

export interface RecipeEntry {
  item: string
  amount: number
}

export interface GameRecipe {
  key: string
  name: string
  isAlternate: boolean
  timeSeconds: number
  machine: string
  ingredients: RecipeEntry[]
  products: RecipeEntry[]
  variablePower: { minMW: number; maxMW: number; avgMW: number } | null
}

export interface GameBuilding {
  key: string
  name: string
  powerMW: number
  /** Overclock power exponent, 1.321929 for every production building. */
  powerExponent: number
  /** Somersloop power exponent, 2. */
  boostPowerExponent: number
  manufacturingSpeed: number
  sloopSlots: number
  /** Production bonus added per Somersloop; slots * this === 1.0 (2x output). */
  sloopBoostPerSlot: number
  canOverclock: boolean
  maxPotential: number
  variablePower: boolean
}

export interface GameExtractor {
  key: string
  name: string
  kind: 'solid' | 'fluid' | 'fracking'
  baseRatePerMin: number
  powerMW: number
  powerExponent: number
  allowedForms: ResourceForm[]
  allowedResources: string[]
  affectedByPurity: boolean
}

export interface GameBelt {
  key: string
  name: string
  itemsPerMin: number
}

export interface GamePipe {
  key: string
  name: string
  cubicMetersPerMin: number
}

export interface GeneratorFuel {
  item: string
  ratePerMin: number
  supplemental: string | null
  supplementalPerMin: number
  byproduct: string | null
  byproductPerMin: number
}

export interface GameGenerator {
  key: string
  name: string
  powerMW: number
  fuels: GeneratorFuel[]
}

export interface GameData {
  gameVersion: string
  source: string
  items: Record<string, GameItem>
  recipes: Record<string, GameRecipe>
  buildings: Record<string, GameBuilding>
  extractors: GameExtractor[]
  belts: GameBelt[]
  pipes: GamePipe[]
  generators: GameGenerator[]
}

// ---------------------------------------------------------------------------
// Planner settings
// ---------------------------------------------------------------------------

export type Purity = 'impure' | 'normal' | 'pure'

export const PURITY_MULTIPLIER: Record<Purity, number> = {
  impure: 0.5,
  normal: 1,
  pure: 2,
}

/** How the solver breaks ties when several recipe sets can hit the target. */
export type Objective = 'raw' | 'buildings' | 'balanced'

/** Per-recipe machine tuning. */
export interface MachineTuning {
  /** Clock speed as a fraction, 1 = 100%. Up to 2.5 with power shards. */
  clock: number
  /** Somersloops installed per machine. */
  sloops: number
}

export interface ExtractionSettings {
  /** Miner building key used for solid nodes. */
  minerKey: string
  minerClock: number
  /** Node purity assumed for solid resources without an explicit override. */
  defaultPurity: Purity
  /** Per-resource purity override. */
  purity: Record<string, Purity>
  oilExtractorClock: number
  waterExtractorClock: number
}

export interface PlannerSettings {
  /** Alternate recipes the player has unlocked. Standard recipes are always on. */
  unlockedAlternates: string[]
  /** Force a specific recipe as the only source of an item. */
  pinnedRecipes: Record<string, string>
  /** Recipes excluded from the search entirely. */
  bannedRecipes: string[]
  /** Items supplied from outside the plan (treated as free inputs). */
  importedItems: string[]
  /** Relative cost per unit of each raw resource; drives recipe choice. */
  resourceWeights: Record<string, number>
  extraction: ExtractionSettings
  beltKey: string
  pipeKey: string
  /** Applied to every machine unless overridden per recipe. */
  defaultClock: number
  tuning: Record<string, MachineTuning>
  objective: Objective
}

// ---------------------------------------------------------------------------
// Solver output
// ---------------------------------------------------------------------------

export interface ProductionStep {
  recipe: GameRecipe
  building: GameBuilding
  /** Recipe executions per minute across all machines in this step. */
  runsPerMin: number
  /** Fractional machine count; ceil() for what you actually build. */
  machines: number
  clock: number
  sloops: number
  /** Output multiplier from Somersloops (1 = none, 2 = all slots filled). */
  sloopMultiplier: number
  powerMW: number
  inputs: { item: GameItem; ratePerMin: number }[]
  outputs: { item: GameItem; ratePerMin: number }[]
  /** The output this step exists to make. */
  primaryItem: GameItem
  primaryRatePerMin: number
}

export interface RawRequirement {
  item: GameItem
  ratePerMin: number
  extractor: GameExtractor | null
  purity: Purity | null
  /** Rate a single extractor delivers at the configured mark/clock/purity. */
  ratePerExtractor: number
  extractorCount: number
  powerMW: number
}

export interface PlanNode {
  id: string
  item: GameItem
  /** Rate of this item consumed by the parent edge. */
  ratePerMin: number
  step: ProductionStep | null
  /**
   * Machines and power for *this branch's share* of the step. An item made once
   * but consumed in several places is split proportionally, so the shares add
   * back up to the step total rather than repeating it at every use.
   */
  machines: number
  powerMW: number
  kind: 'produced' | 'raw' | 'imported' | 'byproduct-loop'
  children: PlanNode[]
  /** True when this item already appears higher in the tree (cycle guard). */
  isRepeat: boolean
  depth: number
}

export interface PlanTarget {
  item: string
  ratePerMin: number
}

export interface Plan {
  targets: PlanTarget[]
  steps: ProductionStep[]
  raw: RawRequirement[]
  byproducts: { item: GameItem; ratePerMin: number }[]
  tree: PlanNode[]
  totals: {
    machines: number
    machinePowerMW: number
    extractorPowerMW: number
    totalPowerMW: number
    buildingCounts: { building: GameBuilding; count: number }[]
    sinkPointsPerMin: number
  }
  /** Populated when the target is impossible with the current recipe set. */
  errors: string[]
  warnings: string[]
}
