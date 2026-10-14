import { Module } from '@nestjs/common';
import { ContentModule } from '@/modules/content/content.module';
import { MediaModule } from '@/modules/media/media.module';
import { AssetsModule } from '@/modules/assets/assets.module';
import { SafetyModule } from '@/modules/safety/safety.module';
import { SimilarityModule } from '@/modules/similarity/similarity.module';
import { CostModule } from '@/modules/cost/cost.module';
import { SystemModule } from '@/modules/system/system.module';
import { JobsModule } from '@/modules/jobs/jobs.module';
import { PipelineOrchestrator } from './pipeline.orchestrator';
import { PIPELINE_STEPS, type PipelineStep } from './pipeline.types';
import { GenerateScriptStep } from './steps/generate-script.step';
import { PlanScenesStep } from './steps/plan-scenes.step';
import { GenerateAssetsStep } from './steps/generate-assets.step';
import { AssembleStep } from './steps/assemble.step';
import { QualityControlStep } from './steps/quality-control.step';

/**
 * Steps are collected into a list and handed to the orchestrator, which indexes
 * them by the status they consume. Adding a stage means adding a class here —
 * the orchestrator needs no change, and it rejects two steps claiming one status.
 */
@Module({
  imports: [
    ContentModule,
    MediaModule,
    AssetsModule,
    SafetyModule,
    SimilarityModule,
    CostModule,
    SystemModule,
    JobsModule,
  ],
  providers: [
    GenerateScriptStep,
    PlanScenesStep,
    GenerateAssetsStep,
    AssembleStep,
    QualityControlStep,
    {
      provide: PIPELINE_STEPS,
      inject: [
        GenerateScriptStep,
        PlanScenesStep,
        GenerateAssetsStep,
        AssembleStep,
        QualityControlStep,
      ],
      useFactory: (...steps: PipelineStep[]) => steps,
    },
    PipelineOrchestrator,
  ],
  exports: [PipelineOrchestrator],
})
export class PipelineModule {}
