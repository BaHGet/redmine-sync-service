import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { SyncService } from '../sync/sync.service';

@Injectable()
export class SchedulerService {
  private readonly logger = new Logger(SchedulerService.name);

  constructor(private readonly sync: SyncService) {}

  @Cron(CronExpression.EVERY_DAY_AT_2AM)
  async scheduledSync() {
    this.logger.log('Cron triggered sync');
    await this.sync.startSync();
  }
}
