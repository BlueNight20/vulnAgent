import type { Edge, Node } from '@xyflow/react';
import { MarkerType } from '@xyflow/react';
import { WORKER_PROFILE_LABEL } from '@vulnagent/shared';
import type { WorkflowEdge, WorkflowNode } from '../../api/agents';

export const ROLE_COLOR: Record<string, string> = {
  orchestrator: '#0B1F3A',
  planner: '#1D4ED8',
  recon: '#2563EB',
  web: '#0891B2',
  service: '#7C3AED',
  'linux-audit': '#B45309',
  'vuln-analysis': '#DC2626',
  verification: '#16A34A',
};

export interface FlowNodeData extends Record<string, unknown> {
  label: string;
  kind: string;
  status: string;
  title: string;
  tokens: number;
  durationMs: number | null;
  evidenceCount: number;
  color: string;
  node: WorkflowNode;
}

const STATUS_LABEL: Record<string, string> = {
  idle: '未启动',
  planning: '规划中',
  executing: '执行中',
  paused: '已暂停',
  stopping: '停止中',
  stopped: '已停止',
  stalled: '已停滞',
  needs_input: '需要介入',
  completed: '已完成',
  failed: '失败',
  running: '执行中',
  queued: '排队中',
  succeeded: '成功',
  timeout: '超时',
  cancelled: '已取消',
  terminated: '已终止',
  created: '已创建',
};

export function statusLabel(status: string): string {
  return STATUS_LABEL[status] ?? status;
}

/**
 * 把后端返回的真实图映射成 React Flow 结构。
 * 布局按层级：orchestrator → planner → worker 列，同层按顺序纵向排列。
 */
export function mapGraph(nodes: WorkflowNode[], edges: WorkflowEdge[]): { nodes: Node<FlowNodeData>[]; edges: Edge[] } {
  const orchestrator = nodes.filter((n) => n.kind === 'orchestrator');
  const planners = nodes.filter((n) => n.kind === 'planner');
  const workers = nodes.filter((n) => n.kind === 'worker');

  const flowNodes: Node<FlowNodeData>[] = [];
  const columnX = { orchestrator: 0, planner: 280, worker: 570 };

  orchestrator.forEach((node, index) => {
    flowNodes.push(toFlowNode(node, columnX.orchestrator, 120 + index * 180));
  });
  planners.forEach((node, index) => {
    flowNodes.push(toFlowNode(node, columnX.planner, 120 + index * 180));
  });
  workers.forEach((node, index) => {
    flowNodes.push(toFlowNode(node, columnX.worker, 20 + index * 168));
  });

  const flowEdges: Edge[] = edges.map((edge) => {
    const isEvidence = edge.kind === 'evidence';
    return {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      label: edge.label ?? undefined,
      type: 'smoothstep',
      animated: isEvidence,
      style: {
        stroke: isEvidence ? '#F59E0B' : edge.kind === 'intent' ? '#2563EB' : '#94A3B8',
        strokeWidth: 1.4,
        strokeDasharray: isEvidence ? '5 4' : undefined,
      },
      labelStyle: { fontSize: 10, fill: '#475569' },
      labelBgStyle: { fill: '#FFFFFF', fillOpacity: 0.9 },
      markerEnd: {
        type: MarkerType.ArrowClosed,
        width: 14,
        height: 14,
        color: isEvidence ? '#F59E0B' : '#94A3B8',
      },
    };
  });

  return { nodes: flowNodes, edges: flowEdges };
}

function toFlowNode(node: WorkflowNode, x: number, y: number): Node<FlowNodeData> {
  const colorKey = node.profileId ?? node.role;
  return {
    id: node.id,
    type: 'liveNode',
    position: { x, y },
    data: {
      label:
        node.kind === 'worker' && node.profileId
          ? (WORKER_PROFILE_LABEL as Record<string, string>)[node.profileId] ?? node.profileId
          : node.label,
      kind: node.kind,
      status: node.status,
      title: node.title,
      tokens: node.tokens,
      durationMs: node.durationMs,
      evidenceCount: node.evidenceCount,
      color: ROLE_COLOR[colorKey] ?? '#64748B',
      node,
    },
  };
}
