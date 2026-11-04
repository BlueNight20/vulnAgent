import { useMemo } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  type Node,
} from '@xyflow/react';
import type { WorkflowEdge, WorkflowNode } from '../../api/agents';
import { mapGraph, type FlowNodeData } from './graph-mapper';
import { nodeTypes } from './live-node';

export function LiveCanvas({
  nodes,
  edges,
  selectedId,
  onSelect,
}: {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  selectedId: string | null;
  onSelect: (node: WorkflowNode | null) => void;
}) {
  const graph = useMemo(() => mapGraph(nodes, edges), [nodes, edges]);
  const flowNodes = useMemo<Node<FlowNodeData>[]>(
    () => graph.nodes.map((n) => ({ ...n, selected: n.id === selectedId })),
    [graph.nodes, selectedId],
  );

  return (
    <ReactFlow
      nodes={flowNodes}
      edges={graph.edges}
      nodeTypes={nodeTypes}
      fitView
      fitViewOptions={{ padding: 0.18 }}
      minZoom={0.3}
      maxZoom={1.6}
      proOptions={{ hideAttribution: true }}
      onNodeClick={(_, node) => {
        const found = nodes.find((n) => n.id === node.id) ?? null;
        onSelect(found);
      }}
      onPaneClick={() => onSelect(null)}
    >
      <Background variant={BackgroundVariant.Dots} gap={18} size={1} color="#CBD5E1" />
      <Controls showInteractive={false} className="!bottom-3 !left-3" />
      <MiniMap
        pannable
        zoomable
        nodeColor={(n) => (n.data as FlowNodeData).color}
        className="!bottom-3 !right-3"
        maskColor="rgba(245,247,250,0.7)"
      />
    </ReactFlow>
  );
}
