import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  createCharacterSchema,
  paginationSchema,
  updateCharacterSchema,
  type CreateCharacterDto,
  type Pagination,
  type SessionUser,
  type UpdateCharacterDto,
} from '@shorts/contracts';
import { zodBody, zodQuery } from '@/common/pipes/zod-validation.pipe';
import { Roles } from '@/modules/auth/auth.guard';
import { CurrentUser } from '@/modules/auth/current-user.decorator';
import { AuditService } from '@/modules/system/audit.service';
import { CharactersService } from './characters.service';

@ApiTags('characters')
@Controller('characters')
export class CharactersController {
  constructor(
    private readonly characters: CharactersService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  list(@Query(zodQuery(paginationSchema)) pagination: Pagination) {
    return this.characters.list(pagination);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.characters.findById(id);
  }

  @Post()
  @Roles('ADMIN', 'EDITOR')
  async create(
    @Body(zodBody(createCharacterSchema)) dto: CreateCharacterDto,
    @CurrentUser() user: SessionUser,
  ) {
    const character = await this.characters.create(dto);
    await this.audit.record({
      userId: user.id,
      action: 'character.create',
      entityType: 'Character',
      entityId: character.id,
      metadata: { name: character.name },
    });
    return character;
  }

  @Patch(':id')
  @Roles('ADMIN', 'EDITOR')
  async update(
    @Param('id') id: string,
    @Body(zodBody(updateCharacterSchema)) dto: UpdateCharacterDto,
    @CurrentUser() user: SessionUser,
  ) {
    const character = await this.characters.update(id, dto);
    await this.audit.record({
      userId: user.id,
      action: 'character.update',
      entityType: 'Character',
      entityId: id,
    });
    return character;
  }

  @Delete(':id')
  @Roles('ADMIN')
  async remove(@Param('id') id: string, @CurrentUser() user: SessionUser) {
    const result = await this.characters.remove(id);
    await this.audit.record({
      userId: user.id,
      action: result.deleted ? 'character.delete' : 'character.deactivate',
      entityType: 'Character',
      entityId: id,
    });
    return result;
  }
}
