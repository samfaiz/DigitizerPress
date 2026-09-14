import { Global, Module } from '@nestjs/common';
import { BatchQueueService } from './batch-queue.service.js';
import { LlmService } from './llm.service.js';

@Global()
@Module({
  // BatchQueueService attaches itself to LlmService in its constructor, so it
  // has to be instantiated for pooled batching to work at all. Listing it
  // here is what guarantees Nest builds it.
  providers: [LlmService, BatchQueueService],
  exports: [LlmService, BatchQueueService],
})
export class LlmModule {}
