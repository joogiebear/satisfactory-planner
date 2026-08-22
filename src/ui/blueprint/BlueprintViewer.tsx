import { useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import type { BlueprintInfo, Placement } from '../../core/blueprint'
import { iconFor } from '../icons'

/**
 * Draws a blueprint the way the designer holds it: every building as the box
 * the game reserves for it, at the transform recorded in the file.
 *
 * Belts, lifts, pipes and power lines are splines — the file stores a path we
 * don't decode — so they get a small marker at their own position instead.
 * Segments sit at regular intervals along a run, so the markers still trace
 * where the belts go without inventing geometry.
 */

const COLOURS: Record<string, number> = {
  machine: 0xf89a3c,
  foundation: 0x39424c,
  wall: 0x4d5763,
  conveyor: 0xd8853a,
  pipe: 0x4fb8c9,
  power: 0x8e7cc3,
  storage: 0x6fbf73,
  other: 0x5a646f,
}

/** Splines get a small stand-in so a belt run still reads as a line. */
const MARKER = { min: [-45, -45, -12] as const, max: [45, 45, 12] as const }

/**
 * Shrink each box slightly. Buildings in a real blueprint touch exactly, and
 * without a gap a row of twelve Smelters renders as one undivided slab.
 */
const INSET_CM = 9

export interface ViewerHandle {
  category: string | null
}

interface Props {
  blueprint: BlueprintInfo
  /** Only these categories are drawn; empty means everything. */
  hidden: Set<string>
}

export function BlueprintViewer({ blueprint, hidden }: Props) {
  const mountRef = useRef<HTMLDivElement>(null)
  const [hover, setHover] = useState<string | null>(null)
  const hiddenKey = useMemo(() => [...hidden].sort().join(','), [hidden])

  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return

    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0x0e1013)
    scene.fog = new THREE.Fog(0x0e1013, 6000, 26000)

    const camera = new THREE.PerspectiveCamera(45, 1, 10, 80000)
    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.shadowMap.enabled = false
    mount.appendChild(renderer.domElement)

    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.dampingFactor = 0.08
    controls.maxPolarAngle = Math.PI * 0.495 // never go under the floor

    // --- lighting: a cool key from above with warm bounce, so orange machines
    // stay legible against the dark plate palette ---
    scene.add(new THREE.HemisphereLight(0xbfd4e6, 0x0b0d10, 1.5))
    const key = new THREE.DirectionalLight(0xffffff, 1.7)
    key.position.set(1, 1.4, 0.8)
    scene.add(key)
    const rim = new THREE.DirectionalLight(0xf89a3c, 0.5)
    rim.position.set(-1, 0.4, -0.9)
    scene.add(rim)

    const root = new THREE.Group()
    scene.add(root)

    // Game axes are Z-up; three.js is Y-up. Rotating the whole group keeps the
    // per-building maths in the game's own coordinates.
    root.rotation.x = -Math.PI / 2

    const visible = blueprint.placements.filter((p) => !hidden.has(p.category))

    // Group by building class rather than category so each type can carry its
    // own icon; a blueprint has a few dozen classes, which is a cheap number of
    // draw calls, and instancing still handles the hundreds of copies.
    const byClass = new Map<string, Placement[]>()
    for (const p of visible) {
      const list = byClass.get(p.key) ?? []
      list.push(p)
      byClass.set(p.key, list)
    }

    const unit = new THREE.BoxGeometry(1, 1, 1)
    const meshes: THREE.InstancedMesh[] = []
    const lookup: { mesh: THREE.InstancedMesh; items: Placement[] }[] = []
    const textures: THREE.Texture[] = []
    const dummy = new THREE.Object3D()

    for (const [classKey, list] of byClass) {
      const category = list[0].category
      const colour = COLOURS[category] ?? COLOURS.other
      const base = () => new THREE.MeshPhongMaterial({
        color: colour, flatShading: true, shininess: 6, specular: 0x111417,
      })

      // BoxGeometry face order is +x, -x, +y, -y, +z, -z. The group is rotated
      // so the box's local +z points up, which is the face worth labelling.
      const faces = [base(), base(), base(), base(), base(), base()]
      const iconUrl = iconFor(classKey)
      if (iconUrl) {
        const img = new Image()
        img.onload = () => {
          // Composite onto the body colour: the icons are transparent PNGs, and
          // an alpha-blended map would show straight through the box.
          const size = 128
          const canvas = document.createElement('canvas')
          canvas.width = canvas.height = size
          const ctx = canvas.getContext('2d')
          if (!ctx) return
          ctx.fillStyle = `#${colour.toString(16).padStart(6, '0')}`
          ctx.fillRect(0, 0, size, size)
          const pad = size * 0.14
          ctx.drawImage(img, pad, pad, size - pad * 2, size - pad * 2)
          const tex = new THREE.CanvasTexture(canvas)
          tex.colorSpace = THREE.SRGBColorSpace
          tex.anisotropy = 4
          textures.push(tex)
          faces[4].map = tex
          faces[4].color.set(0xffffff)
          faces[4].needsUpdate = true
        }
        img.src = iconUrl
      }

      const mesh = new THREE.InstancedMesh(unit, faces, list.length)
      mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage)

      list.forEach((p, i) => {
        const box = p.box ?? { min: [...MARKER.min], max: [...MARKER.max] }
        const inset = p.box ? INSET_CM : 0
        const size = [
          Math.max(20, box.max[0] - box.min[0] - inset),
          Math.max(20, box.max[1] - box.min[1] - inset),
          Math.max(12, box.max[2] - box.min[2] - inset),
        ]
        // The clearance box is offset from the actor origin, so centre on it.
        const centre = [
          (box.max[0] + box.min[0]) / 2,
          (box.max[1] + box.min[1]) / 2,
          (box.max[2] + box.min[2]) / 2,
        ]
        const cos = Math.cos(p.yaw)
        const sin = Math.sin(p.yaw)

        dummy.position.set(
          p.position[0] + centre[0] * cos - centre[1] * sin,
          p.position[1] + centre[0] * sin + centre[1] * cos,
          p.position[2] + centre[2]
        )
        dummy.rotation.set(0, 0, p.yaw)
        dummy.scale.set(size[0] * p.scale[0], size[1] * p.scale[1], size[2] * p.scale[2])
        dummy.updateMatrix()
        mesh.setMatrixAt(i, dummy.matrix)
      })

      mesh.instanceMatrix.needsUpdate = true
      mesh.computeBoundingSphere()
      root.add(mesh)
      meshes.push(mesh)
      lookup.push({ mesh, items: list })
    }

    // --- ground grid, one line per 8 m foundation ---
    const b = blueprint.bounds
    const span = b
      ? Math.max(2400, Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1]) + 1600)
      : 4000
    const grid = new THREE.GridHelper(span, Math.max(4, Math.round(span / 800)), 0x2c3540, 0x1c2228)
    grid.position.y = 0
    scene.add(grid)

    // --- frame the build ---
    const box = new THREE.Box3().setFromObject(root)
    const centre = box.getCenter(new THREE.Vector3())
    const size = box.getSize(new THREE.Vector3())
    const radius = Math.max(size.x, size.y, size.z) || 2000
    controls.target.copy(centre)
    camera.position.set(centre.x + radius * 0.9, centre.y + radius * 0.85, centre.z + radius * 1.1)
    camera.updateProjectionMatrix()

    // --- hover picking ---
    const raycaster = new THREE.Raycaster()
    const pointer = new THREE.Vector2()
    let hoverName: string | null = null

    const onMove = (e: PointerEvent) => {
      const rect = renderer.domElement.getBoundingClientRect()
      pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1
      pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1
      raycaster.setFromCamera(pointer, camera)
      const hits = raycaster.intersectObjects(meshes, false)
      let name: string | null = null
      if (hits.length) {
        const hit = hits[0]
        const entry = lookup.find((l) => l.mesh === hit.object)
        if (entry && hit.instanceId != null) name = entry.items[hit.instanceId]?.name ?? null
      }
      if (name !== hoverName) {
        hoverName = name
        setHover(name)
      }
    }
    renderer.domElement.addEventListener('pointermove', onMove)

    // --- resize + render loop ---
    const resize = () => {
      const w = mount.clientWidth
      const h = mount.clientHeight
      if (!w || !h) return
      renderer.setSize(w, h, false)
      camera.aspect = w / h
      camera.updateProjectionMatrix()
    }
    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(mount)

    let frame = 0
    const tick = () => {
      frame = requestAnimationFrame(tick)
      controls.update()
      renderer.render(scene, camera)
    }
    tick()

    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      renderer.domElement.removeEventListener('pointermove', onMove)
      controls.dispose()
      unit.dispose()
      for (const m of meshes) {
        m.dispose()
        const mats = Array.isArray(m.material) ? m.material : [m.material]
        for (const mat of mats) mat.dispose()
      }
      for (const t of textures) t.dispose()
      renderer.dispose()
      if (renderer.domElement.parentNode === mount) mount.removeChild(renderer.domElement)
    }
  }, [blueprint, hiddenKey, hidden])

  return (
    <div className="bp3d" ref={mountRef}>
      {hover && <div className="bp3d-hover">{hover}</div>}
    </div>
  )
}
