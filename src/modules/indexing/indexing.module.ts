import { Module } from '@nestjs/common';
import { IndexingService } from './indexing.service';
import { IndexingController } from './indexing.controller';
import { GdriveModule } from '../gdrive/gdrive.module';

@Module({
  imports: [GdriveModule],
  providers: [IndexingService],
  controllers: [IndexingController],
  exports: [IndexingService],
})
export class IndexingModule {}
