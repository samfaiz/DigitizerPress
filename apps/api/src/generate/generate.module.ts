import { Module } from '@nestjs/common';
import { HumanizeModule } from '../humanize/humanize.module.js';
import { LibraryModule } from '../library/library.module.js';
import { BulkService } from './bulk.service.js';
import { GenerateController } from './generate.controller.js';
import { GenerateService } from './generate.service.js';
import { ProgressService } from './progress.service.js';

@Module({
  // Generation runs the humanize loop over its own output. Applying the
  // writing rules while drafting is not a substitute for rewriting: measured
  // against a real detector, the loop is worth more than every other lever
  // in this pipeline combined.
  imports: [HumanizeModule, LibraryModule],
  controllers: [GenerateController],
  providers: [GenerateService, ProgressService, BulkService],
})
export class GenerateModule {}
