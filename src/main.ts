import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { Logger } from 'nestjs-pino';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();
  await app.listen(process.env.PORT ?? 3000);
    // Allow BigInt values to serialize as strings in JSON responses
  (BigInt.prototype as any).toJSON = function () {
    return this.toString();
  };
}
bootstrap();
