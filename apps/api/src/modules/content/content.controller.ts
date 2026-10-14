import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  generateIdeasSchema,
  listIdeasSchema,
  updateIdeaSchema,
  updateScriptSchema,
  type GenerateIdeasDto,
  type ListIdeasDto,
  type SessionUser,
  type UpdateIdeaDto,
  type UpdateScriptDto,
} from '@shorts/contracts';
import { PrismaService } from '@/prisma/prisma.service';
import { zodBody, zodQuery } from '@/common/pipes/zod-validation.pipe';
import { Roles } from '@/modules/auth/auth.guard';
import { CurrentUser } from '@/modules/auth/current-user.decorator';
import { AuditService } from '@/modules/system/audit.service';
import { IdeasService } from './ideas.service';
import { ScriptsService } from './scripts.service';

@ApiTags('content')
@Controller()
export class ContentController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ideas: IdeasService,
    private readonly scripts: ScriptsService,
    private readonly audit: AuditService,
  ) {}

  /* -- Ideas -------------------------------------------------------------- */

  @Get('ideas')
  async listIdeas(@Query(zodQuery(listIdeasSchema)) query: ListIdeasDto) {
    const where = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.search
        ? {
            OR: [
              { title: { contains: query.search, mode: 'insensitive' as const } },
              { premise: { contains: query.search, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };

    const [items, total] = await Promise.all([
      this.prisma.contentIdea.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        include: { characters: { include: { character: { select: { name: true } } } } },
      }),
      this.prisma.contentIdea.count({ where }),
    ]);

    return {
      items: items.map((idea) => ({
        id: idea.id,
        title: idea.title,
        premise: idea.premise,
        hook: idea.hook,
        status: idea.status,
        tone: idea.tone,
        targetDurationSeconds: idea.targetDurationSeconds,
        characterNames: idea.characters.map((link) => link.character.name),
        safetyVerdict: idea.safetyVerdict,
        createdAt: idea.createdAt.toISOString(),
      })),
      page: query.page,
      pageSize: query.pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
    };
  }

  @Get('ideas/:id')
  findIdea(@Param('id') id: string) {
    return this.ideas.findById(id);
  }

  @Post('ideas/generate')
  @Roles('ADMIN', 'EDITOR')
  async generateIdeas(
    @Body(zodBody(generateIdeasSchema)) dto: GenerateIdeasDto,
    @CurrentUser() user: SessionUser,
  ) {
    const ideas = await this.ideas.generate(dto);
    await this.audit.record({
      userId: user.id,
      action: 'idea.generate',
      entityType: 'ContentIdea',
      metadata: { requested: dto.count, produced: ideas.length },
    });
    return { ideas };
  }

  @Patch('ideas/:id')
  @Roles('ADMIN', 'EDITOR')
  async updateIdea(
    @Param('id') id: string,
    @Body(zodBody(updateIdeaSchema)) dto: UpdateIdeaDto,
    @CurrentUser() user: SessionUser,
  ) {
    await this.ideas.findById(id);
    const updated = await this.prisma.contentIdea.update({
      where: { id },
      data: {
        ...(dto.title !== undefined ? { title: dto.title } : {}),
        ...(dto.premise !== undefined ? { premise: dto.premise } : {}),
        ...(dto.hook !== undefined ? { hook: dto.hook } : {}),
        ...(dto.beats !== undefined ? { beats: dto.beats } : {}),
        ...(dto.tone !== undefined ? { tone: dto.tone } : {}),
        ...(dto.targetDurationSeconds !== undefined
          ? { targetDurationSeconds: dto.targetDurationSeconds }
          : {}),
        ...(dto.status !== undefined ? { status: dto.status } : {}),
      },
    });

    await this.audit.record({
      userId: user.id,
      action: 'idea.update',
      entityType: 'ContentIdea',
      entityId: id,
    });
    return updated;
  }

  @Delete('ideas/:id')
  @Roles('ADMIN', 'EDITOR')
  async removeIdea(@Param('id') id: string, @CurrentUser() user: SessionUser) {
    await this.ideas.remove(id);
    await this.audit.record({
      userId: user.id,
      action: 'idea.delete',
      entityType: 'ContentIdea',
      entityId: id,
    });
    return { deleted: true };
  }

  /* -- Scripts ------------------------------------------------------------ */

  @Get('scripts/:id')
  findScript(@Param('id') id: string) {
    return this.scripts.findById(id);
  }

  @Patch('scripts/:id')
  @Roles('ADMIN', 'EDITOR')
  async updateScript(
    @Param('id') id: string,
    @Body(zodBody(updateScriptSchema)) dto: UpdateScriptDto,
    @CurrentUser() user: SessionUser,
  ) {
    const script = await this.scripts.update(id, dto);
    await this.audit.record({
      userId: user.id,
      action: 'script.update',
      entityType: 'Script',
      entityId: id,
    });
    return script;
  }
}
