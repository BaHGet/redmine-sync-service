import { Module } from '@nestjs/common';
import { ConfigModule as NestConfigModule } from '@nestjs/config';
import { envSchema } from './env.schema';

@Module({
  imports: [
    NestConfigModule.forRoot({
      isGlobal: true,
      validate: (config: Record<string, unknown>) => {
        const result = envSchema.safeParse(config);
        if (!result.success) {
          const formatted = result.error.format();
          throw new Error(
            `Environment validation failed:\n${JSON.stringify(formatted, null, 2)}`,
          );
        }
        return result.data;
      },
    }),
  ],
  exports: [NestConfigModule],
})
export class ConfigModule {}
