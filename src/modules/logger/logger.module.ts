import { Module } from '@nestjs/common';
import { LoggerModule as PinoLoggerModule } from 'nestjs-pino';

@Module({
  imports: [
    PinoLoggerModule.forRoot({
      pinoHttp: {
        level: process.env.LOG_LEVEL ?? 'info',
        transport:
          process.env.NODE_ENV !== 'production'
            ? { target: 'pino-pretty', options: { singleLine: true } }
            : undefined,
        redact: {
          paths: [
            'req.headers.authorization',
            'REDMINE_API_KEY',
            'WEBDAV_PASSWORD',
            'GDRIVE_SERVICE_ACCOUNT_JSON',
          ],
          censor: '[REDACTED]',
        },
      },
    }),
  ],
  exports: [PinoLoggerModule],
})
export class LoggerModule {}
