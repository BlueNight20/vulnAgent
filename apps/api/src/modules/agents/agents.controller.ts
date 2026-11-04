import { Controller, Get, Param, Post, Query } from '@nestjs/common';
import { AgentsService } from './agents.service';
import { Type } from 'class-transformer';
import { IsInt, Max, Min } from 'class-validator';

export class SessionMessagesQuery {
  @Type(() => Number) @IsInt() @Min(0) @Max(Number.MAX_SAFE_INTEGER)
  afterSeq = 0;
}

@Controller('agents')
export class AgentsController {
  constructor(private readonly service: AgentsService) {}

  @Get('sessions')
  list(@Query('taskId') taskId?: string) {
    return this.service.listSessions(taskId);
  }

  @Get('sessions/:id')
  detail(@Param('id') id: string) {
    return this.service.sessionDetail(id);
  }

  @Get('sessions/:id/messages')
  messages(@Param('id') id: string, @Query() query: SessionMessagesQuery) {
    return this.service.messages(id, query.afterSeq);
  }

  @Get('sessions/:id/events')
  events(@Param('id') id: string, @Query('limit') limit?: string) {
    return this.service.events(id, Number(limit) || 100).then((items) => ({ items }));
  }

  @Post('sessions/:id/pause')
  pause(@Param('id') id: string) {
    return this.service.pause(id);
  }

  @Post('sessions/:id/resume')
  resume(@Param('id') id: string) {
    return this.service.resume(id);
  }

  @Post('sessions/:id/terminate')
  terminate(@Param('id') id: string) {
    return this.service.terminate(id);
  }

  @Get('runtime')
  runtime() {
    return this.service.runtimeStatus();
  }
}
