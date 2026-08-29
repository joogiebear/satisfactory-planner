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
 * Three things it will not do. It will not run a line off the end of the map —
 * past about a hundred metres the machines wrap onto another line, the way
 * anybody actually building it would. It will not pretend a recipe has one
 * ingredient: a Modular Frame Assembler eats plate and rod, so it gets a bus
 * for each, and each of those buses comes off a main that every consumer of
 * that item taps. And it will not stack every block down one side of the map:
 * blocks are dealt into columns until the build is a shape you can see at once,
 * with the mains carried between columns on a trunk across the top.
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
  /** Which column of the build this block sits in. */
  column: number
  /** Top-left of the block, so the drawing can box it. */
  x: number
  width: number
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

/** A machine's box before its block has been placed. */
interface LocalBox { id: string; x: number; y: number; w: number; h: number }
interface LocalAttachment {
  id: string
  kind: 'splitter' | 'merger'
  item: GameItem
  x: number
  y: number
}
interface LocalRun {
  id: string
  item: GameItem
  ratePerMin: number
  points: { x: number; y: number }[]
}

/** One block measured against its own corner, ready to be placed anywhere. */
interface Laid {
  block: Block
  perLine: number
  lines: number
  size: Size
  machines: LocalBox[]
  attachments: LocalAttachment[]
  drops: LocalRun[]
  busInY: number[][]
  busOutY: number[][]
  /** Where each line's buses stop. */
  busEnd: number[]
  width: number
  height: number
  settings: PlannerSettings
}

export interface Layout {
  buildings: Placed[]
  runs: Run[]
  rows: Row[]
  /** How many columns the blocks were dealt into. */
  columns: number
  /** Top-left of everything drawn, mains and trunks included. */
  minX: number
  minY: number
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

/**
 * Measure one block: where its machines, attachments and buses sit, relative to
 * its own top-left corner.
 *
 * Measuring before placing is what lets blocks be packed into columns. Laying
 * them out straight into world coordinates meant the shape of the build was
 * decided by the order they happened to be emitted in, which is how eight
 * blocks became a three-hundred-metre ribbon down one side of the map.
 */
function measure(block: Block, settings: PlannerSettings): Laid {
  const { count, inputs, outputs } = block
  const size = footprint(block.machineKey)
  const perLine = machinesPerLine(count, size)
  const lines = Math.ceil(count / perLine)

  const machines: LocalBox[] = []
  const attachments: LocalAttachment[] = []
  const drops: LocalRun[] = []
  const busInY: number[][] = []
  const busOutY: number[][] = []
  const busEnd: number[] = []

  let cursor = 0
  let width = 0

  for (let line = 0; line < lines; line++) {
    const onLine = Math.min(perLine, count - line * perLine)
    const lineWidth = onLine * size.w + (onLine - 1) * MACHINE_GAP
    width = Math.max(width, lineWidth)
    busEnd.push(lineWidth - size.w / 2)

    const inY = inputs.map((_, k) => cursor + k * BUS_PITCH)
    const machineY = cursor + (inputs.length ? inputs.length * BUS_PITCH : 0) + BUS_OFFSET
    const outTop = machineY + size.h + BUS_OFFSET
    const outY = outputs.map((_, k) => outTop + k * BUS_PITCH)
    busInY.push(inY)
    busOutY.push(outY)

    for (let i = 0; i < onLine; i++) {
      const at = line * perLine + i
      const x = i * (size.w + MACHINE_GAP)
      machines.push({ id: `${at}`, x, y: machineY, w: size.w, h: size.h })

      // Each ingredient takes its own share of the machine's frontage, so two
      // drops land side by side rather than on top of one another.
      inputs.forEach((port, k) => {
        const px = x + ((k + 1) * size.w) / (inputs.length + 1) - ATTACHMENT / 2
        attachments.push({ id: `s:${k}:${at}`, kind: 'splitter', item: port.item, x: px, y: inY[k] })
        drops.push({
          id: `in:${k}:${at}`,
          item: port.item,
          ratePerMin: port.ratePerMin / count,
          points: [
            { x: px + ATTACHMENT / 2, y: inY[k] + ATTACHMENT },
            { x: px + ATTACHMENT / 2, y: machineY },
          ],
        })
      })

      outputs.forEach((port, k) => {
        const px = x + ((k + 1) * size.w) / (outputs.length + 1) - ATTACHMENT / 2
        attachments.push({ id: `g:${k}:${at}`, kind: 'merger', item: port.item, x: px, y: outY[k] })
        drops.push({
          id: `out:${k}:${at}`,
          item: port.item,
          ratePerMin: port.ratePerMin / count,
          points: [
            { x: px + ATTACHMENT / 2, y: machineY + size.h },
            { x: px + ATTACHMENT / 2, y: outY[k] },
          ],
        })
      })
    }

    cursor = (outY[outY.length - 1] ?? machineY + size.h) + ATTACHMENT + ROW_GAP / 2
  }

  return {
    block, perLine, lines, size,
    machines, attachments, drops,
    busInY, busOutY, busEnd,
    width,
    height: cursor - ROW_GAP / 2,
    settings,
  }
}

/**
 * Deal the blocks into columns so the build is a shape rather than a ribbon.
 *
 * Stacked in one column, a chain of eight blocks is a hundred metres wide and
 * three hundred long — legal, unreadable, and nothing like how anybody lays out
 * a factory. Filling a column to roughly the height that would make the whole
 * thing square, then starting another, gets it back to a footprint you can see
 * at once. Feed order is preserved down each column and then across, so the
 * belts still run one way.
 */
function intoColumns(laid: Laid[], gutter: number): { column: number; x: number; y: number }[] {
  const colWidth = Math.max(...laid.map((l) => l.width), FOUNDATION)
  const stacked = laid.reduce((n, l) => n + l.height + ROW_GAP, 0)
  const columns = Math.max(1, Math.min(4, Math.round(Math.sqrt(stacked / (colWidth + gutter)))))
  const target = stacked / columns

  const placed: { column: number; x: number; y: number }[] = []
  let column = 0
  let y = 0

  for (const l of laid) {
    // Start a new column once this one has had its share — but never leave a
    // column empty, and never spill past the last one.
    if (y > 0 && y + l.height / 2 > target && column < columns - 1) {
      column++
      y = 0
    }
    placed.push({ column, x: column * (colWidth + gutter), y })
    y += l.height + ROW_GAP
  }
  return placed
}

/**
 * Lay a plan out as blocks of machines with the belts that feed them.
 *
 * A block is a whole production step: every Constructor making iron rods sits
 * together, wrapped onto as many lines as it takes. Blocks are measured, dealt
 * into columns so the build is a shape rather than a ribbon, and then every
 * item that moves between them runs on a main its producers feed and all of its
 * consumers tap.
 */
export function layOut(plan: Plan, settings: PlannerSettings): Layout {
  const blocks = blocksOf(plan)
  const laid = blocks.map((b) => measure(b, settings))
  if (!laid.length) {
    return {
      buildings: [], runs: [], rows: [], columns: 0,
      minX: 0, minY: 0, width: 0, height: 0,
      foundations: 0, beltMetres: 0, splitters: 0, mergers: 0, warnings: [],
    }
  }

  // Every item that leaves a block gets a lane of its own in the corridors, so
  // the gutter has to be wide enough for all of them.
  const carried: string[] = []
  for (const l of laid) {
    for (const out of l.block.outputs) {
      const wanted = laid.some((other) => other !== l
        && other.block.inputs.some((i) => i.item.key === out.item.key))
      if (wanted && !carried.includes(out.item.key)) carried.push(out.item.key)
    }
  }
  const corridor = BUS_OFFSET + ATTACHMENT * (1 + carried.length)
  const gutter = corridor + FOUNDATION

  const spots = intoColumns(laid, gutter)

  const buildings: Placed[] = []
  const runs: Run[] = []
  const rows: Row[] = []
  const warnings: string[] = []

  for (const [index, l] of laid.entries()) {
    const { x: ox, y: oy, column } = spots[index]
    const { block } = l

    for (const m of l.machines) {
      buildings.push({
        id: `m:${block.id}:${m.id}`,
        kind: 'machine',
        key: block.machineKey,
        name: block.machineName,
        item: block.made,
        x: ox + m.x, y: oy + m.y, w: m.w, h: m.h,
        row: index,
      })
    }
    for (const a of l.attachments) {
      buildings.push({
        id: `${a.kind[0]}:${block.id}:${a.id}`,
        kind: a.kind,
        key: a.kind === 'splitter'
          ? 'Build_ConveyorAttachmentSplitter_C'
          : 'Build_ConveyorAttachmentMerger_C',
        name: a.kind === 'splitter' ? 'Splitter' : 'Merger',
        item: a.item,
        x: ox + a.x, y: oy + a.y, w: ATTACHMENT, h: ATTACHMENT,
        row: index,
      })
    }
    for (const d of l.drops) {
      runs.push({
        id: `${block.id}:${d.id}`,
        item: d.item,
        ratePerMin: d.ratePerMin,
        points: d.points.map((p) => ({ x: ox + p.x, y: oy + p.y })),
        lanes: 1,
        row: index,
      })
    }

    // The buses, one per item per line, running the length of the line.
    for (let line = 0; line < l.lines; line++) {
      const onLine = Math.min(l.perLine, block.count - line * l.perLine)
      const share = onLine / block.count
      const end = ox + l.busEnd[line]

      block.inputs.forEach((port, k) => {
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
            { x: ox - BUS_OFFSET, y: oy + l.busInY[line][k] + ATTACHMENT / 2 },
            { x: end, y: oy + l.busInY[line][k] + ATTACHMENT / 2 },
          ],
          lanes: need,
          row: index,
        })
      })
      block.outputs.forEach((port, k) => {
        const rate = port.ratePerMin * share
        runs.push({
          id: `bus-out:${block.id}:${line}:${k}`,
          item: port.item,
          ratePerMin: rate,
          points: [
            { x: end, y: oy + l.busOutY[line][k] + ATTACHMENT / 2 },
            { x: ox - BUS_OFFSET, y: oy + l.busOutY[line][k] + ATTACHMENT / 2 },
          ],
          lanes: lanesFor(rate, port.item, settings),
          row: index,
        })
      })
    }

    rows.push({
      index, column,
      step: block.step, raw: block.raw, label: block.label,
      machines: block.count, perLine: l.perLine, lines: l.lines,
      inputs: block.inputs, outputs: block.outputs,
      inputRate: block.inputs.reduce((n, i) => n + i.ratePerMin, 0),
      outputRate: block.outputs.reduce((n, o) => n + o.ratePerMin, 0),
      made: block.made,
      busInY: l.busInY.map((line) => line.map((v) => oy + v)),
      busOutY: l.busOutY.map((line) => line.map((v) => oy + v)),
      x: ox, y: oy, width: l.width, height: l.height,
    })
  }

  const colX = [...new Set(spots.map((s) => s.x))].sort((a, b) => a - b)
  const trunk = mains(rows, carried, colX, settings)
  runs.push(...trunk.runs)

  const right = Math.max(...rows.map((r) => r.x + r.width))
  const bottom = Math.max(...rows.map((r) => r.y + r.height))
  const left = -corridor
  const beltMetres = runs.reduce((n, r) => {
    let d = 0
    for (let i = 1; i < r.points.length; i++) {
      d += Math.abs(r.points[i].x - r.points[i - 1].x) + Math.abs(r.points[i].y - r.points[i - 1].y)
    }
    return n + (d * r.lanes) / 100
  }, 0)

  const width = right - left
  const height = bottom - trunk.top
  return {
    buildings,
    runs,
    rows,
    columns: colX.length,
    minX: left,
    minY: trunk.top,
    width,
    height,
    foundations: Math.ceil(width / FOUNDATION) * Math.ceil(height / FOUNDATION),
    beltMetres: Math.round(beltMetres),
    splitters: buildings.filter((b) => b.kind === 'splitter').length,
    mergers: buildings.filter((b) => b.kind === 'merger').length,
    warnings: [...new Set(warnings)],
  }
}

/**
 * The mains: one per item that moves between blocks.
 *
 * Each runs vertically in the corridor to the left of every column it touches,
 * and where it touches more than one those verticals are joined by a trunk
 * across the top of the build. Producers feed it, consumers tap it. Drawing a
 * belt from each producer to each consumer instead was the other half of what
 * made the picture nonsense: iron rods go to the screws, the rotors and the
 * modular frames, and one link per row left two of those fed by nothing.
 */
function mains(
  rows: Row[], carried: string[], colX: number[], settings: PlannerSettings,
): { runs: Run[]; top: number } {
  const runs: Run[] = []
  let top = 0

  for (const [lane, key] of carried.entries()) {
    const offset = BUS_OFFSET + ATTACHMENT * (1 + lane)
    const taps: { column: number; x: number; y: number; rate: number; row: number; into: boolean }[] = []
    let item: GameItem | null = null

    for (const row of rows) {
      const at = colX.indexOf(row.x)
      row.outputs.forEach((port, k) => {
        if (port.item.key !== key) return
        item = port.item
        row.busOutY.forEach((line) => taps.push({
          column: at, x: row.x, y: line[k] + ATTACHMENT / 2,
          rate: port.ratePerMin / row.lines, row: row.index, into: true,
        }))
      })
      row.inputs.forEach((port, k) => {
        if (port.item.key !== key) return
        item = port.item
        row.busInY.forEach((line) => taps.push({
          column: at, x: row.x, y: line[k] + ATTACHMENT / 2,
          rate: port.ratePerMin / row.lines, row: row.index, into: false,
        }))
      })
    }
    if (!item || !taps.some((t) => t.into) || !taps.some((t) => !t.into)) continue

    const columns = [...new Set(taps.map((t) => t.column))].sort((a, b) => a - b)
    const demand = taps.filter((t) => !t.into).reduce((n, t) => n + t.rate, 0)
    const lanes = lanesFor(demand, item, settings)
    const trunkY = -(FOUNDATION + ATTACHMENT * (1 + lane))
    if (columns.length > 1) top = Math.min(top, trunkY)

    for (const column of columns) {
      const here = taps.filter((t) => t.column === column)
      const x = colX[column] - offset
      const highest = Math.min(...here.map((t) => t.y))
      const lowest = Math.max(...here.map((t) => t.y))

      runs.push({
        id: `main:${key}:${column}`,
        item,
        ratePerMin: demand,
        points: [
          { x, y: columns.length > 1 ? trunkY : highest },
          { x, y: lowest },
        ],
        lanes,
        row: -1,
      })

      for (const tap of here) {
        runs.push({
          id: `tap:${key}:${tap.row}:${Math.round(tap.y)}:${tap.into ? 'in' : 'out'}`,
          item,
          ratePerMin: tap.rate,
          points: tap.into
            ? [{ x: tap.x - BUS_OFFSET, y: tap.y }, { x, y: tap.y }]
            : [{ x, y: tap.y }, { x: tap.x - BUS_OFFSET, y: tap.y }],
          lanes: 1,
          row: tap.row,
        })
      }
    }

    // Join the columns across the top, which is the only clear run there is.
    if (columns.length > 1) {
      runs.push({
        id: `trunk:${key}`,
        item,
        ratePerMin: demand,
        points: [
          { x: colX[columns[0]] - offset, y: trunkY },
          { x: colX[columns[columns.length - 1]] - offset, y: trunkY },
        ],
        lanes,
        row: -1,
      })
    }
  }

  return { runs, top }
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
