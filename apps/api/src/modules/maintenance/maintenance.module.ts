import { Module } from '@nestjs/common';
import { TasksModule } from '../tasks/tasks.module';
import { MaintenanceController } from './maintenance.controller';
import { MaintenanceService } from './maintenance.service';
@Module({ imports: [TasksModule], controllers: [MaintenanceController], providers: [MaintenanceService] })
export class MaintenanceModule {}
