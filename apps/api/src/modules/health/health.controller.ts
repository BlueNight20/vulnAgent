import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { nowIso } from '../../common/utils/id';
import { EventsGateway } from '../events/events.gateway';

@Controller('health')
export class HealthController {
  private readonly startedAt = Date.now();

  constructor(
    private readonly dataSource: DataSource,
    private readonly config: ConfigService,
    private readonly events: EventsGateway,
  ) {}

  @Get()
  async check() {
    let database = 'connected';
    try {
      await this.dataSource.query('SELECT 1');
    } catch {
      database = 'disconnected';
    }
    return {
      status: database === 'connected' ? 'ok' : 'degraded',
      version: this.config.get<string>('app.version'),
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      database,
      dbType: this.dataSource.options.type,
      wsClients: this.events.connectionCount,
      timestamp: nowIso(),
    };
  }
}
