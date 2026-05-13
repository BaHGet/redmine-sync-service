import { z } from 'zod';

export const envSchema = z.object({
  // App
  NODE_ENV: z
    .enum(['development', 'production', 'test'])
    .default('development'),
  PORT: z.coerce.number().default(3000),
  LOG_LEVEL: z
    .enum(['trace', 'debug', 'info', 'warn', 'error'])
    .default('info'),

  // Redmine / WebDAV
  REDMINE_URL: z.string().url(),
  REDMINE_API_KEY: z.string().min(1),
  WEBDAV_URL: z.string().url(),
  WEBDAV_USERNAME: z.string().min(1),
  WEBDAV_PASSWORD: z.string().min(1),
  WEBDAV_ROOT_PATH: z
    .string()
    .default(
      '/dmsf/webdav/Documents Repository/CRM Documents/Requirements CRM/Requirements/Requirements',
    ),

  // Google Drive
  GDRIVE_ROOT_FOLDER_ID: z.string().min(1),
  GDRIVE_SERVICE_ACCOUNT_JSON: z.string().min(1),

  // Database
  DATABASE_URL: z.string(),

  // Redis / BullMQ
  REDIS_HOST: z.string().default('redis'),
  REDIS_PORT: z.coerce.number().default(6379),

  // AI Export
  AI_EXPORT_PATH: z.string().default('/app/exports'),
});

export type Env = z.infer<typeof envSchema>;
