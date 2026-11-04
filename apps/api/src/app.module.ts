import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import configuration from './config/configuration';
import { envValidationSchema } from './config/env.validation';
import { DatabaseModule } from './database/database.module';
import { AgentsModule } from './modules/agents/agents.module';
import { AuditModule } from './modules/audit/audit.module';
import { BlackboardModule } from './modules/blackboard/blackboard.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';
import { EventsModule } from './modules/events/events.module';
import { HealthModule } from './modules/health/health.module';
import { McpModule } from './modules/mcp/mcp.module';
import { ToolModule } from './modules/tool/tool.module';
import { ModelGatewayModule } from './modules/model-gateway/model-gateway.module';
import { OrchestratorModule } from './modules/orchestrator/orchestrator.module';
import { PiRuntimeModule } from './modules/pi-runtime/pi-runtime.module';
import { SettingsModule } from './modules/settings/settings.module';
import { TasksModule } from './modules/tasks/tasks.module';
import { WorkerSkillsModule } from './modules/worker-skills/worker-skills.module';
import { WorkflowModule } from './modules/workflow/workflow.module';
import { ReportsModule } from './modules/reports/reports.module';
import { MaintenanceModule } from './modules/maintenance/maintenance.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      envFilePath: ['.env', '../../.env'],
      load: [configuration],
      validationSchema: envValidationSchema,
      validationOptions: { abortEarly: false },
    }),
    EventsModule,
    AuditModule,
    DatabaseModule,
    SettingsModule,
    ModelGatewayModule,
    PiRuntimeModule,
    HealthModule,
    TasksModule,
    BlackboardModule,
    WorkerSkillsModule,
    McpModule,
    ToolModule,
    OrchestratorModule,
    AgentsModule,
    DashboardModule,
    WorkflowModule,
    ReportsModule,
    MaintenanceModule,
  ],
})
export class AppModule {}
