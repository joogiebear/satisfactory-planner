import { belts, pipes } from '../core/gameData'
import type { GameItem, PlannerSettings } from '../core/types'

/** Rates are shown to at most 4 decimals, matching the game's own precision. */
export function fmt(value: number, maxDigits = 4): string {
  if (!isFinite(value)) return '—'
  if (Math.abs(value) < 5e-5) return '0'
  return (Math.round(value * 1e4) / 1e4).toLocaleString(undefined, {
    maximumFractionDigits: maxDigits,
  })
}

export function fmtPower(mw: number): string {
  if (mw >= 1000) return `${fmt(mw / 1000, 2)} GW`
  return `${fmt(mw, 1)} MW`
}

export function unit(item: GameItem): string {
  return item.isFluid ? 'm³/min' : '/min'
}

/** Two-letter mark for an item chip, e.g. "Iron Plate" -> "IP". */
export function initials(name: string): string {
  const words = name.replace(/[^\w\s]/g, ' ').split(/\s+/).filter(Boolean)
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase()
  return (words[0][0] + words[1][0]).toUpperCase()
}

export interface Capacity {
  /** Throughput of one belt or pipe at the configured tier. */
  limit: number
  name: string
  /** How many lines this rate needs. */
  lines: number
  over: boolean
}

/**
 * How the given rate rides between machines: on belts for solids, in pipes for
 * fluids. Anything above one line's throughput is flagged so the tree can show
 * where a higher tier or a second line is needed.
 */
export function capacityFor(item: GameItem, rate: number, settings: PlannerSettings): Capacity {
  if (item.isFluid) {
    const pipe = pipes.find((p) => p.key === settings.pipeKey) ?? pipes[pipes.length - 1]
    const limit = pipe?.cubicMetersPerMin ?? Infinity
    return { limit, name: pipe?.name ?? 'Pipeline', lines: Math.ceil(rate / limit - 1e-9), over: rate > limit + 1e-9 }
  }
  const belt = belts.find((b) => b.key === settings.beltKey) ?? belts[belts.length - 1]
  const limit = belt?.itemsPerMin ?? Infinity
  return { limit, name: belt?.name ?? 'Conveyor', lines: Math.ceil(rate / limit - 1e-9), over: rate > limit + 1e-9 }
}

/** Short label for a belt/pipe requirement, e.g. "2x Mk.5". */
export function linesLabel(cap: Capacity): string {
  const tier = cap.name.replace(/^(Conveyor Belt|Pipeline)\s*/, '')
  return cap.lines <= 1 ? tier : `${cap.lines}× ${tier}`
}
