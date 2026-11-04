import { describe, expect, it } from 'vitest';
import { mapGraph, statusLabel } from './graph-mapper';
import type { WorkflowEdge, WorkflowNode } from '../../api/agents';

const node = (over: Partial<WorkflowNode>): WorkflowNode => ({
  id: 'n1',
  kind: 'worker',
  label: 'worker',
  role: 'explore',
  profileId: 'recon',
  status: 'running',
  title: '端口扫描',
  tokens: 1200,
  durationMs: 3000,
  evidenceCount: 2,
  detail: {},
  ...over,
});

const edge = (over: Partial<WorkflowEdge>): WorkflowEdge => ({
  id: 'e1',
  source: 'a',
  target: 'b',
  kind: 'dependency',
  label: '派发',
  ...over,
});

describe('工作流图映射', () => {
  it('按层级分列排布节点', () => {
    const { nodes } = mapGraph(
      [
        node({ id: 'o', kind: 'orchestrator', role: 'orchestrator', profileId: null, label: 'Orchestrator' }),
        node({ id: 'p', kind: 'planner', role: 'planner', profileId: null, label: 'Planner' }),
        node({ id: 'w', kind: 'worker' }),
      ],
      [],
    );
    expect(nodes).toHaveLength(3);
    const byId = new Map(nodes.map((n) => [n.id, n]));
    expect(byId.get('o')!.position.x).toBeLessThan(byId.get('p')!.position.x);
    expect(byId.get('p')!.position.x).toBeLessThan(byId.get('w')!.position.x);
  });

  it('Worker 节点使用能力档案的中文名', () => {
    const { nodes } = mapGraph([node({ profileId: 'web' })], []);
    expect(nodes[0].data.label).toBe('Web 探测 Worker');
  });

  it('证据边使用虚线并且动画', () => {
    const { edges } = mapGraph([], [edge({ kind: 'evidence' })]);
    expect(edges[0].animated).toBe(true);
    expect(edges[0].style?.strokeDasharray).toBe('5 4');
  });

  it('依赖边为实线', () => {
    const { edges } = mapGraph([], [edge({ kind: 'dependency' })]);
    expect(edges[0].animated).toBe(false);
    expect(edges[0].style?.strokeDasharray).toBeUndefined();
  });

  it('状态有中文标签', () => {
    expect(statusLabel('executing')).toBe('执行中');
    expect(statusLabel('stalled')).toBe('已停滞');
    expect(statusLabel('unknown_state')).toBe('unknown_state');
  });
});
