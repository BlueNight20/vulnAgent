import { useEffect, useRef, useState } from 'react';
import type { WsEvent } from '@vulnagent/shared';

export type WsStatus = 'connecting' | 'open' | 'closed';

export interface WsState {
  status: WsStatus;
  lastEvent: WsEvent | null;
  clientId: string | null;
}

function wsUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws`;
}

/**
 * 连接后端原生 WebSocket 网关。仅监听状态类事件，不发送控制指令。
 * 断线后按 3s 间隔自动重连，页面卸载时关闭。
 */
export function useWebSocket(): WsState {
  const [state, setState] = useState<WsState>({ status: 'connecting', lastEvent: null, clientId: null });
  const socketRef = useRef<WebSocket | null>(null);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    let disposed = false;

    const connect = () => {
      if (disposed) return;
      setState((prev) => ({ ...prev, status: 'connecting' }));
      const socket = new WebSocket(wsUrl());
      socketRef.current = socket;

      socket.onopen = () => setState((prev) => ({ ...prev, status: 'open' }));
      socket.onmessage = (raw) => {
        const parsed = JSON.parse(String(raw.data)) as WsEvent;
        setState((prev) => ({
          status: 'open',
          lastEvent: parsed,
          clientId: parsed.type === 'hello' ? parsed.payload.clientId : prev.clientId,
        }));
      };
      socket.onclose = () => {
        if (disposed) return;
        setState((prev) => ({ ...prev, status: 'closed' }));
        timerRef.current = window.setTimeout(connect, 3000);
      };
      socket.onerror = () => {
        socket.close();
      };
    };

    connect();

    return () => {
      disposed = true;
      if (timerRef.current) window.clearTimeout(timerRef.current);
      socketRef.current?.close();
    };
  }, []);

  return state;
}
