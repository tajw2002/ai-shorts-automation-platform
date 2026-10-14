import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CostService } from './cost.service';

/**
 * Cost reporting.
 *
 * Lives in CostModule rather than on the system controller so SystemModule stays
 * free of a dependency on CostModule — CostModule already depends on SystemModule
 * for the runtime budget limits, and the reverse edge would be a cycle.
 */
@ApiTags('cost')
@Controller('cost')
export class CostController {
  constructor(private readonly cost: CostService) {}

  @Get()
  async getCost(@Query('days') days?: string) {
    const window = Math.min(365, Math.max(1, Number(days) || 30));
    const [summary, breakdown] = await Promise.all([
      this.cost.getSummary(),
      this.cost.getBreakdown(window),
    ]);
    return { summary, breakdown };
  }
}
