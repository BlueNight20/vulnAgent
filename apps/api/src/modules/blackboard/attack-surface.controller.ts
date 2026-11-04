import { Controller, Get, Param } from '@nestjs/common';
import { AttackSurfaceService } from './attack-surface.service';

@Controller('tasks/:taskId/attack-surface')
export class AttackSurfaceController {
  constructor(private readonly surface: AttackSurfaceService) {}
  @Get()
  get(@Param('taskId') taskId: string) { return this.surface.get(taskId); }
}
