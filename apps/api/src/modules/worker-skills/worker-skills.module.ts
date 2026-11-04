import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AgentToolPermissionEntity, McpToolEntity, WorkerProfileLoadEntity } from '../../database/entities';
import { WorkerSkillsService } from './worker-skills.service';

@Module({
  imports: [TypeOrmModule.forFeature([McpToolEntity, WorkerProfileLoadEntity, AgentToolPermissionEntity])],
  providers: [WorkerSkillsService],
  exports: [WorkerSkillsService],
})
export class WorkerSkillsModule {}
