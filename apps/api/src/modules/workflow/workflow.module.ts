import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  AgentSessionEntity,
  EvidenceEntity,
  IntentEntity,
  TaskEntity,
  WorkerTaskEntity,
} from '../../database/entities';
import { OrchestratorModule } from '../orchestrator/orchestrator.module';
import { WorkflowController } from './workflow.controller';
import { WorkflowService } from './workflow.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([TaskEntity, AgentSessionEntity, WorkerTaskEntity, IntentEntity, EvidenceEntity]),
    OrchestratorModule,
  ],
  controllers: [WorkflowController],
  providers: [WorkflowService],
})
export class WorkflowModule {}
