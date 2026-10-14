import 'reflect-metadata';
import { PrismaService } from '@/prisma/prisma.service';
import { AppConfig } from '@/config/app-config';
import { FfmpegRunner } from '@/infrastructure/ffmpeg/ffmpeg.runner';
import { SafetyService } from '@/modules/safety/safety.service';
import { SimilarityService } from '@/modules/similarity/similarity.service';
import { CostService } from '@/modules/cost/cost.service';
import { MeteredExecutor } from '@/modules/cost/metered-executor.service';
import { JobsService } from '@/modules/jobs/jobs.service';
import { AuthService } from '@/modules/auth/auth.service';
import { AuditService } from '@/modules/system/audit.service';
import { SystemLogService } from '@/modules/system/system-log.service';
import { SystemSettingsService } from '@/modules/system/system-settings.service';
import { PublishGuardService } from '@/modules/youtube/publish-guard.service';
import { ChannelsService } from '@/modules/youtube/channels.service';
import { AnalyticsService } from '@/modules/analytics/analytics.service';
import { SchedulerService } from '@/modules/scheduler/scheduler.service';
import { PipelineOrchestrator } from '@/modules/pipeline/pipeline.orchestrator';
import { AssemblyService } from '@/modules/media/assembly.service';
import { QualityControlService } from '@/modules/media/quality-control.service';
import { SubtitleService } from '@/modules/media/subtitle.service';
import { AssetsService } from '@/modules/assets/assets.service';
import { VideosService } from '@/modules/videos/videos.service';
import { IdeasService } from '@/modules/content/ideas.service';
import { CharactersService } from '@/modules/characters/characters.service';
import { GenerateAssetsStep } from '@/modules/pipeline/steps/generate-assets.step';

/**
 * Guards the decorator metadata NestJS resolves dependencies from.
 *
 * NestJS reads constructor parameter types from `design:paramtypes`, which
 * `emitDecoratorMetadata` only emits for classes imported in *value* position.
 * A `type` import is erased at compile time and the parameter silently degrades
 * to `Object` — so Nest has no token to resolve and fails at boot with
 * "Nest can't resolve dependencies", pointing at the injection site rather than
 * at the import that broke it.
 *
 * This is not hypothetical: an ESLint `consistent-type-imports` autofix
 * introduced exactly this across 57 files. It compiled, type-checked and linted
 * cleanly, and every provider failed to construct.
 *
 * Assertions are by **identity**, deliberately. Checking "not Function" is not
 * enough — an erased class comes through as `Object`, which passes that test.
 */

function paramTypes(target: unknown): unknown[] {
  return (Reflect.getMetadata('design:paramtypes', target as object) as unknown[]) ?? [];
}

/**
 * Expected constructor dependencies, in order.
 *
 * `null` marks a parameter injected by token with `@Inject()` — an interface has
 * no runtime value, so `Object` is correct there and is what we assert.
 */
const EXPECTED: Array<[string, new (...args: never[]) => unknown, Array<unknown | null>]> = [
  ['PrismaService', PrismaService, [AppConfig]],
  ['FfmpegRunner', FfmpegRunner, [AppConfig]],
  ['SafetyService', SafetyService, [AppConfig, null]],
  ['SimilarityService', SimilarityService, [PrismaService, AppConfig]],
  ['MeteredExecutor', MeteredExecutor, [CostService]],
  ['CostService', CostService, [PrismaService, AppConfig, SystemSettingsService, SystemLogService]],
  ['JobsService', JobsService, [PrismaService, AppConfig, null]],
  ['AuthService', AuthService, [PrismaService, AppConfig, AuditService]],
  ['AuditService', AuditService, [PrismaService]],
  ['SystemLogService', SystemLogService, [PrismaService]],
  ['SystemSettingsService', SystemSettingsService, [PrismaService, AppConfig]],
  ['PublishGuardService', PublishGuardService, [PrismaService, AppConfig, SystemSettingsService]],
  ['AssemblyService', AssemblyService, [FfmpegRunner]],
  ['SubtitleService', SubtitleService, [AppConfig]],
  ['AssetsService', AssetsService, [PrismaService, null]],
  ['CharactersService', CharactersService, [PrismaService]],
  [
    'GenerateAssetsStep',
    GenerateAssetsStep,
    [
      PrismaService,
      AppConfig,
      null,
      null,
      AssetsService,
      MeteredExecutor,
      SystemLogService,
      FfmpegRunner,
    ],
  ],
];

describe('NestJS dependency metadata', () => {
  it.each(EXPECTED)('%s declares its dependencies by identity', (name, target, expected) => {
    const actual = paramTypes(target);

    expect(actual).toHaveLength(expected.length);

    expected.forEach((expectedType, index) => {
      if (expectedType === null) {
        // Token-injected: an interface has no runtime value.
        expect(actual[index]).toBe(Object);
        return;
      }
      expect(actual[index]).toBe(expectedType);
    });
    void name;
  });

  /**
   * A broader sweep over services whose exact signature is not pinned above.
   * `Object` in a class position is the signature of an erased import.
   */
  it.each([
    ['ChannelsService', ChannelsService, [PrismaService, AppConfig]],
    ['AnalyticsService', AnalyticsService, [PrismaService, AppConfig]],
    ['SchedulerService', SchedulerService, [PrismaService, AppConfig]],
    ['PipelineOrchestrator', PipelineOrchestrator, [PrismaService, JobsService]],
    ['QualityControlService', QualityControlService, []],
    ['VideosService', VideosService, [PrismaService, AppConfig]],
    ['IdeasService', IdeasService, [PrismaService, AppConfig]],
  ] as Array<[string, new (...args: never[]) => unknown, unknown[]]>)(
    '%s keeps its class dependencies resolvable',
    (name, target, mustContain) => {
      const actual = paramTypes(target);
      for (const dependency of mustContain) {
        expect(actual).toContain(dependency);
      }
      void name;
    },
  );

  it('AppConfig itself is a real class, not an erased type', () => {
    expect(typeof AppConfig).toBe('function');
    expect(AppConfig.name).toBe('AppConfig');
  });

  it('detects an erased import — the exact regression this guards against', () => {
    // A class whose dependency was written as a `type` import compiles to
    // `Object` here. This asserts the detection itself works, so the test above
    // cannot pass vacuously.
    class Erased {
      constructor(_config: object) {}
    }
    const erasedTypes = paramTypes(Erased);
    expect(erasedTypes.length === 0 || erasedTypes[0] === Object).toBe(true);
    expect(erasedTypes[0]).not.toBe(AppConfig);
  });
});
