/**
 * Where the blueprint viewer gets its building geometry.
 *
 * In the desktop app the meshes are extracted on first run from the copy of
 * Satisfactory on that machine and served from the app's data folder over the
 * `mesh://` scheme. Nothing of the game's is bundled or redistributed.
 *
 * A building is rarely a single mesh: a window wall is a frame plus a pane, and
 * a foundation's mesh sits below its actor origin, so the manifest gives every
 * part its own offset, rotation and scale.
 */

/** One drawable piece of a building, positioned relative to the actor. */
export interface MeshPart {
  file: string
  /** Centimetres, in the game's axes. */
  loc: [number, number, number]
  /** Quaternion, x y z w. */
  rot: [number, number, number, number]
  scale: [number, number, number]
  /** Glass and windows are drawn see-through. */
  glass?: boolean
  /**
   * Belts, lifts and pipes repeat this mesh along a spline in game. The path
   * lives in the save data rather than the asset, so one segment is drawn at
   * the recorded position instead of the full run.
   */
  spline?: boolean
  /**
   * A conveyor lift's column section, repeated every this many centimetres
   * from the base until it reaches that lift's own height.
   */
  stackEvery?: number | null
  /** A conveyor lift's head, which sits at the lift's own height. */
  atTop?: boolean | null
  /** Base-colour map for this mesh, if the game had one. */
  texture?: string | null
}

const bundledMeshes = import.meta.glob('../../data/meshes/*.glb', {
  eager: true,
  query: '?url',
  import: 'default',
})
const bundledTextures = import.meta.glob('../../data/meshes/*.albedo.jpg', {
  eager: true,
  query: '?url',
  import: 'default',
})
const bundledManifest = import.meta.glob('../../data/meshes/manifest.json', { eager: true })

const bundledUrls: Record<string, string> = {}
for (const [path, url] of Object.entries({ ...bundledMeshes, ...bundledTextures })) {
  const key = path.split('/').pop()
  if (key) bundledUrls[key] = url as string
}

const bundledParts: Record<string, MeshPart[]> =
  (Object.values(bundledManifest)[0] as { default?: Record<string, MeshPart[]> })?.default ?? {}

export interface MeshStatus {
  count: number
  meshFiles?: number
  dir: string
  exporterAvailable: boolean
  detectedGame: string | null
}

export interface MeshProgress {
  phase: 'reading' | 'optimising' | 'done'
  done: number
  total: number
  message: string
}

interface MeshApi {
  status(): Promise<MeshStatus>
  manifest(): Promise<Record<string, MeshPart[]>>
  browse(): Promise<{ dir: string; valid: boolean } | null>
  extract(gameDir: string): Promise<{ ok: boolean; count?: number; dir?: string; error?: string }>
  clear(): Promise<MeshStatus>
  onProgress(callback: (progress: MeshProgress) => void): () => void
}

declare global {
  interface Window {
    meshApi?: MeshApi
    appInfo?: { isElectron?: boolean }
  }
}

export const meshApi: MeshApi | undefined =
  typeof window !== 'undefined' ? window.meshApi : undefined

export const isDesktop = Boolean(meshApi)

let extracted: Record<string, MeshPart[]> = {}

export async function refreshMeshManifest(): Promise<number> {
  if (!meshApi) return 0
  try {
    extracted = await meshApi.manifest()
  } catch {
    extracted = {}
  }
  return Object.keys(extracted).length
}

/** The parts that draw a building, or an empty list to fall back to a box. */
export function partsFor(buildableKey: string): MeshPart[] {
  const found = extracted[buildableKey] ?? bundledParts[buildableKey]
  // An earlier build wrote one file name per building instead of a parts list;
  // a stale cache like that must fall back to boxes, not be iterated as a string.
  return Array.isArray(found) ? found : []
}

/** Resolve a mesh or texture file to something the page can fetch. */
export function urlForFile(file: string): string | undefined {
  if (Object.keys(extracted).length > 0) return `mesh://model/${encodeURIComponent(file)}`
  return bundledUrls[file]
}

export function meshCount(): number {
  return Object.keys(extracted).length || Object.keys(bundledParts).length
}
