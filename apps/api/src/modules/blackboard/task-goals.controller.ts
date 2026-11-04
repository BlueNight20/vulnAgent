import { Body, Controller, Get, Param, Put } from '@nestjs/common';
import { TaskGoalDto } from '../tasks/dto/create-task.dto';
import { TaskGoalsService } from './task-goals.service';

@Controller('tasks/:taskId/goal')
export class TaskGoalsController {
  constructor(private readonly goals: TaskGoalsService) {}
  @Get() get(@Param('taskId') taskId: string) { return this.goals.evaluate(taskId); }
  @Put() set(@Param('taskId') taskId: string, @Body() body: TaskGoalDto) { return this.goals.set(taskId, body); }
}
