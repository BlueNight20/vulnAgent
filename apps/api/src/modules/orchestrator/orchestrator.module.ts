import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  AgentSessionEntity,
  EvidenceEntity,
  FactEntity,
  HypothesisEntity,
  IntentEntity,
  McpToolEntity,
  OrchestratorRunEntity,
  TargetEntity,
  TaskEntity,
  TaskStateEventEntity,
  ToolCallEntity,
  WorkerTaskEntity,
} from '../../database/entities';
import { BlackboardModule } from '../blackboard/blackboard.module';
import { McpModule } from '../mcp/mcp.module';
import { ToolModule } from '../tool/tool.module';
import { PiRuntimeModule } from '../pi-runtime/pi-runtime.module';
import { WorkerSkillsModule } from '../worker-skills/worker-skills.module';
import { OrchestratorController } from './orchestrator.controller';
import { OrchestratorCycleService } from './orchestrator-cycle.service';
import { OrchestratorService } from './orchestrator.service';
import { PlannerRunnerService } from './planner-runner.service';
import { WorkerRunnerService } from './worker-runner.service';
import { TasksModule } from '../tasks/tasks.module';

@Module({
  imports: [
    TasksModule,
    PiRuntimeModule,
    BlackboardModule,
    WorkerSkillsModule,
    McpModule,
    ToolModule,
    TypeOrmModule.forFeature([
      TaskEntity,
      TargetEntity,
      IntentEntity,
      AgentSessionEntity,
      WorkerTaskEntity,
      ToolCallEntity,
      OrchestratorRunEntity,
      TaskStateEventEntity,
      FactEntity,
      HypothesisEntity,
      McpToolEntity,
      EvidenceEntity,
    ]),
  ],
  controllers: [OrchestratorController],
  providers: [
    OrchestratorService,
    OrchestratorCycleService,
    PlannerRunnerService,
    WorkerRunnerService,
  ],
  exports: [OrchestratorService],
})
export class OrchestratorModule {}
