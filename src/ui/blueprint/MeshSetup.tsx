import { useCallback, useEffect, useRef, useState } from 'react'
import { isDesktop, meshApi, refreshMeshManifest, type MeshProgress, type MeshStatus } from './meshes'

interface Props {
  /** Called once meshes land, so the viewer can redraw with real geometry. */
  onReady: () => void
}

/**
 * First-run step for real building models.
 *
 * The planner ships no game art. This reads the copy of Satisfactory already on
 * the machine and caches the geometry in the app's own data folder.
 */
export function MeshSetup({ onReady }: Props) {
  const [status, setStatus] = useState<MeshStatus | null>(null)
  const [progress, setProgress] = useState<MeshProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const [gameDir, setGameDir] = useState<string | null>(null)
  const unsubscribe = useRef<(() => void) | null>(null)

  useEffect(() => {
    if (!meshApi) return
    let live = true
    meshApi.status().then((s) => {
      if (!live) return
      setStatus(s)
      setGameDir(s.detectedGame)
    }).catch(() => {})
    return () => { live = false; unsubscribe.current?.() }
  }, [])

  const run = useCallback(async (dir: string) => {
    if (!meshApi) return
    setBusy(true)
    setError(null)
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
      onReady()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      unsubscribe.current?.()
      unsubscribe.current = null
      setBusy(false)
      setProgress(null)
    }
  }, [onReady])

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
    void run(picked.dir)
  }, [run])

  // Browser build, or meshes already extracted: nothing to set up.
  if (!isDesktop || !status || dismissed) return null
  if (status.count > 0 && !busy) return null

  const pct = progress && progress.total > 0
    ? Math.round((progress.done / progress.total) * 100)
    : null

  return (
    <div className="mesh-setup">
      <div className="mesh-setup-body">
        <div className="mesh-setup-title">Draw the real machines</div>
        <p className="hint">
          Right now buildings are drawn as sized boxes. The planner can use Satisfactory's own
          models instead, read from your installed copy — nothing is downloaded, and the
          geometry stays on this machine.
        </p>

        {!status.exporterAvailable && (
          <p className="hint" style={{ color: 'var(--hazard)' }}>
            The extractor is missing from this build, so this step isn't available.
          </p>
        )}

        {gameDir && !busy && (
          <p className="mesh-setup-path" title={gameDir}>
            Found at <code>{gameDir}</code>
          </p>
        )}

        {busy && (
          <div className="mesh-progress">
            <div className="mesh-progress-bar">
              <span style={{ width: pct === null ? '35%' : `${pct}%` }} data-indeterminate={pct === null} />
            </div>
            <div className="mesh-progress-text">
              {progress?.phase === 'optimising' ? 'Simplifying' : 'Reading game files'}
              {pct !== null && ` · ${pct}%`}
              {progress?.message && <span className="muted"> · {progress.message}</span>}
            </div>
            <p className="hint">
              The first run takes a couple of minutes: 226 MB of source geometry becomes
              about 20 MB the viewer can draw.
            </p>
          </div>
        )}

        {error && <div className="notice" data-kind="error" style={{ marginBottom: 0 }}>{error}</div>}

        {!busy && (
          <div className="row" style={{ marginTop: 4 }}>
            {gameDir && (
              <button type="button" className="btn btn-primary" disabled={!status.exporterAvailable} onClick={() => run(gameDir)}>
                Use these models
              </button>
            )}
            <button type="button" className="btn" disabled={!status.exporterAvailable} onClick={browse}>
              {gameDir ? 'Choose another folder' : 'Find my Satisfactory folder'}
            </button>
            <button type="button" className="btn" onClick={() => setDismissed(true)}>
              Not now
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
