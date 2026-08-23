/**
 * What the map actually holds, counted out of the game's own level.
 *
 * The planner has always taken your word for a survey — three iron nodes, one
 * pure — with no idea whether three was plausible or whether pure iron exists
 * at all. The numbers are not in any data table: resource nodes are actors
 * placed in the world, and the world is a World Partition level split across a
 * few thousand cells. They are counted on extraction, from your own copy,
 * alongside the models and icons, and nothing is bundled or downloaded.
 *
 * Absent an extraction this is simply empty, and every count goes back to being
 * taken on trust.
 */

import type { Purity } from './types'

/** Nodes take a miner; wells take a pressuriser and its satellites. */
export type NodeKind = 'node' | 'well'

export type NodeCounts = Record<string, Partial<Record<NodeKind, Partial<Record<Purity, number>>>>>

let counts: NodeCounts = {}

export async function refreshMapNodes(): Promise<number> {
  const api = typeof window !== 'undefined' ? window.meshApi : undefined
  if (!api?.nodes) return 0
  try {
    counts = (await api.nodes()) ?? {}
  } catch {
    counts = {}
  }
  return Object.keys(counts).length
}

/** True once the map has been counted; until then nothing here constrains anything. */
export const hasMapNodes = () => Object.keys(counts).length > 0

/** Every node of a resource, whatever its purity or kind. */
export function nodesOf(item: string): number {
  const kinds = counts[item]
  if (!kinds) return 0
  let total = 0
  for (const byPurity of Object.values(kinds)) {
    for (const n of Object.values(byPurity ?? {})) total += n ?? 0
  }
  return total
}

/** How many of one purity exist, across nodes and wells alike. */
export function nodesAt(item: string, purity: Purity): number {
  const kinds = counts[item]
  if (!kinds) return 0
  let total = 0
  for (const byPurity of Object.values(kinds)) total += byPurity?.[purity] ?? 0
  return total
}

/** The three purities with their counts, for showing what a resource offers. */
export function spread(item: string): { purity: Purity; count: number }[] {
  return (['impure', 'normal', 'pure'] as const)
    .map((purity) => ({ purity, count: nodesAt(item, purity) }))
    .filter((p) => p.count > 0)
}

/** Resources the map has at all, so a survey can't name one that isn't there. */
export function surveyed(): string[] {
  return Object.keys(counts)
}
