import { Module } from '@nestjs/common';
import { CommonModule } from './common/common.module.js';
import { DetectorModule } from './detectors/detector.module.js';
import { ConfigModule } from './config/config.module.js';
import { GenerateModule } from './generate/generate.module.js';
import { HumanizeModule } from './humanize/humanize.module.js';
import { LibraryModule } from './library/library.module.js';
import { LlmModule } from './llm/llm.module.js';
import { ScorerModule } from './scorer/scorer.module.js';

@Module({
  // ConfigModule first: it is global, and everything below injects CONFIG.
  imports: [
    ConfigModule,
    CommonModule,
    ScorerModule,
    DetectorModule,
    LlmModule,
    HumanizeModule,
    GenerateModule,
    LibraryModule,
  ],
})
export class AppModule {}
