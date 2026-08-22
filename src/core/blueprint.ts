/**
 * Reader for Satisfactory blueprint files (.sbp / .sbpcfg).
 *
 * Layout, confirmed against real blueprints saved by builds 424353 and 502094:
 *
 *   header (plain, uncompressed)
 *     int32   header version        (2)
 *     int32   save version          (52 and 60 both seen in the wild)
 *     int32   game build number
 *     int32   dimensions x, y, z    (in blueprint-designer cells)
 *     int32   item cost count, then per entry:
 *               FString level name (empty) + FString item class path + int32 amount
 *     int32   recipe count, then per entry an object reference
 *
 *   body (Unreal chunked compression, magic 0x9E2A83C1, zlib)
 *     int32   body size
 *     int32   (unread)
 *     int32   object count, then per object:
 *               int32 type (1 actor, 0 component)
 *               FString type path, root object, instance name
 *               int32 flags
 *               actor:     int32 needTransform, 10 floats, int32 wasPlacedInLevel
 *               component: FString parent actor name
 *
 * Only the object headers are read. That is enough for what the blueprint is
 * made of; decoding each object's property block would be needed for per-machine
 * recipe settings, which is a much larger job and not attempted here.
 */

import { buildings, gameData, items } from './gameData'
import type { GameItem } from './types'

const CHUNK_MAGIC = 0x9e2a83c1
const CHUNK_HEADER_BYTES = 49

export interface BlueprintCost {
  key: string
  item: GameItem | null
  name: string
  amount: number
}

export interface BlueprintBuilding {
  key: string
  name: string
  count: number
  /** True when this is a machine the planner knows how to run recipes on. */
  isProduction: boolean
}

export interface BlueprintInfo {
  name: string
  headerVersion: number
  saveVersion: number
  buildVersion: number
  dimensions: { x: number; y: number; z: number }
  cost: BlueprintCost[]
  buildings: BlueprintBuilding[]
  productionBuildings: BlueprintBuilding[]
  totalBuildings: number
  objectCount: number
  /** Build recipes referenced by the header, useful when the body won't parse. */
  recipeRefs: string[]
  warnings: string[]
}

class Reader {
  private view: DataView
  offset = 0

  constructor(private bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  }

  get length(): number { return this.bytes.length }
  get remaining(): number { return this.bytes.length - this.offset }

  int32(): number {
    const v = this.view.getInt32(this.offset, true)
    this.offset += 4
    return v
  }

  int64(): number {
    // Blueprint sizes stay far below 2^53, so a Number is safe here.
    const v = this.view.getBigInt64(this.offset, true)
    this.offset += 8
    return Number(v)
  }

  uint32(): number {
    const v = this.view.getUint32(this.offset, true)
    this.offset += 4
    return v
  }

  skip(n: number): void { this.offset += n }

  /** Unreal FString: positive length is ASCII, negative is UTF-16, both null-terminated. */
  string(): string {
    const len = this.int32()
    if (len === 0) return ''
    if (len > 0) {
      if (len > 4096 || this.offset + len > this.length) throw new RangeError('bad string length')
      const raw = this.bytes.subarray(this.offset, this.offset + len - 1)
      this.offset += len
      return new TextDecoder('utf-8').decode(raw)
    }
    const bytes = -len * 2
    if (bytes > 8192 || this.offset + bytes > this.length) throw new RangeError('bad string length')
    const raw = this.bytes.subarray(this.offset, this.offset + bytes - 2)
    this.offset += bytes
    return new TextDecoder('utf-16le').decode(raw)
  }

  /** Object reference: level name then path name. */
  objectRef(): string {
    this.string()
    return this.string()
  }
}

/** Trailing class name from an Unreal object path. */
function className(path: string): string {
  const dot = path.lastIndexOf('.')
  return dot >= 0 ? path.slice(dot + 1) : path
}

/** Inflate every compression chunk in the file and concatenate the results. */
async function inflateBody(bytes: Uint8Array, start: number): Promise<Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const parts: Uint8Array[] = []
  let offset = start
  let total = 0

  while (offset + CHUNK_HEADER_BYTES <= bytes.length) {
    if (view.getUint32(offset, true) !== CHUNK_MAGIC) break
    const compressed = Number(view.getBigInt64(offset + 33, true))
    const from = offset + CHUNK_HEADER_BYTES
    if (compressed <= 0 || from + compressed > bytes.length) break

    const slice = bytes.subarray(from, from + compressed)
    // 'deflate' in the Compression Streams API is zlib-wrapped, which is what
    // Unreal writes here.
    const stream = new Response(new Blob([slice as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate')))
    const chunk = new Uint8Array(await stream.arrayBuffer())
    parts.push(chunk)
    total += chunk.length
    offset = from + compressed
  }

  const out = new Uint8Array(total)
  let at = 0
  for (const p of parts) { out.set(p, at); at += p.length }
  return out
}

function findChunkStart(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  for (let i = 0; i + 4 <= bytes.length; i++) {
    if (view.getUint32(i, true) === CHUNK_MAGIC) return i
  }
  return -1
}

interface ParsedObject { type: number; typePath: string }

/**
 * Read the object list. `flagBytes` covers a field whose width has changed
 * between save versions, so callers try the known widths and keep whichever
 * consumes the list cleanly.
 */
function readObjects(body: Uint8Array, flagBytes: number): ParsedObject[] | null {
  try {
    const r = new Reader(body)
    r.skip(8) // body size, then a field we don't need
    const count = r.int32()
    if (count < 0 || count > 500_000) return null

    const objects: ParsedObject[] = []
    for (let i = 0; i < count; i++) {
      if (r.remaining < 4) return null
      const type = r.int32()
      if (type !== 0 && type !== 1) return null

      const typePath = r.string()
      r.string() // root object
      r.string() // instance name
      r.skip(flagBytes)

      if (type === 1) {
        // needTransform + rotation/position/scale + wasPlacedInLevel
        r.skip(4 + 40 + 4)
      } else {
        r.string() // parent actor name
      }
      if (r.offset > body.length) return null
      objects.push({ type, typePath })
    }
    return objects
  } catch {
    return null
  }
}

export async function parseBlueprint(file: ArrayBuffer, name: string): Promise<BlueprintInfo> {
  const bytes = new Uint8Array(file)
  const warnings: string[] = []
  const r = new Reader(bytes)

  const headerVersion = r.int32()
  const saveVersion = r.int32()
  const buildVersion = r.int32()
  const dimensions = { x: r.int32(), y: r.int32(), z: r.int32() }

  const cost: BlueprintCost[] = []
  const costCount = r.int32()
  if (costCount < 0 || costCount > 1000) {
    throw new Error('This does not look like a Satisfactory blueprint (.sbp).')
  }
  for (let i = 0; i < costCount; i++) {
    const path = r.objectRef()
    const amount = r.int32()
    const key = className(path)
    cost.push({ key, item: items[key] ?? null, name: items[key]?.name ?? key, amount })
  }

  const recipeRefs: string[] = []
  try {
    const recipeCount = r.int32()
    if (recipeCount >= 0 && recipeCount < 2000) {
      for (let i = 0; i < recipeCount; i++) recipeRefs.push(className(r.objectRef()))
    }
  } catch {
    // The recipe list is a bonus; the cost list above is what matters.
  }

  if (buildVersion !== 0 && Math.abs(buildVersion) > 1e9) {
    warnings.push('Header looks unusual; the file may be from a much newer game build.')
  }

  let objects: ParsedObject[] = []
  const chunkStart = findChunkStart(bytes)
  if (chunkStart < 0) {
    warnings.push('No compressed section found, so the building list is unavailable.')
  } else {
    try {
      const body = await inflateBody(bytes, chunkStart)
      let parsed: ParsedObject[] | null = null
      for (const flagBytes of [4, 0, 8]) {
        parsed = readObjects(body, flagBytes)
        if (parsed) break
      }
      if (parsed) objects = parsed
      else warnings.push(`Could not read the object list for save version ${saveVersion}; showing the build cost only.`)
    } catch {
      warnings.push('The compressed section could not be decoded, so the building list is unavailable.')
    }
  }

  const counts = new Map<string, number>()
  for (const o of objects) {
    if (o.type !== 1) continue
    const key = className(o.typePath)
    if (!key.startsWith('Build_')) continue
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }

  const names = (gameData as unknown as { buildableNames?: Record<string, string> }).buildableNames ?? {}
  const list: BlueprintBuilding[] = [...counts.entries()]
    .map(([key, count]) => ({
      key,
      name: names[key] ?? key.replace(/^Build_/, '').replace(/_C$/, ''),
      count,
      isProduction: Boolean(buildings[key]),
    }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))

  return {
    name,
    headerVersion,
    saveVersion,
    buildVersion,
    dimensions,
    cost: cost.sort((a, b) => b.amount - a.amount),
    buildings: list,
    productionBuildings: list.filter((b) => b.isProduction),
    totalBuildings: list.reduce((n, b) => n + b.count, 0),
    objectCount: objects.length,
    recipeRefs,
    warnings,
  }
}
