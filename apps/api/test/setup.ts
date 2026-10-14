/**
 * Global test bootstrap.
 *
 * Tests must never reach a real provider or a real database by accident, so we
 * pin the environment to the safe, fully-mocked configuration before any module
 * is imported. Individual tests may override a value, but they start from here.
 */
process.env.NODE_ENV = 'test';
process.env.DRY_RUN = 'true';
process.env.LLM_PROVIDER = 'mock';
process.env.VIDEO_PROVIDER = 'mock';
process.env.VOICE_PROVIDER = 'mock';
process.env.YOUTUBE_PROVIDER = 'mock';
process.env.STORAGE_PROVIDER = 'local';
process.env.QUEUE_PROVIDER = 'inmemory';
process.env.LOG_LEVEL = 'silent';

process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test?schema=public';
process.env.SESSION_SECRET ??= Buffer.alloc(32, 7).toString('base64');
process.env.ENCRYPTION_KEY ??= Buffer.alloc(32, 9).toString('base64');
process.env.INTERNAL_API_KEY ??= 'test-internal-key';

// A test that tries to call out over the network is a bug in the test, not a
// flaky environment. Fail loudly instead of silently hitting a paid API.
// Nest's logger writes straight to stdout; in a test run that is noise that
// obscures real failures. Services under test still exercise their logging paths.
import { Logger } from '@nestjs/common';
Logger.overrideLogger(false);

globalThis.fetch = ((input: unknown) => {
  throw new Error(
    `Unexpected network call to ${String(input)}. Tests must mock every outbound request.`,
  );
}) as typeof globalThis.fetch;

export {};
