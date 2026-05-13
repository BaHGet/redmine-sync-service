import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { BullModule } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ConfigModule } from './modules/config/config.module';
import { LoggerModule } from './modules/logger/logger.module';
import { PrismaModule } from './shared/prisma.module';
import { RedmineModule } from './modules/redmine/redmine.module';
import { WebdavModule } from './modules/webdav/webdav.module';
import { GdriveModule } from './modules/gdrive/gdrive.module';
import { SyncModule } from './modules/sync/sync.module';
import { SchedulerModule } from './modules/scheduler/scheduler.module';
import { IndexingModule } from './modules/indexing/indexing.module';

@Module({
  imports: [
    ConfigModule,
    LoggerModule,
    PrismaModule,
    ScheduleModule.forRoot(),
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: {
          host: config.get('REDIS_HOST'),
          port: config.get('REDIS_PORT'),
        },
      }),
    }),
    RedmineModule,
    WebdavModule,
    GdriveModule,
    SyncModule,
    SchedulerModule,
    IndexingModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
