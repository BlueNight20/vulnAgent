import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ToolCallEntity } from '../../database/entities';
import { PiRuntimeModule } from '../pi-runtime/pi-runtime.module';
import { AgentsController } from './agents.controller';
import { AgentsService } from './agents.service';

@Module({
  imports: [PiRuntimeModule, TypeOrmModule.forFeature([ToolCallEntity])],
  controllers: [AgentsController],
  providers: [AgentsService],
})
export class AgentsModule {}
