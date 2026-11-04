import { Controller, Get, Query } from '@nestjs/common';
import { DashboardService } from './dashboard.service';

@Controller('dashboard')
export class DashboardController {
  constructor(private readonly service: DashboardService) {}

  @Get('summary')
  summary() {
    return this.service.summary();
  }

  @Get('usage-trend')
  trend(@Query('days') days?: string) {
    return this.service.usageTrend(Number(days) || 7);
  }
}
