/**
 * Turns a solved Plan into a machine-to-machine flow graph.
 *
 * The plan tells us how fast each recipe runs, but not which machine feeds
 * which. Every item is balanced overall, so supply is split across the machines
 * that want it in proportion to how much each side handles: a Smelter making a
 * third of the iron ingots sends a third of its output to each consumer. Because
 * total supply equals total demand for every item, the split conserves flow
 * exactly.
 */

import type { PowerOption } from '../../core/power'
import type { GameItem, Plan, ProductionStep, RawRequirement } from '../../core/types'

export type FlowNodeKind = 'machine' | 'source' | 'sink' | 'byproduct' | 'power'

export interface Port {
  item: GameItem
  ratePerMin: number
}

export interface FlowNodeData extends Record<string, unknown> {
  kind: FlowNodeKind
  title: string
  subtitle: string
  item: GameItem | null
  step: ProductionStep | null
  raw: RawRequirement | null
  /** Set on the power node: how the factory's draw would be covered. */
  power: PowerOption | null
  /** Whole machines to build. */
  count: number
  powerMW: number
  inputs: Port[]
  outputs: Port[]
  width: number
  height: number
}

export interface FlowEdgeData extends Record<string, unknown> {
  item: GameItem
  ratePerMin: number
}

export interface GraphNode {
  id: string
  data: FlowNodeData
}

export interface GraphEdge {
  id: string
  source: string
  target: string
  sourceHandle: string
  targetHandle: string
  data: FlowEdgeData
}

export const NODE_WIDTH = 268
const HEADER_HEIGHT = 52
const ROW_HEIGHT = 22
const SECTION_PAD = 10

export function nodeHeight(inputs: number, outputs: number): number {
  const rows = Math.max(1, inputs) + Math.max(1, outputs)
  return HEADER_HEIGHT + rows * ROW_HEIGHT + SECTION_PAD * 2
}

const EPS = 1e-7

interface Supplier { nodeId: string; rate: number }
interface Consumer { nodeId: string; rate: number }

export function buildGraph(
  plan: Plan, power: PowerOption | null = null,
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes: GraphNode[] = []

  // --- machines ---
  for (const step of plan.steps) {
    const inputs: Port[] = step.inputs.map((i) => ({ item: i.item, ratePerMin: i.ratePerMin }))
    const outputs: Port[] = step.outputs.map((o) => ({ item: o.item, ratePerMin: o.ratePerMin }))
    const count = Math.ceil(step.machines - 1e-9)
    nodes.push({
      id: `step:${step.recipe.key}`,
      data: {
        kind: 'machine',
        title: `${count}× ${step.building?.name ?? 'Machine'}`,
        subtitle: step.recipe.isAlternate ? `Alt: ${step.recipe.name}` : step.recipe.name,
        item: step.primaryItem,
        step,
        raw: null,
        power: null,
        count,
        powerMW: step.powerMW,
        inputs,
        outputs,
        width: NODE_WIDTH,
        height: nodeHeight(inputs.length, outputs.length),
      },
    })
  }

  // --- extraction / imports ---
  for (const raw of plan.raw) {
    const count = raw.extractor ? Math.ceil(raw.extractorCount - 1e-9) : 0
    nodes.push({
      id: `source:${raw.item.key}`,
      data: {
        kind: 'source',
        title: raw.extractor ? `${count}× ${raw.extractor.name}` : 'Imported',
        subtitle: raw.purity ? `${raw.purity} node` : raw.extractor ? 'unlimited' : 'supplied externally',
        item: raw.item,
        step: null,
        raw,
        power: null,
        count,
        powerMW: raw.powerMW,
        inputs: [],
        outputs: [{ item: raw.item, ratePerMin: raw.ratePerMin }],
        width: NODE_WIDTH,
        height: nodeHeight(0, 1),
      },
    })
  }

  // --- final outputs ---
  for (const target of plan.targets) {
    const item = plan.steps.find((s) => s.outputs.some((o) => o.item.key === target.item))
      ?.outputs.find((o) => o.item.key === target.item)?.item
      ?? plan.raw.find((r) => r.item.key === target.item)?.item
    if (!item) continue
    nodes.push({
      id: `sink:${target.item}`,
      data: {
        kind: 'sink',
        title: item.name,
        subtitle: 'target output',
        item,
        step: null,
        raw: null,
        power: null,
        count: 0,
        powerMW: 0,
        inputs: [{ item, ratePerMin: target.ratePerMin }],
        outputs: [],
        width: NODE_WIDTH,
        height: nodeHeight(1, 0),
      },
    })
  }

  // --- leftover byproducts ---
  for (const bp of plan.byproducts) {
    nodes.push({
      id: `byproduct:${bp.item.key}`,
      data: {
        kind: 'byproduct',
        title: bp.item.name,
        subtitle: 'surplus — sink or store',
        item: bp.item,
        step: null,
        raw: null,
        power: null,
        count: 0,
        powerMW: 0,
        inputs: [{ item: bp.item, ratePerMin: bp.ratePerMin }],
        outputs: [],
        width: NODE_WIDTH,
        height: nodeHeight(1, 0),
      },
    })
  }

  // --- the plant that would run all this ---
  //
  // Deliberately wired to nothing. The generators are not part of the plan
  // until you ask for their fuel, and giving them edges would put fuel the
  // factory does not yet make into a graph that balances exactly.
  if (power) {
    const units = Math.ceil(power.units - 1e-9)
    const inputs: Port[] = [{ item: power.fuelItem, ratePerMin: power.fuelPerMin }]
    if (power.supplementalItem && power.supplementalPerMin > 0) {
      inputs.push({ item: power.supplementalItem, ratePerMin: power.supplementalPerMin })
    }
    const outputs: Port[] = power.byproductItem && power.byproductPerMin > 0
      ? [{ item: power.byproductItem, ratePerMin: power.byproductPerMin }]
      : []
    nodes.push({
      id: 'power',
      data: {
        kind: 'power',
        title: `${units}× ${power.generator.name}`,
        // Generation minus what the fuel plant draws is what the factory on the
        // canvas actually gets, and that is the number worth reading here.
        subtitle: `covers ${Math.round(power.outputMW - power.overheadMW)} MW of factory`,
        item: power.fuelItem,
        step: null,
        raw: null,
        power,
        count: units,
        powerMW: 0,
        inputs,
        outputs,
        width: NODE_WIDTH,
        height: nodeHeight(inputs.length, outputs.length),
      },
    })
  }

  // --- wire them together, one item at a time ---
  const suppliers = new Map<string, Supplier[]>()
  const consumers = new Map<string, Consumer[]>()
  const add = (map: Map<string, { nodeId: string; rate: number }[]>, key: string, entry: { nodeId: string; rate: number }) => {
    const list = map.get(key) ?? []
    list.push(entry)
    map.set(key, list)
  }

  for (const node of nodes) {
    if (node.data.kind === 'power') continue
    for (const out of node.data.outputs) {
      if (out.ratePerMin > EPS) add(suppliers, out.item.key, { nodeId: node.id, rate: out.ratePerMin })
    }
    for (const inp of node.data.inputs) {
      if (inp.ratePerMin > EPS) add(consumers, inp.item.key, { nodeId: node.id, rate: inp.ratePerMin })
    }
  }

  const edges: GraphEdge[] = []
  for (const [itemKey, from] of suppliers) {
    const to = consumers.get(itemKey)
    if (!to?.length) continue
    const supply = from.reduce((n, s) => n + s.rate, 0)
    if (supply <= EPS) continue

    for (const supplier of from) {
      const share = supplier.rate / supply
      for (const consumer of to) {
        const rate = consumer.rate * share
        if (rate <= 1e-4) continue
        const item = nodes.find((n) => n.id === supplier.nodeId)!
          .data.outputs.find((o) => o.item.key === itemKey)!.item
        edges.push({
          id: `${supplier.nodeId}->${consumer.nodeId}:${itemKey}`,
          source: supplier.nodeId,
          target: consumer.nodeId,
          sourceHandle: `out:${itemKey}`,
          targetHandle: `in:${itemKey}`,
          data: { item, ratePerMin: rate },
        })
      }
    }
  }

  return { nodes, edges }
}
