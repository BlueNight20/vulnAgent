import { Logger, OnModuleDestroy } from '@nestjs/common';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { Server, WebSocket } from 'ws';
import type { WsEvent } from '@vulnagent/shared';
import { newId, nowIso } from '../../common/utils/id';

interface TrackedSocket extends WebSocket {
  clientId?: string;
  alive?: boolean;
}

/**
 * 原生 WebSocket 网关（@nestjs/platform-ws + ws）。
 * 第一阶段只推送状态类事件：hello / pong / task.updated / mcp.health / audit.appended。
 */
@WebSocketGateway({ path: '/ws' })
export class EventsGateway
  implements OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy
{
  private readonly logger = new Logger(EventsGateway.name);
  private readonly heartbeat: NodeJS.Timeout;

  @WebSocketServer()
  server: Server;

  constructor() {
    this.heartbeat = setInterval(() => this.pingAll(), 30000);
  }

  handleConnection(client: TrackedSocket): void {
    client.clientId = newId();
    client.alive = true;
    client.on('pong', () => {
      client.alive = true;
    });
    client.on('message', (raw) => {
      // 仅支持最小心跳协议，避免暴露任何控制面
      const text = raw.toString();
      if (text.includes('"ping"')) {
        this.sendTo(client, { type: 'pong', payload: { serverTime: nowIso() } });
      }
    });
    this.sendTo(client, {
      type: 'hello',
      payload: { clientId: client.clientId, serverTime: nowIso() },
    });
    this.logger.log(`WebSocket 客户端接入: ${client.clientId}`);
  }

  handleDisconnect(client: TrackedSocket): void {
    this.logger.log(`WebSocket 客户端断开: ${client.clientId ?? 'unknown'}`);
  }

  /** 按 type/payload 广播事件 */
  broadcast(type: WsEvent['type'], payload: unknown): void {
    if (!this.server) return;
    const frame = JSON.stringify({ type, payload, ts: Date.now() });
    for (const client of this.server.clients as Set<TrackedSocket>) {
      if (client.readyState === 1) {
        client.send(frame);
      }
    }
  }

  get connectionCount(): number {
    if (!this.server) return 0;
    return Array.from(this.server.clients as Set<TrackedSocket>).filter((c) => c.readyState === 1).length;
  }

  onModuleDestroy(): void {
    clearInterval(this.heartbeat);
  }

  private pingAll(): void {
    if (!this.server) return;
    for (const client of this.server.clients as Set<TrackedSocket>) {
      if (client.alive === false) {
        client.terminate();
        continue;
      }
      client.alive = false;
      try {
        client.ping();
      } catch {
        client.terminate();
      }
    }
  }

  private sendTo(client: TrackedSocket, event: WsEvent): void {
    if (client.readyState === 1) {
      client.send(JSON.stringify({ ...event, ts: Date.now() }));
    }
  }
}
