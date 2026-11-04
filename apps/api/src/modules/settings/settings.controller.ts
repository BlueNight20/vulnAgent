import { Body, Controller, Get, Post, Put } from '@nestjs/common';
import { SettingsService } from './settings.service';
import { UpdateSettingsDto } from './dto/update-settings.dto';

@Controller('settings')
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get()
  async get() {
    const settings = await this.settings.get();
    return { ...settings, encryptionKeyEphemeral: this.settings.encryptionEphemeral };
  }

  @Get('models')
  models() {
    return { items: this.settings.availableModels() };
  }

  @Put()
  async update(@Body() dto: UpdateSettingsDto) {
    const saved = await this.settings.update(dto);
    await this.settings.reloadRuntime();
    return saved;
  }

  @Post('model/test')
  testModel() {
    return this.settings.testModel();
  }
}
