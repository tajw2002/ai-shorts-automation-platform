import { Global, Module } from '@nestjs/common';
import { config as loadDotenv } from 'dotenv';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { AppConfig } from './app-config';
import { envSchema } from './env.schema';
import { formatZodError } from '@/common/errors/format-zod-error';

/**
 * Loads and validates configuration exactly once, at boot.
 *
 * Env files are read from the app directory first and the repository root second,
 * so a monorepo checkout works with a single top-level `.env` while a container
 * can still inject a local one.
 */
const ENV_FILE_CANDIDATES = ['.env', resolve(process.cwd(), '../../.env')];

export function loadAppConfig(): AppConfig {
  for (const candidate of ENV_FILE_CANDIDATES) {
    if (existsSync(candidate)) {
      loadDotenv({ path: candidate, override: false, quiet: true });
    }
  }

  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    // Printed rather than thrown as a raw ZodError so the operator sees a list of
    // variables instead of a wall of JSON. Values are never echoed back.
    throw new Error(
      `Invalid environment configuration:\n${formatZodError(parsed.error)
        .map((line) => `  - ${line}`)
        .join('\n')}`,
    );
  }
  return new AppConfig(parsed.data);
}

@Global()
@Module({
  providers: [
    {
      provide: AppConfig,
      useFactory: loadAppConfig,
    },
  ],
  exports: [AppConfig],
})
export class AppConfigModule {}
