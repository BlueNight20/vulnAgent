import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { MaintenanceService } from './maintenance.service';
import { ApplyMaintenanceDto, RetentionPolicyDto } from './maintenance.dto';
@Controller('maintenance')
export class MaintenanceController {
  constructor(private readonly maintenance: MaintenanceService) {}
  @Post('preview') @HttpCode(200) preview(@Body() input: RetentionPolicyDto) { return this.maintenance.preview(input); }
  @Post('apply') @HttpCode(200) apply(@Body() input: ApplyMaintenanceDto) { return this.maintenance.apply(input); }
}
