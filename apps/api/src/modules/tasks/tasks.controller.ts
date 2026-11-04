import { Body, Controller, Delete, Get, Param, Post, Query } from '@nestjs/common';
import { CreateTaskDto, QueryTaskDto } from './dto/create-task.dto';
import { TasksService } from './tasks.service';

@Controller('tasks')
export class TasksController {
  constructor(private readonly service: TasksService) {}

  @Get()
  list(@Query() query: QueryTaskDto) {
    return this.service.list(query);
  }

  @Get('authorized-ips')
  authorizedIps() {
    return this.service.authorizedIps().then((ips) => ({ ips }));
  }

  @Post()
  create(@Body() dto: CreateTaskDto) {
    return this.service.create(dto);
  }

  @Get(':id')
  detail(@Param('id') id: string) {
    return this.service.detail(id);
  }

  @Post(':id/pause')
  pause(@Param('id') id: string) {
    return this.service.applyAction(id, 'pause');
  }

  @Post(':id/resume')
  resume(@Param('id') id: string) {
    return this.service.applyAction(id, 'resume');
  }

  @Post(':id/stop')
  stop(@Param('id') id: string) {
    return this.service.applyAction(id, 'stop');
  }

  @Post(':id/rerun')
  rerun(@Param('id') id: string) {
    return this.service.applyAction(id, 'rerun');
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.service.remove(id);
  }
}
