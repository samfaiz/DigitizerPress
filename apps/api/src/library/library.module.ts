import { Module } from '@nestjs/common';
import { LibraryController } from './library.controller.js';
import { LibraryService } from './library.service.js';

@Module({
  controllers: [LibraryController],
  providers: [LibraryService],
  // Exported so the bulk runner can file its articles under the brand they
  // were written for, rather than leaving a thousand of them in a job folder
  // nobody opens.
  exports: [LibraryService],
})
export class LibraryModule {}
