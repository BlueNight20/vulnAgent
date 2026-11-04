import { Controller, Get, Param } from '@nestjs/common';
import { WorkflowService } from './workflow.service';

@Controller('workflows')
export class WorkflowController {
  constructor(private readonly service: WorkflowService) {}

  @Get(':taskId/graph')
  graph(@Param('taskId') taskId: string) {
    return this.service.graph(taskId);
  }
}
