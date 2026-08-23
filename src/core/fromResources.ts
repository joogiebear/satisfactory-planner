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
 */

import { items, recipesByProduct } from './gameData'
import { buildRawRequirement, solvePlan } from './solver'

import type { GameItem, PlannerSettings, Purity } from './types'

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

export interface Candidate {
  item: GameItem
  ratePerMin: number
  sinkPointsPerMin: number
  machines: number
  powerMW: number
  /** The resource that runs out first — the reason it stops here. */
  limitedBy: GameItem | null
  draws: Draw[]
}

/**
 * Water is placed on a shoreline rather than mined, so it never limits
 * anything. It still shows in a plan's inputs; it just isn't a constraint.
 */
const UNLIMITED = new Set(['Desc_Water_C'])

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
 * Everything those resources could make, best first.
 *
 * A candidate is dropped when it needs a resource you did not list: telling
 * someone their iron node could make computers if only they had caterium is
 * not an answer to the question they asked.
 */
export function bestFrom(available: Available[], settings: PlannerSettings): Candidate[] {
  const supply = supplyOf(available, settings)
  if (supply.size === 0) return []

  const out: Candidate[] = []
  for (const item of Object.values(items)) {
    if (item.isRaw || !(recipesByProduct[item.key] ?? []).length) continue

    const unit = solvePlan([{ item: item.key, ratePerMin: 1 }], settings)
    if (unit.errors.length || !unit.steps.length) continue

    // Anything drawing on a resource that wasn't listed is out.
    if (unit.raw.some((r) => !supply.has(r.item.key) && !UNLIMITED.has(r.item.key))) continue

    let scale = Infinity
    let limitedBy: GameItem | null = null
    for (const raw of unit.raw) {
      if (UNLIMITED.has(raw.item.key) || !(raw.ratePerMin > 0)) continue
      const room = (supply.get(raw.item.key) ?? 0) / raw.ratePerMin
      if (room < scale) { scale = room; limitedBy = raw.item }
    }
    if (!isFinite(scale) || scale <= 0) continue

    const full = solvePlan([{ item: item.key, ratePerMin: scale }], settings)
    if (full.errors.length || !full.steps.length) continue

    out.push({
      item,
      ratePerMin: scale,
      sinkPointsPerMin: full.totals.sinkPointsPerMin,
      machines: full.totals.machines,
      powerMW: full.totals.totalPowerMW,
      limitedBy,
      draws: full.raw
        .filter((r) => r.ratePerMin > 0 && !UNLIMITED.has(r.item.key))
        .map((r) => ({
          item: r.item,
          ratePerMin: r.ratePerMin,
          fraction: r.ratePerMin / (supply.get(r.item.key) || 1),
        }))
        .sort((a, b) => b.fraction - a.fraction),
    })
  }

  out.sort((a, b) => b.sinkPointsPerMin - a.sinkPointsPerMin)
  return out
}
