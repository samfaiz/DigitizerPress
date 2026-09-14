import { Global, Module } from '@nestjs/common';
import { DetectorService } from './detector.service.js';

@Global()
@Module({
  providers: [DetectorService],
  exports: [DetectorService],
})
export class DetectorModule {}
