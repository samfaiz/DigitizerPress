import { Global, Module } from '@nestjs/common';
import { ScorerService } from './scorer.service.js';

@Global()
@Module({
  providers: [ScorerService],
  exports: [ScorerService],
})
export class ScorerModule {}
