import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FindingEntity, ModelUsageEntity } from '../../database/entities';
import { McpModule } from '../mcp/mcp.module';
import { TasksModule } from '../tasks/tasks.module';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';

@Module({
  imports: [TypeOrmModule.forFeature([FindingEntity, ModelUsageEntity]), TasksModule, McpModule],
  controllers: [DashboardController],
  providers: [DashboardService],
})
export class DashboardModule {}
