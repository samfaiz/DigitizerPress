import { Module } from '@nestjs/common';
import { HumanizeController } from './humanize.controller.js';
import { HumanizeService } from './humanize.service.js';

@Module({
  controllers: [HumanizeController],
  providers: [HumanizeService],
  // Exported so the generation pipeline can reuse the loop.
  exports: [HumanizeService],
})
export class HumanizeModule {}
