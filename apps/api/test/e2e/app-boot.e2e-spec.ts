import { Test, type TestingModule } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import { AppModule } from '@/app.module';
import { PrismaService } from '@/prisma/prisma.service';
import { PipelineOrchestrator } from '@/modules/pipeline/pipeline.orchestrator';
import { HealthService } from '@/modules/system/health.service';
import { VideoStatus } from '@shorts/contracts';

/**
 * Boots the real application graph.
 *
 * This is the test that catches what unit tests structurally cannot: a circular
 * module import, a provider that was never registered, a token with no binding,
 * two pipeline steps claiming the same status, or a guard that fails open.
 *
 * Prisma is replaced with an in-memory double so no database is required — the
 * point here is the wiring, not the queries.
 */

/**
 * A Prisma stand-in.
 *
 * Every model responds to the handful of methods the boot path and smoke routes
 * actually touch; anything else returns an empty result rather than throwing, so
 * adding a model does not break this test.
 */
function createPrismaDouble(): Record<string, unknown> {
  const emptyModel = () => ({
    findMany: jest.fn().mockResolvedValue([]),
    findFirst: jest.fn().mockResolvedValue(null),
    findUnique: jest.fn().mockResolvedValue(null),
    findUniqueOrThrow: jest.fn().mockRejectedValue(new Error('not found')),
    create: jest.fn().mockResolvedValue({ id: 'generated-id' }),
    createMany: jest.fn().mockResolvedValue({ count: 0 }),
    update: jest.fn().mockResolvedValue({ id: 'generated-id' }),
    updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    upsert: jest.fn().mockResolvedValue({ id: 'generated-id' }),
    delete: jest.fn().mockResolvedValue({ id: 'generated-id' }),
    deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    count: jest.fn().mockResolvedValue(0),
    aggregate: jest.fn().mockResolvedValue({ _sum: {}, _avg: {} }),
    groupBy: jest.fn().mockResolvedValue([]),
  });

  const models = [
    'user',
    'session',
    'auditLog',
    'channel',
    'oAuthCredential',
    'character',
    'contentIdea',
    'ideaCharacter',
    'script',
    'contentFingerprint',
    'video',
    'videoStatusEvent',
    'videoScene',
    'sceneCharacter',
    'asset',
    'qualityReport',
    'job',
    'generationJob',
    'uploadJob',
    'schedule',
    'scheduleSlot',
    'analyticsSnapshot',
    'performanceInsight',
    'providerConfig',
    'systemSetting',
    'systemLog',
    'costRecord',
  ];

  const double: Record<string, unknown> = {
    $connect: jest.fn().mockResolvedValue(undefined),
    $disconnect: jest.fn().mockResolvedValue(undefined),
    $on: jest.fn(),
    $queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]),
    $transaction: jest.fn(async (arg: unknown) =>
      typeof arg === 'function'
        ? (arg as (tx: unknown) => Promise<unknown>)(double)
        : Promise.all(arg as Promise<unknown>[]),
    ),
    ping: jest.fn().mockResolvedValue(undefined),
    onModuleInit: jest.fn().mockResolvedValue(undefined),
    onModuleDestroy: jest.fn().mockResolvedValue(undefined),
  };

  for (const model of models) double[model] = emptyModel();
  return double;
}

describe('Application boot (e2e)', () => {
  let moduleRef: TestingModule;
  let app: INestApplication;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(createPrismaDouble())
      .compile();

    app = moduleRef.createNestApplication({ logger: false });
    app.use(cookieParser());
    app.setGlobalPrefix('api/v1', { exclude: ['liveness', 'readiness', 'internal/(.*)'] });
    await app.init();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  });

  it('resolves the entire dependency graph', () => {
    // Reaching here at all means every module imported, every token resolved and
    // no circular dependency prevented instantiation.
    expect(app).toBeDefined();
  });

  it('registers exactly one pipeline step per automated status', () => {
    const orchestrator = moduleRef.get(PipelineOrchestrator);
    const statuses = orchestrator.registeredStatuses();

    expect(statuses).toEqual(
      expect.arrayContaining([
        VideoStatus.CREATED,
        VideoStatus.SCRIPT_GENERATED,
        VideoStatus.SCENES_PLANNED,
        VideoStatus.GENERATED,
        VideoStatus.QUALITY_CHECK,
      ]),
    );
    // Duplicates would have thrown in the constructor, but assert it explicitly.
    expect(new Set(statuses).size).toBe(statuses.length);
  });

  it('leaves the human-gate statuses without an automatic step', () => {
    const statuses = moduleRef.get(PipelineOrchestrator).registeredStatuses();
    expect(statuses).not.toContain(VideoStatus.READY_FOR_REVIEW);
    expect(statuses).not.toContain(VideoStatus.APPROVED);
    expect(statuses).not.toContain(VideoStatus.PUBLISHED);
  });

  it('wires the mock providers, because the test environment sets DRY_RUN', () => {
    const descriptors = moduleRef.get(HealthService).describeProviders();
    const byKind = new Map(descriptors.map((d) => [d.kind, d]));

    expect(byKind.get('LLM')?.implementation).toBe('mock');
    expect(byKind.get('VIDEO')?.implementation).toBe('mock');
    expect(byKind.get('VOICE')?.implementation).toBe('mock');
    expect(byKind.get('YOUTUBE')?.implementation).toBe('mock');
    // Storage and queue are not billed per call, so a dry run keeps them real.
    expect(byKind.get('STORAGE')?.implementation).toBe('local');
    expect(byKind.get('QUEUE')?.implementation).toBe('inmemory');
  });

  describe('health probes', () => {
    it('serves liveness without authentication and outside the API prefix', async () => {
      const response = await request(app.getHttpServer()).get('/liveness').expect(200);
      expect(response.body.status).toBe('ok');
      expect(response.body.uptimeSeconds).toBeGreaterThanOrEqual(0);
    });

    it('serves readiness without authentication', async () => {
      const response = await request(app.getHttpServer()).get('/readiness').expect(200);
      expect(response.body.status).toBe('OK');
    });
  });

  describe('authentication guard', () => {
    it('refuses an unauthenticated request to a protected route', async () => {
      const response = await request(app.getHttpServer()).get('/api/v1/videos').expect(401);
      expect(response.body.code).toBe('UNAUTHENTICATED');
    });

    it('refuses an unauthenticated write', async () => {
      await request(app.getHttpServer()).post('/api/v1/videos').send({ ideaId: 'x' }).expect(401);
    });

    it('allows the login route without a session', async () => {
      // Wrong credentials, but it must reach the handler rather than the guard.
      const response = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: 'nobody@example.com', password: 'not-the-right-password' });

      expect(response.status).toBe(401);
      expect(response.body.message).toBe('Incorrect email or password.');
    });

    it('rejects a malformed login payload with a validation error, not a 500', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: 'not-an-email', password: 'short' })
        .expect(400);

      expect(response.body.code).toBe('VALIDATION_FAILED');
      expect(Array.isArray(response.body.details)).toBe(true);
    });

    it('refuses an internal endpoint without the internal key', async () => {
      await request(app.getHttpServer())
        .post('/internal/tasks/run')
        .send({ jobId: 'x', type: 'PIPELINE_ADVANCE', idempotencyKey: 'k', payload: {} })
        .expect(401);
    });

    it('accepts an internal endpoint with the shared secret', async () => {
      const response = await request(app.getHttpServer())
        .post('/internal/tasks/run')
        .set('x-internal-api-key', process.env.INTERNAL_API_KEY as string)
        .send({ jobId: 'missing-job', type: 'PIPELINE_ADVANCE', idempotencyKey: 'k', payload: {} });

      // The job does not exist in the double, so the runner reports it skipped —
      // which is the correct at-least-once behaviour, and a 200 either way.
      expect(response.status).toBe(200);
      expect(response.body.status).toBe('skipped');
    });
  });

  describe('error responses', () => {
    it('returns a structured body with a request id', async () => {
      const response = await request(app.getHttpServer()).get('/api/v1/videos').expect(401);

      expect(response.body).toMatchObject({
        statusCode: 401,
        code: 'UNAUTHENTICATED',
      });
      expect(typeof response.body.requestId).toBe('string');
      expect(typeof response.body.timestamp).toBe('string');
      expect(response.headers['x-request-id']).toBeDefined();
    });

    it('never leaks a stack trace', async () => {
      const response = await request(app.getHttpServer()).get('/api/v1/videos').expect(401);
      expect(JSON.stringify(response.body)).not.toContain('at ');
    });
  });
});
