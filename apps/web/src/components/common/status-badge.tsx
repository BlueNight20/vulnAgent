import { TASK_STATUS_LABEL, MCP_STATUS_LABEL, type McpServerStatus, type TaskStatus } from '@vulnagent/shared';
import { Badge, type BadgeTone } from '../ui/badge';

const TASK_TONE: Record<TaskStatus, BadgeTone> = {
  pending: 'neutral',
  running: 'brand',
  paused: 'warning',
  stopped: 'neutral',
  completed: 'success',
  failed: 'danger',
};

export function TaskStatusBadge({ status }: { status: TaskStatus }) {
  return (
    <Badge tone={TASK_TONE[status]} pulse={status === 'running'}>
      {TASK_STATUS_LABEL[status]}
    </Badge>
  );
}

const MCP_TONE: Record<McpServerStatus, BadgeTone> = {
  unknown: 'neutral',
  online: 'success',
  unreachable: 'neutral',
  error: 'danger',
};

export function McpStatusBadge({ status }: { status: McpServerStatus }) {
  return (
    <Badge tone={MCP_TONE[status]} pulse={status === 'online'}>
      {MCP_STATUS_LABEL[status]}
    </Badge>
  );
}
