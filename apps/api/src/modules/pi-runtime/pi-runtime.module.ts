import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  AgentSessionEntity,
  AgentSessionEventEntity,
  AgentSessionMessageEntity,
  ModelUsageEntity,
} from '../../database/entities';
import { ModelGatewayModule } from '../model-gateway/model-gateway.module';
import { PiRuntimeService } from './pi-runtime.service';
import { SessionManagerService } from './session-manager.service';
import { SessionStoreService } from './session-store.service';
import { BlackboardModule } from '../blackboard/blackboard.module';

@Global()
@Module({
  imports: [
    BlackboardModule,
    ModelGatewayModule,
    TypeOrmModule.forFeature([
      AgentSessionEntity,
      AgentSessionMessageEntity,
      AgentSessionEventEntity,
      ModelUsageEntity,
    ]),
  ],
  providers: [SessionStoreService, SessionManagerService, PiRuntimeService],
  exports: [SessionStoreService, SessionManagerService, PiRuntimeService],
})
export class PiRuntimeModule {}
