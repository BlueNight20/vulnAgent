import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { engineApi } from '../api/agents';

export type EngineAction = 'start' | 'pause' | 'resume' | 'stop';

/** Keep control failures visible and avoid overlapping commands from one page. */
export function useEngineControl(taskId: string) {
  const client = useQueryClient();
  const lock = useRef(false);
  const [result, setResult] = useState<{ taskId: string; pending: EngineAction | null; error: string | null }>({ taskId, pending: null, error: null });
  async function act(action: EngineAction) {
    if (!taskId || lock.current) return;
    lock.current = true;
    setResult({ taskId, pending: action, error: null });
    let error: string | null = null;
    try {
      await engineApi[action](taskId);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      lock.current = false;
      setResult({ taskId, pending: null, error });
      // A failed control can also mean that a concurrent control changed the state.
      await Promise.allSettled([
        client.invalidateQueries({ queryKey: ['engine', taskId] }),
        client.invalidateQueries({ queryKey: ['workflow', taskId] }),
        client.invalidateQueries({ queryKey: ['agents', 'sessions', taskId] }),
        client.invalidateQueries({ queryKey: ['blackboard', 'workers', taskId] }),
        client.invalidateQueries({ queryKey: ['tasks'] }),
      ]);
    }
  }
  return { act, pending: lock.current, action: result.taskId === taskId ? result.pending : null, error: result.taskId === taskId ? result.error : null };
}
