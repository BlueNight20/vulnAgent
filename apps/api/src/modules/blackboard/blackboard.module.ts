import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  EvidenceEntity,
  EvidenceAttachmentEntity,
  FactEntity,
  FindingEntity,
  FindingVerificationEntity,
  HintEntity,
  HypothesisEntity,
  HypothesisLinkEntity,
  IntentEntity,
  TaskEntity,
  WorkerResultCardEntity,
  WorkerTaskEntity,
} from '../../database/entities';
import { BlackboardController } from './blackboard.controller';
import { FactsService } from './facts.service';
import { EvidenceIngestionService } from './evidence-ingestion.service';
import { HintsService } from './hints.service';
import { HypothesisService } from './hypothesis.service';
import { IntentsService } from './intents.service';
import { WorkerStateService } from './worker-state.service';
import { FindingsService } from './findings.service';
import { FindingsController } from './findings.controller';
import { AttackSurfaceService } from './attack-surface.service';
import { AttackSurfaceController } from './attack-surface.controller';
import { TaskGoalsService } from './task-goals.service';
import { TaskGoalsController } from './task-goals.controller';
import { EvidenceAttachmentsController } from './evidence-attachments.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      FactEntity,
      FindingEntity,
      FindingVerificationEntity,
      IntentEntity,
      HintEntity,
      HypothesisEntity,
      HypothesisLinkEntity,
      WorkerTaskEntity,
      WorkerResultCardEntity,
      EvidenceEntity,
      EvidenceAttachmentEntity,
      TaskEntity,
    ]),
  ],
  controllers: [BlackboardController, FindingsController, AttackSurfaceController, TaskGoalsController, EvidenceAttachmentsController],
  providers: [TaskGoalsService, AttackSurfaceService, FindingsService, FactsService, EvidenceIngestionService, IntentsService, HintsService, HypothesisService, WorkerStateService],
  exports: [TaskGoalsService, AttackSurfaceService, FindingsService, FactsService, EvidenceIngestionService, IntentsService, HintsService, HypothesisService, WorkerStateService],
})
export class BlackboardModule {}
