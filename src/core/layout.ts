/**
 * A plan laid out as something you could walk onto the map and build.
 *
 * The factory graph says a chain needs sixteen Constructors; it does not say
 * where they go, how the ore reaches them, or how much floor to pour. This
 * turns the same plan into positions on an 8 m foundation grid, with the
 * splitters and mergers that actually feed it, so the picture can be copied
 * rather than interpreted.
 *
 * The arrangement is a manifold, which is what most people build: a belt runs
 * along the front of a line of machines with a splitter in front of each, and a
 * second runs along the back collecting through mergers. Machines nearest the
 * head fill first and the line balances itself once everything is saturated.
 * Load-balanced trees divide the input evenly from the first item, at the cost
 * of a binary tree of splitters per line — a different diagram, and a much
 * busier one.
 *
 * Two things it will not do. It will not run a line off the end of the map —
 * past about a hundred metres the machines wrap onto another line, the way
 * anybody actually building it would. And it will not pretend a recipe has one
 * ingredient: a Modular Frame Assembler eats plate and rod, so it gets a bus
 * for each, and each of those buses comes off a main that every consumer of
 * that item taps.
 *
 * Everything is in centimetres, the game's own unit, so a foundation is 800 and
 * the numbers can be read straight off.
 */

import { belts, gameData, items, pipes } from './gameData'
import type { GameItem, Plan, PlannerSettings, ProductionStep, RawRequirement } from './types'

/** The game's foundation, and the grid everything snaps to. */
export const FOUNDATION = 800

/** Between machines in a line: enough to walk and to land a belt. */
const MACHINE_GAP = 200

/** Between a machine and the bus feeding it. */
const BUS_OFFSET = 400

/** Between one row and the next. */
export const ROW_GAP = 800

/** Between two buses serving the same line. */
const BUS_PITCH = 500

/** Splitters and mergers are 4 m square. */
const ATTACHMENT = 400

/**
 * How wide a line is allowed to get before the machines wrap onto another.
 *
 * Fourteen foundations is a long shed and still a walkable one. Past that the
 * bus has usually outgrown its belt anyway, so wrapping costs nothing you were
 * not already paying.
 */
const MAX_LINE_WIDTH = 14 * FOUNDATION

const EPS = 1e-7

export type PlacedKind = 'machine' | 'splitter' | 'merger'

export interface Placed {
  id: string
  kind: PlacedKind
  /** Build_*_C, for the icon and for naming what to place. */
  key: string
  name: string
  /** What this machine makes, on a machine; what runs through it otherwise. */
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

export interface Port {
  item: GameItem
  ratePerMin: number
}

export interface Row {
  index: number
  /** The recipe this row runs. Null on a row of extractors. */
  step: ProductionStep | null
  /** What this row mines. Null on a row of machines. */
  raw: RawRequirement | null
  /** How the row reads on the drawing, e.g. "15× Constructor — Iron Plate". */
  label: string
  machines: number
  /** How many machines sit on each line before wrapping. */
  perLine: number
  lines: number
  inputs: Port[]
  outputs: Port[]
  inputRate: number
  outputRate: number
  /** What the row puts out, which is what the rows below it eat. */
  made: GameItem | null
  /** Where each ingredient's bus sits, per line: busInY[line][ingredient]. */
  busInY: number[][]
  busOutY: number[][]
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

/** One band of the drawing: a group of like machines with its buses. */
interface Block {
  id: string
  machineKey: string
  machineName: string
  label: string
  count: number
  made: GameItem | null
  inputs: Port[]
  outputs: Port[]
  step: ProductionStep | null
  raw: RawRequirement | null
}

interface Size { w: number; h: number }

/**
 * One belt or pipe's throughput at the configured tier.
 *
 * A manifold's bus carries a whole line's rate, so this is what decides
 * whether the line fits on one belt or has to be fed from two.
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
 * How many machines to put on one line before starting another.
 *
 * Width is the cheap direction: the drawing is wider than it is tall and every
 * extra line costs a bus, a row gap and another belt down the main. So a block
 * runs as wide as it is allowed to and only wraps when it would not fit — an
 * earlier version aimed for square blocks and made four Smelters two lines
 * deep, which is both uglier and further to walk.
 */
function machinesPerLine(count: number, size: Size): number {
  const fits = Math.max(1, Math.floor((MAX_LINE_WIDTH + MACHINE_GAP) / (size.w + MACHINE_GAP)))
  if (count <= fits) return count
  // Past that, spread the wrap evenly rather than leaving a stub on the end.
  const lines = Math.ceil(count / fits)
  return Math.ceil(count / lines)
}

/** Every block that makes up the build, extractors first. */
function blocksOf(plan: Plan): Block[] {
  const blocks: Block[] = []

  for (const raw of plan.raw) {
    const count = Math.ceil(raw.extractorCount - 1e-9)
    if (!raw.extractor || count <= 0) continue
    blocks.push({
      id: `raw:${raw.item.key}`,
      machineKey: raw.extractor.key,
      machineName: raw.extractor.name,
      label: `${count}× ${raw.extractor.name}`
        + `${raw.purity ? ` on ${raw.purity} nodes` : ''} — ${raw.item.name}`,
      count,
      made: raw.item,
      inputs: [],
      outputs: [{ item: raw.item, ratePerMin: raw.ratePerMin }],
      step: null,
      raw,
    })
  }

  for (const step of inFeedOrder(plan)) {
    const count = Math.ceil(step.machines - 1e-9)
    if (count <= 0) continue
    blocks.push({
      id: `step:${step.recipe.key}`,
      machineKey: step.recipe.machine,
      machineName: step.building?.name ?? 'Machine',
      label: `${count}× ${step.building?.name ?? 'Machine'} — ${step.recipe.name}`,
      count,
      made: primaryOut(step),
      inputs: step.inputs.filter((i) => i.ratePerMin > EPS)
        .map((i) => ({ item: i.item, ratePerMin: i.ratePerMin })),
      outputs: step.outputs.filter((o) => o.ratePerMin > EPS)
        .map((o) => ({ item: o.item, ratePerMin: o.ratePerMin })),
      step,
      raw: null,
    })
  }

  return blocks
}

/**
 * Lay a plan out as blocks of machines with the belts that feed them.
 *
 * A block is a whole production step: every Constructor making iron rods sits
 * together, wrapped into as many lines as it takes to stay a sensible shape.
 * Blocks run down the page in feed order, and every item moves between them on
 * a main down the left that its producers feed and its consumers tap.
 */
export function layOut(plan: Plan, settings: PlannerSettings): Layout {
  const buildings: Placed[] = []
  const runs: Run[] = []
  const rows: Row[] = []
  const warnings: string[] = []

  const blocks = blocksOf(plan)

  let y = 0
  let width = 0

  for (const [index, block] of blocks.entries()) {
    const { count, inputs, outputs } = block
    const size = footprint(block.machineKey)
    const perLine = machinesPerLine(count, size)
    const lines = Math.ceil(count / perLine)

    const busInY: number[][] = []
    const busOutY: number[][] = []
    let cursor = y

    for (let line = 0; line < lines; line++) {
      const onLine = Math.min(perLine, count - line * perLine)
      const lineWidth = onLine * size.w + (onLine - 1) * MACHINE_GAP
      width = Math.max(width, lineWidth)

      // A recipe with two ingredients needs two buses. Drawing one, labelled
      // with whichever item came first and carrying the sum of both rates, is
      // a diagram you can only follow if you already know the answer.
      const inY = inputs.map((_, k) => cursor + k * BUS_PITCH)
      const machineY = cursor + (inputs.length ? inputs.length * BUS_PITCH : 0) + BUS_OFFSET
      const outTop = machineY + size.h + BUS_OFFSET
      const outY = outputs.map((_, k) => outTop + k * BUS_PITCH)
      busInY.push(inY)
      busOutY.push(outY)

      for (let i = 0; i < onLine; i++) {
        const at = line * perLine + i
        const x = i * (size.w + MACHINE_GAP)

        buildings.push({
          id: `m:${block.id}:${at}`,
          kind: 'machine',
          key: block.machineKey,
          name: block.machineName,
          item: block.made,
          x, y: machineY, w: size.w, h: size.h,
          row: index,
        })

        // Each ingredient takes its own share of the machine's frontage, so
        // two drops land side by side rather than on top of one another.
        inputs.forEach((port, k) => {
          const px = x + ((k + 1) * size.w) / (inputs.length + 1) - ATTACHMENT / 2
          buildings.push({
            id: `s:${block.id}:${k}:${at}`,
            kind: 'splitter',
            key: 'Build_ConveyorAttachmentSplitter_C',
            name: 'Splitter',
            item: port.item,
            x: px, y: inY[k], w: ATTACHMENT, h: ATTACHMENT,
            row: index,
          })
          runs.push({
            id: `in:${block.id}:${k}:${at}`,
            item: port.item,
            ratePerMin: port.ratePerMin / count,
            points: [
              { x: px + ATTACHMENT / 2, y: inY[k] + ATTACHMENT },
              { x: px + ATTACHMENT / 2, y: machineY },
            ],
            lanes: 1,
            row: index,
          })
        })

        outputs.forEach((port, k) => {
          const px = x + ((k + 1) * size.w) / (outputs.length + 1) - ATTACHMENT / 2
          buildings.push({
            id: `g:${block.id}:${k}:${at}`,
            kind: 'merger',
            key: 'Build_ConveyorAttachmentMerger_C',
            name: 'Merger',
            item: port.item,
            x: px, y: outY[k], w: ATTACHMENT, h: ATTACHMENT,
            row: index,
          })
          runs.push({
            id: `out:${block.id}:${k}:${at}`,
            item: port.item,
            ratePerMin: port.ratePerMin / count,
            points: [
              { x: px + ATTACHMENT / 2, y: machineY + size.h },
              { x: px + ATTACHMENT / 2, y: outY[k] },
            ],
            lanes: 1,
            row: index,
          })
        })
      }

      // The buses themselves, one per item, running the length of the line.
      const busEnd = lineWidth - size.w / 2
      const share = onLine / count
      inputs.forEach((port, k) => {
        const rate = port.ratePerMin * share
        const need = lanesFor(rate, port.item, settings)
        if (need > 1) {
          warnings.push(
            `${block.machineName} takes ${Math.round(rate)}/min of ${port.item.name} on one line, `
            + `over a ${laneFor(port.item, settings).name} — that bus needs ${need} lines.`,
          )
        }
        runs.push({
          id: `bus-in:${block.id}:${line}:${k}`,
          item: port.item,
          ratePerMin: rate,
          points: [
            { x: -BUS_OFFSET, y: inY[k] + ATTACHMENT / 2 },
            { x: busEnd, y: inY[k] + ATTACHMENT / 2 },
          ],
          lanes: need,
          row: index,
        })
      })
      outputs.forEach((port, k) => {
        const rate = port.ratePerMin * share
        runs.push({
          id: `bus-out:${block.id}:${line}:${k}`,
          item: port.item,
          ratePerMin: rate,
          points: [
            { x: busEnd, y: outY[k] + ATTACHMENT / 2 },
            { x: -BUS_OFFSET, y: outY[k] + ATTACHMENT / 2 },
          ],
          lanes: lanesFor(rate, port.item, settings),
          row: index,
        })
      })

      cursor = (outY[outY.length - 1] ?? machineY + size.h) + ATTACHMENT + ROW_GAP / 2
    }

    const bottom = cursor - ROW_GAP / 2
    rows.push({
      index, step: block.step, raw: block.raw, label: block.label,
      machines: count, perLine, lines,
      inputs, outputs,
      inputRate: inputs.reduce((n, i) => n + i.ratePerMin, 0),
      outputRate: outputs.reduce((n, o) => n + o.ratePerMin, 0),
      made: block.made,
      busInY, busOutY,
      y, height: bottom - y,
    })

    y = bottom + ROW_GAP
  }

  runs.push(...mains(rows, settings))

  const lanes = new Set(rows.flatMap((r) => r.outputs.map((o) => o.item.key)))
  const height = y > 0 ? y - ROW_GAP : 0
  // The buses and the mains live to the left of x=0, so the floor has to reach.
  const left = BUS_OFFSET + ATTACHMENT * (1 + lanes.size)
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

/**
 * The mains down the left, one per item that moves between blocks.
 *
 * Drawing a belt from each producer to each consumer was the other half of what
 * made the picture nonsense: iron rods go to the screws, the rotors and the
 * modular frames, and one link per row left two of those apparently fed by
 * nothing. A main every producer feeds and every consumer taps is both correct
 * and what you would actually build.
 */
function mains(rows: Row[], settings: PlannerSettings): Run[] {
  const runs: Run[] = []
  const order: string[] = []
  for (const row of rows) {
    for (const out of row.outputs) if (!order.includes(out.item.key)) order.push(out.item.key)
  }

  for (const [lane, key] of order.entries()) {
    const x = -BUS_OFFSET - ATTACHMENT * (1 + lane)
    const taps: { y: number; rate: number; row: number; into: boolean }[] = []
    let item: GameItem | null = null

    for (const row of rows) {
      row.outputs.forEach((port, k) => {
        if (port.item.key !== key) return
        item = port.item
        row.busOutY.forEach((line) => {
          taps.push({ y: line[k] + ATTACHMENT / 2, rate: port.ratePerMin / row.lines, row: row.index, into: true })
        })
      })
      row.inputs.forEach((port, k) => {
        if (port.item.key !== key) return
        item = port.item
        row.busInY.forEach((line) => {
          taps.push({ y: line[k] + ATTACHMENT / 2, rate: port.ratePerMin / row.lines, row: row.index, into: false })
        })
      })
    }

    // Nothing downstream wants it, so it never leaves its own block.
    if (!item || !taps.some((t) => t.into) || !taps.some((t) => !t.into)) continue

    const top = Math.min(...taps.map((t) => t.y))
    const bottom = Math.max(...taps.map((t) => t.y))
    const carried = taps.filter((t) => !t.into).reduce((n, t) => n + t.rate, 0)

    runs.push({
      id: `main:${key}`,
      item,
      ratePerMin: carried,
      points: [{ x, y: top }, { x, y: bottom }],
      lanes: lanesFor(carried, item, settings),
      row: -1,
    })

    for (const tap of taps) {
      runs.push({
        id: `tap:${key}:${tap.row}:${Math.round(tap.y)}:${tap.into ? 'in' : 'out'}`,
        item,
        ratePerMin: tap.rate,
        points: tap.into
          ? [{ x: -BUS_OFFSET, y: tap.y }, { x, y: tap.y }]
          : [{ x, y: tap.y }, { x: -BUS_OFFSET, y: tap.y }],
        lanes: 1,
        row: tap.row,
      })
    }
  }

  return runs
}

/** Everything the build needs placing, as a shopping list. */
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
