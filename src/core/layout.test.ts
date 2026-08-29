import { describe, expect, it } from 'vitest'
import { defaultSettings, items } from './gameData'
import { solvePlan } from './solver'
import { billOfMaterials, footprint, layOut, FOUNDATION } from './layout'

const plan = (item: string, rate: number, extra: Partial<ReturnType<typeof defaultSettings>> = {}) => {
  const settings = { ...defaultSettings(), ...extra }
  return { plan: solvePlan([{ item, ratePerMin: rate }], settings), settings }
}

describe('laying a plan out to build', () => {
  it('reads footprints from the game rather than guessing', () => {
    // A Constructor really is 8 m by 10 m, and an Assembler 9 by 16.
    expect(footprint('Build_ConstructorMk1_C')).toEqual({ w: 800, h: 1000 })
    expect(footprint('Build_AssemblerMk1_C')).toEqual({ w: 900, h: 1600 })
    expect(footprint('Build_ConveyorAttachmentSplitter_C')).toEqual({ w: 400, h: 400 })
  })

  it('falls back to a foundation for anything it hasn\u2019t got', () => {
    expect(footprint('Build_NotAThing_C')).toEqual({ w: FOUNDATION, h: FOUNDATION })
  })

  /**
   * One splitter per ingredient per machine, not one per machine. A Modular
   * Frame Assembler eats plate and rod, and a single belt in front of it
   * carrying both is not a thing you can build.
   */
  it('gives every machine a splitter for each ingredient', () => {
    const { plan: p, settings } = plan('Desc_ModularFrame_C', 10)
    const l = layOut(p, settings)
    const machines = l.buildings.filter((b) => b.kind === 'machine').length
    const extractors = p.raw.reduce(
      (n, r) => n + (r.extractor ? Math.ceil(r.extractorCount - 1e-9) : 0), 0)

    // Miners are part of the build: a layout that starts at the smelters is not
    // one you can walk onto and put down.
    expect(extractors).toBeGreaterThan(0)
    expect(machines).toBe(p.totals.machines + extractors)

    expect(l.splitters).toBe(l.rows.reduce((n, r) => n + r.machines * r.inputs.length, 0))
    expect(l.mergers).toBe(l.rows.reduce((n, r) => n + r.machines * r.outputs.length, 0))

    // And at least one row really does take two ingredients, or this proves
    // nothing at all.
    expect(l.rows.some((r) => r.inputs.length > 1)).toBe(true)
  })

  /**
   * Belts that run backwards are worse than no diagram at all. Blocks are dealt
   * into columns, so "before" means earlier in reading order — down a column
   * and then across — rather than simply higher up the page.
   */
  it('puts a block after everything that feeds it', () => {
    const { plan: p, settings } = plan('Desc_ModularFrame_C', 10)
    const l = layOut(p, settings)
    const before = (a: { column: number; y: number }, b: { column: number; y: number }) =>
      a.column < b.column || (a.column === b.column && a.y < b.y)

    for (const row of l.rows) {
      for (const input of row.step?.inputs ?? []) {
        const feeder = l.rows.find((r) => r.made?.key === input.item.key)
        if (!feeder || feeder === row) continue
        expect(feeder.index).toBeLessThan(row.index)
        expect(before(feeder, row)).toBe(true)
      }
    }
  })

  it('never overlaps two machines on a line', () => {
    const { plan: p, settings } = plan('Desc_Rotor_C', 40)
    const l = layOut(p, settings)
    const machines = l.buildings.filter((b) => b.kind === 'machine')

    // Machines wrap onto further lines, so "side by side" means sharing a y.
    const byLine = new Map<string, typeof machines>()
    for (const m of machines) {
      const key = `${m.row}:${m.y}`
      byLine.set(key, [...(byLine.get(key) ?? []), m])
    }
    for (const line of byLine.values()) {
      const sorted = [...line].sort((a, b) => a.x - b.x)
      for (let i = 1; i < sorted.length; i++) {
        expect(sorted[i].x).toBeGreaterThanOrEqual(sorted[i - 1].x + sorted[i - 1].w)
      }
    }
  })

  /**
   * A hundred-and-sixty-metre line is a legal factory nobody builds. Past a
   * handful the machines wrap, which keeps a block a shape you would lay out.
   */
  it('wraps a big block instead of drawing one enormous line', () => {
    const { plan: p, settings } = plan('Desc_IronPlateReinforced_C', 250)
    const l = layOut(p, settings)
    const big = l.rows.filter((r) => r.machines > 12)
    expect(big.length).toBeGreaterThan(0)
    for (const row of big) {
      expect(row.lines).toBeGreaterThan(1)
      expect(row.perLine).toBeLessThan(row.machines)
    }
  })

  /**
   * Iron rods go to the screws, the rotors and the modular frames. One belt per
   * row left two of those apparently fed by nothing.
   */
  it('runs a main every consumer of an item can tap', () => {
    const { plan: p, settings } = plan('Desc_ModularFrame_C', 10)
    const l = layOut(p, settings)
    let checked = 0

    for (const row of l.rows) {
      for (const port of row.inputs) {
        const upstream = l.rows.some((r) => r.index < row.index
          && r.outputs.some((o) => o.item.key === port.item.key))
        if (!upstream) continue
        checked++
        expect(l.runs.some((r) => r.id.startsWith(`main:${port.item.key}:`))).toBe(true)
        expect(l.runs.some((r) => r.id.startsWith(`tap:${port.item.key}:${row.index}:`))).toBe(true)
      }
    }
    expect(checked).toBeGreaterThan(3)
  })

  /** Belts are drawn orthogonally, because that is how they are built. */
  it('routes every belt in right angles', () => {
    const { plan: p, settings } = plan('Desc_ModularFrame_C', 10)
    for (const run of layOut(p, settings).runs) {
      for (let i = 1; i < run.points.length; i++) {
        const a = run.points[i - 1]
        const b = run.points[i]
        expect(a.x === b.x || a.y === b.y).toBe(true)
      }
    }
  })

  /** A bus carries the whole row, so it is the bus that outgrows a belt. */
  it('says when a row needs more than one line to feed it', () => {
    const slow = { ...defaultSettings(), beltKey: 'Build_ConveyorBeltMk1_C' }
    const p = solvePlan([{ item: 'Desc_IronPlate_C', ratePerMin: 600 }], slow)
    const l = layOut(p, slow)
    expect(l.warnings.length).toBeGreaterThan(0)
    expect(l.runs.some((r) => r.lanes > 1)).toBe(true)
  })

  it('adds up what you would have to place', () => {
    const { plan: p, settings } = plan('Desc_IronPlateReinforced_C', 20)
    const l = layOut(p, settings)
    const bom = billOfMaterials(l)
    const total = bom.reduce((n, b) => n + b.count, 0)
    expect(total).toBe(l.buildings.length)
    expect(bom.every((b) => items[b.key] === undefined)).toBe(true)
  })

  it('has nothing to lay out when there is no plan', () => {
    const l = layOut(solvePlan([], defaultSettings()), defaultSettings())
    expect(l.rows).toEqual([])
    expect(l.foundations).toBe(0)
  })
  /** The miners are the top of the build and nothing feeds them. */
  it('lays the extractors out above everything they feed', () => {
    const { plan: p, settings } = plan('Desc_IronPlateReinforced_C', 20)
    const l = layOut(p, settings)
    const mining = l.rows.filter((r) => r.raw)
    expect(mining.length).toBe(p.raw.filter((r) => r.extractor).length)

    for (const row of mining) {
      expect(row.step).toBeNull()
      expect(row.inputRate).toBe(0)
      // First in reading order: nothing feeds a miner.
      for (const other of l.rows.filter((r) => !r.raw)) {
        expect(row.column < other.column || (row.column === other.column && row.y < other.y))
          .toBe(true)
      }
    }
  })

  /**
   * A chain of eight blocks in one column is a hundred metres wide and three
   * hundred long: legal, unreadable, and nothing like how anybody lays out a
   * factory.
   */
  it('deals a long chain into columns rather than one ribbon', () => {
    const { plan: p, settings } = plan('Desc_ModularFrame_C', 10)
    const l = layOut(p, settings)
    expect(l.rows.length).toBeGreaterThan(5)
    expect(l.columns).toBeGreaterThan(1)

    // Every column is used, and the build is a shape rather than a strip.
    for (let c = 0; c < l.columns; c++) {
      expect(l.rows.some((r) => r.column === c)).toBe(true)
    }
    expect(l.height / l.width).toBeLessThan(3)
  })

  /** An item wanted in two columns is carried across the top, not teleported. */
  it('joins the columns it carries an item between', () => {
    const { plan: p, settings } = plan('Desc_ModularFrame_C', 10)
    const l = layOut(p, settings)

    for (const run of l.runs.filter((r) => r.id.startsWith('trunk:'))) {
      const key = run.id.slice('trunk:'.length)
      const columns = new Set(l.runs
        .filter((r) => r.id.startsWith(`main:${key}:`))
        .map((r) => r.id.split(':').pop()))
      // A trunk only exists where the main really does stand in more than one.
      expect(columns.size).toBeGreaterThan(1)
      // And it runs flat across the top, above every block.
      expect(run.points[0].y).toBe(run.points[1].y)
      expect(run.points[0].y).toBeLessThan(Math.min(...l.rows.map((r) => r.y)))
    }
  })
})
