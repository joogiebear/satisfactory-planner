/**
 * A plan laid out as something you could walk onto the map and build.
 *
 * The factory graph says a chain needs sixteen Constructors; it does not say
 * where they go, how the ore reaches them, or how much floor to pour. This
 * turns the same plan into positions on an 8 m foundation grid, with the
 * splitters and mergers that actually feed it, so the picture can be copied
 * rather than interpreted.
 *
 * The arrangement is a manifold, which is what most people build: one belt runs
 * along the front of a row of machines with a splitter in front of each, and a
 * second runs along the back collecting through mergers. Machines nearest the
 * head fill first and the row balances itself once everything is saturated.
 * Load-balanced trees divide the input evenly from the first item, at the cost
 * of a binary tree of splitters per row — a different diagram, and a much
 * busier one.
 *
 * Everything is in centimetres, the game's own unit, so a foundation is 800 and
 * the numbers can be read straight off.
 */

import { belts, gameData, items, pipes } from './gameData'
import type { GameItem, Plan, PlannerSettings, ProductionStep } from './types'

/** The game's foundation, and the grid everything snaps to. */
export const FOUNDATION = 800

/** Between machines in a row: enough to walk and to land a belt. */
const MACHINE_GAP = 200

/** Between a machine and the bus feeding it. */
const BUS_OFFSET = 400

/** Between one row's output bus and the next row's input bus. */
const ROW_GAP = 800

const ATTACHMENT = 400

export type PlacedKind = 'machine' | 'splitter' | 'merger'

export interface Placed {
  id: string
  kind: PlacedKind
  /** Build_*_C, for the icon and for naming what to place. */
  key: string
  name: string
  /** What this machine makes, on a machine. */
  item: GameItem | null
  /** Top-left corner, centimetres. */
  x: number
  y: number
  w: number
  h: number
  /** Which row of the build it belongs to, for highlighting. */
  row: number
}

export interface Run {
  id: string
  item: GameItem
  ratePerMin: number
  /** Orthogonal path, centimetres. */
  points: { x: number; y: number }[]
  /** How many belts of the chosen tier this rate needs. */
  lanes: number
  row: number
}

export interface Row {
  index: number
  step: ProductionStep
  machines: number
  /** Rate along the input bus, which is what decides its belt tier. */
  inputRate: number
  outputRate: number
  y: number
  height: number
}

export interface Layout {
  buildings: Placed[]
  runs: Run[]
  rows: Row[]
  /** Extent of the whole build, centimetres. */
  width: number
  height: number
  /** 8 m foundations to cover it. */
  foundations: number
  beltMetres: number
  splitters: number
  mergers: number
  warnings: string[]
}

interface Size { w: number; h: number }

/**
 * One belt or pipe's throughput at the configured tier.
 *
 * A manifold's bus carries the whole row's rate, so this is what decides
 * whether the row fits on one line or has to be fed from two.
 */
function laneFor(item: GameItem, settings: PlannerSettings): { perMin: number; name: string } {
  if (item.isFluid) {
    const pipe = pipes.find((p) => p.key === settings.pipeKey) ?? pipes[pipes.length - 1]
    return { perMin: pipe?.cubicMetersPerMin ?? Infinity, name: pipe?.name ?? 'Pipeline' }
  }
  const belt = belts.find((b) => b.key === settings.beltKey) ?? belts[belts.length - 1]
  return { perMin: belt?.itemsPerMin ?? Infinity, name: belt?.name ?? 'Conveyor' }
}

function lanesFor(rate: number, item: GameItem, settings: PlannerSettings): number {
  const { perMin } = laneFor(item, settings)
  return Math.max(1, Math.ceil(rate / perMin - 1e-6))
}

/** A building's own footprint, or a sensible square if it isn't known. */
export function footprint(key: string): Size {
  const box = gameData.footprints?.[key]?.box
  if (!box) return { w: FOUNDATION, h: FOUNDATION }
  return {
    w: Math.max(100, Math.round(box.max[0] - box.min[0])),
    h: Math.max(100, Math.round(box.max[1] - box.min[1])),
  }
}

/**
 * Order the steps so a row is built after everything feeding it.
 *
 * Reading the plan's own order would put an Assembler above the Constructors
 * making its plates as often as not, and a diagram whose belts run backwards is
 * worse than no diagram.
 */
function inFeedOrder(plan: Plan): ProductionStep[] {
  const makers = new Map<string, ProductionStep[]>()
  for (const step of plan.steps) {
    for (const out of step.outputs) {
      const list = makers.get(out.item.key) ?? []
      list.push(step)
      makers.set(out.item.key, list)
    }
  }

  const depth = new Map<string, number>()
  const walk = (step: ProductionStep, seen: Set<string>): number => {
    const key = step.recipe.key
    const known = depth.get(key)
    if (known !== undefined) return known
    if (seen.has(key)) return 0
    seen.add(key)

    let deepest = 0
    for (const input of step.inputs) {
      for (const from of makers.get(input.item.key) ?? []) {
        if (from.recipe.key === key) continue
        deepest = Math.max(deepest, walk(from, seen) + 1)
      }
    }
    seen.delete(key)
    depth.set(key, deepest)
    return deepest
  }

  for (const step of plan.steps) walk(step, new Set())
  return [...plan.steps].sort(
    (a, b) => (depth.get(a.recipe.key) ?? 0) - (depth.get(b.recipe.key) ?? 0)
      || a.recipe.name.localeCompare(b.recipe.name),
  )
}

/** The item a row is really about — what its machines put out. */
function primaryOut(step: ProductionStep): GameItem | null {
  return step.primaryItem ?? step.outputs[0]?.item ?? null
}

/**
 * Lay a plan out as rows of machines with the belts that feed them.
 *
 * A row is a whole production step: every Constructor making iron rods sits
 * together, fed from one bus and collected onto another. Rows run down the
 * page in feed order, so the belts between them all run one way.
 */
export function layOut(plan: Plan, settings: PlannerSettings): Layout {
  const buildings: Placed[] = []
  const runs: Run[] = []
  const rows: Row[] = []
  const warnings: string[] = []

  const steps = inFeedOrder(plan)

  let y = 0
  let width = 0

  for (const [index, step] of steps.entries()) {
    const count = Math.ceil(step.machines - 1e-9)
    if (count <= 0) continue
    const size = footprint(step.recipe.machine)
    const made = primaryOut(step)

    const rowWidth = count * size.w + (count - 1) * MACHINE_GAP
    width = Math.max(width, rowWidth)

    const busIn = y
    const machineY = busIn + ATTACHMENT + BUS_OFFSET
    const busOut = machineY + size.h + BUS_OFFSET

    // The bus carries everything the row eats, so it is what decides the tier.
    const inputRate = step.inputs.reduce((n, i) => n + i.ratePerMin, 0)
    const outputRate = step.outputs.reduce((n, o) => n + o.ratePerMin, 0)

    for (let i = 0; i < count; i++) {
      const x = i * (size.w + MACHINE_GAP)
      const centre = x + size.w / 2 - ATTACHMENT / 2

      buildings.push({
        id: `m:${step.recipe.key}:${i}`,
        kind: 'machine',
        key: step.recipe.machine,
        name: step.building?.name ?? 'Machine',
        item: made,
        x, y: machineY, w: size.w, h: size.h,
        row: index,
      })

      if (step.inputs.length > 0) {
        buildings.push({
          id: `s:${step.recipe.key}:${i}`,
          kind: 'splitter',
          key: 'Build_ConveyorAttachmentSplitter_C',
          name: 'Splitter',
          item: step.inputs[0]?.item ?? null,
          x: centre, y: busIn, w: ATTACHMENT, h: ATTACHMENT,
          row: index,
        })
      }
      buildings.push({
        id: `g:${step.recipe.key}:${i}`,
        kind: 'merger',
        key: 'Build_ConveyorAttachmentMerger_C',
        name: 'Merger',
        item: made,
        x: centre, y: busOut, w: ATTACHMENT, h: ATTACHMENT,
        row: index,
      })

      // The drop from bus to machine, and back out the far side.
      if (step.inputs.length > 0) {
        runs.push({
          id: `in:${step.recipe.key}:${i}`,
          item: step.inputs[0].item,
          ratePerMin: step.inputs.reduce((n, s) => n + s.ratePerMin, 0) / count,
          points: [
            { x: centre + ATTACHMENT / 2, y: busIn + ATTACHMENT },
            { x: centre + ATTACHMENT / 2, y: machineY },
          ],
          lanes: 1,
          row: index,
        })
      }
      if (made) {
        runs.push({
          id: `out:${step.recipe.key}:${i}`,
          item: made,
          ratePerMin: outputRate / count,
          points: [
            { x: centre + ATTACHMENT / 2, y: machineY + size.h },
            { x: centre + ATTACHMENT / 2, y: busOut },
          ],
          lanes: 1,
          row: index,
        })
      }
    }

    // The buses themselves, running the length of the row.
    const busEnd = rowWidth - size.w / 2
    if (step.inputs.length > 0) {
      const feed = step.inputs[0].item
      const lanes = lanesFor(inputRate, feed, settings)
      if (lanes > 1) {
        warnings.push(
          `${step.building?.name ?? 'This row'} eats ${Math.round(inputRate)}/min, over one `
          + `${laneFor(feed, settings).name} — the bus needs ${lanes} lines, or split the row.`,
        )
      }
      runs.push({
        id: `bus-in:${step.recipe.key}`,
        item: step.inputs[0].item,
        ratePerMin: inputRate,
        points: [
          { x: -BUS_OFFSET, y: busIn + ATTACHMENT / 2 },
          { x: busEnd, y: busIn + ATTACHMENT / 2 },
        ],
        lanes,
        row: index,
      })
    }
    if (made) {
      const lanes = lanesFor(outputRate, made, settings)
      runs.push({
        id: `bus-out:${step.recipe.key}`,
        item: made,
        ratePerMin: outputRate,
        points: [
          { x: busEnd, y: busOut + ATTACHMENT / 2 },
          { x: -BUS_OFFSET, y: busOut + ATTACHMENT / 2 },
        ],
        lanes,
        row: index,
      })
    }

    rows.push({
      index, step, machines: count, inputRate, outputRate,
      y: busIn, height: busOut + ATTACHMENT - busIn,
    })

    y = busOut + ATTACHMENT + ROW_GAP
  }

  // Carry each row's output down the left-hand side to whatever eats it next.
  for (const row of rows) {
    const made = primaryOut(row.step)
    if (!made) continue
    const next = rows.find((r) => r.index > row.index
      && r.step.inputs.some((i) => i.item.key === made.key))
    if (!next) continue
    const from = row.y + row.height - ATTACHMENT / 2
    const to = next.y + ATTACHMENT / 2
    runs.push({
      id: `link:${row.step.recipe.key}->${next.step.recipe.key}`,
      item: made,
      ratePerMin: row.outputRate,
      points: [
        { x: -BUS_OFFSET, y: from },
        { x: -BUS_OFFSET - ATTACHMENT, y: from },
        { x: -BUS_OFFSET - ATTACHMENT, y: to },
        { x: -BUS_OFFSET, y: to },
      ],
      lanes: lanesFor(row.outputRate, made, settings),
      row: row.index,
    })
  }

  const height = y > 0 ? y - ROW_GAP : 0
  // The buses and the links live to the left of x=0, so the floor has to reach.
  const left = BUS_OFFSET + ATTACHMENT
  const beltMetres = runs.reduce((n, r) => {
    let d = 0
    for (let i = 1; i < r.points.length; i++) {
      d += Math.abs(r.points[i].x - r.points[i - 1].x) + Math.abs(r.points[i].y - r.points[i - 1].y)
    }
    return n + (d * r.lanes) / 100
  }, 0)

  return {
    buildings,
    runs,
    rows,
    width: width + left,
    height,
    foundations: Math.ceil((width + left) / FOUNDATION) * Math.ceil(height / FOUNDATION),
    beltMetres: Math.round(beltMetres),
    splitters: buildings.filter((b) => b.kind === 'splitter').length,
    mergers: buildings.filter((b) => b.kind === 'merger').length,
    warnings: [...new Set(warnings)],
  }
}

/** Everything a row needs placing, as a shopping list. */
export function billOfMaterials(layout: Layout): { key: string; name: string; count: number }[] {
  const tally = new Map<string, { name: string; count: number }>()
  for (const b of layout.buildings) {
    const seen = tally.get(b.key) ?? { name: b.name, count: 0 }
    seen.count++
    tally.set(b.key, seen)
  }
  return [...tally].map(([key, v]) => ({ key, ...v })).sort((a, b) => b.count - a.count)
}

/** Named for the diagram's legend. */
export function itemName(key: string): string {
  return items[key]?.name ?? key
}
