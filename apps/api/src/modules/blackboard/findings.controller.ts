import { Controller, DefaultValuePipe, Get, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import { FindingsService } from './findings.service';

@Controller('tasks/:taskId/findings')
export class FindingsController {
  constructor(private readonly findings: FindingsService) {}
  @Get()
  list(@Param('taskId') taskId: string, @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number, @Query('status') status?: string, @Query('clueLevel') clueLevel?: string) {
    return this.findings.list(taskId, page, status, clueLevel);
  }
  @Post('refresh')
  refresh(@Param('taskId') taskId: string) { return this.findings.captureCandidates(taskId).then((created) => ({ created })); }
  @Get(':id')
  detail(@Param('taskId') taskId: string, @Param('id') id: string) { return this.findings.detail(taskId, id); }
  @Post(':id/verify')
  verify(@Param('taskId') taskId: string, @Param('id') id: string) { return this.findings.requestVerification(taskId, id); }
}
