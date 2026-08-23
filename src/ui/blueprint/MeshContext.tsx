import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
  type ReactNode,
} from 'react'
import { isDesktop, meshApi, refreshMeshManifest, type MeshProgress, type MeshStatus } from './meshes'

/**
 * One place that knows about the game models: whether they are installed, and
 * whether an extraction is running.
 *
 * It used to live inside the blueprint panel, which meant the offer to use real
 * models only appeared if you happened to open that tab, and the progress
 * vanished the moment you looked at anything else. Extraction takes several
 * minutes and the rest of the planner works fine throughout, so it belongs at
 * the top of the app where it can be started from anywhere and watched from
 * anywhere.
 */
interface MeshState {
  status: MeshStatus | null
  progress: MeshProgress | null
  busy: boolean
  error: string | null
  /** Where Satisfactory was found, if it was. */
  gameDir: string | null
  /** Set once the offer has been declined or taken, so it stops asking. */
  answered: boolean
  extract: (dir: string) => Promise<void>
  browse: () => Promise<void>
  dismiss: () => void
  /** Bumped whenever new geometry lands, so viewers know to redraw. */
  generation: number
}

const Ctx = createContext<MeshState | null>(null)

/** Remembered across launches: nobody wants to decline this every time. */
const ANSWERED_KEY = 'satisfactory-planner/mesh-offer-answered'

export function MeshProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<MeshStatus | null>(null)
  const [progress, setProgress] = useState<MeshProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [gameDir, setGameDir] = useState<string | null>(null)
  const [generation, setGeneration] = useState(0)
  const [answered, setAnswered] = useState(() => {
    try { return localStorage.getItem(ANSWERED_KEY) === '1' } catch { return false }
  })
  const unsubscribe = useRef<(() => void) | null>(null)

  useEffect(() => {
    if (!meshApi) return
    let live = true
    meshApi.status()
      .then((s) => { if (live) { setStatus(s); setGameDir(s.detectedGame) } })
      .catch(() => {})
    return () => { live = false; unsubscribe.current?.() }
  }, [])

  const remember = useCallback(() => {
    setAnswered(true)
    try { localStorage.setItem(ANSWERED_KEY, '1') } catch { /* private mode */ }
  }, [])

  const extract = useCallback(async (dir: string) => {
    if (!meshApi) return
    setBusy(true)
    setError(null)
    remember()
    setProgress({ phase: 'reading', done: 0, total: 0, message: 'Starting…' })
    unsubscribe.current = meshApi.onProgress(setProgress)
    try {
      const result = await meshApi.extract(dir)
      if (!result.ok) {
        setError(result.error ?? 'Extraction failed.')
        return
      }
      await refreshMeshManifest()
      setStatus(await meshApi.status())
      setGeneration((g) => g + 1)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      unsubscribe.current?.()
      unsubscribe.current = null
      setBusy(false)
      setProgress(null)
    }
  }, [remember])

  const browse = useCallback(async () => {
    if (!meshApi) return
    const picked = await meshApi.browse()
    if (!picked) return
    if (!picked.valid) {
      setError(`${picked.dir} doesn't contain FactoryGame\\Content\\Paks. Pick the folder with FactoryGameSteam.exe in it.`)
      return
    }
    setError(null)
    setGameDir(picked.dir)
    void extract(picked.dir)
  }, [extract])

  const value = useMemo<MeshState>(() => ({
    status, progress, busy, error, gameDir, answered,
    extract, browse, dismiss: remember, generation,
  }), [status, progress, busy, error, gameDir, answered, extract, browse, remember, generation])

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useMeshes(): MeshState {
  const value = useContext(Ctx)
  if (!value) throw new Error('useMeshes needs a MeshProvider above it')
  return value
}

/** True when there is a real offer to make: desktop, a game found, nothing extracted. */
export function shouldOffer(state: MeshState): boolean {
  return Boolean(
    isDesktop && state.status && !state.busy && !state.answered
    && state.status.count === 0 && state.status.exporterAvailable
  )
}
