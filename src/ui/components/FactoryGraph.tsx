import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Background, BackgroundVariant, Controls, MiniMap, ReactFlow, ReactFlowProvider,
  useEdgesState, useNodesState, useReactFlow,
  type Edge, type Node,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import dagre from 'dagre'

import type { Plan, PlannerSettings } from '../../core/types'
import { buildGraph, type FlowEdgeData, type FlowNodeData } from '../graph/model'
import { FactoryNode } from '../graph/FactoryNode'
import { BeltEdge, setEdgeSettings } from '../graph/BeltEdge'
import { NodeInspector } from '../graph/NodeInspector'
import { fmtPower } from '../format'
import { toPng } from 'html-to-image'
import { getNodesBounds, getViewportForBounds } from '@xyflow/react'

const nodeTypes = { factory: FactoryNode }
const edgeTypes = { belt: BeltEdge }

export type Direction = 'LR' | 'TB'

interface Props {
  plan: Plan
  settings: PlannerSettings
  setSettings: (next: PlannerSettings) => void
}

/** Lay the graph out with dagre, which keeps a production chain readable. */
function layout(
  nodes: Node<FlowNodeData>[],
  edges: Edge<FlowEdgeData>[],
  direction: Direction
): Node<FlowNodeData>[] {
  const g = new dagre.graphlib.Graph()
  g.setDefaultEdgeLabel(() => ({}))
  g.setGraph({
    rankdir: direction,
    nodesep: direction === 'LR' ? 24 : 44,
    ranksep: direction === 'LR' ? 150 : 100,
    marginx: 30,
    marginy: 30,
  })

  for (const n of nodes) g.setNode(n.id, { width: n.data.width, height: n.data.height })
  for (const e of edges) g.setEdge(e.source, e.target)
  dagre.layout(g)

  return nodes.map((n) => {
    const pos = g.node(n.id)
    return {
      ...n,
      // dagre centres nodes; React Flow positions by top-left.
      position: { x: pos.x - n.data.width / 2, y: pos.y - n.data.height / 2 },
    }
  })
}

function Canvas({ plan, settings, setSettings }: Props) {
  const [direction, setDirection] = useState<Direction>('LR')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const { fitView } = useReactFlow()
  setEdgeSettings(settings)

  const graph = useMemo(() => buildGraph(plan), [plan])

  const built = useMemo(() => {
    const nodes: Node<FlowNodeData>[] = graph.nodes.map((n) => ({
      id: n.id,
      type: 'factory',
      position: { x: 0, y: 0 },
      data: n.data,
    }))
    const edges: Edge<FlowEdgeData>[] = graph.edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      sourceHandle: e.sourceHandle,
      targetHandle: e.targetHandle,
      type: 'belt',
      data: e.data,
    }))
    return { nodes: layout(nodes, edges, direction), edges }
  }, [graph, direction])

  const [nodes, setNodes, onNodesChange] = useNodesState(built.nodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState(built.edges)

  useEffect(() => {
    setNodes(built.nodes)
    setEdges(built.edges)
    const id = setTimeout(() => fitView({ padding: 0.14, duration: 320 }), 60)
    return () => clearTimeout(id)
  }, [built, setNodes, setEdges, fitView])

  // Selecting a machine dims everything it isn't wired to, which is the only
  // way to follow one chain through a large factory.
  const neighbours = useMemo(() => {
    if (!selectedId) return null
    const near = new Set<string>([selectedId])
    for (const e of built.edges) {
      if (e.source === selectedId) near.add(e.target)
      if (e.target === selectedId) near.add(e.source)
    }
    return near
  }, [selectedId, built.edges])

  const shownNodes = useMemo(() => nodes.map((n) => ({
    ...n,
    selected: n.id === selectedId,
    className: neighbours && !neighbours.has(n.id) ? 'dimmed' : undefined,
  })), [nodes, selectedId, neighbours])

  const shownEdges = useMemo(() => edges.map((e) => {
    const touching = selectedId ? e.source === selectedId || e.target === selectedId : true
    return { ...e, selected: Boolean(selectedId) && touching, className: touching ? undefined : 'dimmed' }
  }), [edges, selectedId])

  const selected = useMemo(
    () => (selectedId ? built.nodes.find((n) => n.id === selectedId)?.data ?? null : null),
    [selectedId, built.nodes]
  )

  const relayout = useCallback((dir: Direction) => setDirection(dir), [])

  // Render the whole factory to a PNG at a readable scale, regardless of what
  // is currently on screen.
  const [exporting, setExporting] = useState(false)
  const exportPng = useCallback(async () => {
    const viewport = document.querySelector<HTMLElement>('.react-flow__viewport')
    if (!viewport || !nodes.length) return
    setExporting(true)
    try {
      const bounds = getNodesBounds(nodes)
      const pad = 60
      const width = Math.min(6000, Math.round(bounds.width + pad * 2))
      const height = Math.min(6000, Math.round(bounds.height + pad * 2))
      const t = getViewportForBounds(bounds, width, height, 0.2, 2, 0.06)

      const url = await toPng(viewport, {
        backgroundColor: '#0e1013',
        width,
        height,
        style: {
          width: `${width}px`,
          height: `${height}px`,
          transform: `translate(${t.x}px, ${t.y}px) scale(${t.zoom})`,
        },
      })
      const a = document.createElement('a')
      a.href = url
      a.download = 'factory.png'
      a.click()
    } finally {
      setExporting(false)
    }
  }, [nodes])

  return (
    <div className="graph-wrap">
      <div className="graph-bar">
        <div className="graph-stats">
          <span><strong>{plan.totals.machines}</strong> machines</span>
          <span><strong>{edges.length}</strong> connections</span>
          <span><strong>{fmtPower(plan.totals.totalPowerMW)}</strong></span>
          {plan.byproducts.length > 0 && (
            <span className="graph-warn">
              {plan.byproducts.length} byproduct{plan.byproducts.length > 1 ? 's' : ''}
            </span>
          )}
        </div>
        <div className="graph-actions">
          <div className="segmented" style={{ width: 148 }}>
            <button type="button" aria-pressed={direction === 'LR'} onClick={() => relayout('LR')}>Across</button>
            <button type="button" aria-pressed={direction === 'TB'} onClick={() => relayout('TB')}>Down</button>
          </div>
          <button type="button" className="btn" onClick={() => fitView({ padding: 0.14, duration: 320 })}>Fit</button>
          <button type="button" className="btn" onClick={exportPng} disabled={exporting}>
            {exporting ? 'Saving…' : 'Save PNG'}
          </button>
        </div>
      </div>

      <div className="graph-canvas">
        <ReactFlow
          nodes={shownNodes}
          edges={shownEdges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodeClick={(_, node) => setSelectedId(node.id)}
          onPaneClick={() => setSelectedId(null)}
          fitView
          fitViewOptions={{ padding: 0.14 }}
          minZoom={0.06}
          maxZoom={2.2}
          proOptions={{ hideAttribution: true }}
          nodesConnectable={false}
          elevateEdgesOnSelect
          defaultEdgeOptions={{ type: 'belt' }}
        >
          <Background variant={BackgroundVariant.Dots} gap={26} size={1} color="#232a31" />
          <Controls showInteractive={false} />
          <MiniMap
            pannable
            zoomable
            nodeColor={(n) => {
              const kind = (n.data as FlowNodeData)?.kind
              if (kind === 'source') return '#6fbf73'
              if (kind === 'sink') return '#f89a3c'
              if (kind === 'byproduct') return '#f2c14e'
              return '#4a5661'
            }}
            maskColor="#0e1013cc"
            style={{ background: '#171b20', border: '1px solid #232a31', width: 168, height: 108 }}
          />
        </ReactFlow>

        {selected && (
          <NodeInspector
            data={selected}
            settings={settings}
            setSettings={setSettings}
            onClose={() => setSelectedId(null)}
          />
        )}
      </div>

      <div className="graph-legend">
        <span><i className="sw" style={{ background: 'var(--ficsit)' }} /> belt</span>
        <span><i className="sw" style={{ background: 'var(--coolant)' }} /> pipe</span>
        <span><i className="sw sw-dash" /> over your tier</span>
        <span><i className="sw" style={{ background: 'var(--go)' }} /> extraction</span>
        <span className="muted">click a machine to change its recipe · drag to rearrange · scroll to zoom</span>
      </div>
    </div>
  )
}

export function FactoryGraph(props: Props) {
  if (!props.plan.steps.length && !props.plan.raw.length) return null
  return (
    <ReactFlowProvider>
      <Canvas {...props} />
    </ReactFlowProvider>
  )
}
