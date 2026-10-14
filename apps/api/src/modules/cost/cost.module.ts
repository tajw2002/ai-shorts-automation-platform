import { Module } from '@nestjs/common';
import { SystemModule } from '@/modules/system/system.module';
import { CostService } from './cost.service';
import { MeteredExecutor } from './metered-executor.service';
import { CostController } from './cost.controller';

@Module({
  imports: [SystemModule],
  controllers: [CostController],
  providers: [CostService, MeteredExecutor],
  exports: [CostService, MeteredExecutor],
})
export class CostModule {}
