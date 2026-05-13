import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { SyncService } from './sync.service';
import { SyncProcessor } from './sync.processor';
import { SyncController } from './sync.controller';
import { SYNC_QUEUE } from './sync.constants';
import { GdriveModule } from '../gdrive/gdrive.module';
import { IndexingModule } from '../indexing/indexing.module';

@Module({
  imports: [
    BullModule.registerQueue({ name: SYNC_QUEUE }),
    GdriveModule,
    IndexingModule,
  ],
  providers: [SyncService, SyncProcessor],
  controllers: [SyncController],
  exports: [SyncService],
})
export class SyncModule {}
