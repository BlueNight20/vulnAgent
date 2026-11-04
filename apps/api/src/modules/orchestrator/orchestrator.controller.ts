import { Controller, Get, Param, Post } from '@nestjs/common';
import { OrchestratorService } from './orchestrator.service';
import { TasksService } from '../tasks/tasks.service';

@Controller('tasks/:taskId/engine')
export class OrchestratorController {
  constructor(private readonly orchestrator: OrchestratorService, private readonly tasks: TasksService) {}

  @Get()
  snapshot(@Param('taskId') taskId: string) {
    return this.orchestrator.snapshot(taskId);
  }

  @Post('start')
  start(@Param('taskId') taskId: string) {
    return this.tasks.requestStart(taskId);
  }

  @Post('pause')
  pause(@Param('taskId') taskId: string) {
    return this.tasks.applyAction(taskId, 'pause');
  }

  @Post('resume')
  resume(@Param('taskId') taskId: string) {
    return this.tasks.applyAction(taskId, 'resume');
  }

  @Post('stop')
  stop(@Param('taskId') taskId: string) {
    return this.tasks.applyAction(taskId, 'stop');
  }
}
