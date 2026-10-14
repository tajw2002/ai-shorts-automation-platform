import { Module } from '@nestjs/common';
import { CharactersModule } from '@/modules/characters/characters.module';
import { SafetyModule } from '@/modules/safety/safety.module';
import { SimilarityModule } from '@/modules/similarity/similarity.module';
import { CostModule } from '@/modules/cost/cost.module';
import { SystemModule } from '@/modules/system/system.module';
import { IdeasService } from './ideas.service';
import { ScriptsService } from './scripts.service';
import { MetadataService } from './metadata.service';
import { ContentController } from './content.controller';

@Module({
  imports: [CharactersModule, SafetyModule, SimilarityModule, CostModule, SystemModule],
  controllers: [ContentController],
  providers: [IdeasService, ScriptsService, MetadataService],
  exports: [IdeasService, ScriptsService, MetadataService],
})
export class ContentModule {}
