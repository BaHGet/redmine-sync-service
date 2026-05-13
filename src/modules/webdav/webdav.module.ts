import { Module } from '@nestjs/common';
import { WebdavService } from './webdav.service';
import { WebdavController } from './webdav.controller';

@Module({
  providers: [WebdavService],
  controllers: [WebdavController],
  exports: [WebdavService],
})
export class WebdavModule {}