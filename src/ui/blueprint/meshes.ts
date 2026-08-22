/**
 * Where the blueprint viewer gets its building geometry.
 *
 * In the desktop app the meshes are extracted on first run from the copy of
 * Satisfactory on that machine and served from the app's data folder over the
 * `mesh://` scheme. Nothing of the game's is bundled or redistributed.
 *
 * A build that ran `npm run fetch-meshes` during development also has them in
 * src/data/meshes, which Vite inlines; that path is the fallback so the viewer
 * still works in a browser.
 */

const bundled = import.meta.glob('../../data/meshes/*.glb', {
  eager: true,
  query: '?url',
  import: 'default',
})

const bundledUrls: Record<string, string> = {}
for (const [path, url] of Object.entries(bundled)) {
  const key = path.split('/').pop()?.replace(/\.glb$/, '')
  if (key) bundledUrls[key] = url as string
}

export interface MeshStatus {
  count: number
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
  manifest(): Promise<Record<string, string>>
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

/** Class names the app has extracted, refreshed after every extraction. */
let extracted: Record<string, string> = {}

export async function refreshMeshManifest(): Promise<number> {
  if (!meshApi) return 0
  try {
    extracted = await meshApi.manifest()
  } catch {
    extracted = {}
  }
  return Object.keys(extracted).length
}

export function meshFor(buildableKey: string): string | undefined {
  const file = extracted[buildableKey]
  // Cache-bust per extraction so a re-run doesn't serve stale geometry.
  if (file) return `mesh://model/${encodeURIComponent(file)}`
  return bundledUrls[buildableKey]
}

export function meshCount(): number {
  return Object.keys(extracted).length || Object.keys(bundledUrls).length
}
