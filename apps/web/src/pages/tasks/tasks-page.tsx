import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, RefreshCw } from 'lucide-react';
import { ENGINE_PHASE_NOTICE } from '@vulnagent/shared';
import type { TaskAction, TaskSummary } from '@vulnagent/shared';
import { PageHeader } from '../../components/layout/page-header';
import { Panel, EmptyState, ErrorBlock, LoadingBlock } from '../../components/ui/panel';
import { Button } from '../../components/ui/button';
import { NoticeBanner } from '../../components/common/notice-banner';
import { TaskFilterBar } from '../../components/tasks/task-filter-bar';
import { TaskTable } from '../../components/tasks/task-table';
import { CreateTaskDrawer } from '../../components/tasks/create-task-drawer';
import { TaskDetailDrawer } from '../../components/tasks/task-detail-drawer';
import { TaskDeleteDialog } from '../../components/tasks/task-delete-dialog';
import { tasksApi } from '../../api/tasks';
import { useUiStore } from '../../stores/ui-store';

export function TasksPage() {
  const queryClient = useQueryClient();
  const { taskKeyword, taskStatusFilter, setTaskKeyword, setTaskStatusFilter, createTaskOpen, setCreateTaskOpen } =
    useUiStore();
  const [inspect, setInspect] = useState<TaskSummary | null>(null);
  const [deleting, setDeleting] = useState<TaskSummary | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const list = useQuery({
    queryKey: ['tasks', 'list', taskKeyword, taskStatusFilter],
    queryFn: () => tasksApi.list({ keyword: taskKeyword || undefined, status: taskStatusFilter || undefined }),
  });

  const actionMutation = useMutation({
    mutationFn: ({ id, action }: { id: string; action: TaskAction }) => tasksApi.action(id, action),
    onMutate: ({ id }) => {
      setPendingId(id);
      setActionError(null);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['tasks'] });
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    },
    onError: (err: Error) => setActionError(err.message),
    onSettled: () => setPendingId(null),
  });

  return (
    <>
      <PageHeader
        title="任务中心"
        description="管理授权靶机的测试任务。任务状态流转与审计日志均为真实后端行为。"
        actions={
          <>
            <Button onClick={() => void list.refetch()} loading={list.isFetching}>
              <RefreshCw className="h-3.5 w-3.5" />
              刷新
            </Button>
            <Button variant="primary" onClick={() => setCreateTaskOpen(true)}>
              <Plus className="h-3.5 w-3.5" />
              新建测试任务
            </Button>
          </>
        }
      />

      <NoticeBanner tone="warning" text={ENGINE_PHASE_NOTICE} />

      <div className="mt-3">
        <TaskFilterBar
          keyword={taskKeyword}
          onKeywordChange={setTaskKeyword}
          status={taskStatusFilter}
          onStatusChange={setTaskStatusFilter}
          stats={list.data?.stats ?? {}}
          total={list.data?.total ?? 0}
        />
      </div>

      {actionError ? (
        <div className="mt-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-700">
          操作失败：{actionError}
        </div>
      ) : null}

      <div className="mt-3">
        <Panel dense>
          {list.isLoading ? (
            <LoadingBlock />
          ) : list.isError ? (
            <div className="p-4">
              <ErrorBlock message={(list.error as Error).message} onRetry={() => void list.refetch()} />
            </div>
          ) : (list.data?.items.length ?? 0) === 0 ? (
            <EmptyState
              title="暂无符合条件的任务"
              description="在已授权的 VulnHub 实验环境中创建第一个测试任务，或调整筛选条件。"
              action={
                <Button variant="primary" onClick={() => setCreateTaskOpen(true)}>
                  <Plus className="h-3.5 w-3.5" />
                  新建测试任务
                </Button>
              }
            />
          ) : (
            <TaskTable
              tasks={list.data!.items}
              pendingId={pendingId}
              onAction={(task, action) => actionMutation.mutate({ id: task.id, action })}
              onInspect={setInspect}
              onDelete={setDeleting}
            />
          )}
        </Panel>
      </div>

      <CreateTaskDrawer open={createTaskOpen} onClose={() => setCreateTaskOpen(false)} />
      <TaskDetailDrawer task={inspect} onClose={() => setInspect(null)} />
      {deleting ? (
        <TaskDeleteDialog
          key={deleting.id}
          task={deleting}
          onCancel={() => setDeleting(null)}
          onDeleted={() => {
            setActionError(null);
            setInspect((current) => (current?.id === deleting.id ? null : current));
          }}
        />
      ) : null}
    </>
  );
}
