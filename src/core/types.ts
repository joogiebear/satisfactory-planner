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

/** Which progression track a goal belongs to. */
export type ProgressionTrack = 'milestone' | 'spaceelevator' | 'mam' | 'harddrive'

/** Something you complete to open up more of the game. */
export interface ProgressionGoal {
  key: string
  name: string
  track: ProgressionTrack
  /**
   * The tier you hold while working on it. Meaningful for milestones and Space
   * Elevator phases; MAM and hard drives aren't tier-gated and report 0.
   */
  tier: number
  /** MAM research tree, e.g. "Caterium". Empty on the other tracks. */
  group: string
  cost: RecipeEntry[]
  unlocksRecipes: string[]
  /** Map markers, inventory slots and the like — counted, not listed. */
  otherUnlocks: number
  /** What completing it opens, when that isn't a recipe. Empty on most tracks. */
  note: string
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
  milestones: ProgressionGoal[]
  spaceElevator: ProgressionGoal[]
  mamResearch: ProgressionGoal[]
  hardDrives: ProgressionGoal[]
  /** Tier the HUB hands you each recipe at. MAM and hard-drive recipes have no entry. */
  recipeTiers: Record<string, number>
  /** Earliest tier each production building can exist at. */
  machineTiers: Record<string, number>
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
/**
 * What the planner should spend least of when recipes offer a choice.
 *
 * `raw` is priced by scarcity rather than by count: 30 bauxite costs more
 * than 200 limestone, because bauxite is rarer on the map. So it is not the
 * same as the fewest items on a belt, and a plan optimised for machines can
 * genuinely move less material while spending more of what is precious.
 *
 * There was a fourth, `balanced`, and it was a fiction. The three costs live on
 * different scales, and every weighting tried for it collapsed onto one of its
 * neighbours -- the recipe routes are discrete, so there is rarely a middle to
 * sit in. Three that each win on their own metric beat four where one is a
 * duplicate wearing a different name.
 */
export type Objective = 'raw' | 'buildings' | 'power'

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
  /**
   * Only use recipes unlocked by this tier or earlier. Null means no limit,
   * which is the right default for someone planning a factory they will build
   * later; setting it is how a milestone plan stays honest about what you
   * could actually build at that point in the game.
   */
  maxTier: number | null
  /**
   * Whether a tier-limited plan may use recipes the HUB never hands you — MAM
   * research and hard-drive alternates. On for free-form planning, where the
   * question is "what is the best way to make this". Off when planning a
   * milestone, where the question is "can I build this now" and assuming a
   * hard drive you may never have found makes the answer worthless.
   *
   * Ignored entirely when maxTier is null: with no tier limit there is no
   * point in the game to be honest about.
   */
  allowResearch: boolean
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
  /**
   * What the build produces. Derived, not asked for: it follows from how many
   * machines you are building and how they are tuned, so overclocking them or
   * changing a recipe moves this number rather than leaving it stranded.
   */
  ratePerMin: number
  /**
   * How many machines of the chosen recipe, which is the thing actually being
   * decided. Absent on targets saved before the rate stopped being an input.
   */
  build?: number
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
