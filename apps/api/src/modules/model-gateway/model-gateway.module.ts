import { Global, Module } from '@nestjs/common';
import { SettingsModule } from '../settings/settings.module';
import { ModelGatewayService } from './model-gateway.service';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ModelRequestEntity } from '../../database/entities';
import { ModelBudgetService } from './model-budget.service';
import { ModelBudgetController } from './model-budget.controller';

@Global()
@Module({
  imports: [SettingsModule, TypeOrmModule.forFeature([ModelRequestEntity])],
  providers: [ModelGatewayService, ModelBudgetService],
  controllers: [ModelBudgetController],
  exports: [ModelGatewayService, ModelBudgetService],
})
export class ModelGatewayModule {}
